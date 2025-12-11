use nullspace_types::{
    execution::{Account, Event, Instruction, Key, Output, Transaction, Value},
    Seed,
};
use bytes::{Buf, BufMut};
use commonware_codec::{Encode, EncodeSize, Error, Read, ReadExt, Write};
use commonware_consensus::threshold_simplex::types::View;
use commonware_cryptography::{
    bls12381::primitives::variant::{MinSig, Variant},
    ed25519::PublicKey,
    sha256::{Digest, Sha256},
    Hasher,
};
#[cfg(feature = "parallel")]
use commonware_runtime::ThreadPool;
use commonware_runtime::{Clock, Metrics, Spawner, Storage};
use commonware_storage::{adb::any::variable::Any, translator::Translator};
#[cfg(feature = "parallel")]
use rayon::iter::{IntoParallelIterator, ParallelIterator};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    future::Future,
};
use tracing::warn;

pub mod casino;
mod fixed;
pub mod state_transition;

#[cfg(any(test, feature = "mocks"))]
pub mod mocks;

pub type Adb<E, T> = Any<E, Digest, Value, Sha256, T>;

pub trait State {
    fn get(&self, key: &Key) -> impl Future<Output = Option<Value>>;
    fn insert(&mut self, key: Key, value: Value) -> impl Future<Output = ()>;
    fn delete(&mut self, key: &Key) -> impl Future<Output = ()>;

    fn apply(&mut self, changes: Vec<(Key, Status)>) -> impl Future<Output = ()> {
        async {
            for (key, status) in changes {
                match status {
                    Status::Update(value) => self.insert(key, value).await,
                    Status::Delete => self.delete(&key).await,
                }
            }
        }
    }
}

impl<E: Spawner + Metrics + Clock + Storage, T: Translator> State for Adb<E, T> {
    async fn get(&self, key: &Key) -> Option<Value> {
        let key = Sha256::hash(&key.encode());
        match self.get(&key).await {
            Ok(value) => value,
            Err(e) => {
                warn!("Database error during get operation: {:?}", e);
                None
            }
        }
    }

    async fn insert(&mut self, key: Key, value: Value) {
        let key = Sha256::hash(&key.encode());
        if let Err(e) = self.update(key, value).await {
            warn!("Database error during insert operation: {:?}", e);
        }
    }

    async fn delete(&mut self, key: &Key) {
        let key = Sha256::hash(&key.encode());
        if let Err(e) = self.delete(key).await {
            warn!("Database error during delete operation: {:?}", e);
        }
    }
}

#[derive(Default)]
pub struct Memory {
    state: HashMap<Key, Value>,
}

impl State for Memory {
    async fn get(&self, key: &Key) -> Option<Value> {
        self.state.get(key).cloned()
    }

    async fn insert(&mut self, key: Key, value: Value) {
        self.state.insert(key, value);
    }

    async fn delete(&mut self, key: &Key) {
        self.state.remove(key);
    }
}

#[derive(Clone)]
#[allow(clippy::large_enum_variant)]
pub enum Status {
    Update(Value),
    Delete,
}

impl Write for Status {
    fn write(&self, writer: &mut impl BufMut) {
        match self {
            Status::Update(value) => {
                0u8.write(writer);
                value.write(writer);
            }
            Status::Delete => 1u8.write(writer),
        }
    }
}

impl Read for Status {
    type Cfg = ();

    fn read_cfg(reader: &mut impl Buf, _: &Self::Cfg) -> Result<Self, Error> {
        let kind = u8::read(reader)?;
        match kind {
            0 => Ok(Status::Update(Value::read(reader)?)),
            1 => Ok(Status::Delete),
            _ => Err(Error::InvalidEnum(kind)),
        }
    }
}

impl EncodeSize for Status {
    fn encode_size(&self) -> usize {
        1 + match self {
            Status::Update(value) => value.encode_size(),
            Status::Delete => 0,
        }
    }
}

pub async fn nonce<S: State>(state: &S, public: &PublicKey) -> u64 {
    let account =
        if let Some(Value::Account(account)) = state.get(&Key::Account(public.clone())).await {
            account
        } else {
            Account::default()
        };
    account.nonce
}

pub struct Noncer<'a, S: State> {
    state: &'a S,
    pending: BTreeMap<Key, Status>,
}

impl<'a, S: State> Noncer<'a, S> {
    pub fn new(state: &'a S) -> Self {
        Self {
            state,
            pending: BTreeMap::new(),
        }
    }

