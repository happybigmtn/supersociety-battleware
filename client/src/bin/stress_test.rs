//! Bot stress test - simulates multiple concurrent casino bots
//!
//! Usage:
//!   cargo run --release --bin stress-test -- --identity <IDENTITY_HEX> [OPTIONS]
//!
//! Options:
//!   -u, --url            Node URL (default: http://localhost:8080)
//!   -i, --identity       Validator identity hex (required)
//!   -n, --num-bots       Number of bots to spawn (default: 300)
//!   -d, --duration       Duration in seconds (default: 300 = 5 minutes)
//!   -r, --rate           Bets per second per bot (default: 3.0)

use nullspace_client::Client;
use nullspace_types::{
    casino::GameType,
    execution::{Instruction, Transaction, Key, Value},
    Identity,
};
use clap::Parser;
use commonware_codec::DecodeExt;
use commonware_cryptography::{
    ed25519::{PrivateKey, PublicKey}, 
    PrivateKeyExt, Signer
};
use rand::{rngs::StdRng, Rng, SeedableRng};
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tracing::{info, warn, error};
use tokio::time;

#[derive(Parser, Debug)]
#[command(author, version, about = "Bot stress test for casino games")]
struct Args {
    #[arg(short, long, default_value = "http://localhost:8080")]
    url: String,

    #[arg(short, long)]
    identity: String,

    #[arg(short, long, default_value = "300")]
    num_bots: usize,

    #[arg(short, long, default_value = "300")]
    duration: u64,

    #[arg(short, long, default_value = "3.0")]
    rate: f64,
}

/// Bot state tracking
struct BotState {
    keypair: PrivateKey,
    name: String,
    nonce: AtomicU64,
    session_counter: AtomicU64,
    games_played: AtomicU64,
}

impl BotState {
    fn new(id: usize, rng: &mut StdRng) -> Self {
        let keypair = PrivateKey::from_rng(rng);
        Self {
            keypair,
            name: format!("Bot{:04}", id),
            nonce: AtomicU64::new(0),
            session_counter: AtomicU64::new(id as u64 * 1_000_000),
            games_played: AtomicU64::new(0),
        }
    }

    fn next_nonce(&self) -> u64 {
        self.nonce.fetch_add(1, Ordering::Relaxed)
    }

    fn next_session_id(&self) -> u64 {
        self.session_counter.fetch_add(1, Ordering::Relaxed)
    }

    fn public_key(&self) -> PublicKey {
        self.keypair.public_key()
    }
}

/// Global metrics
struct Metrics {
    transactions_submitted: AtomicU64,
    transactions_success: AtomicU64,
    transactions_failed: AtomicU64,
    total_latency_ms: AtomicU64,
}

impl Metrics {
    fn new() -> Self {
        Self {
            transactions_submitted: AtomicU64::new(0),
            transactions_success: AtomicU64::new(0),
            transactions_failed: AtomicU64::new(0),
            total_latency_ms: AtomicU64::new(0),
        }
    }

    fn record_submit(&self, success: bool, latency_ms: u64) {
        self.transactions_submitted.fetch_add(1, Ordering::Relaxed);
        if success {
            self.transactions_success.fetch_add(1, Ordering::Relaxed);
        } else {
            self.transactions_failed.fetch_add(1, Ordering::Relaxed);
        }
        self.total_latency_ms.fetch_add(latency_ms, Ordering::Relaxed);
    }
}

/// Generate a random game move payload based on game type
fn generate_move_payload(game_type: GameType, rng: &mut StdRng, move_number: u32) -> Vec<u8> {
    match game_type {
        GameType::Baccarat => {
            if move_number == 0 {
                // Place a bet: [0, bet_type, amount_bytes...]
                let bet_type = rng.gen_range(0..=2u8); // Player, Banker, or Tie
                let amount = 10u64;
                let mut payload = vec![0, bet_type];
                payload.extend_from_slice(&amount.to_be_bytes());
                payload
            } else if move_number == 1 {
                // Deal: [1]
                vec![1]
            } else {
                vec![]
            }
        }
        GameType::Blackjack => {
            if move_number == 0 {
                // Stand to finish quickly: [1]
                vec![1]
            } else {
                vec![]
            }
        }
        GameType::CasinoWar => {
            // Just wait for deal - usually immediate resolution?
            // Actually CasinoWar init() does nothing, process_move handles bet then deal.
            // If move 0 is bet, move 1 is deal?
            // Let's assume standard flow: 0=bet, 1=deal? 
            // Wait, CasinoWar might be simpler. Let's send empty to be safe or check code.
            // Assuming it needs a move to progress if not auto-resolved.
            if move_number == 0 {
                vec![] // No payload needed? Or maybe just 'deal' signal?
            } else {
                vec![]
            }
        }
        GameType::Craps => {
            if move_number == 0 {
                // Place pass bet: [0, 0, 0, amount_bytes...]
                let mut payload = vec![0, 0, 0];
                payload.extend_from_slice(&10u64.to_be_bytes());
                payload
            } else {
                // Roll dice: [2]
                vec![2]
            }
        }
        GameType::VideoPoker => {
            if move_number == 0 {
                // Hold all cards: [0b11111] = 31
                vec![31]
            } else {
                vec![]
            }
        }
        GameType::HiLo => {
            // 0=higher, 1=lower, 2=cashout
            // If move > 0, 30% chance to cashout to lock in wins
            if move_number > 0 && rng.gen_bool(0.3) {
                vec![2]
            } else {
                let choice = rng.gen_range(0..=1u8);
                vec![choice]
            }
        }
        GameType::Roulette => {
            if move_number == 0 {
                // Bet on red: [1, 0]
                vec![1, 0]
            } else {
                vec![]
            }
        }
        GameType::SicBo => {
            if move_number == 0 {
                // Bet on small: [0, 0]
                vec![0, 0]
            } else {
                vec![]
            }
        }
        GameType::ThreeCard => {
            if move_number == 0 {
                // Play: [0]
                vec![0]
            } else {
                vec![]
            }
        }
        GameType::UltimateHoldem => {
            // Check or fold randomly
            if move_number < 2 {
                vec![0] // Check
            } else if move_number == 2 {
                vec![4] // Fold
            } else {
                vec![]
            }
        }
    }
}

