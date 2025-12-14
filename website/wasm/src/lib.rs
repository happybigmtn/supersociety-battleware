use commonware_codec::{Encode, ReadExt};
#[cfg(feature = "testing")]
use commonware_consensus::threshold_simplex::types::{seed_namespace, view_message};
#[cfg(feature = "testing")]
use commonware_cryptography::bls12381::primitives::ops;
#[cfg(feature = "testing")]
use commonware_cryptography::bls12381::primitives::variant::MinSig;
use commonware_cryptography::{ed25519, Hasher, PrivateKeyExt, Sha256, Signer as _};
#[cfg(feature = "testing")]
use commonware_runtime::{deterministic::Runner, Runner as _};
use commonware_storage::store::operation::{Keyless, Variable};
use commonware_utils::hex;
#[cfg(feature = "testing")]
use nullspace_execution::mocks;
#[cfg(feature = "testing")]
use nullspace_types::api::Summary;
use nullspace_types::{
    api::{Lookup, Submission, Update, UpdatesFilter},
    execution::{
        Event, Instruction, Key, Output, Seed, Transaction as ExecutionTransaction, Value,
        NAMESPACE, TRANSACTION_NAMESPACE,
    },
    Identity, Query,
};
use rand::rngs::OsRng;
#[cfg(feature = "testing")]
use rand::SeedableRng;
#[cfg(feature = "testing")]
use rand_chacha::ChaCha20Rng;
use serde::Serialize;
use serde_wasm_bindgen::Serializer;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstructionKind {
    // Casino instructions
    CasinoRegister = 0,
    CasinoDeposit = 1,
    CasinoStartGame = 2,
    CasinoGameMove = 3,
    CasinoToggleShield = 4,
    CasinoToggleDouble = 5,
    CasinoToggleSuper = 6,
    CasinoJoinTournament = 7,
    CasinoStartTournament = 8,
    CasinoEndTournament = 9,

    // Staking instructions
    Stake = 10,
    Unstake = 11,
    ClaimRewards = 12,
    ProcessEpoch = 13,

    // Vault / AMM instructions
    CreateVault = 14,
    DepositCollateral = 15,
    BorrowUSDT = 16,
    RepayUSDT = 17,
    Swap = 18,
    AddLiquidity = 19,
    RemoveLiquidity = 20,
}

impl InstructionKind {
    fn from_instruction(instruction: &Instruction) -> Self {
        match instruction {
            // Casino instructions
            Instruction::CasinoRegister { .. } => Self::CasinoRegister,
            Instruction::CasinoDeposit { .. } => Self::CasinoDeposit,
            Instruction::CasinoStartGame { .. } => Self::CasinoStartGame,
            Instruction::CasinoGameMove { .. } => Self::CasinoGameMove,
            Instruction::CasinoToggleShield => Self::CasinoToggleShield,
            Instruction::CasinoToggleDouble => Self::CasinoToggleDouble,
            Instruction::CasinoToggleSuper => Self::CasinoToggleSuper,
            Instruction::CasinoJoinTournament { .. } => Self::CasinoJoinTournament,
            Instruction::CasinoStartTournament { .. } => Self::CasinoStartTournament,
            Instruction::CasinoEndTournament { .. } => Self::CasinoEndTournament,

            // Staking instructions
            Instruction::Stake { .. } => Self::Stake,
            Instruction::Unstake => Self::Unstake,
            Instruction::ClaimRewards => Self::ClaimRewards,
            Instruction::ProcessEpoch => Self::ProcessEpoch,

            // Vault / AMM instructions
            Instruction::CreateVault => Self::CreateVault,
            Instruction::DepositCollateral { .. } => Self::DepositCollateral,
            Instruction::BorrowUSDT { .. } => Self::BorrowUSDT,
            Instruction::RepayUSDT { .. } => Self::RepayUSDT,
            Instruction::Swap { .. } => Self::Swap,
            Instruction::AddLiquidity { .. } => Self::AddLiquidity,
            Instruction::RemoveLiquidity { .. } => Self::RemoveLiquidity,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            // Casino instructions
            Self::CasinoRegister => "CasinoRegister",
            Self::CasinoDeposit => "CasinoDeposit",
            Self::CasinoStartGame => "CasinoStartGame",
            Self::CasinoGameMove => "CasinoGameMove",
            Self::CasinoToggleShield => "CasinoToggleShield",
            Self::CasinoToggleDouble => "CasinoToggleDouble",
            Self::CasinoToggleSuper => "CasinoToggleSuper",
            Self::CasinoJoinTournament => "CasinoJoinTournament",
            Self::CasinoStartTournament => "CasinoStartTournament",
            Self::CasinoEndTournament => "CasinoEndTournament",

            // Staking instructions
            Self::Stake => "Stake",
            Self::Unstake => "Unstake",
            Self::ClaimRewards => "ClaimRewards",
            Self::ProcessEpoch => "ProcessEpoch",

            // Vault / AMM instructions
            Self::CreateVault => "CreateVault",
            Self::DepositCollateral => "DepositCollateral",
            Self::BorrowUSDT => "BorrowUSDT",
            Self::RepayUSDT => "RepayUSDT",
            Self::Swap => "Swap",
            Self::AddLiquidity => "AddLiquidity",
            Self::RemoveLiquidity => "RemoveLiquidity",
        }
    }
}

/// Helper to convert serde_json::Value to a plain JavaScript object
fn to_object(value: &serde_json::Value) -> Result<JsValue, JsValue> {
    value
        .serialize(&Serializer::json_compatible())
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize: {e}")))
}