    pub async fn prepare(&mut self, transaction: &Transaction) -> bool {
        let mut account = if let Some(Value::Account(account)) =
            self.get(&Key::Account(transaction.public.clone())).await
        {
            account
        } else {
            Account::default()
        };

        // Ensure nonce is correct
        if account.nonce != transaction.nonce {
            return false;
        }

        // Increment nonce
        account.nonce += 1;
        self.insert(
            Key::Account(transaction.public.clone()),
            Value::Account(account),
        )
        .await;

        true
    }
}

impl<'a, S: State> State for Noncer<'a, S> {
    async fn get(&self, key: &Key) -> Option<Value> {
        match self.pending.get(key) {
            Some(Status::Update(value)) => Some(value.clone()),
            Some(Status::Delete) => None,
            None => self.state.get(key).await,
        }
    }

    async fn insert(&mut self, key: Key, value: Value) {
        self.pending.insert(key, Status::Update(value));
    }

    async fn delete(&mut self, key: &Key) {
        self.pending.insert(key.clone(), Status::Delete);
    }
}

#[derive(Hash, Eq, PartialEq)]
enum Task {
    Seed(Seed),
}

enum TaskResult {
    Seed(bool),
}

pub struct Layer<'a, S: State> {
    state: &'a S,
    pending: BTreeMap<Key, Status>,

    master: <MinSig as Variant>::Public,
    namespace: Vec<u8>,

    seed: Seed,

    precomputations: HashMap<Task, TaskResult>,
}

impl<'a, S: State> Layer<'a, S> {
    pub fn new(
        state: &'a S,
        master: <MinSig as Variant>::Public,
        namespace: &[u8],
        seed: Seed,
    ) -> Self {
        let mut verified_seeds = HashSet::new();
        verified_seeds.insert(seed.clone());
        Self {
            state,
            pending: BTreeMap::new(),

            master,
            namespace: namespace.to_vec(),

            seed,

            precomputations: HashMap::new(),
        }
    }

    fn insert(&mut self, key: Key, value: Value) {
        self.pending.insert(key, Status::Update(value));
    }

    fn delete(&mut self, key: Key) {
        self.pending.insert(key, Status::Delete);
    }

    pub fn view(&self) -> View {
        self.seed.view
    }

    async fn prepare(&mut self, transaction: &Transaction) -> bool {
        // Get account
        let mut account = if let Some(Value::Account(account)) =
            self.get(&Key::Account(transaction.public.clone())).await
        {
            account
        } else {
            Account::default()
        };

        // Ensure nonce is correct
        if account.nonce != transaction.nonce {
            return false;
        }

        // Increment nonce
        account.nonce += 1;
        self.insert(
            Key::Account(transaction.public.clone()),
            Value::Account(account),
        );

        true
    }

    async fn extract(&mut self, _transaction: &Transaction) -> Vec<Task> {
        // Casino instructions don't need precomputation
        vec![]
    }

    async fn apply(&mut self, transaction: &Transaction) -> Vec<Event> {
        match &transaction.instruction {
            Instruction::CasinoRegister { name } => {
                self.handle_casino_register(&transaction.public, name).await
            }
            Instruction::CasinoDeposit { amount } => {
                self.handle_casino_deposit(&transaction.public, *amount).await
            }
            Instruction::CasinoStartGame {
                game_type,
                bet,
                session_id,
            } => {
                self.handle_casino_start_game(&transaction.public, *game_type, *bet, *session_id)
                    .await
            }
            Instruction::CasinoGameMove {
                session_id,
                payload,
            } => {
                self.handle_casino_game_move(&transaction.public, *session_id, payload)
                    .await
            }
            Instruction::CasinoToggleShield => {
                self.handle_casino_toggle_shield(&transaction.public).await
            }
            Instruction::CasinoToggleDouble => {
                self.handle_casino_toggle_double(&transaction.public).await
            }
            Instruction::CasinoJoinTournament { tournament_id } => {
                self.handle_casino_join_tournament(&transaction.public, *tournament_id)
                    .await
            }
            Instruction::CasinoStartTournament { tournament_id, start_time_ms, end_time_ms } => {
                self.handle_casino_start_tournament(&transaction.public, *tournament_id, *start_time_ms, *end_time_ms)
                    .await
            }
        }
    }

    // === Casino Handler Methods ===

