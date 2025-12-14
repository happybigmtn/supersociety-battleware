//! Development executor - processes transactions submitted to the simulator
//!
//! This is a simple executor for local development that:
//! 1. Connects to the simulator's mempool WebSocket
//! 2. Collects pending transactions
//! 3. Executes blocks periodically
//! 4. Submits block summaries back to the simulator

use clap::Parser;
use commonware_codec::DecodeExt;
use commonware_consensus::Viewable;
use commonware_runtime::{tokio as cw_tokio, Runner};
use futures_util::StreamExt;
use nullspace_client::Client;
use nullspace_execution::mocks::{create_adbs, create_network_keypair, execute_block};
use nullspace_types::{api, execution::Transaction, Identity};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

/// Maximum pending transactions to prevent OOM
const MAX_PENDING_TXS: usize = 100_000;

#[derive(Parser, Debug)]
#[command(author, version, about = "Development executor for local testing")]
struct Args {
    #[arg(short, long, default_value = "http://localhost:8080")]
    url: String,

    #[arg(short, long)]
    identity: String,

    #[arg(short, long, default_value = "100")]
    block_interval_ms: u64,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Parse args
    let args = Args::parse();

    // Setup logging
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::DEBUG)
        .init();

    // Parse identity
    let identity_bytes =
        commonware_utils::from_hex(&args.identity).ok_or("Invalid identity hex format")?;
    let identity: Identity = Identity::decode(&mut identity_bytes.as_slice())
        .map_err(|_| "Failed to decode identity")?;

    // Get network secret from the same seed used to create identity
    let (network_secret, network_identity) = create_network_keypair();

    // Verify identity matches
    if network_identity != identity {
        return Err("Identity mismatch - use the identity from get_identity example".into());
    }

    info!(url = %args.url, "Starting dev executor");

    // Create client
    let client = Client::new(&args.url, identity)?;
    let ws_url = format!("{}/mempool", args.url.replace("http://", "ws://"));
    let block_interval_ms = args.block_interval_ms;

    // Run executor using commonware runtime with panic catching
    let cfg = cw_tokio::Config::default().with_catch_panics(true);
    let executor = cw_tokio::Runner::new(cfg);
    executor.start(|context| async move {
        // Create state and events databases (persistent across reconnections)
        let (mut state, mut events) = create_adbs(&context).await;
        let mut pending_txs: Vec<Transaction> = Vec::new();
        let mut view: u64 = match client.query_seed(api::Query::Latest).await {
            Ok(Some(seed)) => seed.view() + 1,
            Ok(None) => 1,
            Err(e) => {
                warn!(?e, "Failed to query latest seed, assuming new chain");
                1
            }
        };
        let block_interval = Duration::from_millis(block_interval_ms);
        let mut last_block_time = std::time::Instant::now();

        // Bootstrap the chain with a genesis block (empty txs) if needed so the frontend
        // doesn't report CHAIN_OFFLINE before any user transactions arrive.
        if view == 1 {
            info!("No existing seed found, submitting genesis block");
            let (seed, summary) = execute_block(
                &network_secret,
                network_identity,
                &mut state,
                &mut events,
                view,
                Vec::new(),
            )
            .await;

            if let Err(err) = summary.verify(&network_identity) {
                warn!(?err, "Genesis summary verification failed");
            }

            if let Err(e) = client.submit_seed(seed).await {
                warn!(?e, "Failed to submit genesis seed");
            }
            if let Err(e) = client.submit_summary(summary).await {
                warn!(?e, "Failed to submit genesis summary");
            }

            info!(view, "Genesis block executed and submitted");
            view += 1;
        }

        // Outer reconnection loop
        loop {
            // Connect to mempool using tokio-tungstenite directly
            info!(url = %ws_url, "Connecting to mempool...");
            let ws_stream = match tokio_tungstenite::connect_async(&ws_url).await {
                Ok((stream, _)) => stream,
                Err(e) => {
                    warn!(?e, "Failed to connect to mempool, retrying in 2 seconds...");
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                }
            };
            info!("WebSocket connected");

            let (_, mut read) = ws_stream.split();

            // Inner message processing loop
            loop {
                // Use tokio::select! with timeout to ensure periodic block execution
                tokio::select! {
                    biased;

                    // Short timeout to ensure we don't block forever
                    _ = tokio::time::sleep(Duration::from_millis(10)) => {}

                    // Process WebSocket messages
                    msg = read.next() => {
                        match msg {
                            Some(Ok(Message::Binary(data))) => {
                                match api::Pending::decode(&mut data.as_slice()) {
                                    Ok(pending) => {
                                        let tx_count = pending.transactions.len();
                                        if tx_count > 0 {
                                            // Prevent OOM by limiting pending transactions
                                            if pending_txs.len() + tx_count > MAX_PENDING_TXS {
                                                warn!(
                                                    current = pending_txs.len(),
                                                    incoming = tx_count,
                                                    max = MAX_PENDING_TXS,
                                                    "Dropping transactions - pending queue full"
                                                );
                                            } else {
                                                info!(count = tx_count, total_pending = pending_txs.len() + tx_count, "Adding transactions to pending queue");
                                                pending_txs.extend(pending.transactions);
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        warn!(?e, "Failed to decode Pending");
                                    }
                                }
                            }
                            Some(Ok(Message::Text(text))) => {
                                info!(text = %text, "Received text message from mempool");
                            }
                            Some(Ok(Message::Ping(_))) => {}
                            Some(Ok(Message::Pong(_))) => {}
                            Some(Ok(Message::Close(frame))) => {
                                warn!(?frame, "Mempool WebSocket closed, reconnecting...");
                                break;
                            }
                            Some(Ok(Message::Frame(_))) => {}
                            Some(Err(e)) => {
                                warn!(?e, "Mempool WebSocket error, reconnecting...");
                                break;
                            }
                            None => {
                                warn!("Mempool WebSocket stream ended, reconnecting...");
                                break;
                            }
                        }
                    }
                }

                // Check if it's time to execute a block (regardless of WebSocket messages)
                let elapsed = last_block_time.elapsed();
                if elapsed >= block_interval {
                    if pending_txs.is_empty() {
                        // Reset timer even if no transactions to avoid log spam
                        last_block_time = std::time::Instant::now();
                    } else {
                        let txs = std::mem::take(&mut pending_txs);
                        info!(count = txs.len(), view, elapsed_ms = elapsed.as_millis(), "Executing block");

                        // Execute block
                        let (seed, summary) = execute_block(
                            &network_secret,
                            network_identity,
                            &mut state,
                            &mut events,
                            view,
                            txs,
                        )
                        .await;

                        // Verify and get digests
                        let (_state_digests, _events_digests) = match summary.verify(&network_identity) {
                            Ok(digests) => digests,
                            Err(err) => {
                                warn!(?err, "Summary verification failed");
                                last_block_time = std::time::Instant::now();
                                continue;
                            }
                        };

                        // Submit seed first
                        if let Err(e) = client.submit_seed(seed).await {
                            warn!(?e, "Failed to submit seed");
                        }

                        // Submit summary
                        if let Err(e) = client.submit_summary(summary).await {
                            warn!(?e, "Failed to submit summary");
                        }

                        info!(view, "Block executed and submitted");
                        view += 1;
                        last_block_time = std::time::Instant::now();
                    }
                }
            }

            // Brief delay before reconnecting
            info!("Reconnecting in 1 second...");
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });

    Ok(())
}