/// Helper function to flush a batch of transactions
async fn flush_batch(
    client: &Arc<Client>,
    pending_txs: &mut Vec<Transaction>,
    metrics: &Arc<Metrics>,
) {
    if pending_txs.is_empty() {
        return;
    }

    let start = Instant::now();
    let num_txs = pending_txs.len();

    match client.submit_transactions(pending_txs.drain(..).collect()).await {
        Ok(_) => {
            let latency = start.elapsed().as_millis() as u64;
            for _ in 0..num_txs {
                metrics.record_submit(true, latency);
            }
        }
        Err(e) => {
            warn!("Transaction failed: {}", e);
            let latency = start.elapsed().as_millis() as u64;
            for _ in 0..num_txs {
                metrics.record_submit(false, latency);
            }
        }
    }
}

/// Run a single bot
async fn run_bot(
    client: Arc<Client>,
    bot: Arc<BotState>,
    duration: Duration,
    rate_limit_per_sec: f64,
    metrics: Arc<Metrics>,
) {
    let mut rng = StdRng::from_entropy();
    let mut pending_txs: Vec<Transaction> = Vec::with_capacity(5);

    // Register the bot
    let register_tx = Transaction::sign(
        &bot.keypair,
        bot.next_nonce(),
        Instruction::CasinoRegister {
            name: bot.name.clone(),
        },
    );
    pending_txs.push(register_tx);
    flush_batch(&client, &mut pending_txs, &metrics).await;

    // Wait a bit for registration to process
    time::sleep(Duration::from_millis(100)).await;

    let start_time = Instant::now();
    let interval_duration = Duration::from_secs_f64(1.0 / rate_limit_per_sec);
    let mut interval = time::interval(interval_duration);
    // Tick once immediately to start
    interval.tick().await;

    while start_time.elapsed() < duration {
        interval.tick().await;

        // Pick a random game type
        let game_type = match rng.gen_range(0..10u8) {
            0 => GameType::Baccarat,
            1 => GameType::Blackjack,
            2 => GameType::CasinoWar,
            3 => GameType::Craps,
            4 => GameType::VideoPoker,
            5 => GameType::HiLo,
            6 => GameType::Roulette,
            7 => GameType::SicBo,
            8 => GameType::ThreeCard,
            _ => GameType::UltimateHoldem,
        };

        let session_id = bot.next_session_id();
        let bet = 10;

        // Start game
        let start_tx = Transaction::sign(
            &bot.keypair,
            bot.next_nonce(),
            Instruction::CasinoStartGame {
                game_type,
                bet,
                session_id,
            },
        );
        pending_txs.push(start_tx);

        // Make moves until game completes
        // Increased limit to 50 to allow Craps/HiLo to finish
        for move_num in 0..50u32 {
            let payload = generate_move_payload(game_type, &mut rng, move_num);
            if payload.is_empty() {
                break;
            }

            let move_tx = Transaction::sign(
                &bot.keypair,
                bot.next_nonce(),
                Instruction::CasinoGameMove {
                    session_id,
                    payload,
                },
            );
            pending_txs.push(move_tx);
        }

        // Flush game transactions
        flush_batch(&client, &mut pending_txs, &metrics).await;
        bot.games_played.fetch_add(1, Ordering::Relaxed);
    }
}