/// The key to use for signing transactions.
#[wasm_bindgen]
pub struct Signer {
    private_key: ed25519::PrivateKey,
    public_key: ed25519::PublicKey,
}

#[wasm_bindgen]
impl Signer {
    /// Generate a new signer from a random private key.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<Signer, JsValue> {
        let private_key = ed25519::PrivateKey::from_rng(&mut OsRng);
        let public_key = private_key.public_key();

        Ok(Signer {
            private_key,
            public_key,
        })
    }

    /// Create a signer from an encoded private key.
    #[wasm_bindgen]
    pub fn from_bytes(private_key_bytes: &[u8]) -> Result<Signer, JsValue> {
        let mut buf = private_key_bytes;
        let private_key = ed25519::PrivateKey::read(&mut buf)
            .map_err(|e| JsValue::from_str(&format!("Failed to create private key: {e:?}")))?;
        let public_key = private_key.public_key();

        Ok(Signer {
            private_key,
            public_key,
        })
    }

    /// Get the public key.
    #[wasm_bindgen(getter)]
    pub fn public_key(&self) -> Vec<u8> {
        self.public_key.as_ref().to_vec()
    }

    /// Get the public key as a hex string.
    #[wasm_bindgen(getter)]
    pub fn public_key_hex(&self) -> String {
        hex(self.public_key.as_ref())
    }

    /// Get the private key.
    #[wasm_bindgen(getter)]
    pub fn private_key(&self) -> Vec<u8> {
        self.private_key.as_ref().to_vec()
    }

    /// Get the private key as a hex string.
    #[wasm_bindgen(getter)]
    pub fn private_key_hex(&self) -> String {
        hex(self.private_key.as_ref())
    }

    /// Sign a message.
    pub fn sign(&self, message: &[u8]) -> Vec<u8> {
        self.private_key
            .sign(Some(TRANSACTION_NAMESPACE), message)
            .encode()
            .to_vec()
    }
}

/// An onchain transaction.
#[wasm_bindgen]
pub struct Transaction {
    inner: ExecutionTransaction,
}

#[wasm_bindgen]
impl Transaction {
    /// Encode the transaction.
    #[wasm_bindgen]
    pub fn encode(&self) -> Vec<u8> {
        self.inner.encode().to_vec()
    }

    /// Get the instruction kind as a stable enum.
    #[wasm_bindgen(getter)]
    pub fn instruction_kind(&self) -> InstructionKind {
        InstructionKind::from_instruction(&self.inner.instruction)
    }

    /// Get the canonical instruction name.
    #[wasm_bindgen(getter)]
    pub fn instruction_name(&self) -> String {
        InstructionKind::from_instruction(&self.inner.instruction)
            .as_str()
            .to_string()
    }

    /// Sign a new casino start game transaction.
    #[wasm_bindgen]
    pub fn casino_start_game(
        signer: &Signer,
        nonce: u64,
        game_type: u8,
        bet: u64,
        session_id: u64,
    ) -> Result<Transaction, JsValue> {
        use nullspace_types::casino::GameType;
        let game_type = match game_type {
            0 => GameType::Baccarat,
            1 => GameType::Blackjack,
            2 => GameType::CasinoWar,
            3 => GameType::Craps,
            4 => GameType::VideoPoker,
            5 => GameType::HiLo,
            6 => GameType::Roulette,
            7 => GameType::SicBo,
            8 => GameType::ThreeCard,
            9 => GameType::UltimateHoldem,
            _ => {
                return Err(JsValue::from_str(&format!(
                    "Invalid game type: {}",
                    game_type
                )))
            }
        };
        let instruction = Instruction::CasinoStartGame {
            game_type,
            bet,
            session_id,
        };
        let tx = ExecutionTransaction::sign(&signer.private_key, nonce, instruction);
        Ok(Transaction { inner: tx })
    }

    /// Sign a new casino game move transaction.
    #[wasm_bindgen]
    pub fn casino_game_move(
        signer: &Signer,
        nonce: u64,
        session_id: u64,
        payload: &[u8],
    ) -> Result<Transaction, JsValue> {
        let instruction = Instruction::CasinoGameMove {
            session_id,
            payload: payload.to_vec(),
        };
        let tx = ExecutionTransaction::sign(&signer.private_key, nonce, instruction);
        Ok(Transaction { inner: tx })
    }

    /// Sign a new casino toggle shield transaction.
    #[wasm_bindgen]
    pub fn casino_toggle_shield(signer: &Signer, nonce: u64) -> Result<Transaction, JsValue> {
        let instruction = Instruction::CasinoToggleShield;
        let tx = ExecutionTransaction::sign(&signer.private_key, nonce, instruction);
        Ok(Transaction { inner: tx })
    }

    /// Sign a new casino toggle double transaction.
    #[wasm_bindgen]
    pub fn casino_toggle_double(signer: &Signer, nonce: u64) -> Result<Transaction, JsValue> {
        let instruction = Instruction::CasinoToggleDouble;
        let tx = ExecutionTransaction::sign(&signer.private_key, nonce, instruction);
        Ok(Transaction { inner: tx })
    }

    /// Sign a new casino toggle super/aura transaction.
    #[wasm_bindgen]
    pub fn casino_toggle_super(signer: &Signer, nonce: u64) -> Result<Transaction, JsValue> {
        let instruction = Instruction::CasinoToggleSuper;
        let tx = ExecutionTransaction::sign(&signer.private_key, nonce, instruction);
        Ok(Transaction { inner: tx })
    }

