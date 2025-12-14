#[cfg(feature = "passkeys")]
use axum::http::HeaderMap;
use axum::{
    body::Bytes,
    extract::{ws::WebSocketUpgrade, Path, Query, State as AxumState},
    http::{header, Method, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use commonware_codec::{DecodeExt, Encode, Read, ReadExt, ReadRangeExt};
use commonware_consensus::{aggregation::types::Certificate, Viewable};
use commonware_cryptography::{
    bls12381::primitives::variant::MinSig,
    ed25519::{self, PublicKey},
    sha256::Digest,
    Digestible,
};
#[cfg(feature = "passkeys")]
use commonware_cryptography::{PrivateKeyExt, Signer};
use commonware_storage::{
    adb::{
        create_multi_proof, create_proof, create_proof_store_from_digests,
        digests_required_for_proof,
    },
    mmr::verification::Proof,
    store::operation::{Keyless, Variable},
};
use commonware_utils::{from_hex, hex};
use futures::{SinkExt, StreamExt};
use nullspace_types::{
    api::{Events, FilteredEvents, Lookup, Pending, Submission, Summary, Update, UpdatesFilter},
    execution::{Event, Output, Progress, Seed, Transaction, Value},
    Identity, Query as ChainQuery, NAMESPACE,
};
#[cfg(feature = "passkeys")]
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::{broadcast, RwLock};
use tower_governor::{
    governor::GovernorConfigBuilder, key_extractor::SmartIpKeyExtractor, GovernorLayer,
};
use tower_http::cors::{Any, CorsLayer};
#[cfg(feature = "passkeys")]
use uuid::Uuid;

#[derive(Clone)]
#[allow(clippy::large_enum_variant)]
pub enum InternalUpdate {
    Seed(Seed),
    Events(Events, Vec<(u64, Digest)>),
}

#[derive(Clone, Serialize)]
pub struct ExplorerBlock {
    height: u64,
    view: u64,
    block_digest: String,
    parent: Option<String>,
    tx_hashes: Vec<String>,
    tx_count: usize,
    indexed_at_ms: u64,
}

#[derive(Clone, Serialize)]
pub struct ExplorerTransaction {
    hash: String,
    block_height: u64,
    block_digest: String,
    position: u32,
    public_key: String,
    nonce: u64,
    description: String,
    instruction: String,
}

#[derive(Clone, Default, Serialize)]
pub struct AccountActivity {
    public_key: String,
    txs: Vec<String>,
    events: Vec<String>,
    last_nonce: Option<u64>,
    last_updated_height: Option<u64>,
}

#[derive(Default)]
pub struct ExplorerState {
    indexed_blocks: BTreeMap<u64, ExplorerBlock>,
    blocks_by_hash: HashMap<Digest, ExplorerBlock>,
    txs_by_hash: HashMap<Digest, ExplorerTransaction>,
    accounts: HashMap<PublicKey, AccountActivity>,
}

#[cfg(feature = "passkeys")]
#[derive(Clone, Serialize, Deserialize)]
pub struct PasskeyChallenge {
    challenge: String,
    issued_at_ms: u64,
}

#[cfg(feature = "passkeys")]
#[derive(Clone)]
pub struct PasskeyCredential {
    credential_id: String,
    webauthn_public_key: String,
    ed25519_public_key: String,
    ed25519_private_key: ed25519::PrivateKey,
    created_at_ms: u64,
}

#[cfg(feature = "passkeys")]
#[derive(Clone)]
pub struct PasskeySession {
    token: String,
    credential_id: String,
    issued_at_ms: u64,
    expires_at_ms: u64,
}

#[cfg(feature = "passkeys")]
#[derive(Default)]
pub struct PasskeyStore {
    challenges: HashMap<String, PasskeyChallenge>,
    credentials: HashMap<String, PasskeyCredential>,
    sessions: HashMap<String, PasskeySession>,
}

#[derive(Default)]
pub struct State {
    seeds: BTreeMap<u64, Seed>,

    nodes: BTreeMap<u64, Digest>,
    leaves: BTreeMap<u64, Variable<Digest, Value>>,
    #[allow(clippy::type_complexity)]
    keys: HashMap<Digest, BTreeMap<u64, (u64, Variable<Digest, Value>)>>,
    progress: BTreeMap<u64, (Progress, Certificate<MinSig, Digest>)>,

    submitted_events: HashSet<u64>,
    submitted_state: HashSet<u64>,

    explorer: ExplorerState,
    #[cfg(feature = "passkeys")]
    passkeys: PasskeyStore,
}

#[derive(Clone)]
pub struct Simulator {
    identity: Identity,
    state: Arc<RwLock<State>>,
    update_tx: broadcast::Sender<InternalUpdate>,
    mempool_tx: broadcast::Sender<Pending>,
}

impl Simulator {
    pub fn new(identity: Identity) -> Self {
        let (update_tx, _) = broadcast::channel(1024);
        let (mempool_tx, _) = broadcast::channel(1024);
        let state = Arc::new(RwLock::new(State::default()));

        Self {
            identity,
            state,
            update_tx,
            mempool_tx,
        }
    }
}

impl Simulator {
    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    fn record_event_for_accounts(
        accounts: &mut HashMap<PublicKey, AccountActivity>,
        event: &Event,
        height: u64,
    ) {
        let event_name = match event {
            Event::CasinoPlayerRegistered { .. } => "CasinoPlayerRegistered",
            Event::CasinoGameStarted { .. } => "CasinoGameStarted",
            Event::CasinoGameMoved { .. } => "CasinoGameMoved",
            Event::CasinoGameCompleted { .. } => "CasinoGameCompleted",
            Event::CasinoLeaderboardUpdated { .. } => "CasinoLeaderboardUpdated",
            Event::CasinoError { .. } => "CasinoError",
            Event::TournamentStarted { .. } => "TournamentStarted",
            Event::PlayerJoined { .. } => "PlayerJoined",
            Event::TournamentPhaseChanged { .. } => "TournamentPhaseChanged",
            Event::TournamentEnded { .. } => "TournamentEnded",
            Event::VaultCreated { .. } => "VaultCreated",
            Event::CollateralDeposited { .. } => "CollateralDeposited",
            Event::VusdtBorrowed { .. } => "VusdtBorrowed",
            Event::VusdtRepaid { .. } => "VusdtRepaid",
            Event::AmmSwapped { .. } => "AmmSwapped",
            Event::LiquidityAdded { .. } => "LiquidityAdded",
            Event::LiquidityRemoved { .. } => "LiquidityRemoved",
            Event::Staked { .. } => "Staked",
            Event::Unstaked { .. } => "Unstaked",
            Event::EpochProcessed { .. } => "EpochProcessed",
            Event::RewardsClaimed { .. } => "RewardsClaimed",
        };

        let mut touch_account = |pk: &PublicKey| {
            let activity = accounts
                .entry(pk.clone())
                .or_insert_with(|| AccountActivity {
                    public_key: hex(pk.as_ref()),
                    ..Default::default()
                });
            activity.events.push(event_name.to_string());
            activity.last_updated_height = Some(height);
        };

        match event {
            Event::CasinoPlayerRegistered { player, .. } => touch_account(player),
            Event::CasinoGameStarted { player, .. } => touch_account(player),
            Event::CasinoGameMoved { .. } => {} // broadcasted; not account-specific
            Event::CasinoGameCompleted { player, .. } => touch_account(player),
            Event::CasinoLeaderboardUpdated { .. } => {}
            Event::CasinoError { player, .. } => touch_account(player),
            Event::TournamentStarted { .. } => {}
            Event::PlayerJoined { player, .. } => touch_account(player),
            Event::TournamentPhaseChanged { .. } => {}
            Event::TournamentEnded { rankings, .. } => {
                for (pk, _) in rankings {
                    touch_account(pk);
                }
            }
            Event::VaultCreated { player } => touch_account(player),
            Event::CollateralDeposited { player, .. } => touch_account(player),
            Event::VusdtBorrowed { player, .. } => touch_account(player),
            Event::VusdtRepaid { player, .. } => touch_account(player),
            Event::AmmSwapped { player, .. } => touch_account(player),
            Event::LiquidityAdded { player, .. } => touch_account(player),
            Event::LiquidityRemoved { player, .. } => touch_account(player),
            Event::Staked { player, .. } => touch_account(player),
            Event::Unstaked { player, .. } => touch_account(player),
            Event::RewardsClaimed { player, .. } => touch_account(player),
            Event::EpochProcessed { .. } => {}
        }
    }

    fn describe_game_type(game_type: &nullspace_types::casino::GameType) -> &'static str {
        use nullspace_types::casino::GameType;

        match game_type {
            GameType::Baccarat => "Baccarat",
            GameType::Blackjack => "Blackjack",
            GameType::CasinoWar => "Casino War",
            GameType::Craps => "Craps",
            GameType::VideoPoker => "Video Poker",
            GameType::HiLo => "Hi-Lo",
            GameType::Roulette => "Roulette",
            GameType::SicBo => "Sic Bo",
            GameType::ThreeCard => "Three Card",
            GameType::UltimateHoldem => "Ultimate Hold'em",
        }
    }

    fn describe_instruction(instruction: &nullspace_types::execution::Instruction) -> String {
        use nullspace_types::execution::Instruction;

        match instruction {
            Instruction::CasinoRegister { name } => format!("Register casino player \"{name}\""),
            Instruction::CasinoDeposit { amount } => format!("Deposit {amount} RNG (faucet)"),
            Instruction::CasinoStartGame {
                game_type,
                bet,
                session_id,
            } => format!(
                "Start {} game (bet {bet} RNG, session {session_id})",
                Self::describe_game_type(game_type)
            ),
            Instruction::CasinoGameMove {
                session_id,
                payload,
            } => {
                let bytes = payload.len();
                if bytes == 0 {
                    format!("Casino game move (session {session_id})")
                } else {
                    format!("Casino game move (session {session_id}, {bytes} bytes)")
                }
            }
            Instruction::CasinoToggleShield => "Toggle shield modifier".to_string(),
            Instruction::CasinoToggleDouble => "Toggle double modifier".to_string(),
            Instruction::CasinoToggleSuper => "Toggle super mode".to_string(),
            Instruction::CasinoJoinTournament { tournament_id } => {
                format!("Join tournament {tournament_id}")
            }
            Instruction::CasinoStartTournament {
                tournament_id,
                start_time_ms,
                end_time_ms,
            } => format!(
                "Start tournament {tournament_id} (start {start_time_ms}, end {end_time_ms})"
            ),
            Instruction::CasinoEndTournament { tournament_id } => {
                format!("End tournament {tournament_id}")
            }

            Instruction::Stake { amount, duration } => {
                format!("Stake {amount} RNG for {duration} blocks")
            }
            Instruction::Unstake => "Unstake".to_string(),
            Instruction::ClaimRewards => "Claim staking rewards".to_string(),
            Instruction::ProcessEpoch => "Process epoch".to_string(),

            Instruction::CreateVault => "Create vault".to_string(),
            Instruction::DepositCollateral { amount } => {
                format!("Deposit {amount} RNG as collateral")
            }
            Instruction::BorrowUSDT { amount } => format!("Borrow {amount} vUSDT"),
            Instruction::RepayUSDT { amount } => format!("Repay {amount} vUSDT"),

            Instruction::Swap {
                amount_in,
                min_amount_out,
                is_buying_rng,
            } => {
                if *is_buying_rng {
                    format!("Swap {amount_in} vUSDT for ≥ {min_amount_out} RNG")
                } else {
                    format!("Swap {amount_in} RNG for ≥ {min_amount_out} vUSDT")
                }
            }
            Instruction::AddLiquidity {
                rng_amount,
                usdt_amount,
            } => format!("Add liquidity ({rng_amount} RNG + {usdt_amount} vUSDT)"),
            Instruction::RemoveLiquidity { shares } => {
                format!("Remove liquidity ({shares} LP shares)")
            }
        }
    }

    async fn index_block_from_summary(&self, progress: &Progress, ops: &[Keyless<Output>]) {
        let mut state = self.state.write().await;

        if state.explorer.indexed_blocks.contains_key(&progress.height) {
            return;
        }

        let parent = progress.height.checked_sub(1).and_then(|h| {
            state
                .explorer
                .indexed_blocks
                .get(&h)
                .map(|b| b.block_digest.clone())
        });
        let mut tx_hashes = Vec::new();

        for (idx, op) in ops.iter().enumerate() {
            match op {
                Keyless::Append(Output::Transaction(tx)) => {
                    let digest = tx.digest();
                    let hash_hex = hex(digest.as_ref());
                    tx_hashes.push(hash_hex.clone());
                    let entry = ExplorerTransaction {
                        hash: hash_hex.clone(),
                        block_height: progress.height,
                        block_digest: hex(progress.block_digest.as_ref()),
                        position: idx as u32,
                        public_key: hex(tx.public.as_ref()),
                        nonce: tx.nonce,
                        description: Self::describe_instruction(&tx.instruction),
                        instruction: format!("{:?}", tx.instruction),
                    };
                    state.explorer.txs_by_hash.insert(digest, entry);

                    let activity = state
                        .explorer
                        .accounts
                        .entry(tx.public.clone())
                        .or_insert_with(|| AccountActivity {
                            public_key: hex(tx.public.as_ref()),
                            ..Default::default()
                        });
                    activity.txs.push(hash_hex);
                    activity.last_nonce = Some(tx.nonce);
                    activity.last_updated_height = Some(progress.height);
                }
                Keyless::Append(Output::Event(evt)) => {
                    Self::record_event_for_accounts(
                        &mut state.explorer.accounts,
                        evt,
                        progress.height,
                    );
                }
                _ => {}
            }
        }

        let tx_count = tx_hashes.len();
        let block = ExplorerBlock {
            height: progress.height,
            view: progress.view,
            block_digest: hex(progress.block_digest.as_ref()),
            parent,
            tx_hashes,
            tx_count,
            indexed_at_ms: Self::now_ms(),
        };

        state
            .explorer
            .blocks_by_hash
            .insert(progress.block_digest, block.clone());
        state.explorer.indexed_blocks.insert(progress.height, block);
    }

    pub async fn submit_seed(&self, seed: Seed) {
        {
            let mut state = self.state.write().await;
            if state.seeds.insert(seed.view(), seed.clone()).is_some() {
                return;
            }
        } // Release lock before broadcasting
        if let Err(e) = self.update_tx.send(InternalUpdate::Seed(seed)) {
            tracing::warn!("Failed to broadcast seed update (no subscribers): {}", e);
        }
    }

    pub fn submit_transactions(&self, transactions: Vec<Transaction>) {
        if let Err(e) = self.mempool_tx.send(Pending { transactions }) {
            tracing::warn!("Failed to broadcast transactions (no subscribers): {}", e);
        }
    }

    pub async fn submit_state(&self, summary: Summary, inner: Vec<(u64, Digest)>) {
        let mut state = self.state.write().await;
        if !state.submitted_state.insert(summary.progress.height) {
            return;
        }

        // Store node digests
        for (pos, digest) in inner {
            state.nodes.insert(pos, digest);
        }

        // Store leaves
        let start_loc = summary.progress.state_start_op;
        for (i, value) in summary.state_proof_ops.into_iter().enumerate() {
            // Store in leaves
            let loc = start_loc + i as u64;
            state.leaves.insert(loc, value.clone());

            // Store in keys
            match value {
                Variable::Update(key, value) => {
                    state
                        .keys
                        .entry(key)
                        .or_default()
                        .insert(summary.progress.height, (loc, Variable::Update(key, value)));
                }
                Variable::Delete(key) => {
                    state
                        .keys
                        .entry(key)
                        .or_default()
                        .insert(summary.progress.height, (loc, Variable::Delete(key)));
                }
                _ => {}
            }
        }

        // Store progress at height to build proofs
        state.progress.insert(
            summary.progress.height,
            (summary.progress, summary.certificate),
        );
    }

    pub async fn submit_events(&self, summary: Summary, events_digests: Vec<(u64, Digest)>) {
        let height = summary.progress.height;

        // Check if already submitted before acquiring lock
        {
            let mut state = self.state.write().await;
            if !state.submitted_events.insert(height) {
                return;
            }
        } // Release lock before broadcasting

        // Index blocks/transactions for explorer consumers
        self.index_block_from_summary(&summary.progress, &summary.events_proof_ops)
            .await;

        // Broadcast events with digests for efficient filtering
        if let Err(e) = self.update_tx.send(InternalUpdate::Events(
            Events {
                progress: summary.progress.clone(),
                certificate: summary.certificate.clone(),
                events_proof: summary.events_proof.clone(),
                events_proof_ops: summary.events_proof_ops.clone(),
            },
            events_digests,
        )) {
            tracing::warn!("Failed to broadcast events update (no subscribers): {}", e);
        }
    }

    pub async fn query_state(&self, key: &Digest) -> Option<Lookup> {
        self.try_query_state(key).await
    }

    async fn try_query_state(&self, key: &Digest) -> Option<Lookup> {
        let state = self.state.read().await;

        let key_history = match state.keys.get(key) {
            Some(key_history) => key_history,
            None => return None,
        };
        let (height, operation) = match key_history.last_key_value() {
            Some((height, operation)) => (height, operation),
            None => return None,
        };
        let (loc, Variable::Update(_, value)) = operation else {
            return None;
        };

        // Get progress and certificate
        let (progress, certificate) = match state.progress.get(height) {
            Some(value) => value,
            None => return None,
        };

        // Get required nodes
        let required_digest_positions =
            digests_required_for_proof::<Digest>(progress.state_end_op, *loc, *loc);
        let required_digests = required_digest_positions
            .iter()
            .filter_map(|pos| state.nodes.get(pos).cloned())
            .collect::<Vec<_>>();

        // Verify we got all required digests
        if required_digests.len() != required_digest_positions.len() {
            tracing::error!(
                "Missing node digests: expected {}, got {}",
                required_digest_positions.len(),
                required_digests.len()
            );
            return None;
        }

        // Construct proof
        let proof = create_proof(progress.state_end_op, required_digests);

        Some(Lookup {
            progress: *progress,
            certificate: certificate.clone(),
            proof,
            location: *loc,
            operation: Variable::Update(*key, value.clone()),
        })
    }

    pub async fn query_seed(&self, query: &ChainQuery) -> Option<Seed> {
        self.try_query_seed(query).await
    }

    async fn try_query_seed(&self, query: &ChainQuery) -> Option<Seed> {
        let state = self.state.read().await;
        match query {
            ChainQuery::Latest => state.seeds.last_key_value().map(|(_, seed)| seed.clone()),
            ChainQuery::Index(index) => state.seeds.get(index).cloned(),
        }
    }

    pub fn update_subscriber(&self) -> broadcast::Receiver<InternalUpdate> {
        self.update_tx.subscribe()
    }

    pub fn mempool_subscriber(&self) -> broadcast::Receiver<Pending> {
        self.mempool_tx.subscribe()
    }
}

pub struct Api {
    simulator: Arc<Simulator>,
}

impl Api {
    pub fn new(simulator: Arc<Simulator>) -> Self {
        Self { simulator }
    }

    pub fn router(&self) -> Router {
        // Configure CORS
        let cors = CorsLayer::new()
            .allow_origin(Any)
            .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
            .allow_headers([header::CONTENT_TYPE]);

        // Configure Rate Limiting
        // Maximize throughput for local sims: allow ~1M req/s with a large burst
        let governor_conf = Arc::new(
            GovernorConfigBuilder::default()
                .per_nanosecond(1) // effectively unlimited for local sims (~1B req/s)
                .burst_size(2_000_000)
                .key_extractor(SmartIpKeyExtractor)
                .finish()
                .unwrap(),
        );

        let router = Router::new()
            .route("/submit", post(submit))
            .route("/seed/:query", get(query_seed))
            .route("/state/:query", get(query_state))
            .route("/updates/:filter", get(updates_ws))
            .route("/mempool", get(mempool_ws))
            .route("/explorer/blocks", get(list_blocks))
            .route("/explorer/blocks/:id", get(get_block))
            .route("/explorer/tx/:hash", get(get_transaction))
            .route("/explorer/account/:pubkey", get(get_account_activity))
            .route("/explorer/search", get(search_explorer));

        #[cfg(feature = "passkeys")]
        let router = router
            .route("/webauthn/challenge", get(get_passkey_challenge))
            .route("/webauthn/register", post(register_passkey))
            .route("/webauthn/login", post(login_passkey))
            .route("/webauthn/sign", post(sign_with_passkey));

        router
            .layer(cors)
            .layer(GovernorLayer {
                config: governor_conf,
            })
            .with_state(self.simulator.clone())
    }
}

async fn submit(AxumState(simulator): AxumState<Arc<Simulator>>, body: Bytes) -> impl IntoResponse {
    fn log_summary_decode_stages(bytes: &[u8]) {
        if bytes.is_empty() {
            tracing::warn!("Empty submission body");
            return;
        }
        if bytes[0] != 2 {
            return;
        }

        const MAX_PROOF_NODES: usize = 500;
        const MAX_PROOF_OPS: usize = 500;

        let mut reader = &bytes[1..];
        let progress = match Progress::read(&mut reader) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!("Summary decode failed at progress: {:?}", e);
                return;
            }
        };

        if let Err(e) = Certificate::<MinSig, Digest>::read(&mut reader) {
            tracing::warn!(
                view = progress.view,
                height = progress.height,
                "Summary decode failed at certificate: {:?}",
                e
            );
            return;
        }

        if let Err(e) = Proof::<Digest>::read_cfg(&mut reader, &MAX_PROOF_NODES) {
            tracing::warn!(
                view = progress.view,
                height = progress.height,
                "Summary decode failed at state_proof: {:?}",
                e
            );
            return;
        }

        let state_ops_len = match usize::read_cfg(
            &mut reader,
            &commonware_codec::RangeCfg::from(0..=MAX_PROOF_OPS),
        ) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(
                    view = progress.view,
                    height = progress.height,
                    "Summary decode failed reading state_proof_ops length: {:?}",
                    e
                );
                return;
            }
        };

        let mut state_ops = Vec::with_capacity(state_ops_len);
        for idx in 0..state_ops_len {
            let op_context = reader.first().copied();
            match Variable::<Digest, Value>::read(&mut reader) {
                Ok(op) => state_ops.push(op),
                Err(e) => {
                    let preview_len = core::cmp::min(32, reader.len());
                    tracing::warn!(
                        view = progress.view,
                        height = progress.height,
                        idx,
                        op_context = op_context.map(|b| format!("0x{b:02x}")).unwrap_or_else(|| "EOF".to_string()),
                        remaining = reader.len(),
                        head = %commonware_utils::hex(&reader[..preview_len]),
                        "Summary decode failed at state_proof_ops[{idx}]: {:?}",
                        e
                    );
                    return;
                }
            }
        }

        if let Err(e) = Proof::<Digest>::read_cfg(&mut reader, &MAX_PROOF_NODES) {
            tracing::warn!(
                view = progress.view,
                height = progress.height,
                state_ops = state_ops.len(),
                "Summary decode failed at events_proof: {:?}",
                e
            );
            return;
        }

        if let Err(e) = Vec::<Keyless<Output>>::read_range(&mut reader, 0..=MAX_PROOF_OPS) {
            tracing::warn!(
                view = progress.view,
                height = progress.height,
                state_ops = state_ops.len(),
                "Summary decode failed at events_proof_ops: {:?}",
                e
            );
            return;
        }

        if !reader.is_empty() {
            tracing::warn!(
                view = progress.view,
                height = progress.height,
                state_ops = state_ops.len(),
                remaining = reader.len(),
                "Summary decoded fully but had trailing bytes"
            );
        } else {
            tracing::warn!(
                view = progress.view,
                height = progress.height,
                state_ops = state_ops.len(),
                "Summary decode stages succeeded (unexpected)"
            );
        }
    }

    let submission = match Submission::decode(&mut body.as_ref()) {
        Ok(submission) => submission,
        Err(e) => {
            let preview_len = std::cmp::min(32, body.len());
            log_summary_decode_stages(body.as_ref());
            tracing::warn!(
                len = body.len(),
                head = %commonware_utils::hex(&body[..preview_len]),
                "Failed to decode submission: {:?}",
                e
            );
            return StatusCode::BAD_REQUEST;
        }
    };

    match submission {
        Submission::Seed(seed) => {
            if !seed.verify(NAMESPACE, &simulator.identity) {
                tracing::warn!("Seed verification failed (bad identity or corrupted seed)");
                return StatusCode::BAD_REQUEST;
            }
            simulator.submit_seed(seed).await;
            StatusCode::OK
        }
        Submission::Transactions(txs) => {
            simulator.submit_transactions(txs);
            StatusCode::OK
        }
        Submission::Summary(summary) => {
            let (state_digests, events_digests) = match summary.verify(&simulator.identity) {
                Ok(digests) => digests,
                Err(err) => {
                    tracing::warn!(
                        ?err,
                        view = summary.progress.view,
                        height = summary.progress.height,
                        state_ops = summary.state_proof_ops.len(),
                        events_ops = summary.events_proof_ops.len(),
                        "Summary verification failed"
                    );
                    return StatusCode::BAD_REQUEST;
                }
            };
            simulator
                .submit_events(summary.clone(), events_digests)
                .await;
            simulator.submit_state(summary, state_digests).await;
            StatusCode::OK
        }
    }
}