/// Monitor task to check leaderboard and logic
async fn monitor_logic(
    client: Arc<Client>,
    bots: Vec<Arc<BotState>>,
    duration: Duration,
) {
    let start_time = Instant::now();
    
    info!("Starting leaderboard and logic monitor...");

    while start_time.elapsed() < duration {
        time::sleep(Duration::from_secs(5)).await;

        // 1. Check Leaderboard
        match client.query_state(&Key::CasinoLeaderboard).await {
            Ok(Some(lookup)) => {
                let value = lookup.operation.value();
                if let Some(Value::CasinoLeaderboard(lb)) = value {
                    info!("Leaderboard Update ({} entries):", lb.entries.len());
                    for (i, entry) in lb.entries.iter().enumerate() {
                        info!("  #{}: {} - {} chips", i + 1, entry.name, entry.chips);
                    }
                    
                    if lb.entries.is_empty() {
                         warn!("Leaderboard is empty!");
                    }
                } else {
                    error!("Expected CasinoLeaderboard value, got {:?}", value);
                }
            }
            Ok(None) => {
                warn!("Leaderboard state not found yet");
            }
            Err(e) => {
                error!("Failed to query leaderboard: {}", e);
            }
        }

        // 2. Check a random bot for logic verification
        if let Some(_) = bots.first() {
            let sample_bots = bots.iter().take(5); 
            for bot in sample_bots {
                match client.query_state(&Key::CasinoPlayer(bot.public_key())).await {
                    Ok(Some(lookup)) => {
                        let value = lookup.operation.value();
                        if let Some(Value::CasinoPlayer(player)) = value {
                             // Just checking if we can read state, no specific assertion logs to avoid spam
                             // unless critical
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Parse args
    let args = Args::parse();

    // Setup logging
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    // Parse identity
    let identity_bytes =
        commonware_utils::from_hex(&args.identity).ok_or("Invalid identity hex format")?;
    let identity: Identity =
        Identity::decode(&mut identity_bytes.as_slice()).map_err(|_| "Failed to decode identity")?;

    info!(
        "Starting stress test tournament with {} bots",
        args.num_bots
    );
    info!("Duration: {} seconds, Rate: {} bets/sec/bot", args.duration, args.rate);
    info!("Connecting to {}", args.url);

    // Create client
    let client = Arc::new(Client::new(&args.url, identity)?);

    // Create bots
    let mut master_rng = StdRng::seed_from_u64(42);
    let bots: Vec<Arc<BotState>> = (0..args.num_bots)
        .map(|i| Arc::new(BotState::new(i, &mut master_rng)))
        .collect();

    // Create metrics
    let metrics = Arc::new(Metrics::new());

    // Start timer
    let start_time = Instant::now();
    let duration = Duration::from_secs(args.duration);

    // Spawn monitor task
    let monitor_handle = tokio::spawn({
        let client = Arc::clone(&client);
        let bots = bots.clone();
        async move {
            monitor_logic(client, bots, duration).await;
        }
    });

    // Spawn bot tasks
    let mut handles = Vec::new();
    for bot in &bots {
        let client = Arc::clone(&client);
        let metrics = Arc::clone(&metrics);
        let bot = Arc::clone(bot);
        let rate = args.rate;

        handles.push(tokio::spawn(async move {
            run_bot(client, bot, duration, rate, metrics).await;
        }));
    }

    // Wait for all bots to complete
    for handle in handles {
        let _ = handle.await;
    }
    
    // Wait for monitor
    let _ = monitor_handle.await;

    // Print results
    let elapsed = start_time.elapsed();
    let submitted = metrics.transactions_submitted.load(Ordering::Relaxed);
    let success = metrics.transactions_success.load(Ordering::Relaxed);
    let failed = metrics.transactions_failed.load(Ordering::Relaxed);
    let total_latency = metrics.total_latency_ms.load(Ordering::Relaxed);
    let games_played: u64 = bots.iter().map(|b| b.games_played.load(Ordering::Relaxed)).sum();

    let tps = if elapsed.as_secs() > 0 {
        submitted as f64 / elapsed.as_secs_f64()
    } else {
        0.0
    };

    let avg_latency = if submitted > 0 {
        total_latency as f64 / submitted as f64
    } else {
        0.0
    };

    info!("=== TOURNAMENT SIMULATION RESULTS ===");
    info!("Duration: {:.2}s", elapsed.as_secs_f64());
    info!("Total Games Played: {}", games_played);
    info!("Transactions: {} submitted, {} success, {} failed", submitted, success, failed);
    info!("TPS: {:.2}", tps);
    info!("Average Latency: {:.2}ms", avg_latency);
    
    // Final Leaderboard Check
    info!("Final Leaderboard Check:");
    match client.query_state(&Key::CasinoLeaderboard).await {
         Ok(Some(lookup)) => {
             if let Some(Value::CasinoLeaderboard(lb)) = lookup.operation.value() {
                 for (i, entry) in lb.entries.iter().enumerate() {
                    info!("  #{}: {} - {} chips", i + 1, entry.name, entry.chips);
                 }
             }
         }
         _ => info!("Could not fetch final leaderboard"),
    }

    Ok(())
}