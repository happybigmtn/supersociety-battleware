#[cfg(feature = "testing")]
use battleware_execution::mocks;
#[cfg(feature = "testing")]
use battleware_types::api::Summary;
use battleware_types::{
    api::{Lookup, Submission, Update, UpdatesFilter},
    execution::{
        transaction_namespace, Event, Instruction, Key, Output,
        Seed, Transaction as ExecutionTransaction, Value, NAMESPACE,
    },
    Identity, Query,
};
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
use rand::rngs::OsRng;
#[cfg(feature = "testing")]
use rand::SeedableRng;
#[cfg(feature = "testing")]
use rand_chacha::ChaCha20Rng;
use serde::Serialize;
use serde_wasm_bindgen::Serializer;
use wasm_bindgen::prelude::*;

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
            .sign(Some(&transaction_namespace(NAMESPACE)), message)
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

    /// Sign a new casino start game transaction.
    #[wasm_bindgen]
    pub fn casino_start_game(
        signer: &Signer,
        nonce: u64,
        game_type: u8,
        bet: u64,
        session_id: u64,
    ) -> Result<Transaction, JsValue> {
        use battleware_types::casino::GameType;
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
            _ => return Err(JsValue::from_str(&format!("Invalid game type: {}", game_type))),
        };
        let instruction = Instruction::CasinoStartGame { game_type, bet, session_id };
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

    /// Sign a new casino register transaction.
    #[wasm_bindgen]
    pub fn casino_register(signer: &Signer, nonce: u64, name: &str) -> Result<Transaction, JsValue> {
        let instruction = Instruction::CasinoRegister { name: name.to_string() };
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
                "name": player.name,
                "chips": player.chips,
                "shields": player.shields,
                "doubles": player.doubles,
                "active_shield": player.active_shield,
                "active_double": player.active_double,
                "active_session": player.active_session
            })
        }
        Value::CasinoSession(session) => {
            serde_json::json!({
                "type": "CasinoSession",
                "id": session.id,
                "player": hex(&session.player.encode()),
                "game_type": format!("{:?}", session.game_type),
                "bet": session.bet,
                "state_blob": hex(&session.state_blob),
                "move_count": session.move_count,
                "is_complete": session.is_complete
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
            serde_json::json!({
                "type": "Tournament",
                "id": tournament.id,
                "phase": format!("{:?}", tournament.phase)
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
    if !lookup.verify(&identity) {
        return Err(JsValue::from_str("Lookup verification failed"));
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
        // Tournament events
        Event::TournamentStarted { id, start_block } => {
            serde_json::json!({
                "type": "TournamentStarted",
                "id": id,
                "start_block": start_block
            })
        }
        Event::PlayerJoined { tournament_id, player } => {
            serde_json::json!({
                "type": "PlayerJoined",
                "tournament_id": tournament_id,
                "player": hex(&player.encode())
            })
        }
        Event::TournamentPhaseChanged { id, phase } => {
            let phase_str = match phase {
                battleware_types::casino::TournamentPhase::Registration => "Registration",
                battleware_types::casino::TournamentPhase::Active => "Active",
                battleware_types::casino::TournamentPhase::Complete => "Complete",
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
            let instruction = match &tx.instruction {
                // Casino instructions
                Instruction::CasinoRegister { .. } => "CasinoRegister",
                Instruction::CasinoDeposit { .. } => "CasinoDeposit",
                Instruction::CasinoStartGame { .. } => "CasinoStartGame",
                Instruction::CasinoGameMove { .. } => "CasinoGameMove",
                Instruction::CasinoToggleShield => "CasinoToggleShield",
                Instruction::CasinoToggleDouble => "CasinoToggleDouble",
                Instruction::CasinoJoinTournament { .. } => "CasinoJoinTournament",
            };
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
            if !events.verify(&identity) {
                return Err(JsValue::from_str("Invalid events signature or proof"));
            }
            process_events(events.events_proof_ops.iter())
        }
        Update::FilteredEvents(events) => {
            // Verify the filtered events signature and proof
            if !events.verify(&identity) {
                return Err(JsValue::from_str(
                    "Invalid filtered events signature or proof",
                ));
            }
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