    /// Sign a new casino register transaction.
    #[wasm_bindgen]
    pub fn casino_register(
        signer: &Signer,
        nonce: u64,
        name: &str,
    ) -> Result<Transaction, JsValue> {
        let instruction = Instruction::CasinoRegister {
            name: name.to_string(),
        };
        let tx = ExecutionTransaction::sign(&signer.private_key, nonce, instruction);
        Ok(Transaction { inner: tx })
    }

    /// Sign a new casino join tournament transaction.
    #[wasm_bindgen]
    pub fn casino_join_tournament(
        signer: &Signer,
        nonce: u64,
        tournament_id: u64,
    ) -> Result<Transaction, JsValue> {
        let instruction = Instruction::CasinoJoinTournament { tournament_id };
        let tx = ExecutionTransaction::sign(&signer.private_key, nonce, instruction);
        Ok(Transaction { inner: tx })
    }

    /// Sign a new casino start tournament transaction.
    #[wasm_bindgen]
    pub fn casino_start_tournament(
        signer: &Signer,
        nonce: u64,
        tournament_id: u64,
        start_time_ms: u64,
        end_time_ms: u64,
    ) -> Result<Transaction, JsValue> {
        let instruction = Instruction::CasinoStartTournament {
            tournament_id,
            start_time_ms,
            end_time_ms,
        };
        let tx = ExecutionTransaction::sign(&signer.private_key, nonce, instruction);
        Ok(Transaction { inner: tx })
    }

    /// Sign a new casino deposit transaction (dev faucet / testing).
    #[wasm_bindgen]
    pub fn casino_deposit(
        signer: &Signer,
        nonce: u64,
        amount: u64,
    ) -> Result<Transaction, JsValue> {
        let instruction = Instruction::CasinoDeposit { amount };
        let tx = ExecutionTransaction::sign(&signer.private_key, nonce, instruction);
        Ok(Transaction { inner: tx })
    }

    /// Sign a new casino end tournament transaction.
    #[wasm_bindgen]
    pub fn casino_end_tournament(
        signer: &Signer,
        nonce: u64,
        tournament_id: u64,
    ) -> Result<Transaction, JsValue> {
        let instruction = Instruction::CasinoEndTournament { tournament_id };
        let tx = ExecutionTransaction::sign(&signer.private_key, nonce, instruction);
        Ok(Transaction { inner: tx })
    }

    /// Sign a new stake transaction.
    #[wasm_bindgen]
    pub fn stake(
        signer: &Signer,
        nonce: u64,
        amount: u64,
        duration: u64,
    ) -> Result<Transaction, JsValue> {
        let instruction = Instruction::Stake { amount, duration };
        let tx = ExecutionTransaction::sign(&signer.private_key, nonce, instruction);
        Ok(Transaction { inner: tx })
    }

    /// Sign a new unstake transaction.
    #[wasm_bindgen]
    pub fn unstake(signer: &Signer, nonce: u64) -> Result<Transaction, JsValue> {
        let instruction = Instruction::Unstake;
        let tx = ExecutionTransaction::sign(&signer.private_key, nonce, instruction);
        Ok(Transaction { inner: tx })
    }

    /// Sign a new claim rewards transaction.
    #[wasm_bindgen]
    pub fn claim_rewards(signer: &Signer, nonce: u64) -> Result<Transaction, JsValue> {
        let instruction = Instruction::ClaimRewards;
        let tx = ExecutionTransaction::sign(&signer.private_key, nonce, instruction);
        Ok(Transaction { inner: tx })
    }

    /// Sign a new process epoch transaction.
    #[wasm_bindgen]
    pub fn process_epoch(signer: &Signer, nonce: u64) -> Result<Transaction, JsValue> {
        let instruction = Instruction::ProcessEpoch;
        let tx = ExecutionTransaction::sign(&signer.private_key, nonce, instruction);
        Ok(Transaction { inner: tx })
    }

    /// Sign a new create vault transaction.
    #[wasm_bindgen]
    pub fn create_vault(signer: &Signer, nonce: u64) -> Result<Transaction, JsValue> {
        let instruction = Instruction::CreateVault;
        let tx = ExecutionTransaction::sign(&signer.private_key, nonce, instruction);
        Ok(Transaction { inner: tx })
    }

    /// Sign a new deposit collateral transaction.
    #[wasm_bindgen]
    pub fn deposit_collateral(
        signer: &Signer,
        nonce: u64,
        amount: u64,
    ) -> Result<Transaction, JsValue> {
        let instruction = Instruction::DepositCollateral { amount };
        let tx = ExecutionTransaction::sign(&signer.private_key, nonce, instruction);
        Ok(Transaction { inner: tx })
    }

    /// Sign a new borrow vUSDT transaction.
    #[wasm_bindgen]
    pub fn borrow_usdt(signer: &Signer, nonce: u64, amount: u64) -> Result<Transaction, JsValue> {
        let instruction = Instruction::BorrowUSDT { amount };
        let tx = ExecutionTransaction::sign(&signer.private_key, nonce, instruction);
        Ok(Transaction { inner: tx })
    }

    /// Sign a new repay vUSDT transaction.
    #[wasm_bindgen]
    pub fn repay_usdt(signer: &Signer, nonce: u64, amount: u64) -> Result<Transaction, JsValue> {
        let instruction = Instruction::RepayUSDT { amount };
        let tx = ExecutionTransaction::sign(&signer.private_key, nonce, instruction);
        Ok(Transaction { inner: tx })
    }

