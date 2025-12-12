use axum::{
    body::Bytes,
    extract::{ws::WebSocketUpgrade, State as AxumState},
    http::{header, Method, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Router,
};
use commonware_codec::{DecodeExt, Encode};
use commonware_consensus::{aggregation::types::Certificate, Viewable};
use commonware_cryptography::{
    bls12381::primitives::variant::MinSig, ed25519::PublicKey, sha256::Digest,
};
use commonware_storage::{
    adb::{
        create_multi_proof, create_proof, create_proof_store_from_digests,
        digests_required_for_proof,
    },
    store::operation::{Keyless, Variable},
};
use commonware_utils::from_hex;
use futures::{SinkExt, StreamExt};
use nullspace_types::{
    api::{Events, FilteredEvents, Lookup, Pending, Submission, Summary, Update, UpdatesFilter},
    execution::{Event, Output, Progress, Seed, Transaction, Value},
    Identity, Query, NAMESPACE,
};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{Arc, RwLock},
};
use tokio::sync::broadcast;
use tower_governor::{
    governor::GovernorConfigBuilder, key_extractor::SmartIpKeyExtractor, GovernorLayer,
};
use tower_http::cors::{Any, CorsLayer};

#[derive(Clone)]
#[allow(clippy::large_enum_variant)]
pub enum InternalUpdate {
    Seed(Seed),
    Events(Events, Vec<(u64, Digest)>),
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
    pub fn submit_seed(&self, seed: Seed) {
        let mut state = match self.state.write() {
            Ok(state) => state,
            Err(e) => {
                tracing::error!("Failed to acquire write lock in submit_seed: {}", e);
                return;
            }
        };
        if state.seeds.insert(seed.view(), seed.clone()).is_some() {
            return;
        }
        drop(state); // Release lock before broadcasting
        if let Err(e) = self.update_tx.send(InternalUpdate::Seed(seed)) {
            tracing::warn!("Failed to broadcast seed update (no subscribers): {}", e);
        }
    }

    pub fn submit_transactions(&self, transactions: Vec<Transaction>) {
        if let Err(e) = self.mempool_tx.send(Pending { transactions }) {
            tracing::warn!("Failed to broadcast transactions (no subscribers): {}", e);
        }
    }