async fn query_state(
    AxumState(simulator): AxumState<Arc<Simulator>>,
    axum::extract::Path(query): axum::extract::Path<String>,
) -> impl IntoResponse {
    let raw = match from_hex(&query) {
        Some(raw) => raw,
        None => return StatusCode::BAD_REQUEST.into_response(),
    };
    let key = match Digest::decode(&mut raw.as_slice()) {
        Ok(key) => key,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    match simulator.query_state(&key).await {
        Some(value) => (StatusCode::OK, value.encode().to_vec()).into_response(),
        None => (StatusCode::NOT_FOUND, vec![]).into_response(),
    }
}

async fn query_seed(
    AxumState(simulator): AxumState<Arc<Simulator>>,
    axum::extract::Path(query): axum::extract::Path<String>,
) -> impl IntoResponse {
    let raw = match from_hex(&query) {
        Some(raw) => raw,
        None => return StatusCode::BAD_REQUEST.into_response(),
    };
    let query = match ChainQuery::decode(&mut raw.as_slice()) {
        Ok(query) => query,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    match simulator.query_seed(&query).await {
        Some(seed) => (StatusCode::OK, seed.encode().to_vec()).into_response(),
        None => (StatusCode::NOT_FOUND, vec![]).into_response(),
    }
}

async fn updates_ws(
    AxumState(simulator): AxumState<Arc<Simulator>>,
    axum::extract::Path(filter): axum::extract::Path<String>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_updates_ws(socket, simulator, filter))
}

async fn mempool_ws(
    AxumState(simulator): AxumState<Arc<Simulator>>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_mempool_ws(socket, simulator))
}