    async fn handle_casino_register(&mut self, public: &PublicKey, name: &str) -> Vec<Event> {
        // Check if player already exists
        if self.get(&Key::CasinoPlayer(public.clone())).await.is_some() {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_PLAYER_ALREADY_REGISTERED,
                message: "Player already registered".to_string(),
            }];
        }

        // Create new player with initial chips and current block for rate limiting
        let player = nullspace_types::casino::Player::new_with_block(
            name.to_string(),
            self.seed.view
        );

        self.insert(
            Key::CasinoPlayer(public.clone()),
            Value::CasinoPlayer(player.clone()),
        );

        // Update leaderboard with initial chips
        self.update_casino_leaderboard(public, &player).await;

        vec![Event::CasinoPlayerRegistered {
            player: public.clone(),
            name: name.to_string(),
        }]
    }

    async fn handle_casino_deposit(&mut self, public: &PublicKey, _amount: u64) -> Vec<Event> {
        let mut player = match self.get(&Key::CasinoPlayer(public.clone())).await {
            Some(Value::CasinoPlayer(p)) => p,
            _ => {
                return vec![Event::CasinoError {
                    player: public.clone(),
                    session_id: None,
                    error_code: nullspace_types::casino::ERROR_PLAYER_NOT_FOUND,
                    message: "Player not found".to_string(),
                }]
            }
        };

        // Check rate limiting
        let current_block = self.seed.view;
        if player.last_deposit_block + nullspace_types::casino::FAUCET_RATE_LIMIT > current_block {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_RATE_LIMITED,
                message: "Faucet rate limited, try again later".to_string(),
            }];
        }

        // Grant faucet chips
        player.chips = player.chips.saturating_add(nullspace_types::casino::FAUCET_AMOUNT);
        player.last_deposit_block = current_block;

        self.insert(
            Key::CasinoPlayer(public.clone()),
            Value::CasinoPlayer(player.clone()),
        );

        self.update_casino_leaderboard(public, &player).await;

        vec![Event::CasinoPlayerRegistered {
            player: public.clone(),
            name: player.name,
        }]
    }

    async fn handle_casino_start_game(
        &mut self,
        public: &PublicKey,
        game_type: nullspace_types::casino::GameType,
        bet: u64,
        session_id: u64,
    ) -> Vec<Event> {
        // Get player
        let mut player = match self.get(&Key::CasinoPlayer(public.clone())).await {
            Some(Value::CasinoPlayer(p)) => p,
            _ => {
                return vec![Event::CasinoError {
                    player: public.clone(),
                    session_id: Some(session_id),
                    error_code: nullspace_types::casino::ERROR_PLAYER_NOT_FOUND,
                    message: "Player not found".to_string(),
                }]
            }
        };

        // Check player has enough chips
        if bet == 0 {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: Some(session_id),
                error_code: nullspace_types::casino::ERROR_INVALID_BET,
                message: "Bet must be greater than zero".to_string(),
            }];
        }
        if player.chips < bet {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: Some(session_id),
                error_code: nullspace_types::casino::ERROR_INSUFFICIENT_FUNDS,
                message: format!("Insufficient chips: have {}, need {}", player.chips, bet),
            }];
        }

        // Check for existing session
        if self.get(&Key::CasinoSession(session_id)).await.is_some() {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: Some(session_id),
                error_code: nullspace_types::casino::ERROR_SESSION_EXISTS,
                message: "Session already exists".to_string(),
            }];
        }

        // Deduct bet from player
        player.chips = player.chips.saturating_sub(bet);
        self.insert(
            Key::CasinoPlayer(public.clone()),
            Value::CasinoPlayer(player.clone()),
        );

        // Update leaderboard after bet deduction
        self.update_casino_leaderboard(public, &player).await;

        // Create game session
        let mut session = nullspace_types::casino::GameSession {
            id: session_id,
            player: public.clone(),
            game_type,
            bet,
            state_blob: vec![],
            move_count: 0,
            created_at: self.seed.view,
            is_complete: false,
            super_mode: nullspace_types::casino::SuperModeState::default(),
        };

        // Initialize game
        let mut rng = crate::casino::GameRng::new(&self.seed, session_id, 0);
        let result = crate::casino::init_game(&mut session, &mut rng);

        let initial_state = session.state_blob.clone();
        self.insert(Key::CasinoSession(session_id), Value::CasinoSession(session.clone()));

        let mut events = vec![Event::CasinoGameStarted {
            session_id,
            player: public.clone(),
            game_type,
            bet,
            initial_state,
        }];

        // Handle immediate result (e.g. Natural Blackjack)
        if !matches!(result, crate::casino::GameResult::Continue) {
            if let Some(Value::CasinoPlayer(mut player)) = self.get(&Key::CasinoPlayer(public.clone())).await {
                match result {
                    crate::casino::GameResult::Win(base_payout) => {
                        let mut payout = base_payout as i64;
                        let was_doubled = player.active_double;
                        if was_doubled && player.doubles > 0 {
                            payout *= 2;
                            player.doubles -= 1;
                        }
                        // Safe cast: payout should always be positive for Win result
                        let addition = u64::try_from(payout).unwrap_or(0);
                        player.chips = player.chips.saturating_add(addition);
                        player.active_shield = false;
                        player.active_double = false;

                        let final_chips = player.chips;
                        self.insert(Key::CasinoPlayer(public.clone()), Value::CasinoPlayer(player.clone()));
                        self.update_casino_leaderboard(public, &player).await;

                        events.push(Event::CasinoGameCompleted {
                            session_id,
                            player: public.clone(),
                            game_type: session.game_type,
                            payout,
                            final_chips,
                            was_shielded: false,
                            was_doubled,
                        });
                    }
                    crate::casino::GameResult::Push => {
                        player.chips = player.chips.saturating_add(session.bet);
                        player.active_shield = false;
                        player.active_double = false;

                        let final_chips = player.chips;
                        self.insert(Key::CasinoPlayer(public.clone()), Value::CasinoPlayer(player.clone()));

                        // Update leaderboard after push
                        self.update_casino_leaderboard(public, &player).await;

                        events.push(Event::CasinoGameCompleted {
                            session_id,
                            player: public.clone(),
                            game_type: session.game_type,
                            payout: session.bet as i64,
                            final_chips,
                            was_shielded: false,
                            was_doubled: false,
                        });
                    }
                    crate::casino::GameResult::Loss => {
                        let was_shielded = player.active_shield && player.shields > 0;
                        let payout = if was_shielded {
                            player.shields -= 1;
                            0
                        } else {
                            -(session.bet as i64)
                        };
                        player.active_shield = false;
                        player.active_double = false;

                        let final_chips = player.chips;
                        self.insert(Key::CasinoPlayer(public.clone()), Value::CasinoPlayer(player.clone()));

                        // Update leaderboard after immediate loss
                        self.update_casino_leaderboard(public, &player).await;

                        events.push(Event::CasinoGameCompleted {
                            session_id,
                            player: public.clone(),
                            game_type: session.game_type,
                            payout,
                            final_chips,
                            was_shielded,
                            was_doubled: false,
                        });
                    }
                    _ => {}
                }
            }
        }

        events
    }

    async fn handle_casino_game_move(
        &mut self,
        public: &PublicKey,
        session_id: u64,
        payload: &[u8],
    ) -> Vec<Event> {
        // Get session
        let mut session = match self.get(&Key::CasinoSession(session_id)).await {
            Some(Value::CasinoSession(s)) => s,
            _ => {
                return vec![Event::CasinoError {
                    player: public.clone(),
                    session_id: Some(session_id),
                    error_code: nullspace_types::casino::ERROR_SESSION_NOT_FOUND,
                    message: "Session not found".to_string(),
                }]
            }
        };

        // Verify ownership and not complete
        if session.player != *public {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: Some(session_id),
                error_code: nullspace_types::casino::ERROR_SESSION_NOT_OWNED,
                message: "Session does not belong to this player".to_string(),
            }];
        }
        if session.is_complete {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: Some(session_id),
                error_code: nullspace_types::casino::ERROR_SESSION_COMPLETE,
                message: "Session already complete".to_string(),
            }];
        }

        // Process move
        session.move_count += 1;
        let mut rng = crate::casino::GameRng::new(&self.seed, session_id, session.move_count);

        let result = match crate::casino::process_game_move(&mut session, payload, &mut rng) {
            Ok(r) => r,
            Err(_) => {
                return vec![Event::CasinoError {
                    player: public.clone(),
                    session_id: Some(session_id),
                    error_code: nullspace_types::casino::ERROR_INVALID_MOVE,
                    message: "Invalid game move".to_string(),
                }]
            }
        };

        let move_number = session.move_count;
        let new_state = session.state_blob.clone();

        // Handle game result
        let mut events = vec![Event::CasinoGameMoved {
            session_id,
            move_number,
            new_state,
        }];

        match result {
            crate::casino::GameResult::Continue => {
                self.insert(Key::CasinoSession(session_id), Value::CasinoSession(session));
            }
            crate::casino::GameResult::ContinueWithUpdate { payout } => {
                // Handle mid-game balance updates (additional bets or intermediate payouts)
                if let Some(Value::CasinoPlayer(mut player)) =
                    self.get(&Key::CasinoPlayer(public.clone())).await
                {
                    if payout < 0 {
                        // Deducting chips (new bet placed)
                        // Use checked_neg to safely convert negative i64 to positive value
                        let deduction = payout.checked_neg()
                            .and_then(|v| u64::try_from(v).ok())
                            .unwrap_or(0);
                        if deduction == 0 || player.chips < deduction {
                            // Insufficient funds or overflow - reject the move
                            return vec![Event::CasinoError {
                                player: public.clone(),
                                session_id: Some(session_id),
                                error_code: nullspace_types::casino::ERROR_INSUFFICIENT_FUNDS,
                                message: format!(
                                    "Insufficient chips for additional bet: have {}, need {}",
                                    player.chips, deduction
                                ),
                            }];
                        }
                        player.chips = player.chips.saturating_sub(deduction);
                    } else {
                        // Adding chips (intermediate win)
                        // Safe cast: positive i64 fits in u64
                        let addition = u64::try_from(payout).unwrap_or(0);
                        player.chips = player.chips.saturating_add(addition);
                    }
                    self.insert(Key::CasinoPlayer(public.clone()), Value::CasinoPlayer(player.clone()));

                    // Update leaderboard after mid-game balance change
                    self.update_casino_leaderboard(public, &player).await;
                }
                self.insert(Key::CasinoSession(session_id), Value::CasinoSession(session));
            }
            crate::casino::GameResult::Win(base_payout) => {
                session.is_complete = true;
                self.insert(Key::CasinoSession(session_id), Value::CasinoSession(session.clone()));

                // Get player for modifier state
                if let Some(Value::CasinoPlayer(mut player)) =
                    self.get(&Key::CasinoPlayer(public.clone())).await
                {
                    let mut payout = base_payout as i64;
                    let was_doubled = player.active_double;
                    if was_doubled && player.doubles > 0 {
                        payout *= 2;
                        player.doubles -= 1;
                    }
                    // Safe cast: payout should always be positive for Win result
                    let addition = u64::try_from(payout).unwrap_or(0);
                    player.chips = player.chips.saturating_add(addition);
                    player.active_shield = false;
                    player.active_double = false;

                    let final_chips = player.chips;
                    self.insert(Key::CasinoPlayer(public.clone()), Value::CasinoPlayer(player.clone()));
                    self.update_casino_leaderboard(public, &player).await;

                    events.push(Event::CasinoGameCompleted {
                        session_id,
                        player: public.clone(),
                        game_type: session.game_type,
                        payout,
                        final_chips,
                        was_shielded: false,
                        was_doubled,
                    });
                }
            }
            crate::casino::GameResult::Push => {
                session.is_complete = true;
                self.insert(Key::CasinoSession(session_id), Value::CasinoSession(session.clone()));

                if let Some(Value::CasinoPlayer(mut player)) =
                    self.get(&Key::CasinoPlayer(public.clone())).await
                {
                    // Return bet on push
                    player.chips = player.chips.saturating_add(session.bet);
                    player.active_shield = false;
                    player.active_double = false;

                    let final_chips = player.chips;
                    self.insert(Key::CasinoPlayer(public.clone()), Value::CasinoPlayer(player.clone()));

                    // Update leaderboard after push
                    self.update_casino_leaderboard(public, &player).await;

                    events.push(Event::CasinoGameCompleted {
                        session_id,
                        player: public.clone(),
                        game_type: session.game_type,
                        payout: session.bet as i64,
                        final_chips,
                        was_shielded: false,
                        was_doubled: false,
                    });
                }
            }
            crate::casino::GameResult::Loss => {
                session.is_complete = true;
                self.insert(Key::CasinoSession(session_id), Value::CasinoSession(session.clone()));

                if let Some(Value::CasinoPlayer(mut player)) =
                    self.get(&Key::CasinoPlayer(public.clone())).await
                {
                    let was_shielded = player.active_shield && player.shields > 0;
                    let payout = if was_shielded {
                        player.shields -= 1;
                        0 // Shield prevents loss
                    } else {
                        -(session.bet as i64)
                    };
                    player.active_shield = false;
                    player.active_double = false;

                    let final_chips = player.chips;
                    self.insert(Key::CasinoPlayer(public.clone()), Value::CasinoPlayer(player.clone()));

                    // Update leaderboard after loss
                    self.update_casino_leaderboard(public, &player).await;

                    events.push(Event::CasinoGameCompleted {
                        session_id,
                        player: public.clone(),
                        game_type: session.game_type,
                        payout,
                        final_chips,
                        was_shielded,
                        was_doubled: false,
                    });
                }
            }
            crate::casino::GameResult::LossWithExtraDeduction(extra) => {
                // Loss with additional deduction for mid-game bet increases
                // (e.g., Blackjack double-down, Casino War go-to-war)
                session.is_complete = true;
                self.insert(Key::CasinoSession(session_id), Value::CasinoSession(session.clone()));

                if let Some(Value::CasinoPlayer(mut player)) =
                    self.get(&Key::CasinoPlayer(public.clone())).await
                {
                    let was_shielded = player.active_shield && player.shields > 0;
                    let payout = if was_shielded {
                        player.shields -= 1;
                        0 // Shield prevents loss (but extra still deducted)
                    } else {
                        -(session.bet as i64)
                    };

                    // Deduct the extra amount that wasn't charged at StartGame
                    player.chips = player.chips.saturating_sub(extra);

                    player.active_shield = false;
                    player.active_double = false;

                    let final_chips = player.chips;
                    self.insert(Key::CasinoPlayer(public.clone()), Value::CasinoPlayer(player.clone()));

                    // Update leaderboard after loss with extra deduction
                    self.update_casino_leaderboard(public, &player).await;

                    events.push(Event::CasinoGameCompleted {
                        session_id,
                        player: public.clone(),
                        game_type: session.game_type,
                        payout: payout - (extra as i64), // Total loss includes extra
                        final_chips,
                        was_shielded,
                        was_doubled: false,
                    });
                }
            }
            crate::casino::GameResult::LossPreDeducted(total_loss) => {
                // Loss where chips were already deducted via ContinueWithUpdate
                // (e.g., Baccarat, Craps, Roulette, Sic Bo table games)
                // No additional chip deduction needed, just report the loss amount
                session.is_complete = true;
                self.insert(Key::CasinoSession(session_id), Value::CasinoSession(session.clone()));

                if let Some(Value::CasinoPlayer(mut player)) =
                    self.get(&Key::CasinoPlayer(public.clone())).await
                {
                    let was_shielded = player.active_shield && player.shields > 0;
                    let payout = if was_shielded {
                        // Shield prevents loss - refund the pre-deducted amount
                        player.shields -= 1;
                        player.chips = player.chips.saturating_add(total_loss);
                        0
                    } else {
                        -(total_loss as i64)
                    };

                    player.active_shield = false;
                    player.active_double = false;

                    let final_chips = player.chips;
                    self.insert(Key::CasinoPlayer(public.clone()), Value::CasinoPlayer(player.clone()));

                    // Update leaderboard after pre-deducted loss
                    self.update_casino_leaderboard(public, &player).await;

                    events.push(Event::CasinoGameCompleted {
                        session_id,
                        player: public.clone(),
                        game_type: session.game_type,
                        payout,
                        final_chips,
                        was_shielded,
                        was_doubled: false,
                    });
                }
            }
        }

        events
    }

    async fn handle_casino_toggle_shield(&mut self, public: &PublicKey) -> Vec<Event> {
        if let Some(Value::CasinoPlayer(mut player)) = self.get(&Key::CasinoPlayer(public.clone())).await {
            player.active_shield = !player.active_shield;
            self.insert(Key::CasinoPlayer(public.clone()), Value::CasinoPlayer(player));
        }
        vec![]
    }

    async fn handle_casino_toggle_double(&mut self, public: &PublicKey) -> Vec<Event> {
        if let Some(Value::CasinoPlayer(mut player)) = self.get(&Key::CasinoPlayer(public.clone())).await {
            player.active_double = !player.active_double;
            self.insert(Key::CasinoPlayer(public.clone()), Value::CasinoPlayer(player));
        }
        vec![]
    }

    async fn handle_casino_join_tournament(&mut self, public: &PublicKey, tournament_id: u64) -> Vec<Event> {
        // Verify player exists
        if self.get(&Key::CasinoPlayer(public.clone())).await.is_none() {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_PLAYER_NOT_FOUND,
                message: "Player not found".to_string(),
            }];
        }

        // Get or create tournament
        let mut tournament = match self.get(&Key::Tournament(tournament_id)).await {
            Some(Value::Tournament(t)) => t,
            _ => nullspace_types::casino::Tournament {
                id: tournament_id,
                phase: nullspace_types::casino::TournamentPhase::Registration,
                start_block: 0,
                start_time_ms: 0,
                end_time_ms: 0,
                players: Vec::new(),
                starting_chips: nullspace_types::casino::STARTING_CHIPS,
                starting_shields: nullspace_types::casino::STARTING_SHIELDS,
                starting_doubles: nullspace_types::casino::STARTING_DOUBLES,
            },
        };

        // Check if can join
        if !matches!(tournament.phase, nullspace_types::casino::TournamentPhase::Registration) {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_TOURNAMENT_NOT_REGISTERING,
                message: "Tournament is not in registration phase".to_string(),
            }];
        }

        // Add player (check not already joined)
        if !tournament.add_player(public.clone()) {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_ALREADY_IN_TOURNAMENT,
                message: "Already joined this tournament".to_string(),
            }];
        }
        self.insert(Key::Tournament(tournament_id), Value::Tournament(tournament));

        vec![Event::PlayerJoined {
            tournament_id,
            player: public.clone(),
        }]
    }

    async fn handle_casino_start_tournament(
        &mut self,
        public: &PublicKey,
        tournament_id: u64,
        start_time_ms: u64,
        end_time_ms: u64,
    ) -> Vec<Event> {
        // Always create a fresh tournament when starting
        // This allows restarting tournaments (e.g., after one ends)
        let mut tournament = nullspace_types::casino::Tournament {
            id: tournament_id,
            phase: nullspace_types::casino::TournamentPhase::Active, // Start directly in Active
            start_block: self.seed.view,
            start_time_ms,
            end_time_ms,
            players: Vec::new(),
            starting_chips: nullspace_types::casino::STARTING_CHIPS,
            starting_shields: nullspace_types::casino::STARTING_SHIELDS,
            starting_doubles: nullspace_types::casino::STARTING_DOUBLES,
        };

        // Add the starting player to the tournament
        tournament.players.push(public.clone());

        // Reset the starting player's chips/shields/doubles to starting values
        let mut events = Vec::new();
        if let Some(Value::CasinoPlayer(mut player)) = self.get(&Key::CasinoPlayer(public.clone())).await {
            player.chips = tournament.starting_chips;
            player.shields = tournament.starting_shields;
            player.doubles = tournament.starting_doubles;
            player.active_shield = false;
            player.active_double = false;
            player.active_session = None;
            player.aura_meter = 0;

            self.insert(Key::CasinoPlayer(public.clone()), Value::CasinoPlayer(player.clone()));

            // Update leaderboard for this player
            self.update_casino_leaderboard(public, &player).await;
        }

        self.insert(Key::Tournament(tournament_id), Value::Tournament(tournament.clone()));

        events.push(Event::TournamentStarted {
            id: tournament_id,
            start_block: self.seed.view,
        });

        events
    }

    async fn update_casino_leaderboard(&mut self, public: &PublicKey, player: &nullspace_types::casino::Player) {
        let mut leaderboard = match self.get(&Key::CasinoLeaderboard).await {
            Some(Value::CasinoLeaderboard(lb)) => lb,
            _ => nullspace_types::casino::CasinoLeaderboard::default(),
        };
        leaderboard.update(public.clone(), player.name.clone(), player.chips);
        self.insert(Key::CasinoLeaderboard, Value::CasinoLeaderboard(leaderboard));
    }
    pub async fn execute(
        &mut self,
        #[cfg(feature = "parallel")] pool: ThreadPool,
        transactions: Vec<Transaction>,
    ) -> (Vec<Output>, BTreeMap<PublicKey, u64>) {
        let mut processed_nonces = BTreeMap::new();
        let mut seed_ops = HashSet::new();
        let mut valid_transactions = Vec::new();

        for tx in transactions {
            if !self.prepare(&tx).await {
                continue;
            }
            processed_nonces.insert(tx.public.clone(), tx.nonce.saturating_add(1));
            let ops = self.extract(&tx).await;
            for op in ops {
                if let Task::Seed(_) = op {
                    seed_ops.insert(op);
                }
            }
            valid_transactions.push(tx);
        }

        // Verify seeds
        macro_rules! process_ops {
            ($iter:ident) => {{
                seed_ops
                    .$iter()
                    .map(|op| match op {
                        Task::Seed(ref seed) => {
                            if self.seed == *seed {
                                return (op, TaskResult::Seed(true));
                            }
                            let result = seed.verify(&self.namespace, &self.master);
                            (op, TaskResult::Seed(result))
                        }
                    })
                    .collect()
            }};
        }
        #[cfg(feature = "parallel")]
        let precomputations = pool.install(|| process_ops!(into_par_iter));
        #[cfg(not(feature = "parallel"))]
        let precomputations = process_ops!(into_iter);

        self.precomputations = precomputations;

        let mut events = Vec::new();
        for tx in valid_transactions {
            events.extend(self.apply(&tx).await.into_iter().map(Output::Event));
            events.push(Output::Transaction(tx));
        }

        (events, processed_nonces)
    }

    pub fn commit(self) -> Vec<(Key, Status)> {
        self.pending.into_iter().collect()
    }
}