    /// Sign a new AMM swap transaction.
    #[wasm_bindgen]
    pub fn swap(
        signer: &Signer,
        nonce: u64,
        amount_in: u64,
        min_amount_out: u64,
        is_buying_rng: bool,
    ) -> Result<Transaction, JsValue> {
        let instruction = Instruction::Swap {
            amount_in,
            min_amount_out,
            is_buying_rng,
        };
        let tx = ExecutionTransaction::sign(&signer.private_key, nonce, instruction);
        Ok(Transaction { inner: tx })
    }

    /// Sign a new add liquidity transaction.
    #[wasm_bindgen]
    pub fn add_liquidity(
        signer: &Signer,
        nonce: u64,
        rng_amount: u64,
        usdt_amount: u64,
    ) -> Result<Transaction, JsValue> {
        let instruction = Instruction::AddLiquidity {
            rng_amount,
            usdt_amount,
        };
        let tx = ExecutionTransaction::sign(&signer.private_key, nonce, instruction);
        Ok(Transaction { inner: tx })
    }

    /// Sign a new remove liquidity transaction.
    #[wasm_bindgen]
    pub fn remove_liquidity(
        signer: &Signer,
        nonce: u64,
        shares: u64,
    ) -> Result<Transaction, JsValue> {
        let instruction = Instruction::RemoveLiquidity { shares };
        let tx = ExecutionTransaction::sign(&signer.private_key, nonce, instruction);
        Ok(Transaction { inner: tx })
    }
}

/// Encode an account key.
#[wasm_bindgen]
pub fn encode_account_key(public_key: &[u8]) -> Result<Vec<u8>, JsValue> {
    let mut buf = public_key;
    let pk = ed25519::PublicKey::read(&mut buf)
        .map_err(|e| JsValue::from_str(&format!("Invalid public key: {e:?}")))?;
    let key = Key::Account(pk);
    Ok(key.encode().to_vec())
}

/// Encode a casino player key.
#[wasm_bindgen]
pub fn encode_casino_player_key(public_key: &[u8]) -> Result<Vec<u8>, JsValue> {
    let mut buf = public_key;
    let pk = ed25519::PublicKey::read(&mut buf)
        .map_err(|e| JsValue::from_str(&format!("Invalid public key: {e:?}")))?;
    let key = Key::CasinoPlayer(pk);
    Ok(key.encode().to_vec())
}

/// Encode a casino session key.
#[wasm_bindgen]
pub fn encode_casino_session_key(session_id: u64) -> Vec<u8> {
    let key = Key::CasinoSession(session_id);
    key.encode().to_vec()
}

/// Encode the casino leaderboard key.
#[wasm_bindgen]
pub fn encode_casino_leaderboard_key() -> Vec<u8> {
    let key = Key::CasinoLeaderboard;
    key.encode().to_vec()
}

/// Encode a casino tournament key.
#[wasm_bindgen]
pub fn encode_casino_tournament_key(tournament_id: u64) -> Vec<u8> {
    let key = Key::Tournament(tournament_id);
    key.encode().to_vec()
}

/// Encode a vault key.
#[wasm_bindgen]
pub fn encode_vault_key(public_key: &[u8]) -> Result<Vec<u8>, JsValue> {
    let mut buf = public_key;
    let pk = ed25519::PublicKey::read(&mut buf)
        .map_err(|e| JsValue::from_str(&format!("Invalid public key: {e:?}")))?;
    let key = Key::Vault(pk);
    Ok(key.encode().to_vec())
}

/// Encode the AMM pool key.
#[wasm_bindgen]
pub fn encode_amm_pool_key() -> Vec<u8> {
    let key = Key::AmmPool;
    key.encode().to_vec()
}

/// Encode an LP balance key.
#[wasm_bindgen]
pub fn encode_lp_balance_key(public_key: &[u8]) -> Result<Vec<u8>, JsValue> {
    let mut buf = public_key;
    let pk = ed25519::PublicKey::read(&mut buf)
        .map_err(|e| JsValue::from_str(&format!("Invalid public key: {e:?}")))?;
    let key = Key::LpBalance(pk);
    Ok(key.encode().to_vec())
}

/// Encode the house key.
#[wasm_bindgen]
pub fn encode_house_key() -> Vec<u8> {
    let key = Key::House;
    key.encode().to_vec()
}

/// Encode a staker key.
#[wasm_bindgen]
pub fn encode_staker_key(public_key: &[u8]) -> Result<Vec<u8>, JsValue> {
    let mut buf = public_key;
    let pk = ed25519::PublicKey::read(&mut buf)
        .map_err(|e| JsValue::from_str(&format!("Invalid public key: {e:?}")))?;
    let key = Key::Staker(pk);
    Ok(key.encode().to_vec())
}

/// Encode UpdatesFilter::All
#[wasm_bindgen]
pub fn encode_updates_filter_all() -> Vec<u8> {
    UpdatesFilter::All.encode().to_vec()
}

/// Encode UpdatesFilter::Account
#[wasm_bindgen]
pub fn encode_updates_filter_account(public_key: &[u8]) -> Result<Vec<u8>, JsValue> {
    let mut buf = public_key;
    let pk = ed25519::PublicKey::read(&mut buf)
        .map_err(|e| JsValue::from_str(&format!("Invalid public key: {e:?}")))?;
    Ok(UpdatesFilter::Account(pk).encode().to_vec())
}

