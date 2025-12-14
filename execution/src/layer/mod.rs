use commonware_consensus::threshold_simplex::types::View;
use commonware_cryptography::{
    bls12381::primitives::variant::{MinSig, Variant},
    ed25519::PublicKey,
};
#[cfg(feature = "parallel")]
use commonware_runtime::ThreadPool;
use nullspace_types::{
    execution::{Event, Instruction, Key, Output, Transaction, Value},
    Seed,
};
use std::collections::BTreeMap;

use crate::state::{load_account, validate_and_increment_nonce, PrepareError, State, Status};

mod handlers;

// Keep a small amount of LP tokens permanently locked so the pool can never be fully drained.
// This mirrors the MINIMUM_LIQUIDITY pattern used by Raydium/Uniswap to avoid zero-price states.
const MINIMUM_LIQUIDITY: u64 = 1_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UthJackpotTier {
    None,
    StraightFlush,
    RoyalFlush,
}

fn parse_u64_be_at(bytes: &[u8], offset: usize) -> Option<u64> {
    let slice = bytes.get(offset..offset + 8)?;
    let buf: [u8; 8] = slice.try_into().ok()?;
    Some(u64::from_be_bytes(buf))
}

fn parse_three_card_progressive_state(state_blob: &[u8]) -> Option<(u64, [u8; 3])> {
    // v3:
    // [version:u8=3] [stage:u8] [player:3] [dealer:3] [pairplus:u64] [six_card:u64] [progressive:u64]
    //
    // v1/v2 have the same leading bytes for player cards but no progressive bet field.
    if state_blob.len() < 5 {
        return None;
    }

    let version = state_blob[0];
    let player = [state_blob[2], state_blob[3], state_blob[4]];
    let progressive_bet = if version >= 3 {
        parse_u64_be_at(state_blob, 24).unwrap_or(0)
    } else {
        0
    };

    Some((progressive_bet, player))
}

fn is_three_card_mini_royal_spades(cards: &[u8; 3]) -> bool {
    if !cards.iter().all(|&c| c < 52) {
        return false;
    }
    if !cards.iter().all(|&c| card_suit(c) == 0) {
        return false;
    }

    let mut ranks = [
        card_rank_ace_high(cards[0]),
        card_rank_ace_high(cards[1]),
        card_rank_ace_high(cards[2]),
    ];
    ranks.sort_unstable_by(|a, b| b.cmp(a));

    ranks == [14, 13, 12]
}

fn parse_uth_progressive_state(state_blob: &[u8]) -> Option<(u64, [u8; 2], [u8; 3])> {
    // v3:
    // [version:u8=3] [stage:u8] [hole:2] [community:5] [dealer:2] [play_mult:u8] [bonus:4]
    // [trips:u64] [six_card:u64] [progressive:u64]
    //
    // v1/v2 have the same leading bytes for hole+community but no progressive bet field.
    if state_blob.len() < 7 {
        return None;
    }

    let version = state_blob[0];
    let hole = [state_blob[2], state_blob[3]];
    let flop = [state_blob[4], state_blob[5], state_blob[6]];
    let progressive_bet = if version >= 3 {
        parse_u64_be_at(state_blob, 32).unwrap_or(0)
    } else {
        0
    };

    Some((progressive_bet, hole, flop))
}

fn uth_progressive_jackpot_tier(hole: &[u8; 2], flop: &[u8; 3]) -> UthJackpotTier {
    let cards = [hole[0], hole[1], flop[0], flop[1], flop[2]];
    if !cards.iter().all(|&c| c < 52) {
        return UthJackpotTier::None;
    }

    let suits = [
        card_suit(cards[0]),
        card_suit(cards[1]),
        card_suit(cards[2]),
        card_suit(cards[3]),
        card_suit(cards[4]),
    ];
    let is_flush = suits[0] == suits[1]
        && suits[1] == suits[2]
        && suits[2] == suits[3]
        && suits[3] == suits[4];

    let mut ranks = [
        card_rank_ace_high(cards[0]),
        card_rank_ace_high(cards[1]),
        card_rank_ace_high(cards[2]),
        card_rank_ace_high(cards[3]),
        card_rank_ace_high(cards[4]),
    ];
    ranks.sort_unstable();

    let has_duplicates = ranks[0] == ranks[1]
        || ranks[1] == ranks[2]
        || ranks[2] == ranks[3]
        || ranks[3] == ranks[4];

    let is_straight = if has_duplicates {
        false
    } else if ranks[4].saturating_sub(ranks[0]) == 4 {
        true
    } else {
        // Wheel: A-2-3-4-5
        ranks == [2, 3, 4, 5, 14]
    };

    let is_royal = ranks == [10, 11, 12, 13, 14];

    if is_flush && is_royal {
        UthJackpotTier::RoyalFlush
    } else if is_flush && is_straight {
        UthJackpotTier::StraightFlush
    } else {
        UthJackpotTier::None
    }
}

fn card_rank_ace_high(card: u8) -> u8 {
    let r = (card % 13) + 1;
    if r == 1 {
        14
    } else {
        r
    }
}

fn card_suit(card: u8) -> u8 {
    card / 13
}

pub struct Layer<'a, S: State> {
    state: &'a S,
    pending: BTreeMap<Key, Status>,

    seed: Seed,
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
        _master: <MinSig as Variant>::Public,
        _namespace: &[u8],
        seed: Seed,
    ) -> Self {
        Self {
            state,
            pending: BTreeMap::new(),

            seed,
        }
    }

    fn insert(&mut self, key: Key, value: Value) {
        self.pending.insert(key, Status::Update(value));
    }

    pub fn view(&self) -> View {
        self.seed.view
    }

    async fn prepare(&mut self, transaction: &Transaction) -> Result<(), PrepareError> {
        let mut account = load_account(self, &transaction.public).await;
        validate_and_increment_nonce(&mut account, transaction.nonce)?;
        self.insert(
            Key::Account(transaction.public.clone()),
            Value::Account(account),
        );

        Ok(())
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
            Instruction::CasinoToggleSuper => {
                self.handle_casino_toggle_super(&transaction.public).await
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

    pub async fn execute(
        &mut self,
        #[cfg(feature = "parallel")] _pool: ThreadPool,
        transactions: Vec<Transaction>,
    ) -> (Vec<Output>, BTreeMap<PublicKey, u64>) {
        let mut processed_nonces = BTreeMap::new();
        let mut outputs = Vec::new();

        for tx in transactions {
            if self.prepare(&tx).await.is_err() {
                continue;
            }
            processed_nonces.insert(tx.public.clone(), tx.nonce.saturating_add(1));
            outputs.extend(self.apply(&tx).await.into_iter().map(Output::Event));
            outputs.push(Output::Transaction(tx));
        }

        (outputs, processed_nonces)
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
            assert!(layer.prepare(&tx).await.is_err());

            // Correct nonce should succeed
            let tx = Transaction::sign(
                &signer,
                0,
                Instruction::CasinoRegister {
                    name: "test".to_string(),
                },
            );
            assert!(layer.prepare(&tx).await.is_ok());

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
            assert!(layer.prepare(&tx).await.is_ok());
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