async fn handle_updates_ws(
    socket: axum::extract::ws::WebSocket,
    simulator: Arc<Simulator>,
    filter: String,
) {
    tracing::info!("Updates WebSocket connected, filter: {}", filter);
    let (mut sender, mut receiver) = socket.split();
    let mut updates = simulator.update_subscriber();

    // Parse filter from URL path using UpdatesFilter
    let filter = match from_hex(&filter) {
        Some(filter) => filter,
        None => {
            tracing::warn!("Failed to parse filter hex");
            let _ = sender.close().await;
            return;
        }
    };
    let subscription = match UpdatesFilter::decode(&mut filter.as_slice()) {
        Ok(subscription) => subscription,
        Err(e) => {
            tracing::warn!("Failed to decode UpdatesFilter: {:?}", e);
            let _ = sender.close().await;
            return;
        }
    };
    tracing::info!("UpdatesFilter parsed successfully: {:?}", subscription);

    // Send updates based on subscription
    loop {
        tokio::select! {
            // Handle incoming WebSocket messages (ping/pong/close)
            msg = receiver.next() => {
                match msg {
                    Some(Ok(axum::extract::ws::Message::Close(_))) => {
                        tracing::info!("Client closed WebSocket connection");
                        break;
                    }
                    Some(Ok(axum::extract::ws::Message::Ping(data))) => {
                        if sender.send(axum::extract::ws::Message::Pong(data)).await.is_err() {
                            tracing::warn!("Failed to send pong, client disconnected");
                            break;
                        }
                    }
                    Some(Err(e)) => {
                        tracing::warn!("WebSocket error: {:?}", e);
                        break;
                    }
                    None => {
                        tracing::info!("WebSocket stream ended");
                        break;
                    }
                    _ => {} // Ignore other message types
                }
            }
            // Handle broadcast updates
            update_result = updates.recv() => {
                match update_result {
                    Ok(internal_update) => {
                        tracing::debug!("Received internal update");
                        // Convert InternalUpdate to Update and apply filtering
                        let update = match internal_update {
                            InternalUpdate::Seed(seed) => {
                                tracing::debug!("Broadcasting Seed update");
                                Some(Update::Seed(seed))
                            }
                            InternalUpdate::Events(events, digests) => match &subscription {
                                UpdatesFilter::All => {
                                    tracing::debug!("Broadcasting Events update (All filter)");
                                    Some(Update::Events(events))
                                }
                                UpdatesFilter::Account(account) => {
                                    tracing::debug!("Filtering Events for account");
                                    filter_updates_for_account(events, digests, account).await
                                }
                            },
                        };
                        let Some(update) = update else {
                            tracing::debug!("Update filtered out");
                            continue;
                        };

                        // Send update
                        tracing::info!("Sending update to WebSocket client");
                        if sender
                            .send(axum::extract::ws::Message::Binary(update.encode().to_vec()))
                            .await
                            .is_err()
                        {
                            tracing::warn!("Failed to send update, client disconnected");
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(
                            "WebSocket client lagged behind, skipped {} messages. Consider increasing buffer size.",
                            skipped
                        );
                        // Continue receiving - client may catch up
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        tracing::info!("Broadcast channel closed");
                        break;
                    }
                }
            }
        }
    }
    tracing::info!("Updates WebSocket handler exiting");
    let _ = sender.close().await;
}

async fn handle_mempool_ws(socket: axum::extract::ws::WebSocket, simulator: Arc<Simulator>) {
    tracing::info!("Mempool WebSocket connected");
    let (mut sender, mut receiver) = socket.split();
    let mut txs = simulator.mempool_subscriber();

    loop {
        tokio::select! {
            // Handle incoming WebSocket messages (ping/pong/close)
            msg = receiver.next() => {
                match msg {
                    Some(Ok(axum::extract::ws::Message::Close(_))) => {
                        tracing::info!("Client closed mempool WebSocket connection");
                        break;
                    }
                    Some(Ok(axum::extract::ws::Message::Ping(data))) => {
                        if sender.send(axum::extract::ws::Message::Pong(data)).await.is_err() {
                            tracing::warn!("Failed to send pong, client disconnected");
                            break;
                        }
                    }
                    Some(Err(e)) => {
                        tracing::warn!("Mempool WebSocket error: {:?}", e);
                        break;
                    }
                    None => {
                        tracing::info!("Mempool WebSocket stream ended");
                        break;
                    }
                    _ => {} // Ignore other message types
                }
            }
            // Handle broadcast transactions
            tx_result = txs.recv() => {
                match tx_result {
                    Ok(tx) => {
                        if sender
                            .send(axum::extract::ws::Message::Binary(tx.encode().to_vec()))
                            .await
                            .is_err()
                        {
                            tracing::warn!("Failed to send mempool update, client disconnected");
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(
                            "Mempool WebSocket client lagged behind, skipped {} messages. Consider increasing buffer size.",
                            skipped
                        );
                        // Continue receiving - client may catch up
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        tracing::info!("Mempool broadcast channel closed");
                        break;
                    }
                }
            }
        }
    }
    tracing::info!("Mempool WebSocket handler exiting");
    let _ = sender.close().await;
}

#[derive(Deserialize)]
struct Pagination {
    offset: Option<usize>,
    limit: Option<usize>,
}

async fn list_blocks(
    AxumState(simulator): AxumState<Arc<Simulator>>,
    Query(pagination): Query<Pagination>,
) -> impl IntoResponse {
    let offset = pagination.offset.unwrap_or(0);
    let limit = pagination.limit.unwrap_or(20).min(200);

    let state = simulator.state.read().await;

    let total = state.explorer.indexed_blocks.len();
    let blocks: Vec<_> = state
        .explorer
        .indexed_blocks
        .iter()
        .rev()
        .skip(offset)
        .take(limit)
        .map(|(_, b)| b.clone())
        .collect();

    let next_offset = if offset + blocks.len() < total {
        Some(offset + blocks.len())
    } else {
        None
    };

    Json(json!({ "blocks": blocks, "next_offset": next_offset, "total": total })).into_response()
}

async fn get_block(
    AxumState(simulator): AxumState<Arc<Simulator>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let state = simulator.state.read().await;

    // Try height first
    let block_opt = if let Ok(height) = id.parse::<u64>() {
        state.explorer.indexed_blocks.get(&height).cloned()
    } else {
        // Try hash
        from_hex(&id)
            .and_then(|raw| Digest::decode(&mut raw.as_slice()).ok())
            .and_then(|digest| state.explorer.blocks_by_hash.get(&digest).cloned())
    };

    match block_opt {
        Some(block) => Json(block).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn get_transaction(
    AxumState(simulator): AxumState<Arc<Simulator>>,
    Path(hash): Path<String>,
) -> impl IntoResponse {
    let raw = match from_hex(&hash) {
        Some(raw) => raw,
        None => return StatusCode::BAD_REQUEST.into_response(),
    };
    let digest = match Digest::decode(&mut raw.as_slice()) {
        Ok(d) => d,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };

    let state = simulator.state.read().await;

    match state.explorer.txs_by_hash.get(&digest) {
        Some(tx) => Json(tx).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn get_account_activity(
    AxumState(simulator): AxumState<Arc<Simulator>>,
    Path(pubkey): Path<String>,
) -> impl IntoResponse {
    let raw = match from_hex(&pubkey) {
        Some(raw) => raw,
        None => return StatusCode::BAD_REQUEST.into_response(),
    };
    let public_key = match ed25519::PublicKey::read(&mut raw.as_slice()) {
        Ok(pk) => pk,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };

    let state = simulator.state.read().await;

    match state.explorer.accounts.get(&public_key) {
        Some(account) => Json(account).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
}

async fn search_explorer(
    AxumState(simulator): AxumState<Arc<Simulator>>,
    Query(params): Query<SearchQuery>,
) -> impl IntoResponse {
    let state = simulator.state.read().await;

    let q = params.q.trim();

    // Height search
    if let Ok(height) = q.parse::<u64>() {
        if let Some(block) = state.explorer.indexed_blocks.get(&height) {
            return Json(json!({"type": "block", "block": block})).into_response();
        }
    }

    // Hex search
    if let Some(raw) = from_hex(q) {
        if raw.len() == 32 {
            if let Ok(digest) = Digest::decode(&mut raw.as_slice()) {
                if let Some(block) = state.explorer.blocks_by_hash.get(&digest) {
                    return Json(json!({"type": "block", "block": block})).into_response();
                }
                if let Some(tx) = state.explorer.txs_by_hash.get(&digest) {
                    return Json(json!({"type": "transaction", "transaction": tx})).into_response();
                }
            }
        }

        // Account search
        if let Ok(pk) = ed25519::PublicKey::read(&mut raw.as_slice()) {
            if let Some(account) = state.explorer.accounts.get(&pk) {
                return Json(json!({"type": "account", "account": account})).into_response();
            }
        }
    }

    StatusCode::NOT_FOUND.into_response()
}

#[cfg(feature = "passkeys")]
#[derive(Serialize)]
struct ChallengeResponse {
    challenge: String,
}

#[cfg(feature = "passkeys")]
async fn get_passkey_challenge(
    AxumState(simulator): AxumState<Arc<Simulator>>,
) -> impl IntoResponse {
    let challenge = Uuid::new_v4().to_string().replace('-', "");
    let issued_at_ms = Simulator::now_ms();
    let passkey_challenge = PasskeyChallenge {
        challenge: challenge.clone(),
        issued_at_ms,
    };

    let mut state = simulator.state.write().await;
    state
        .passkeys
        .challenges
        .insert(challenge.clone(), passkey_challenge);

    Json(ChallengeResponse { challenge }).into_response()
}

#[cfg(feature = "passkeys")]
#[derive(Deserialize)]
struct RegisterRequest {
    credential_id: String,
    webauthn_public_key: String,
    challenge: String,
}

#[cfg(feature = "passkeys")]
#[derive(Serialize)]
struct RegisterResponse {
    credential_id: String,
    ed25519_public_key: String,
}

#[cfg(feature = "passkeys")]
async fn register_passkey(
    AxumState(simulator): AxumState<Arc<Simulator>>,
    Json(req): Json<RegisterRequest>,
) -> impl IntoResponse {
    let mut state = simulator.state.write().await;

    if state.passkeys.challenges.remove(&req.challenge).is_none() {
        return StatusCode::BAD_REQUEST.into_response();
    }

    let mut rng = OsRng;
    let private = ed25519::PrivateKey::from_rng(&mut rng);
    let public = private.public_key();

    let cred = PasskeyCredential {
        credential_id: req.credential_id.clone(),
        webauthn_public_key: req.webauthn_public_key.clone(),
        ed25519_public_key: hex(public.as_ref()),
        ed25519_private_key: private,
        created_at_ms: Simulator::now_ms(),
    };

    state
        .passkeys
        .credentials
        .insert(req.credential_id.clone(), cred);

    Json(RegisterResponse {
        credential_id: req.credential_id,
        ed25519_public_key: hex(public.as_ref()),
    })
    .into_response()
}

#[cfg(feature = "passkeys")]
#[derive(Deserialize)]
struct LoginRequest {
    credential_id: String,
    challenge: String,
}

#[cfg(feature = "passkeys")]
#[derive(Serialize)]
struct LoginResponse {
    session_token: String,
    credential_id: String,
    ed25519_public_key: String,
}

#[cfg(feature = "passkeys")]
async fn login_passkey(
    AxumState(simulator): AxumState<Arc<Simulator>>,
    Json(req): Json<LoginRequest>,
) -> impl IntoResponse {
    let mut state = simulator.state.write().await;

    if state.passkeys.challenges.remove(&req.challenge).is_none() {
        return StatusCode::BAD_REQUEST.into_response();
    }

    let credential = match state.passkeys.credentials.get(&req.credential_id) {
        Some(c) => c.clone(),
        None => return StatusCode::NOT_FOUND.into_response(),
    };

    let token = Uuid::new_v4().to_string();
    let now = Simulator::now_ms();
    let session = PasskeySession {
        token: token.clone(),
        credential_id: credential.credential_id.clone(),
        issued_at_ms: now,
        expires_at_ms: now + 30 * 60 * 1000, // 30 minutes
    };
    state.passkeys.sessions.insert(token.clone(), session);

    Json(LoginResponse {
        session_token: token,
        credential_id: credential.credential_id,
        ed25519_public_key: credential.ed25519_public_key,
    })
    .into_response()
}

#[cfg(feature = "passkeys")]
#[derive(Deserialize)]
struct SignRequest {
    message_hex: String,
}

#[cfg(feature = "passkeys")]
#[derive(Serialize)]
struct SignResponse {
    signature_hex: String,
    public_key: String,
}

#[cfg(feature = "passkeys")]
async fn sign_with_passkey(
    AxumState(simulator): AxumState<Arc<Simulator>>,
    headers: HeaderMap,
    Json(req): Json<SignRequest>,
) -> impl IntoResponse {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.to_string());

    let token = match token {
        Some(t) => t,
        None => return StatusCode::UNAUTHORIZED.into_response(),
    };

    let credential = {
        let mut state = simulator.state.write().await;
        let session = match state.passkeys.sessions.get(&token) {
            Some(s) => s.clone(),
            None => return StatusCode::UNAUTHORIZED.into_response(),
        };

        if session.expires_at_ms < Simulator::now_ms() {
            state.passkeys.sessions.remove(&token);
            return StatusCode::UNAUTHORIZED.into_response();
        }

        match state.passkeys.credentials.get(&session.credential_id) {
            Some(c) => c.clone(),
            None => return StatusCode::UNAUTHORIZED.into_response(),
        }
    };

    let raw = match from_hex(&req.message_hex) {
        Some(raw) => raw,
        None => return StatusCode::BAD_REQUEST.into_response(),
    };
    let signature = credential.ed25519_private_key.sign(
        Some(nullspace_types::execution::TRANSACTION_NAMESPACE),
        &raw,
    );

    Json(SignResponse {
        signature_hex: hex(signature.as_ref()),
        public_key: credential.ed25519_public_key,
    })
    .into_response()
}

async fn filter_updates_for_account(
    events: Events,
    digests: Vec<(u64, Digest)>,
    account: &PublicKey,
) -> Option<Update> {
    // Determine which operations to include
    let mut filtered_ops = Vec::new();
    for (i, op) in events.events_proof_ops.into_iter().enumerate() {
        let should_include = match &op {
            Keyless::Append(output) => match output {
                Output::Event(event) => is_event_relevant_to_account(event, account),
                Output::Transaction(tx) => tx.public == *account,
                _ => false,
            },
            Keyless::Commit(_) => false,
        };
        if should_include {
            // Convert index to absolute location
            filtered_ops.push((events.progress.events_start_op + i as u64, op));
        }
    }

    // If no relevant events, skip this update entirely
    if filtered_ops.is_empty() {
        return None;
    }

    // Create a ProofStore directly from the pre-verified digests
    // Use the size from the original proof, not the operation count
    let proof_store = create_proof_store_from_digests(&events.events_proof, digests);

    // Generate a filtered proof for only the relevant locations
    let locations_to_include = filtered_ops.iter().map(|(loc, _)| *loc).collect::<Vec<_>>();
    let filtered_proof = match create_multi_proof(&proof_store, &locations_to_include).await {
        Ok(proof) => proof,
        Err(e) => {
            tracing::error!("Failed to generate filtered proof: {:?}", e);
            return None;
        }
    };
    Some(Update::FilteredEvents(FilteredEvents {
        progress: events.progress,
        certificate: events.certificate,
        events_proof: filtered_proof,
        events_proof_ops: filtered_ops,
    }))
}

fn is_event_relevant_to_account(event: &Event, account: &PublicKey) -> bool {
    match event {
        // Casino events - check if player matches
        Event::CasinoPlayerRegistered { player, .. } => player == account,
        Event::CasinoGameStarted { player, .. } => player == account,
        Event::CasinoGameMoved { .. } => true, // Broadcast all moves - clients filter by session_id
        Event::CasinoGameCompleted { player, .. } => player == account,
        Event::CasinoLeaderboardUpdated { .. } => true, // Leaderboard updates are public
        Event::CasinoError { player, .. } => player == account,
        // Tournament events
        Event::TournamentStarted { .. } => true, // Tournament start is public
        Event::PlayerJoined { player, .. } => player == account,
        Event::TournamentPhaseChanged { .. } => true, // Phase changes are public
        Event::TournamentEnded { rankings, .. } => {
            // Check if account is in the rankings
            rankings.iter().any(|(player, _)| player == account)
        }
        // Liquidity / Vault events
        Event::VaultCreated { player } => player == account,
        Event::CollateralDeposited { player, .. } => player == account,
        Event::VusdtBorrowed { player, .. } => player == account,
        Event::VusdtRepaid { player, .. } => player == account,
        Event::AmmSwapped { player, .. } => player == account,
        Event::LiquidityAdded { player, .. } => player == account,
        Event::LiquidityRemoved { player, .. } => player == account,
        // Staking events
        Event::Staked { player, .. } => player == account,
        Event::Unstaked { player, .. } => player == account,
        Event::RewardsClaimed { player, .. } => player == account,
        Event::EpochProcessed { .. } => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use commonware_cryptography::{Hasher, Sha256};
    use commonware_runtime::{deterministic::Runner, Runner as _};
    use commonware_storage::store::operation::Variable;
    use nullspace_execution::mocks::{
        create_account_keypair, create_adbs, create_network_keypair, create_seed, execute_block,
    };
    use nullspace_types::execution::{Instruction, Key, Transaction, Value};

    #[tokio::test]
    async fn test_submit_seed() {
        let (network_secret, network_identity) = create_network_keypair();
        let simulator = Simulator::new(network_identity);
        let mut update_stream = simulator.update_subscriber();

        // Submit seed
        let seed = create_seed(&network_secret, 1);
        simulator.submit_seed(seed.clone()).await;
        let received_update = update_stream.recv().await.unwrap();
        match received_update {
            InternalUpdate::Seed(received_seed) => assert_eq!(received_seed, seed),
            _ => panic!("Expected seed update"),
        }
        assert_eq!(
            simulator.query_seed(&ChainQuery::Latest).await,
            Some(seed.clone())
        );
        assert_eq!(
            simulator.query_seed(&ChainQuery::Index(1)).await,
            Some(seed)
        );

        // Submit another seed
        let seed = create_seed(&network_secret, 3);
        simulator.submit_seed(seed.clone()).await;
        let received_update = update_stream.recv().await.unwrap();
        match received_update {
            InternalUpdate::Seed(received_seed) => assert_eq!(received_seed, seed),
            _ => panic!("Expected seed update"),
        }
        assert_eq!(
            simulator.query_seed(&ChainQuery::Latest).await,
            Some(seed.clone())
        );
        assert_eq!(simulator.query_seed(&ChainQuery::Index(2)).await, None);
        assert_eq!(
            simulator.query_seed(&ChainQuery::Index(3)).await,
            Some(seed.clone())
        );
    }

    #[tokio::test]
    async fn test_submit_transaction() {
        let (_, network_identity) = create_network_keypair();
        let simulator = Simulator::new(network_identity);
        let mut mempool_rx = simulator.mempool_subscriber();

        let (private, _) = create_account_keypair(1);
        let tx = Transaction::sign(
            &private,
            1,
            Instruction::CasinoRegister {
                name: "TestPlayer".to_string(),
            },
        );

        simulator.submit_transactions(vec![tx.clone()]);

        let received_txs = mempool_rx.recv().await.unwrap();
        assert_eq!(received_txs.transactions.len(), 1);
        let received_tx = &received_txs.transactions[0];
        assert_eq!(received_tx.public, tx.public);
        assert_eq!(received_tx.nonce, tx.nonce);
    }

    #[test]
    fn test_submit_summary() {
        let executor = Runner::default();
        executor.start(|context| async move {
            // Initialize databases
            let (network_secret, network_identity) = create_network_keypair();
            let simulator = Simulator::new(network_identity);
            let (mut state, mut events) = create_adbs(&context).await;

            // Create mock transaction - register a casino player
            let (private, public) = create_account_keypair(1);
            let tx = Transaction::sign(
                &private,
                0,
                Instruction::CasinoRegister {
                    name: "TestPlayer".to_string(),
                },
            );

            // Create summary using helper
            let (_, summary) = execute_block(
                &network_secret,
                network_identity,
                &mut state,
                &mut events,
                1, // view
                vec![tx],
            )
            .await;

            // Verify the summary
            let (state_digests, events_digests) = summary
                .verify(&network_identity)
                .expect("Summary verification failed");

            // Submit events
            let mut update_stream = simulator.update_subscriber();
            simulator
                .submit_events(summary.clone(), events_digests)
                .await;

            // Wait for events
            let update_recv = update_stream.recv().await.unwrap();
            match update_recv {
                InternalUpdate::Events(events_recv, _) => {
                    events_recv.verify(&network_identity).unwrap();
                    assert_eq!(events_recv.events_proof, summary.events_proof);
                    assert_eq!(events_recv.events_proof_ops, summary.events_proof_ops);
                }
                _ => panic!("Expected events update"),
            }

            // Submit state
            simulator.submit_state(summary.clone(), state_digests).await;

            // Query for state
            let account_key = Sha256::hash(&Key::Account(public.clone()).encode());
            let lookup = simulator.query_state(&account_key).await.unwrap();
            lookup.verify(&network_identity).unwrap();
            let Variable::Update(_, Value::Account(account)) = lookup.operation else {
                panic!("account not found");
            };
            assert_eq!(account.nonce, 1);

            // Query for non-existent account
            let (_, other_public) = create_account_keypair(2);
            let other_key = Sha256::hash(&Key::Account(other_public).encode());
            assert!(simulator.query_state(&other_key).await.is_none());
        });
    }

    #[test]
    fn test_filtered_events() {
        let executor = Runner::default();
        executor.start(|context| async move {
            // Initialize
            let (network_secret, network_identity) = create_network_keypair();
            let simulator = Simulator::new(network_identity);
            let (mut state, mut events) = create_adbs(&context).await;

            // Create multiple accounts
            let (private1, public1) = create_account_keypair(1);
            let (private2, _public2) = create_account_keypair(2);
            let (private3, _public3) = create_account_keypair(3);

            // Create transactions from all accounts - register casino players
            let txs = vec![
                Transaction::sign(
                    &private1,
                    0,
                    Instruction::CasinoRegister {
                        name: "Player1".to_string(),
                    },
                ),
                Transaction::sign(
                    &private2,
                    0,
                    Instruction::CasinoRegister {
                        name: "Player2".to_string(),
                    },
                ),
                Transaction::sign(
                    &private3,
                    0,
                    Instruction::CasinoRegister {
                        name: "Player3".to_string(),
                    },
                ),
            ];

            // Execute block
            let (_, summary) = execute_block(
                &network_secret,
                network_identity,
                &mut state,
                &mut events,
                1, // view
                txs,
            )
            .await;

            // Submit the summary
            let (state_digests, events_digests) = summary.verify(&network_identity).unwrap();
            simulator
                .submit_events(summary.clone(), events_digests.clone())
                .await;
            simulator.submit_state(summary.clone(), state_digests).await;

            // Store original count before moving
            let original_ops_count = summary.events_proof_ops.len();

            let events = Events {
                progress: summary.progress,
                certificate: summary.certificate,
                events_proof: summary.events_proof,
                events_proof_ops: summary.events_proof_ops,
            };

            // Apply filter
            let filtered = filter_updates_for_account(events, events_digests, &public1)
                .await
                .unwrap();

            // Verify filtered events
            match filtered {
                Update::FilteredEvents(filtered_events) => {
                    // Count how many events are included
                    let included_count = filtered_events.events_proof_ops.len();

                    // Verify we only have events related to account1
                    for (_loc, op) in &filtered_events.events_proof_ops {
                        if let Keyless::Append(Output::Event(Event::CasinoPlayerRegistered {
                            player,
                            ..
                        })) = op
                        {
                            assert_eq!(
                                player, &public1,
                                "Filtered events should only contain account1"
                            );
                        }
                    }

                    // We should have filtered out events for account2 and account3
                    assert!(
                        included_count > 0,
                        "Should have at least one included event"
                    );
                    assert!(
                        included_count < original_ops_count,
                        "Should have filtered out some events"
                    );

                    // Verify the proof still validates with multi-proof verification
                    filtered_events
                        .verify(&network_identity)
                        .expect("Multi-proof verification should pass");
                }
                _ => panic!("Expected FilteredEvents"),
            }
        });
    }

    #[test]
    fn test_multiple_transactions_per_block() {
        let executor = Runner::default();
        executor.start(|context| async move {
            // Initialize
            let (network_secret, network_identity) = create_network_keypair();
            let simulator = Simulator::new(network_identity);
            let (mut state, mut events) = create_adbs(&context).await;

            // Create multiple accounts
            let accounts: Vec<_> = (0..5).map(create_account_keypair).collect();

            // Block 1: Multiple casino registrations in a single block
            let txs1: Vec<_> = accounts
                .iter()
                .enumerate()
                .map(|(i, (private, _))| {
                    Transaction::sign(
                        private,
                        0,
                        Instruction::CasinoRegister {
                            name: format!("Player{}", i),
                        },
                    )
                })
                .collect();

            let (_, summary1) = execute_block(
                &network_secret,
                network_identity,
                &mut state,
                &mut events,
                1, // view
                txs1.clone(),
            )
            .await;

            // Verify and submit
            let (state_digests1, events_digests1) = summary1
                .verify(&network_identity)
                .expect("Summary 1 verification failed");
            simulator
                .submit_events(summary1.clone(), events_digests1)
                .await;
            simulator
                .submit_state(summary1.clone(), state_digests1)
                .await;

            // Verify height was inferred correctly (should be 1)
            assert_eq!(summary1.progress.height, 1);

            // Query each account to verify they were created
            for (_, public) in accounts.iter() {
                let account_key = Sha256::hash(&Key::Account(public.clone()).encode());
                let lookup = simulator.query_state(&account_key).await.unwrap();
                lookup.verify(&network_identity).unwrap();
                let Variable::Update(_, Value::Account(account)) = lookup.operation else {
                    panic!("Account not found for {public:?}");
                };
                assert_eq!(account.nonce, 1);
            }

            // Block 2: Deposit chips to subset of accounts
            let txs2: Vec<_> = accounts
                .iter()
                .take(3)
                .map(|(private, _)| {
                    Transaction::sign(private, 1, Instruction::CasinoDeposit { amount: 1000 })
                })
                .collect();

            let (_, summary2) = execute_block(
                &network_secret,
                network_identity,
                &mut state,
                &mut events,
                5, // view
                txs2,
            )
            .await;

            // Verify and submit
            let (state_digests2, events_digests2) = summary2
                .verify(&network_identity)
                .expect("Summary 2 verification failed");
            simulator
                .submit_events(summary2.clone(), events_digests2)
                .await;
            simulator
                .submit_state(summary2.clone(), state_digests2)
                .await;

            // Verify height was inferred correctly (should be 2)
            assert_eq!(summary2.progress.height, 2);

            // Query accounts to verify nonce updates
            for (i, (_, public)) in accounts.iter().enumerate() {
                let account_key = Sha256::hash(&Key::Account(public.clone()).encode());
                let lookup = simulator.query_state(&account_key).await.unwrap();
                lookup.verify(&network_identity).unwrap();
                let Variable::Update(_, Value::Account(account)) = lookup.operation else {
                    panic!("Account not found for {public:?}");
                };
                // First 3 accounts should have nonce 2, others still 1
                let expected_nonce = if i < 3 { 2 } else { 1 };
                assert_eq!(account.nonce, expected_nonce);
            }
        });
    }
}