/// Hash a key for state queries.
#[wasm_bindgen]
pub fn hash_key(key: &[u8]) -> Vec<u8> {
    let digest = Sha256::hash(key);
    digest.encode().to_vec()
}

/// Encode a query for the latest state.
#[wasm_bindgen]
pub fn encode_query_latest() -> Vec<u8> {
    let query = Query::Latest;
    query.encode().to_vec()
}

/// Encode a query for a specific index.
#[wasm_bindgen]
pub fn encode_query_index(index: u64) -> Vec<u8> {
    let query = Query::Index(index);
    query.encode().to_vec()
}

// Helper function to convert Value to JSON
fn decode_value(value: Value) -> Result<JsValue, JsValue> {
    // Convert to JSON
    let json = match value {
        Value::Account(account) => {
            serde_json::json!({
                "type": "Account",
                "nonce": account.nonce
            })
        }
        Value::Commit { height, start: _ } => {
            serde_json::json!({
                "type": "Height",
                "height": height
            })
        }
        // Casino values
        Value::CasinoPlayer(player) => {
            serde_json::json!({
                "type": "CasinoPlayer",
                "nonce": player.nonce,
                "name": player.name,
                "chips": player.chips,
                "vusdt_balance": player.vusdt_balance,
                "shields": player.shields,
                "doubles": player.doubles,
                "tournament_chips": player.tournament_chips,
                "tournament_shields": player.tournament_shields,
                "tournament_doubles": player.tournament_doubles,
                "active_tournament": player.active_tournament,
                "rank": player.rank,
                "active_shield": player.active_shield,
                "active_double": player.active_double,
                "active_super": player.active_super,
                "active_session": player.active_session,
                "last_deposit_block": player.last_deposit_block,
                "aura_meter": player.aura_meter,
                "tournaments_played_today": player.tournaments_played_today,
                "last_tournament_ts": player.last_tournament_ts,
                "is_kyc_verified": player.is_kyc_verified
            })
        }
        Value::CasinoSession(session) => {
            let multipliers: Vec<_> = session
                .super_mode
                .multipliers
                .iter()
                .map(|m| {
                    serde_json::json!({
                        "id": m.id,
                        "multiplier": m.multiplier,
                        "super_type": format!("{:?}", m.super_type)
                    })
                })
                .collect();
            serde_json::json!({
                "type": "CasinoSession",
                "id": session.id,
                "player": hex(&session.player.encode()),
                "game_type": session.game_type as u8,
                "bet": session.bet,
                "state_blob": hex(&session.state_blob),
                "move_count": session.move_count,
                "created_at": session.created_at,
                "is_complete": session.is_complete,
                "super_mode": {
                    "is_active": session.super_mode.is_active,
                    "streak_level": session.super_mode.streak_level,
                    "multipliers": multipliers
                },
                "is_tournament": session.is_tournament,
                "tournament_id": session.tournament_id
            })
        }
        Value::CasinoLeaderboard(leaderboard) => {
            let entries: Vec<_> = leaderboard
                .entries
                .iter()
                .map(|e| {
                    serde_json::json!({
                        "player": hex(&e.player.encode()),
                        "name": e.name,
                        "chips": e.chips
                    })
                })
                .collect();
            serde_json::json!({
                "type": "CasinoLeaderboard",
                "entries": entries
            })
        }
        Value::Tournament(tournament) => {
            let players: Vec<_> = tournament
                .players
                .iter()
                .map(|pk| hex(&pk.encode()))
                .collect();

            let leaderboard_entries: Vec<_> = tournament
                .leaderboard
                .entries
                .iter()
                .map(|e| {
                    serde_json::json!({
                        "player": hex(&e.player.encode()),
                        "name": e.name,
                        "chips": e.chips,
                        "rank": e.rank
                    })
                })
                .collect();

            serde_json::json!({
                "type": "Tournament",
                "id": tournament.id,
                "phase": format!("{:?}", tournament.phase),
                "start_block": tournament.start_block,
                "start_time_ms": tournament.start_time_ms,
                "end_time_ms": tournament.end_time_ms,
                "players": players,
                "prize_pool": tournament.prize_pool,
                "starting_chips": tournament.starting_chips,
                "starting_shields": tournament.starting_shields,
                "starting_doubles": tournament.starting_doubles,
                "leaderboard": {
                    "entries": leaderboard_entries
                }
            })
        }
        // Staking & House values
        Value::House(house) => {
            serde_json::json!({
                "type": "House",
                "current_epoch": house.current_epoch,
                "epoch_start_ts": house.epoch_start_ts,
                "net_pnl": house.net_pnl.to_string(),
                "total_staked_amount": house.total_staked_amount,
                "total_voting_power": house.total_voting_power.to_string(),
                "accumulated_fees": house.accumulated_fees,
                "total_burned": house.total_burned,
                "total_issuance": house.total_issuance,
                "three_card_progressive_jackpot": house.three_card_progressive_jackpot,
                "uth_progressive_jackpot": house.uth_progressive_jackpot
            })
        }
        Value::Staker(staker) => {
            serde_json::json!({
                "type": "Staker",
                "balance": staker.balance,
                "unlock_ts": staker.unlock_ts,
                "last_claim_epoch": staker.last_claim_epoch,
                "voting_power": staker.voting_power.to_string()
            })
        }
        // Virtual Liquidity values
        Value::Vault(vault) => {
            serde_json::json!({
                "type": "Vault",
                "collateral_rng": vault.collateral_rng,
                "debt_vusdt": vault.debt_vusdt
            })
        }
        Value::AmmPool(pool) => {
            serde_json::json!({
                "type": "AmmPool",
                "reserve_rng": pool.reserve_rng,
                "reserve_vusdt": pool.reserve_vusdt,
                "total_shares": pool.total_shares,
                "fee_basis_points": pool.fee_basis_points,
                "sell_tax_basis_points": pool.sell_tax_basis_points
            })
        }
        Value::LpBalance(bal) => {
            serde_json::json!({
                "type": "LpBalance",
                "balance": bal
            })
        }
    };

    to_object(&json)
}