    pub fn submit_state(&self, summary: Summary, inner: Vec<(u64, Digest)>) {
        let mut state = match self.state.write() {
            Ok(state) => state,
            Err(e) => {
                tracing::error!("Failed to acquire write lock in submit_state: {}", e);
                return;
            }
        };
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

    pub fn submit_events(&self, summary: Summary, events_digests: Vec<(u64, Digest)>) {
        let height = summary.progress.height;

        // Check if already submitted before acquiring lock
        {
            let mut state = match self.state.write() {
                Ok(state) => state,
                Err(e) => {
                    tracing::error!("Failed to acquire write lock in submit_events: {}", e);
                    return;
                }
            };
            if !state.submitted_events.insert(height) {
                return;
            }
        } // Release lock before broadcasting

        // Broadcast events with digests for efficient filtering
        if let Err(e) = self.update_tx.send(InternalUpdate::Events(
            Events {
                progress: summary.progress,
                certificate: summary.certificate,
                events_proof: summary.events_proof,
                events_proof_ops: summary.events_proof_ops,
            },
            events_digests,
        )) {
            tracing::warn!("Failed to broadcast events update (no subscribers): {}", e);
        }
    }

    pub fn query_state(&self, key: &Digest) -> Option<Lookup> {
        let state = match self.state.read() {
            Ok(state) => state,
            Err(e) => {
                tracing::error!("Failed to acquire read lock in query_state: {}", e);
                return None;
            }
        };
        let (height, operation) = state.keys.get(key)?.last_key_value()?;
        let (loc, Variable::Update(_, value)) = operation else {
            return None;
        };

        // Get progress and certificate
        let (progress, certificate) = state.progress.get(height)?;

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

    pub fn query_seed(&self, query: &Query) -> Option<Seed> {
        let state = match self.state.read() {
            Ok(state) => state,
            Err(e) => {
                tracing::error!("Failed to acquire read lock in query_seed: {}", e);
                return None;
            }
        };
        match query {
            Query::Latest => state.seeds.last_key_value().map(|(_, seed)| seed.clone()),
            Query::Index(index) => state.seeds.get(index).cloned(),
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

        Router::new()
            .route("/submit", post(submit))
            .route("/seed/:query", get(query_seed))
            .route("/state/:query", get(query_state))
            .route("/updates/:filter", get(updates_ws))
            .route("/mempool", get(mempool_ws))
            .layer(cors)
            .layer(GovernorLayer {
                config: governor_conf,
            })
            .with_state(self.simulator.clone())
    }
}

async fn submit(AxumState(simulator): AxumState<Arc<Simulator>>, body: Bytes) -> impl IntoResponse {
    let submission = match Submission::decode(&mut body.as_ref()) {
        Ok(submission) => submission,
        Err(_) => return StatusCode::BAD_REQUEST,
    };

    match submission {
        Submission::Seed(seed) => {
            if !seed.verify(NAMESPACE, &simulator.identity) {
                return StatusCode::BAD_REQUEST;
            }
            simulator.submit_seed(seed);
            StatusCode::OK
        }
        Submission::Transactions(txs) => {
            simulator.submit_transactions(txs);
            StatusCode::OK
        }
        Submission::Summary(summary) => {
            let Some((state_digests, events_digests)) = summary.verify(&simulator.identity) else {
                return StatusCode::BAD_REQUEST;
            };
            simulator.submit_events(summary.clone(), events_digests);
            simulator.submit_state(summary, state_digests);
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
    match simulator.query_state(&key) {
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
    let query = match Query::decode(&mut raw.as_slice()) {
        Ok(query) => query,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    match simulator.query_seed(&query) {
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use commonware_cryptography::{Hasher, Sha256};
    use commonware_runtime::{deterministic::Runner, Runner as _};
    use commonware_storage::store::operation::Variable;
    use futures::executor::block_on;
    use nullspace_execution::mocks::{
        create_account_keypair, create_adbs, create_network_keypair, create_seed, execute_block,
    };
    use nullspace_types::execution::{Instruction, Key, Transaction, Value};

    #[test]
    fn test_submit_seed() {
        let (network_secret, network_identity) = create_network_keypair();
        let simulator = Simulator::new(network_identity);
        let mut update_stream = simulator.update_subscriber();

        // Submit seed
        let seed = create_seed(&network_secret, 1);
        simulator.submit_seed(seed.clone());
        let received_update = block_on(async { update_stream.recv().await.unwrap() });
        match received_update {
            InternalUpdate::Seed(received_seed) => assert_eq!(received_seed, seed),
            _ => panic!("Expected seed update"),
        }
        assert_eq!(simulator.query_seed(&Query::Latest), Some(seed.clone()));
        assert_eq!(simulator.query_seed(&Query::Index(1)), Some(seed));

        // Submit another seed
        let seed = create_seed(&network_secret, 3);
        simulator.submit_seed(seed.clone());
        let received_update = block_on(async { update_stream.recv().await.unwrap() });
        match received_update {
            InternalUpdate::Seed(received_seed) => assert_eq!(received_seed, seed),
            _ => panic!("Expected seed update"),
        }
        assert_eq!(simulator.query_seed(&Query::Latest), Some(seed.clone()));
        assert_eq!(simulator.query_seed(&Query::Index(2)), None);
        assert_eq!(simulator.query_seed(&Query::Index(3)), Some(seed.clone()));
    }

    #[test]
    fn test_submit_transaction() {
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

        let received_txs = block_on(async { mempool_rx.recv().await.unwrap() });
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
            simulator.submit_events(summary.clone(), events_digests);

            // Wait for events
            let update_recv = update_stream.recv().await.unwrap();
            match update_recv {
                InternalUpdate::Events(events_recv, _) => {
                    assert!(events_recv.verify(&network_identity));
                    assert_eq!(events_recv.events_proof, summary.events_proof);
                    assert_eq!(events_recv.events_proof_ops, summary.events_proof_ops);
                }
                _ => panic!("Expected events update"),
            }

            // Submit state
            simulator.submit_state(summary.clone(), state_digests);

            // Query for state
            let account_key = Sha256::hash(&Key::Account(public.clone()).encode());
            let lookup = simulator.query_state(&account_key).unwrap();
            assert!(lookup.verify(&network_identity));
            let Variable::Update(_, Value::Account(account)) = lookup.operation else {
                panic!("account not found");
            };
            assert_eq!(account.nonce, 1);

            // Query for non-existent account
            let (_, other_public) = create_account_keypair(2);
            let other_key = Sha256::hash(&Key::Account(other_public).encode());
            assert!(simulator.query_state(&other_key).is_none());
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
            simulator.submit_events(summary.clone(), events_digests.clone());
            simulator.submit_state(summary.clone(), state_digests);

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
                    assert!(
                        filtered_events.verify(&network_identity),
                        "Multi-proof verification should pass"
                    );
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
            simulator.submit_events(summary1.clone(), events_digests1);
            simulator.submit_state(summary1.clone(), state_digests1);

            // Verify height was inferred correctly (should be 1)
            assert_eq!(summary1.progress.height, 1);

            // Query each account to verify they were created
            for (_, public) in accounts.iter() {
                let account_key = Sha256::hash(&Key::Account(public.clone()).encode());
                let lookup = simulator.query_state(&account_key).unwrap();
                assert!(lookup.verify(&network_identity));
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
            simulator.submit_events(summary2.clone(), events_digests2);
            simulator.submit_state(summary2.clone(), state_digests2);

            // Verify height was inferred correctly (should be 2)
            assert_eq!(summary2.progress.height, 2);

            // Query accounts to verify nonce updates
            for (i, (_, public)) in accounts.iter().enumerate() {
                let account_key = Sha256::hash(&Key::Account(public.clone()).encode());
                let lookup = simulator.query_state(&account_key).unwrap();
                assert!(lookup.verify(&network_identity));
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