impl<'a, S: State> State for Layer<'a, S> {
    async fn get(&self, key: &Key) -> Option<Value> {
        match self.pending.get(key) {
            Some(Status::Update(value)) => Some(value.clone()),
            Some(Status::Delete) => None,
            None => self.state.get(key).await,
        }
    }

    async fn insert(&mut self, key: Key, value: Value) {
        self.pending.insert(key, Status::Update(value));
    }

    async fn delete(&mut self, key: &Key) {
        self.pending.insert(key.clone(), Status::Delete);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::mocks::{create_account_keypair, create_network_keypair, create_seed};
    use commonware_runtime::deterministic::Runner;
    use commonware_runtime::Runner as _;

    const TEST_NAMESPACE: &[u8] = b"test-namespace";

    struct MockState {
        data: std::collections::HashMap<Key, Value>,
    }

    impl MockState {
        fn new() -> Self {
            Self {
                data: std::collections::HashMap::new(),
            }
        }
    }

    impl State for MockState {
        async fn get(&self, key: &Key) -> Option<Value> {
            self.data.get(key).cloned()
        }

        async fn insert(&mut self, key: Key, value: Value) {
            self.data.insert(key, value);
        }

        async fn delete(&mut self, key: &Key) {
            self.data.remove(key);
        }
    }

    #[test]
    fn test_nonce_validation() {
        let executor = Runner::default();
        executor.start(|_| async move {
            let state = MockState::new();
            let (network_secret, master_public) = create_network_keypair();
            let seed = create_seed(&network_secret, 1);
            let mut layer = Layer::new(&state, master_public, TEST_NAMESPACE, seed);

            let (signer, _) = create_account_keypair(1);

            // Wrong nonce should fail
            let tx = Transaction::sign(&signer, 1, Instruction::CasinoRegister {
                name: "test".to_string()
            });
            assert!(!layer.prepare(&tx).await);

            // Correct nonce should succeed
            let tx = Transaction::sign(&signer, 0, Instruction::CasinoRegister {
                name: "test".to_string()
            });
            assert!(layer.prepare(&tx).await);

            let _ = layer.commit();
        });
    }

    #[test]
    fn test_casino_register() {
        let executor = Runner::default();
        executor.start(|_| async move {
            let state = MockState::new();
            let (network_secret, master_public) = create_network_keypair();
            let seed = create_seed(&network_secret, 1);
            let mut layer = Layer::new(&state, master_public, TEST_NAMESPACE, seed);

            let (signer, public) = create_account_keypair(1);

            // Register player
            let tx = Transaction::sign(&signer, 0, Instruction::CasinoRegister {
                name: "Alice".to_string()
            });
            assert!(layer.prepare(&tx).await);
            let events = layer.apply(&tx).await;

            assert_eq!(events.len(), 1);
            if let Event::CasinoPlayerRegistered { player, name } = &events[0] {
                assert_eq!(player, &public);
                assert_eq!(name, "Alice");
            } else {
                panic!("Expected CasinoPlayerRegistered event");
            }

            // Verify player was created
            if let Some(Value::CasinoPlayer(player)) = layer.get(&Key::CasinoPlayer(public)).await {
                assert_eq!(player.name, "Alice");
                assert_eq!(player.chips, 1000); // Initial chips
            } else {
                panic!("Player not found");
            }

            let _ = layer.commit();
        });
    }
}