/// Decode a lookup response from the simulator.
/// The identity_bytes should be the simulator's identity for verification.
#[wasm_bindgen]
pub fn decode_lookup(lookup_bytes: &[u8], identity_bytes: &[u8]) -> Result<JsValue, JsValue> {
    // Decode the lookup
    let mut buf = lookup_bytes;
    let lookup = Lookup::read(&mut buf)
        .map_err(|e| JsValue::from_str(&format!("Failed to decode lookup: {e:?}")))?;

    // Decode the identity for verification
    let mut id_buf = identity_bytes;
    let identity = Identity::read(&mut id_buf)
        .map_err(|e| JsValue::from_str(&format!("Failed to decode identity: {e:?}")))?;

    // Verify the lookup
    if let Err(err) = lookup.verify(&identity) {
        return Err(JsValue::from_str(&format!(
            "Lookup verification failed: {err}"
        )));
    }

    // Extract the value from the operation
    let value = match lookup.operation {
        Variable::Update(_, value) => value,
        _ => return Err(JsValue::from_str("Expected Update operation in lookup")),
    };

    // Convert to JSON (reuse the logic from decode_value)
    decode_value(value)
}

/// Helper function to decode and verify a seed
fn decode_seed_internal(seed: Seed, identity: &Identity) -> Result<JsValue, JsValue> {
    // Verify the seed signature
    if !seed.verify(NAMESPACE, identity) {
        return Err(JsValue::from_str("invalid seed"));
    }

    // Include raw bytes for settle operations
    let bytes = seed.encode().to_vec();

    // Create response using serde_json for consistency
    let response = serde_json::json!({
        "type": "Seed",
        "view": seed.view,
        "bytes": bytes
    });

    to_object(&response)
}

/// Decode and verify a seed.
#[wasm_bindgen]
pub fn decode_seed(seed: &[u8], identity: &[u8]) -> Result<JsValue, JsValue> {
    let mut buf = seed;
    let seed = Seed::read(&mut buf)
        .map_err(|e| JsValue::from_str(&format!("Failed to decode seed: {e:?}")))?;

    // Decode the identity (BLS public key)
    let identity = decode_bls_public(identity)?;

    decode_seed_internal(seed, &identity)
}

