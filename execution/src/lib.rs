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
use nullspace_types::{
    execution::{Account, Event, Instruction, Key, Output, Transaction, Value},
    Seed,
};
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

// Keep a small amount of LP tokens permanently locked so the pool can never be fully drained.
// This mirrors the MINIMUM_LIQUIDITY pattern used by Raydium/Uniswap to avoid zero-price states.
const MINIMUM_LIQUIDITY: u64 = 1_000;

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
    fn integer_sqrt(value: u128) -> u64 {
        if value == 0 {
            return 0;
        }
        let mut x = value;
        let mut y = (x + 1) >> 1;
        while y < x {
            x = y;
            y = (x + value / x) >> 1;
        }
        x as u64
    }

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
                self.handle_casino_deposit(&transaction.public, *amount)
                    .await
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
            Instruction::CasinoStartTournament {
                tournament_id,
                start_time_ms,
                end_time_ms,
            } => {
                self.handle_casino_start_tournament(
                    &transaction.public,
                    *tournament_id,
                    *start_time_ms,
                    *end_time_ms,
                )
                .await
            }
            Instruction::CasinoEndTournament { tournament_id } => {
                self.handle_casino_end_tournament(&transaction.public, *tournament_id)
                    .await
            }
            // Staking
            Instruction::Stake { amount, duration } => {
                self.handle_stake(&transaction.public, *amount, *duration)
                    .await
            }
            Instruction::Unstake => self.handle_unstake(&transaction.public).await,
            Instruction::ClaimRewards => self.handle_claim_rewards(&transaction.public).await,
            Instruction::ProcessEpoch => self.handle_process_epoch(&transaction.public).await,

            // Vaults
            Instruction::CreateVault => self.handle_create_vault(&transaction.public).await,
            Instruction::DepositCollateral { amount } => {
                self.handle_deposit_collateral(&transaction.public, *amount)
                    .await
            }
            Instruction::BorrowUSDT { amount } => {
                self.handle_borrow_usdt(&transaction.public, *amount).await
            }
            Instruction::RepayUSDT { amount } => {
                self.handle_repay_usdt(&transaction.public, *amount).await
            }

            // AMM
            Instruction::Swap {
                amount_in,
                min_amount_out,
                is_buying_rng,
            } => {
                self.handle_swap(
                    &transaction.public,
                    *amount_in,
                    *min_amount_out,
                    *is_buying_rng,
                )
                .await
            }
            Instruction::AddLiquidity {
                rng_amount,
                usdt_amount,
            } => {
                self.handle_add_liquidity(&transaction.public, *rng_amount, *usdt_amount)
                    .await
            }
            Instruction::RemoveLiquidity { shares } => {
                self.handle_remove_liquidity(&transaction.public, *shares)
                    .await
            }
        }
    }

    async fn get_or_init_house(&mut self) -> nullspace_types::casino::HouseState {
        match self.get(&Key::House).await {
            Some(Value::House(h)) => h,
            _ => nullspace_types::casino::HouseState::new(self.seed.view),
        }
    }

    async fn get_or_init_amm(&mut self) -> nullspace_types::casino::AmmPool {
        match self.get(&Key::AmmPool).await {
            Some(Value::AmmPool(p)) => p,
            _ => nullspace_types::casino::AmmPool::new(30), // 0.3% fee
        }
    }

    async fn get_lp_balance(&self, public: &PublicKey) -> u64 {
        match self.get(&Key::LpBalance(public.clone())).await {
            Some(Value::LpBalance(bal)) => bal,
            _ => 0,
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
        let player =
            nullspace_types::casino::Player::new_with_block(name.to_string(), self.seed.view);

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

    async fn handle_casino_deposit(&mut self, public: &PublicKey, amount: u64) -> Vec<Event> {
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
        let is_rate_limited = player.last_deposit_block != 0
            && player.last_deposit_block + nullspace_types::casino::FAUCET_RATE_LIMIT
                > current_block;
        if is_rate_limited {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_RATE_LIMITED,
                message: "Faucet rate limited, try again later".to_string(),
            }];
        }

        // Grant faucet chips
        player.chips = player.chips.saturating_add(amount);
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

        // Update House PnL (Income)
        self.update_house_pnl(bet as i128).await;

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
        self.insert(
            Key::CasinoSession(session_id),
            Value::CasinoSession(session.clone()),
        );

        let mut events = vec![Event::CasinoGameStarted {
            session_id,
            player: public.clone(),
            game_type,
            bet,
            initial_state,
        }];

        // Handle immediate result (e.g. Natural Blackjack)
        if !matches!(result, crate::casino::GameResult::Continue) {
            if let Some(Value::CasinoPlayer(mut player)) =
                self.get(&Key::CasinoPlayer(public.clone())).await
            {
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

                        // Update House PnL (Payout)
                        self.update_house_pnl(-(payout as i128)).await;

                        let final_chips = player.chips;
                        self.insert(
                            Key::CasinoPlayer(public.clone()),
                            Value::CasinoPlayer(player.clone()),
                        );
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
                        self.insert(
                            Key::CasinoPlayer(public.clone()),
                            Value::CasinoPlayer(player.clone()),
                        );

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
                        self.insert(
                            Key::CasinoPlayer(public.clone()),
                            Value::CasinoPlayer(player.clone()),
                        );

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
                self.insert(
                    Key::CasinoSession(session_id),
                    Value::CasinoSession(session),
                );
            }
            crate::casino::GameResult::ContinueWithUpdate { payout } => {
                // Update House PnL
                self.update_house_pnl(-(payout as i128)).await;

                // Handle mid-game balance updates (additional bets or intermediate payouts)
                if let Some(Value::CasinoPlayer(mut player)) =
                    self.get(&Key::CasinoPlayer(public.clone())).await
                {
                    if payout < 0 {
                        // Deducting chips (new bet placed)
                        // Use checked_neg to safely convert negative i64 to positive value
                        let deduction = payout
                            .checked_neg()
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
                    self.insert(
                        Key::CasinoPlayer(public.clone()),
                        Value::CasinoPlayer(player.clone()),
                    );

                    // Update leaderboard after mid-game balance change
                    self.update_casino_leaderboard(public, &player).await;
                }
                self.insert(
                    Key::CasinoSession(session_id),
                    Value::CasinoSession(session),
                );
            }
            crate::casino::GameResult::Win(base_payout) => {
                session.is_complete = true;
                self.insert(
                    Key::CasinoSession(session_id),
                    Value::CasinoSession(session.clone()),
                );

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
                    self.insert(
                        Key::CasinoPlayer(public.clone()),
                        Value::CasinoPlayer(player.clone()),
                    );
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
                self.insert(
                    Key::CasinoSession(session_id),
                    Value::CasinoSession(session.clone()),
                );

                if let Some(Value::CasinoPlayer(mut player)) =
                    self.get(&Key::CasinoPlayer(public.clone())).await
                {
                    // Return bet on push
                    player.chips = player.chips.saturating_add(session.bet);
                    player.active_shield = false;
                    player.active_double = false;

                    // Update House PnL (Refund)
                    self.update_house_pnl(-(session.bet as i128)).await;

                    let final_chips = player.chips;
                    self.insert(
                        Key::CasinoPlayer(public.clone()),
                        Value::CasinoPlayer(player.clone()),
                    );

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
                self.insert(
                    Key::CasinoSession(session_id),
                    Value::CasinoSession(session.clone()),
                );

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
                    self.insert(
                        Key::CasinoPlayer(public.clone()),
                        Value::CasinoPlayer(player.clone()),
                    );

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
                self.insert(
                    Key::CasinoSession(session_id),
                    Value::CasinoSession(session.clone()),
                );

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

                    // Update House PnL (Extra gain)
                    // Note: Shield does NOT prevent this extra deduction in current logic
                    self.update_house_pnl(extra as i128).await;

                    player.active_shield = false;
                    player.active_double = false;

                    let final_chips = player.chips;
                    self.insert(
                        Key::CasinoPlayer(public.clone()),
                        Value::CasinoPlayer(player.clone()),
                    );

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
                self.insert(
                    Key::CasinoSession(session_id),
                    Value::CasinoSession(session.clone()),
                );

                if let Some(Value::CasinoPlayer(mut player)) =
                    self.get(&Key::CasinoPlayer(public.clone())).await
                {
                    let was_shielded = player.active_shield && player.shields > 0;
                    let payout = if was_shielded {
                        // Shield prevents loss - refund the pre-deducted amount
                        player.shields -= 1;
                        player.chips = player.chips.saturating_add(total_loss);

                        // Update House PnL (Refund)
                        self.update_house_pnl(-(total_loss as i128)).await;

                        0
                    } else {
                        -(total_loss as i64)
                    };

                    player.active_shield = false;
                    player.active_double = false;

                    let final_chips = player.chips;
                    self.insert(
                        Key::CasinoPlayer(public.clone()),
                        Value::CasinoPlayer(player.clone()),
                    );

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
        if let Some(Value::CasinoPlayer(mut player)) =
            self.get(&Key::CasinoPlayer(public.clone())).await
        {
            player.active_shield = !player.active_shield;
            self.insert(
                Key::CasinoPlayer(public.clone()),
                Value::CasinoPlayer(player),
            );
        }
        vec![]
    }

    async fn handle_casino_toggle_double(&mut self, public: &PublicKey) -> Vec<Event> {
        if let Some(Value::CasinoPlayer(mut player)) =
            self.get(&Key::CasinoPlayer(public.clone())).await
        {
            player.active_double = !player.active_double;
            self.insert(
                Key::CasinoPlayer(public.clone()),
                Value::CasinoPlayer(player),
            );
        }
        vec![]
    }

    async fn handle_casino_join_tournament(
        &mut self,
        public: &PublicKey,
        tournament_id: u64,
    ) -> Vec<Event> {
        // Verify player exists
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

        // Check tournament limit (5 per day)
        // Approximate time from view (3s per block)
        let current_time_sec = self.seed.view * 3;
        let current_day = current_time_sec / 86400;
        let last_played_day = player.last_tournament_ts / 86400;

        if current_day > last_played_day {
            player.tournaments_played_today = 0;
        }

        if player.tournaments_played_today >= 5 {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_TOURNAMENT_LIMIT_REACHED,
                message: "Daily tournament limit reached (5/5)".to_string(),
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
                prize_pool: 0,
                starting_chips: nullspace_types::casino::STARTING_CHIPS,
                starting_shields: nullspace_types::casino::STARTING_SHIELDS,
                starting_doubles: nullspace_types::casino::STARTING_DOUBLES,
            },
        };

        // Check if can join
        if !matches!(
            tournament.phase,
            nullspace_types::casino::TournamentPhase::Registration
        ) {
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

        // Update player tracking
        player.tournaments_played_today += 1;
        player.last_tournament_ts = current_time_sec;

        self.insert(
            Key::CasinoPlayer(public.clone()),
            Value::CasinoPlayer(player),
        );
        self.insert(
            Key::Tournament(tournament_id),
            Value::Tournament(tournament),
        );

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
        let mut tournament = match self.get(&Key::Tournament(tournament_id)).await {
            Some(Value::Tournament(t)) => t,
            None => {
                // Create new if doesn't exist (single player start)
                let mut t = nullspace_types::casino::Tournament {
                    id: tournament_id,
                    phase: nullspace_types::casino::TournamentPhase::Active,
                    start_block: self.seed.view,
                    start_time_ms,
                    end_time_ms,
                    players: Vec::new(),
                    prize_pool: 0,
                    starting_chips: nullspace_types::casino::STARTING_CHIPS,
                    starting_shields: nullspace_types::casino::STARTING_SHIELDS,
                    starting_doubles: nullspace_types::casino::STARTING_DOUBLES,
                };
                t.add_player(public.clone());
                t
            }
            _ => panic!("Storage corruption: Key::Tournament returned non-Tournament value"),
        };

        // Calculate Prize Pool (Inflationary)
        let total_supply = nullspace_types::casino::TOTAL_SUPPLY as u128;
        let annual_bps = nullspace_types::casino::ANNUAL_EMISSION_RATE_BPS as u128;
        let tournaments_per_day = nullspace_types::casino::TOURNAMENTS_PER_DAY as u128;

        let annual_emission = total_supply * annual_bps / 10000;
        let daily_emission = annual_emission / 365;
        let prize_pool = (daily_emission / tournaments_per_day) as u64;

        // Track Issuance in House
        let mut house = self.get_or_init_house().await;
        house.total_issuance += prize_pool;
        self.insert(Key::House, Value::House(house));

        // Update state
        tournament.phase = nullspace_types::casino::TournamentPhase::Active;
        tournament.start_block = self.seed.view;
        tournament.start_time_ms = start_time_ms;
        tournament.end_time_ms = end_time_ms;
        tournament.prize_pool = prize_pool;

        // Reset chips for all players
        for player_pk in &tournament.players {
            if let Some(Value::CasinoPlayer(mut player)) =
                self.get(&Key::CasinoPlayer(player_pk.clone())).await
            {
                player.chips = tournament.starting_chips;
                player.shields = tournament.starting_shields;
                player.doubles = tournament.starting_doubles;
                player.active_shield = false;
                player.active_double = false;
                player.active_session = None;
                player.aura_meter = 0;

                self.insert(
                    Key::CasinoPlayer(player_pk.clone()),
                    Value::CasinoPlayer(player.clone()),
                );
                self.update_casino_leaderboard(player_pk, &player).await;
            }
        }

        self.insert(
            Key::Tournament(tournament_id),
            Value::Tournament(tournament.clone()),
        );

        vec![Event::TournamentStarted {
            id: tournament_id,
            start_block: self.seed.view,
        }]
    }

    async fn handle_casino_end_tournament(
        &mut self,
        _public: &PublicKey,
        tournament_id: u64,
    ) -> Vec<Event> {
        let mut tournament =
            if let Some(Value::Tournament(t)) = self.get(&Key::Tournament(tournament_id)).await {
                t
            } else {
                return vec![];
            };

        if !matches!(
            tournament.phase,
            nullspace_types::casino::TournamentPhase::Active
        ) {
            return vec![];
        }

        // Gather player chips
        let mut rankings: Vec<(PublicKey, u64)> = Vec::new();
        for player_pk in &tournament.players {
            if let Some(Value::CasinoPlayer(p)) =
                self.get(&Key::CasinoPlayer(player_pk.clone())).await
            {
                rankings.push((player_pk.clone(), p.chips));
            }
        }

        // Sort descending
        rankings.sort_by(|a, b| b.1.cmp(&a.1));

        // Determine winners (Top 15% for MTT style)
        let num_players = rankings.len();
        let num_winners = (num_players as f64 * 0.15).ceil() as usize;
        let num_winners = num_winners.max(1).min(num_players);

        // Calculate payout weights (1/rank harmonic distribution)
        let mut weights = Vec::with_capacity(num_winners);
        let mut total_weight = 0.0;
        for i in 1..=num_winners {
            let w = 1.0 / (i as f64);
            weights.push(w);
            total_weight += w;
        }

        // Distribute Prize Pool
        if total_weight > 0.0 && tournament.prize_pool > 0 {
            for i in 0..num_winners {
                let (pk, _) = &rankings[i];
                let weight = weights[i];
                let share = weight / total_weight;
                let payout = (share * tournament.prize_pool as f64) as u64;

                if payout > 0 {
                    if let Some(Value::CasinoPlayer(mut p)) =
                        self.get(&Key::CasinoPlayer(pk.clone())).await
                    {
                        p.chips += payout;
                        self.insert(Key::CasinoPlayer(pk.clone()), Value::CasinoPlayer(p));
                    }
                }
            }
        }

        tournament.phase = nullspace_types::casino::TournamentPhase::Complete;
        self.insert(
            Key::Tournament(tournament_id),
            Value::Tournament(tournament),
        );

        vec![Event::TournamentEnded {
            id: tournament_id,
            rankings,
        }]
    }

    async fn update_casino_leaderboard(
        &mut self,
        public: &PublicKey,
        player: &nullspace_types::casino::Player,
    ) {
        let mut leaderboard = match self.get(&Key::CasinoLeaderboard).await {
            Some(Value::CasinoLeaderboard(lb)) => lb,
            _ => nullspace_types::casino::CasinoLeaderboard::default(),
        };
        leaderboard.update(public.clone(), player.name.clone(), player.chips);
        self.insert(
            Key::CasinoLeaderboard,
            Value::CasinoLeaderboard(leaderboard),
        );
    }

    async fn update_house_pnl(&mut self, amount: i128) {
        let mut house = self.get_or_init_house().await;
        house.net_pnl += amount;
        self.insert(Key::House, Value::House(house));
    }

    // === Staking Handlers ===

    async fn handle_stake(&mut self, public: &PublicKey, amount: u64, duration: u64) -> Vec<Event> {
        let mut player = match self.get(&Key::CasinoPlayer(public.clone())).await {
            Some(Value::CasinoPlayer(p)) => p,
            _ => return vec![], // Error handled by checking balance
        };

        if player.chips < amount {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INSUFFICIENT_FUNDS,
                message: "Insufficient chips to stake".to_string(),
            }];
        }

        // Min duration 1 week (approx 201600 blocks @ 3s), Max 4 years
        const MIN_DURATION: u64 = 1; // Simplified for dev
        if duration < MIN_DURATION {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INVALID_BET, // Reuse code
                message: "Duration too short".to_string(),
            }];
        }

        // Deduct chips
        player.chips -= amount;
        self.insert(
            Key::CasinoPlayer(public.clone()),
            Value::CasinoPlayer(player),
        );

        // Create/Update Staker
        let mut staker = match self.get(&Key::Staker(public.clone())).await {
            Some(Value::Staker(s)) => s,
            _ => nullspace_types::casino::Staker::default(),
        };

        // Calculate Voting Power: Amount * Duration
        // If adding to existing stake, we weight-average or just add?
        // Simple model: New stake resets lockup to max(old_unlock, new_unlock)
        let current_block = self.seed.view;
        let new_unlock = current_block + duration;

        // If extending, new VP is total amount * new duration remaining
        staker.balance += amount;
        staker.unlock_ts = new_unlock;
        staker.voting_power = (staker.balance as u128) * (duration as u128);

        self.insert(Key::Staker(public.clone()), Value::Staker(staker.clone()));

        // Update House Total VP
        let mut house = self.get_or_init_house().await;
        house.total_staked_amount += amount;
        house.total_voting_power += (amount as u128) * (duration as u128); // Approximation for new stake
        self.insert(Key::House, Value::House(house));

        vec![] // Staked event?
    }

    async fn handle_unstake(&mut self, public: &PublicKey) -> Vec<Event> {
        let mut staker = match self.get(&Key::Staker(public.clone())).await {
            Some(Value::Staker(s)) => s,
            _ => return vec![],
        };

        if self.seed.view < staker.unlock_ts {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INVALID_MOVE,
                message: "Stake still locked".to_string(),
            }];
        }

        if staker.balance == 0 {
            return vec![];
        }

        // Return chips
        if let Some(Value::CasinoPlayer(mut player)) =
            self.get(&Key::CasinoPlayer(public.clone())).await
        {
            player.chips += staker.balance;
            self.insert(
                Key::CasinoPlayer(public.clone()),
                Value::CasinoPlayer(player),
            );
        }

        // Update House
        let mut house = self.get_or_init_house().await;
        house.total_staked_amount = house.total_staked_amount.saturating_sub(staker.balance);
        house.total_voting_power = house.total_voting_power.saturating_sub(staker.voting_power);
        self.insert(Key::House, Value::House(house));

        // Clear Staker
        staker.balance = 0;
        staker.voting_power = 0;
        self.insert(Key::Staker(public.clone()), Value::Staker(staker));

        vec![]
    }

    async fn handle_claim_rewards(&mut self, _public: &PublicKey) -> Vec<Event> {
        // Placeholder for distribution logic
        // In this MVP, rewards are auto-compounded or we just skip this for now
        vec![]
    }

    async fn handle_process_epoch(&mut self, _public: &PublicKey) -> Vec<Event> {
        let mut house = self.get_or_init_house().await;

        // 1 Week Epoch (approx)
        const EPOCH_LENGTH: u64 = 100; // Short for testing

        if self.seed.view >= house.epoch_start_ts + EPOCH_LENGTH {
            // End Epoch

            // If Net PnL > 0, Surplus!
            if house.net_pnl > 0 {
                // In a real system, we'd snapshot this into a "RewardPool"
                // For now, we just reset PnL and log it (via debug/warn or event)
                // warn!("Epoch Surplus: {}", house.net_pnl);
            } else {
                // Deficit. Minting happened. Inflation.
                // warn!("Epoch Deficit: {}", house.net_pnl);
            }

            house.current_epoch += 1;
            house.epoch_start_ts = self.seed.view;
            house.net_pnl = 0; // Reset for next week

            self.insert(Key::House, Value::House(house));
        }

        vec![]
    }

    // === Liquidity / Vault Handlers ===

    async fn handle_create_vault(&mut self, public: &PublicKey) -> Vec<Event> {
        if self.get(&Key::Vault(public.clone())).await.is_some() {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INVALID_MOVE, // Reuse
                message: "Vault already exists".to_string(),
            }];
        }

        let vault = nullspace_types::casino::Vault::default();
        self.insert(Key::Vault(public.clone()), Value::Vault(vault));
        vec![]
    }

    async fn handle_deposit_collateral(&mut self, public: &PublicKey, amount: u64) -> Vec<Event> {
        let mut player = match self.get(&Key::CasinoPlayer(public.clone())).await {
            Some(Value::CasinoPlayer(p)) => p,
            _ => return vec![],
        };

        if player.chips < amount {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INSUFFICIENT_FUNDS,
                message: "Insufficient chips".to_string(),
            }];
        }

        let mut vault = match self.get(&Key::Vault(public.clone())).await {
            Some(Value::Vault(v)) => v,
            _ => {
                return vec![Event::CasinoError {
                    player: public.clone(),
                    session_id: None,
                    error_code: nullspace_types::casino::ERROR_INVALID_MOVE,
                    message: "Vault not found".to_string(),
                }]
            }
        };

        player.chips -= amount;
        vault.collateral_rng += amount;

        self.insert(
            Key::CasinoPlayer(public.clone()),
            Value::CasinoPlayer(player),
        );
        self.insert(Key::Vault(public.clone()), Value::Vault(vault));

        vec![]
    }

    async fn handle_borrow_usdt(&mut self, public: &PublicKey, amount: u64) -> Vec<Event> {
        let mut vault = match self.get(&Key::Vault(public.clone())).await {
            Some(Value::Vault(v)) => v,
            _ => return vec![],
        };

        // Determine Price (RNG price in vUSDT)
        let amm = self.get_or_init_amm().await;
        let price_numerator = if amm.reserve_rng > 0 {
            amm.reserve_vusdt as u128
        } else {
            1 // Bootstrap price: 1 RNG = 1 vUSDT
        };
        let price_denominator = if amm.reserve_rng > 0 {
            amm.reserve_rng as u128
        } else {
            1
        };

        // LTV Calculation: Max Debt = (Collateral * Price) * 50%
        // Debt <= (Collateral * P_num / P_den) / 2
        // 2 * Debt * P_den <= Collateral * P_num
        let new_debt = vault.debt_vusdt + amount;

        let lhs = 2 * (new_debt as u128) * price_denominator;
        let rhs = (vault.collateral_rng as u128) * price_numerator;

        if lhs > rhs {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INVALID_MOVE,
                message: "Insufficient collateral (Max 50% LTV)".to_string(),
            }];
        }

        // Update Vault
        vault.debt_vusdt = new_debt;
        self.insert(Key::Vault(public.clone()), Value::Vault(vault));

        // Mint vUSDT to Player
        if let Some(Value::CasinoPlayer(mut player)) =
            self.get(&Key::CasinoPlayer(public.clone())).await
        {
            player.vusdt_balance += amount;
            self.insert(
                Key::CasinoPlayer(public.clone()),
                Value::CasinoPlayer(player),
            );
        }

        vec![]
    }

    async fn handle_repay_usdt(&mut self, public: &PublicKey, amount: u64) -> Vec<Event> {
        let mut player = match self.get(&Key::CasinoPlayer(public.clone())).await {
            Some(Value::CasinoPlayer(p)) => p,
            _ => return vec![],
        };

        let mut vault = match self.get(&Key::Vault(public.clone())).await {
            Some(Value::Vault(v)) => v,
            _ => return vec![],
        };

        if player.vusdt_balance < amount {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INSUFFICIENT_FUNDS,
                message: "Insufficient vUSDT".to_string(),
            }];
        }

        let actual_repay = amount.min(vault.debt_vusdt);

        player.vusdt_balance -= actual_repay;
        vault.debt_vusdt -= actual_repay;

        self.insert(
            Key::CasinoPlayer(public.clone()),
            Value::CasinoPlayer(player),
        );
        self.insert(Key::Vault(public.clone()), Value::Vault(vault));

        vec![]
    }

    async fn handle_swap(
        &mut self,
        public: &PublicKey,
        mut amount_in: u64,
        min_amount_out: u64,
        is_buying_rng: bool,
    ) -> Vec<Event> {
        let mut amm = self.get_or_init_amm().await;
        let mut player = match self.get(&Key::CasinoPlayer(public.clone())).await {
            Some(Value::CasinoPlayer(p)) => p,
            _ => return vec![],
        };

        if amount_in == 0 {
            return vec![];
        }

        if amm.reserve_rng == 0 || amm.reserve_vusdt == 0 {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INVALID_MOVE,
                message: "AMM has zero liquidity".to_string(),
            }];
        }

        // Apply Sell Tax (if Selling RNG)
        let mut burned_amount = 0;
        if !is_buying_rng {
            // Sell Tax: 5% (default)
            burned_amount = (amount_in as u128 * amm.sell_tax_basis_points as u128 / 10000) as u64;
            if burned_amount > 0 {
                // Deduct tax from input amount
                amount_in = amount_in.saturating_sub(burned_amount);

                // Track burned amount in House
                let mut house = self.get_or_init_house().await;
                house.total_burned += burned_amount;
                self.insert(Key::House, Value::House(house));
            }
        }

        // Reserves (u128 for safety)
        let (reserve_in, reserve_out) = if is_buying_rng {
            (amm.reserve_vusdt as u128, amm.reserve_rng as u128)
        } else {
            (amm.reserve_rng as u128, amm.reserve_vusdt as u128)
        };

        // Fee (30 bps = 0.3%)
        let fee_bps = amm.fee_basis_points as u128;
        let fee_amount = ((amount_in as u128) * fee_bps) / 10_000;
        let net_in = (amount_in as u128).saturating_sub(fee_amount);
        let amount_in_with_fee = net_in * 10_000;
        let numerator = amount_in_with_fee.saturating_mul(reserve_out);
        let denominator = reserve_in
            .saturating_mul(10_000)
            .saturating_add(amount_in_with_fee);
        if denominator == 0 {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INVALID_MOVE,
                message: "Invalid AMM state".to_string(),
            }];
        }
        let amount_out = (numerator / denominator) as u64;

        if amount_out < min_amount_out {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INVALID_MOVE, // Slippage
                message: "Slippage limit exceeded".to_string(),
            }];
        }

        // Execute Swap
        if is_buying_rng {
            // Player gives vUSDT, gets RNG
            if player.vusdt_balance < amount_in {
                return vec![Event::CasinoError {
                    player: public.clone(),
                    session_id: None,
                    error_code: nullspace_types::casino::ERROR_INSUFFICIENT_FUNDS,
                    message: "Insufficient vUSDT".to_string(),
                }];
            }
            player.vusdt_balance -= amount_in;
            player.chips = player.chips.saturating_add(amount_out);

            amm.reserve_vusdt = amm.reserve_vusdt.saturating_add(amount_in);
            amm.reserve_rng = amm.reserve_rng.saturating_sub(amount_out);
        } else {
            // Player gives RNG, gets vUSDT
            // Note: We deduct the FULL amount (incl tax) from player
            let total_deduction = amount_in + burned_amount;
            if player.chips < total_deduction {
                return vec![Event::CasinoError {
                    player: public.clone(),
                    session_id: None,
                    error_code: nullspace_types::casino::ERROR_INSUFFICIENT_FUNDS,
                    message: "Insufficient RNG".to_string(),
                }];
            }

            player.chips = player.chips.saturating_sub(total_deduction);
            player.vusdt_balance = player.vusdt_balance.saturating_add(amount_out);

            amm.reserve_rng = amm.reserve_rng.saturating_add(amount_in); // Add net amount (after tax) to reserves
            amm.reserve_vusdt = amm.reserve_vusdt.saturating_sub(amount_out);
        }

        // Book fee to House
        if fee_amount > 0 {
            let mut house = self.get_or_init_house().await;
            house.accumulated_fees = house.accumulated_fees.saturating_add(fee_amount as u64);
            self.insert(Key::House, Value::House(house));
        }

        self.insert(
            Key::CasinoPlayer(public.clone()),
            Value::CasinoPlayer(player),
        );
        self.insert(Key::AmmPool, Value::AmmPool(amm));

        vec![]
    }

    async fn handle_add_liquidity(
        &mut self,
        public: &PublicKey,
        rng_amount: u64,
        usdt_amount: u64,
    ) -> Vec<Event> {
        let mut amm = self.get_or_init_amm().await;
        let mut player = match self.get(&Key::CasinoPlayer(public.clone())).await {
            Some(Value::CasinoPlayer(p)) => p,
            _ => return vec![],
        };

        if rng_amount == 0 || usdt_amount == 0 {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INVALID_MOVE,
                message: "Zero liquidity not allowed".to_string(),
            }];
        }

        if player.chips < rng_amount || player.vusdt_balance < usdt_amount {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INSUFFICIENT_FUNDS,
                message: "Insufficient funds".to_string(),
            }];
        }

        let lp_balance = self.get_lp_balance(public).await;

        // Initial liquidity?
        let mut shares_minted = if amm.total_shares == 0 {
            // Sqrt(x*y)
            let val = (rng_amount as u128) * (usdt_amount as u128);
            Self::integer_sqrt(val)
        } else {
            // Proportional to current reserves
            if amm.reserve_rng == 0 || amm.reserve_vusdt == 0 {
                return vec![Event::CasinoError {
                    player: public.clone(),
                    session_id: None,
                    error_code: nullspace_types::casino::ERROR_INVALID_MOVE,
                    message: "AMM has zero liquidity".to_string(),
                }];
            }
            let share_a = (rng_amount as u128 * amm.total_shares as u128) / amm.reserve_rng as u128;
            let share_b =
                (usdt_amount as u128 * amm.total_shares as u128) / amm.reserve_vusdt as u128;
            share_a.min(share_b) as u64
        };

        // Lock a minimum amount of LP shares on first deposit so reserves can never be fully drained.
        if amm.total_shares == 0 {
            if shares_minted <= MINIMUM_LIQUIDITY {
                return vec![Event::CasinoError {
                    player: public.clone(),
                    session_id: None,
                    error_code: nullspace_types::casino::ERROR_INVALID_MOVE,
                    message: "Initial liquidity too small".to_string(),
                }];
            }
            amm.total_shares = amm.total_shares.saturating_add(MINIMUM_LIQUIDITY);
            shares_minted = shares_minted.saturating_sub(MINIMUM_LIQUIDITY);
        }

        if shares_minted == 0 {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INVALID_MOVE,
                message: "Deposit too small".to_string(),
            }];
        }

        player.chips = player.chips.saturating_sub(rng_amount);
        player.vusdt_balance = player.vusdt_balance.saturating_sub(usdt_amount);

        amm.reserve_rng = amm.reserve_rng.saturating_add(rng_amount);
        amm.reserve_vusdt = amm.reserve_vusdt.saturating_add(usdt_amount);
        amm.total_shares = amm.total_shares.saturating_add(shares_minted);

        let new_lp_balance = lp_balance.saturating_add(shares_minted);

        self.insert(
            Key::CasinoPlayer(public.clone()),
            Value::CasinoPlayer(player),
        );
        self.insert(Key::AmmPool, Value::AmmPool(amm));
        self.insert(
            Key::LpBalance(public.clone()),
            Value::LpBalance(new_lp_balance),
        );

        vec![]
    }

    async fn handle_remove_liquidity(&mut self, public: &PublicKey, shares: u64) -> Vec<Event> {
        if shares == 0 {
            return vec![];
        }

        let mut amm = self.get_or_init_amm().await;
        if amm.total_shares == 0 || shares > amm.total_shares {
            return vec![];
        }

        let lp_balance = self.get_lp_balance(public).await;
        if shares > lp_balance {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INSUFFICIENT_FUNDS,
                message: "Not enough LP shares".to_string(),
            }];
        }

        let mut player = match self.get(&Key::CasinoPlayer(public.clone())).await {
            Some(Value::CasinoPlayer(p)) => p,
            _ => return vec![],
        };

        // Calculate amounts out proportionally
        let amount_rng =
            ((shares as u128 * amm.reserve_rng as u128) / amm.total_shares as u128) as u64;
        let amount_vusd =
            ((shares as u128 * amm.reserve_vusdt as u128) / amm.total_shares as u128) as u64;

        amm.reserve_rng = amm.reserve_rng.saturating_sub(amount_rng);
        amm.reserve_vusdt = amm.reserve_vusdt.saturating_sub(amount_vusd);
        amm.total_shares = amm.total_shares.saturating_sub(shares);

        player.chips = player.chips.saturating_add(amount_rng);
        player.vusdt_balance = player.vusdt_balance.saturating_add(amount_vusd);

        let new_lp_balance = lp_balance.saturating_sub(shares);

        self.insert(
            Key::CasinoPlayer(public.clone()),
            Value::CasinoPlayer(player),
        );
        self.insert(Key::AmmPool, Value::AmmPool(amm));
        self.insert(
            Key::LpBalance(public.clone()),
            Value::LpBalance(new_lp_balance),
        );

        vec![]
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
            let tx = Transaction::sign(
                &signer,
                1,
                Instruction::CasinoRegister {
                    name: "test".to_string(),
                },
            );
            assert!(!layer.prepare(&tx).await);

            // Correct nonce should succeed
            let tx = Transaction::sign(
                &signer,
                0,
                Instruction::CasinoRegister {
                    name: "test".to_string(),
                },
            );
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
            let tx = Transaction::sign(
                &signer,
                0,
                Instruction::CasinoRegister {
                    name: "Alice".to_string(),
                },
            );
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