/// Helper function to convert an Event to JSON
fn decode_event(event: &Event) -> Result<serde_json::Value, JsValue> {
    let json = match event {
        // Casino events
        Event::CasinoPlayerRegistered { player, name } => {
            serde_json::json!({
                "type": "CasinoPlayerRegistered",
                "player": hex(&player.encode()),
                "name": name
            })
        }
        Event::CasinoGameStarted {
            session_id,
            player,
            game_type,
            bet,
            initial_state,
        } => {
            serde_json::json!({
                "type": "CasinoGameStarted",
                "session_id": session_id,
                "player": hex(&player.encode()),
                "game_type": format!("{:?}", game_type),
                "bet": bet,
                "initial_state": hex(initial_state)
            })
        }
        Event::CasinoGameMoved {
            session_id,
            move_number,
            new_state,
        } => {
            serde_json::json!({
                "type": "CasinoGameMoved",
                "session_id": session_id,
                "move_number": move_number,
                "new_state": hex(new_state)
            })
        }
        Event::CasinoGameCompleted {
            session_id,
            player,
            game_type,
            payout,
            final_chips,
            was_shielded,
            was_doubled,
        } => {
            serde_json::json!({
                "type": "CasinoGameCompleted",
                "session_id": session_id,
                "player": hex(&player.encode()),
                "game_type": format!("{:?}", game_type),
                "payout": payout,
                "final_chips": final_chips,
                "was_shielded": was_shielded,
                "was_doubled": was_doubled
            })
        }
        Event::CasinoLeaderboardUpdated { leaderboard } => {
            let entries: Vec<_> = leaderboard
                .entries
                .iter()
                .map(|e| {
                    serde_json::json!({
                        "player": hex(&e.player.encode()),
                        "name": e.name,
                        "chips": e.chips
                    })
                })
                .collect();
            serde_json::json!({
                "type": "CasinoLeaderboardUpdated",
                "entries": entries
            })
        }
        Event::CasinoError {
            player,
            session_id,
            error_code,
            message,
        } => {
            serde_json::json!({
                "type": "CasinoError",
                "player": hex(&player.encode()),
                "session_id": session_id,
                "error_code": error_code,
                "message": message
            })
        }
        // Tournament events
        Event::TournamentStarted { id, start_block } => {
            serde_json::json!({
                "type": "TournamentStarted",
                "id": id,
                "start_block": start_block
            })
        }
        Event::PlayerJoined {
            tournament_id,
            player,
        } => {
            serde_json::json!({
                "type": "PlayerJoined",
                "tournament_id": tournament_id,
                "player": hex(&player.encode())
            })
        }
        Event::TournamentPhaseChanged { id, phase } => {
            let phase_str = match phase {
                nullspace_types::casino::TournamentPhase::Registration => "Registration",
                nullspace_types::casino::TournamentPhase::Active => "Active",
                nullspace_types::casino::TournamentPhase::Complete => "Complete",
            };
            serde_json::json!({
                "type": "TournamentPhaseChanged",
                "id": id,
                "phase": phase_str
            })
        }
        Event::TournamentEnded { id, rankings } => {
            let rankings_json: Vec<_> = rankings
                .iter()
                .map(|(player, chips)| {
                    serde_json::json!({
                        "player": hex(&player.encode()),
                        "chips": chips
                    })
                })
                .collect();
            serde_json::json!({
                "type": "TournamentEnded",
                "id": id,
                "rankings": rankings_json
            })
        }

        // Vault & AMM events
        Event::VaultCreated { player } => {
            serde_json::json!({
                "type": "VaultCreated",
                "player": hex(&player.encode())
            })
        }
        Event::CollateralDeposited {
            player,
            amount,
            new_collateral,
        } => {
            serde_json::json!({
                "type": "CollateralDeposited",
                "player": hex(&player.encode()),
                "amount": amount,
                "new_collateral": new_collateral
            })
        }
        Event::VusdtBorrowed {
            player,
            amount,
            new_debt,
        } => {
            serde_json::json!({
                "type": "VusdtBorrowed",
                "player": hex(&player.encode()),
                "amount": amount,
                "new_debt": new_debt
            })
        }
        Event::VusdtRepaid {
            player,
            amount,
            new_debt,
        } => {
            serde_json::json!({
                "type": "VusdtRepaid",
                "player": hex(&player.encode()),
                "amount": amount,
                "new_debt": new_debt
            })
        }
        Event::AmmSwapped {
            player,
            is_buying_rng,
            amount_in,
            amount_out,
            fee_amount,
            burned_amount,
            reserve_rng,
            reserve_vusdt,
        } => {
            serde_json::json!({
                "type": "AmmSwapped",
                "player": hex(&player.encode()),
                "is_buying_rng": is_buying_rng,
                "amount_in": amount_in,
                "amount_out": amount_out,
                "fee_amount": fee_amount,
                "burned_amount": burned_amount,
                "reserve_rng": reserve_rng,
                "reserve_vusdt": reserve_vusdt
            })
        }
        Event::LiquidityAdded {
            player,
            rng_amount,
            vusdt_amount,
            shares_minted,
            total_shares,
            reserve_rng,
            reserve_vusdt,
            lp_balance,
        } => {
            serde_json::json!({
                "type": "LiquidityAdded",
                "player": hex(&player.encode()),
                "rng_amount": rng_amount,
                "vusdt_amount": vusdt_amount,
                "shares_minted": shares_minted,
                "total_shares": total_shares,
                "reserve_rng": reserve_rng,
                "reserve_vusdt": reserve_vusdt,
                "lp_balance": lp_balance
            })
        }
        Event::LiquidityRemoved {
            player,
            rng_amount,
            vusdt_amount,
            shares_burned,
            total_shares,
            reserve_rng,
            reserve_vusdt,
            lp_balance,
        } => {
            serde_json::json!({
                "type": "LiquidityRemoved",
                "player": hex(&player.encode()),
                "rng_amount": rng_amount,
                "vusdt_amount": vusdt_amount,
                "shares_burned": shares_burned,
                "total_shares": total_shares,
                "reserve_rng": reserve_rng,
                "reserve_vusdt": reserve_vusdt,
                "lp_balance": lp_balance
            })
        }

        // Staking events
        Event::Staked {
            player,
            amount,
            duration,
            new_balance,
            unlock_ts,
            voting_power,
        } => {
            serde_json::json!({
                "type": "Staked",
                "player": hex(&player.encode()),
                "amount": amount,
                "duration": duration,
                "new_balance": new_balance,
                "unlock_ts": unlock_ts,
                "voting_power": voting_power.to_string()
            })
        }
        Event::Unstaked { player, amount } => {
            serde_json::json!({
                "type": "Unstaked",
                "player": hex(&player.encode()),
                "amount": amount
            })
        }
        Event::EpochProcessed { epoch } => {
            serde_json::json!({
                "type": "EpochProcessed",
                "epoch": epoch
            })
        }
        Event::RewardsClaimed { player, amount } => {
            serde_json::json!({
                "type": "RewardsClaimed",
                "player": hex(&player.encode()),
                "amount": amount
            })
        }
    };
    Ok(json)
}

/// Decode a BLS public key.
fn decode_bls_public(bytes: &[u8]) -> Result<Identity, JsValue> {
    let mut buf = bytes;
    let identity = Identity::read(&mut buf)
        .map_err(|e| JsValue::from_str(&format!("Failed to decode BLS public key: {e:?}")))?;
    Ok(identity)
}

#[cfg(feature = "testing")]
#[wasm_bindgen]
pub fn get_identity(seed: u64) -> Vec<u8> {
    let mut rng = ChaCha20Rng::seed_from_u64(seed);
    let (_, identity) = ops::keypair::<_, MinSig>(&mut rng);
    identity.encode().to_vec()
}

#[cfg(feature = "testing")]
#[wasm_bindgen]
pub fn encode_seed(seed: u64, view: u64) -> Vec<u8> {
    let mut rng = ChaCha20Rng::seed_from_u64(seed);
    let (network_secret, _) = ops::keypair::<_, MinSig>(&mut rng);

    let seed_namespace = seed_namespace(NAMESPACE);
    let message = view_message(view);
    let sig = ops::sign_message::<MinSig>(&network_secret, Some(&seed_namespace), &message);
    let seed = Seed::new(view, sig);

    seed.encode().to_vec()
}

/// Create a test summary with transactions for testing.
/// This creates a summary that processes the given transactions and updates state accordingly.
#[cfg(feature = "testing")]
#[wasm_bindgen]
pub fn execute_block(network_secret: u64, view: u64, tx_bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
    // Create master keypair from seed
    let mut rng = ChaCha20Rng::seed_from_u64(network_secret);
    let (network_secret, network_identity) = ops::keypair::<_, MinSig>(&mut rng);

    // Decode all transactions from the buffer (its ok to be empty)
    let mut transactions = Vec::new();
    let mut buf = tx_bytes;
    while !buf.is_empty() {
        match ExecutionTransaction::read(&mut buf) {
            Ok(tx) => transactions.push(tx),
            Err(_) => break, // End of transactions
        }
    }

    // Create summary in deterministic runtime
    let executor = Runner::default();
    let (_, summary) = executor.start(|context| async move {
        let (mut state, mut events) = mocks::create_adbs(&context).await;
        mocks::execute_block(
            &network_secret,
            network_identity,
            &mut state,
            &mut events,
            view,
            transactions,
        )
        .await
    });

    Ok(summary.encode().to_vec())
}

/// Helper function to process an output into a JSON value
fn process_output(output: &Output) -> Result<serde_json::Value, JsValue> {
    match output {
        Output::Transaction(tx) => {
            let instruction = instruction_name(&tx.instruction);
            Ok(serde_json::json!({
                "type": "Transaction",
                "nonce": tx.nonce,
                "public": hex(&tx.public),
                "instruction": instruction
            }))
        }
        Output::Event(event) => decode_event(event),
        _ => Ok(serde_json::Value::Null),
    }
}

fn instruction_name(instruction: &Instruction) -> &'static str {
    InstructionKind::from_instruction(instruction).as_str()
}

/// Helper function to process events (both regular and filtered)
fn process_events<'a, I>(ops_iter: I) -> Result<JsValue, JsValue>
where
    I: Iterator<Item = &'a Keyless<Output>>,
{
    // Process events - extract outputs
    let mut events_array = Vec::new();
    for op in ops_iter {
        if let Keyless::Append(output) = op {
            let json_value = process_output(output)?;
            if json_value.is_null() {
                continue;
            }
            events_array.push(json_value);
        }
    }

    // Create response using serde_json for consistency
    let response = serde_json::json!({
        "type": "Events",
        "events": events_array
    });

    to_object(&response)
}

/// Decode an Update (which can be either a Seed or Events).
#[wasm_bindgen]
pub fn decode_update(update: &[u8], identity: &[u8]) -> Result<JsValue, JsValue> {
    let mut buf = update;
    let update = Update::read(&mut buf)
        .map_err(|e| JsValue::from_str(&format!("Failed to decode update: {e:?}")))?;

    // Decode the identity (BLS public key)
    let identity = decode_bls_public(identity)?;

    match update {
        Update::Seed(seed) => decode_seed_internal(seed, &identity),
        Update::Events(events) => {
            // Verify the events signature and proof
            events.verify(&identity).map_err(|err| {
                JsValue::from_str(&format!("Invalid events signature or proof: {err}"))
            })?;
            process_events(events.events_proof_ops.iter())
        }
        Update::FilteredEvents(events) => {
            // Verify the filtered events signature and proof
            events.verify(&identity).map_err(|err| {
                JsValue::from_str(&format!(
                    "Invalid filtered events signature or proof: {err}"
                ))
            })?;
            process_events(events.events_proof_ops.iter().map(|(_, op)| op))
        }
    }
}

/// Wrap a transaction in a Submission enum for the /submit endpoint.
#[wasm_bindgen]
pub fn wrap_transaction_submission(transaction: &[u8]) -> Result<Vec<u8>, JsValue> {
    let mut buf = transaction;
    let tx = ExecutionTransaction::read(&mut buf)
        .map_err(|e| JsValue::from_str(&format!("Failed to decode transaction: {e:?}")))?;

    let submission = Submission::Transactions(vec![tx]);
    Ok(submission.encode().to_vec())
}

/// Wrap a summary in a Submission enum for the /submit endpoint.
#[wasm_bindgen]
#[cfg(feature = "testing")]
pub fn wrap_summary_submission(summary: &[u8]) -> Result<Vec<u8>, JsValue> {
    let mut buf = summary;
    let summary = Summary::read(&mut buf)
        .map_err(|e| JsValue::from_str(&format!("Failed to decode summary: {e:?}")))?;

    let submission = Submission::Summary(summary);
    Ok(submission.encode().to_vec())
}

/// Wrap a seed in a Submission enum for the /submit endpoint.
#[wasm_bindgen]
#[cfg(feature = "testing")]
pub fn wrap_seed_submission(seed: &[u8]) -> Result<Vec<u8>, JsValue> {
    let mut buf = seed;
    let seed = Seed::read(&mut buf)
        .map_err(|e| JsValue::from_str(&format!("Failed to decode seed: {e:?}")))?;

    let submission = Submission::Seed(seed);
    Ok(submission.encode().to_vec())
}
