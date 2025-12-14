//! Ecosystem Simulation (Enhanced)
//!
//! Simulates a high-volume economy with:
//! - Periodic Tournaments (MTT style, accelerated)
//! - Whales (Buy/Sell pressure)
//! - Retail (Lending/Borrowing/Trading)
//! - Maximizer Agent (Optimized Strategy)
//! - Epoch Keeper (Triggers distributions)
//!
//! Connects to a live network.

use clap::Parser;
use commonware_codec::DecodeExt;
use commonware_cryptography::{
    ed25519::{PrivateKey, PublicKey},
    PrivateKeyExt, Signer,
};
use commonware_storage::store::operation::Keyless;
use nullspace_client::Client;
use nullspace_types::{
    api::{Update, UpdatesFilter},
    casino::{AmmPool, GameType, HouseState},
    execution::{Event, Instruction, Key, Output, Transaction, Value}, // Added Output/Event
    Identity,
};
use rand::{rngs::StdRng, Rng, SeedableRng};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs::File,
    io::Write,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, OnceLock,
    },
    time::{Duration, Instant},
};
use tokio::{sync::Mutex, time};
use tracing::{error, info, warn};

const INITIAL_POOL_RNG: u64 = 500_000;
const INITIAL_POOL_VUSD: u64 = 500_000;
const BOOTSTRAP_COLLATERAL: u64 = INITIAL_POOL_VUSD * 2; // 50% LTV requires 2x collateral
const CLIENT_MAX_RPS: u64 = 50_000;
static SUBMIT_FAILURES: AtomicU64 = AtomicU64::new(0);

#[derive(Parser, Debug)]
struct Args {
    #[arg(short, long, default_value = "http://localhost:8080")]
    url: String,

    #[arg(short, long)]
    identity: String,

    #[arg(long, default_value = "300")]
    duration: u64,
}

struct Bot {
    keypair: PrivateKey,
    nonce: AtomicU64,
    name: String,
}

impl Bot {
    fn new(name: &str, rng: &mut StdRng) -> Self {
        Self {
            keypair: PrivateKey::from_rng(rng),
            nonce: AtomicU64::new(0),
            name: name.to_string(),
        }
    }

    fn next_nonce(&self) -> u64 {
        self.nonce.fetch_add(1, Ordering::Relaxed)
    }

    fn public_key(&self) -> PublicKey {
        self.keypair.public_key()
    }
}

#[derive(Serialize)]
struct EconomySnapshot {
    block_height: u64,
    timestamp: u64,
    house_pnl: i128,
    rng_price: f64,
    total_burned: u64,
    total_issuance: u64,
    amm_rng: u64,
    amm_vusdt: u64,
    maximizer_nw: i64,
    tx_count: usize,
    volume_vusdt: u64,
    fees_vusdt: u64,
    burn_rng: u64,
    mint_rng: u64,
    epoch: u64,
    lp_shares: u64,
    total_staked: u64,
    swap_count: u64,
    buy_volume_vusdt: u64,
    sell_volume_rng: u64,
    game_bet_volume: u64,
    game_net_payout: i64,
    game_starts: u64,
    tournament_game_bet_volume: u64,
    tournament_game_net_payout: i64,
    tournament_game_starts: u64,
    stakes_in: u64,
    unstake_actions: u64,
    claim_actions: u64,
    pool_tvl_vusdt: f64,
    amm_invariant_k: u128,
    lp_share_price_vusdt: f64,
    whale_volume_vusdt: u64,
    retail_volume_vusdt: u64,
    grinder_tournament_joins: u64,
    maximizer_game_bet_volume: u64,
    errors_invalid_move: u64,
    errors_invalid_bet: u64,
    errors_insufficient: u64,
    errors_player_not_found: u64,
    errors_session_exists: u64,
    errors_session_not_found: u64,
    errors_session_not_owned: u64,
    errors_session_complete: u64,
    errors_tournament_not_registering: u64,
    errors_already_in_tournament: u64,
    errors_tournament_limit_reached: u64,
    errors_rate_limited: u64,
    errors_other: u64,
    submit_failures: u64,
    vault_collateral: u64,
    vusd_borrowed: u64,
    vusd_repaid: u64,
    liquidity_rng_added: u64,
    liquidity_vusd_added: u64,
    liquidity_shares_removed: u64,
    tournament_started: u64,
    tournament_joined: u64,
    tournament_ended: u64,
    epoch_calls: u64,
    errors: u64,
    game_stats: Vec<GameStat>,
    top_players: Vec<PlayerStat>,
    freeroll_game_stats: Vec<GameStat>,
    freeroll_top_players: Vec<PlayerStat>,
}

struct SubmitRateState {
    window_start: u64,
    count: u64,
}

static SUBMIT_RATE_STATE: OnceLock<Mutex<SubmitRateState>> = OnceLock::new();

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

async fn throttle_submissions() {
    let limiter = SUBMIT_RATE_STATE.get_or_init(|| {
        Mutex::new(SubmitRateState {
            window_start: 0,
            count: 0,
        })
    });

    loop {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let mut state = limiter.lock().await;
        if state.window_start != now {
            state.window_start = now;
            state.count = 0;
        }
        if state.count < CLIENT_MAX_RPS {
            state.count += 1;
            break;
        }
        drop(state);
        time::sleep(Duration::from_millis(1)).await;
    }
}

async fn flush_batch(client: &Arc<Client>, txs: &mut Vec<Transaction>) {
    if txs.is_empty() {
        return;
    }
    let batch: Vec<Transaction> = txs.drain(..).collect();
    throttle_submissions().await;
    if let Err(e) = client.submit_transactions(batch).await {
        warn!("Batch submission failed: {}", e);
        SUBMIT_FAILURES.fetch_add(1, Ordering::Relaxed);
    }
}

async fn flush_tx(client: &Client, tx: Transaction) {
    throttle_submissions().await;
    if let Err(e) = client.submit_transactions(vec![tx]).await {
        warn!("Tx failed: {}", e);
        SUBMIT_FAILURES.fetch_add(1, Ordering::Relaxed);
    }
}

// === Epoch Keeper ===
async fn run_keeper(client: Arc<Client>, bot: Arc<Bot>, duration: Duration) {
    let start = Instant::now();

    flush_tx(
        &client,
        Transaction::sign(
            &bot.keypair,
            bot.next_nonce(),
            Instruction::CasinoRegister {
                name: "Keeper".to_string(),
            },
        ),
    )
    .await;

    let mut interval = time::interval(Duration::from_secs(10)); // Trigger Epoch every 10s
    while start.elapsed() < duration {
        interval.tick().await;
        info!("Keeper: Processing Epoch...");
        flush_tx(
            &client,
            Transaction::sign(&bot.keypair, bot.next_nonce(), Instruction::ProcessEpoch),
        )
        .await;
    }
}

// === Bootstrap AMM Liquidity (Central Bank style) ===
async fn bootstrap_amm(client: Arc<Client>, bot: Arc<Bot>) {
    let seeded = match client.query_state(&Key::AmmPool).await {
        Ok(Some(lookup)) => {
            matches!(lookup.operation.value(), Some(Value::AmmPool(p)) if p.reserve_rng > 0 && p.reserve_vusdt > 0)
        }
        _ => false,
    };
    if seeded {
        info!("AMM already seeded, skipping bootstrap.");
        return;
    }

    info!(
        "Bootstrapping AMM with {} RNG and {} vUSD liquidity",
        INITIAL_POOL_RNG, INITIAL_POOL_VUSD
    );

    // Register/Fund bootstrap account
    flush_tx(
        &client,
        Transaction::sign(
            &bot.keypair,
            bot.next_nonce(),
            Instruction::CasinoRegister {
                name: "Bootstrapper".to_string(),
            },
        ),
    )
    .await;
    // Need enough chips for RNG liquidity plus collateral to mint vUSD
    flush_tx(
        &client,
        Transaction::sign(
            &bot.keypair,
            bot.next_nonce(),
            Instruction::CasinoDeposit {
                amount: INITIAL_POOL_RNG + BOOTSTRAP_COLLATERAL,
            },
        ),
    )
    .await;
    flush_tx(
        &client,
        Transaction::sign(&bot.keypair, bot.next_nonce(), Instruction::CreateVault),
    )
    .await;
    flush_tx(
        &client,
        Transaction::sign(
            &bot.keypair,
            bot.next_nonce(),
            Instruction::DepositCollateral {
                amount: BOOTSTRAP_COLLATERAL,
            },
        ),
    )
    .await;
    flush_tx(
        &client,
        Transaction::sign(
            &bot.keypair,
            bot.next_nonce(),
            Instruction::BorrowUSDT {
                amount: INITIAL_POOL_VUSD,
            },
        ),
    )
    .await;
    flush_tx(
        &client,
        Transaction::sign(
            &bot.keypair,
            bot.next_nonce(),
            Instruction::AddLiquidity {
                rng_amount: INITIAL_POOL_RNG,
                usdt_amount: INITIAL_POOL_VUSD,
            },
        ),
    )
    .await;

    // Wait for block inclusion
    let mut seeded = false;
    for _ in 0..20 {
        if let Ok(Some(lookup)) = client.query_state(&Key::AmmPool).await {
            if let Some(Value::AmmPool(p)) = lookup.operation.value() {
                info!(
                    "AMM seeded: reserves {} RNG / {} vUSD, shares {}",
                    p.reserve_rng, p.reserve_vusdt, p.total_shares
                );
                seeded = p.reserve_rng > 0 && p.reserve_vusdt > 0;
                break;
            }
        }
        time::sleep(Duration::from_millis(200)).await;
    }

    if !seeded {
        warn!("AMM not found after bootstrap; trades will price at last known level");
    }
}

// === Whale Behavior (Buy/Sell/LP) ===
async fn run_whale(client: Arc<Client>, bot: Arc<Bot>, duration: Duration) {
    let mut rng = StdRng::from_entropy();
    let start = Instant::now();
    let mut held_rng = 0u64;

    // Register & Fund
    flush_tx(
        &client,
        Transaction::sign(
            &bot.keypair,
            bot.next_nonce(),
            Instruction::CasinoRegister {
                name: bot.name.clone(),
            },
        ),
    )
    .await;
    flush_tx(
        &client,
        Transaction::sign(
            &bot.keypair,
            bot.next_nonce(),
            Instruction::CasinoDeposit { amount: 50_000_000 },
        ),
    )
    .await;

    // Initial Liquidity
    flush_tx(
        &client,
        Transaction::sign(&bot.keypair, bot.next_nonce(), Instruction::CreateVault),
    )
    .await;
    flush_tx(
        &client,
        Transaction::sign(
            &bot.keypair,
            bot.next_nonce(),
            Instruction::DepositCollateral { amount: 20_000_000 },
        ),
    )
    .await;
    flush_tx(
        &client,
        Transaction::sign(
            &bot.keypair,
            bot.next_nonce(),
            Instruction::BorrowUSDT { amount: 10_000_000 },
        ),
    )
    .await;
    flush_tx(
        &client,
        Transaction::sign(
            &bot.keypair,
            bot.next_nonce(),
            Instruction::AddLiquidity {
                rng_amount: 5_000_000,
                usdt_amount: 5_000_000,
            },
        ),
    )
    .await;

    let mut interval = time::interval(Duration::from_secs(5));
    while start.elapsed() < duration {
        interval.tick().await;

        // Strategy: Buy/Sell or Hold
        // If we have RNG, bias towards selling to realize profit? Or random.

        let action = rng.gen_range(0..3);
        match action {
            0 => {
                // Pump (Buy)
                let amount = rng.gen_range(10_000..50_000); // Reduced size
                info!("{}: PUMP Buying {} vUSDT of RNG", bot.name, amount);
                flush_tx(
                    &client,
                    Transaction::sign(
                        &bot.keypair,
                        bot.next_nonce(),
                        Instruction::Swap {
                            amount_in: amount,
                            min_amount_out: 0,
                            is_buying_rng: true,
                        },
                    ),
                )
                .await;
                // Approx conversion, just tracking "some" held
                held_rng += amount;
            }
            1 => {
                // Dump (Sell)
                if held_rng > 0 {
                    let max_sell = held_rng.min(50_000).max(1);
                    let amount = rng.gen_range(1..=max_sell);
                    info!("{}: DUMP Selling {} RNG", bot.name, amount);
                    flush_tx(
                        &client,
                        Transaction::sign(
                            &bot.keypair,
                            bot.next_nonce(),
                            Instruction::Swap {
                                amount_in: amount,
                                min_amount_out: 0,
                                is_buying_rng: false,
                            },
                        ),
                    )
                    .await;
                    held_rng = held_rng.saturating_sub(amount);
                }
            }
            _ => {} // Hold
        }
    }
}

// === Retail Behavior (Leverage/Trade) ===
async fn run_retail(client: Arc<Client>, bot: Arc<Bot>, duration: Duration) {
    let mut rng = StdRng::from_entropy();
    let start = Instant::now();

    flush_tx(
        &client,
        Transaction::sign(
            &bot.keypair,
            bot.next_nonce(),
            Instruction::CasinoRegister {
                name: bot.name.clone(),
            },
        ),
    )
    .await;
    flush_tx(
        &client,
        Transaction::sign(
            &bot.keypair,
            bot.next_nonce(),
            Instruction::CasinoDeposit { amount: 500_000 },
        ),
    )
    .await;

    // Open Vault
    flush_tx(
        &client,
        Transaction::sign(&bot.keypair, bot.next_nonce(), Instruction::CreateVault),
    )
    .await;

    let mut interval = time::interval(Duration::from_secs(rng.gen_range(2..5)));
    while start.elapsed() < duration {
        interval.tick().await;

        let r = rng.gen_range(0..10);
        if r < 3 {
            // Leverage Up: Deposit RNG, Borrow vUSDT, Buy RNG
            let amount = 10_000;
            let mut txs = Vec::new();
            txs.push(Transaction::sign(
                &bot.keypair,
                bot.next_nonce(),
                Instruction::DepositCollateral { amount },
            ));
            txs.push(Transaction::sign(
                &bot.keypair,
                bot.next_nonce(),
                Instruction::BorrowUSDT { amount: amount / 2 },
            )); // 50% LTV safe-ish
            txs.push(Transaction::sign(
                &bot.keypair,
                bot.next_nonce(),
                Instruction::Swap {
                    amount_in: amount / 2,
                    min_amount_out: 0,
                    is_buying_rng: true,
                },
            ));
            flush_batch(&client, &mut txs).await;
        } else if r < 6 {
            // Trade
            let amount = rng.gen_range(1000..5000);
            let buy = rng.gen_bool(0.5);
            flush_tx(
                &client,
                Transaction::sign(
                    &bot.keypair,
                    bot.next_nonce(),
                    Instruction::Swap {
                        amount_in: amount,
                        min_amount_out: 0,
                        is_buying_rng: buy,
                    },
                ),
            )
            .await;
        } else {
            // Play Game
            let session_id = rng.gen::<u64>();
            flush_tx(
                &client,
                Transaction::sign(
                    &bot.keypair,
                    bot.next_nonce(),
                    Instruction::CasinoStartGame {
                        game_type: GameType::Blackjack,
                        bet: 500,
                        session_id,
                    },
                ),
            )
            .await;
            flush_tx(
                &client,
                Transaction::sign(
                    &bot.keypair,
                    bot.next_nonce(),
                    Instruction::CasinoGameMove {
                        session_id,
                        payload: vec![1], // Stand
                    },
                ),
            )
            .await;
        }
    }
}

// === Maximizer Bot ===
async fn run_maximizer(client: Arc<Client>, bot: Arc<Bot>, duration: Duration) {
    let start = Instant::now();
    let mut rng = StdRng::from_entropy();
    info!("Maximizer: Started.");

    flush_tx(
        &client,
        Transaction::sign(
            &bot.keypair,
            bot.next_nonce(),
            Instruction::CasinoRegister {
                name: "MAXIMIZER".to_string(),
            },
        ),
    )
    .await;
    flush_tx(
        &client,
        Transaction::sign(
            &bot.keypair,
            bot.next_nonce(),
            Instruction::CasinoDeposit { amount: 1_000_000 },
        ),
    )
    .await;

    let mut interval = time::interval(Duration::from_millis(500));
    while start.elapsed() < duration {
        interval.tick().await;
        // Strategy: High volume Baccarat Banker bets to farm House Edge distribution (via Staking)
        // Also stake frequently.

        let session_id = rng.gen::<u64>();
        let mut txs = Vec::new();

        // 1. Play
        txs.push(Transaction::sign(
            &bot.keypair,
            bot.next_nonce(),
            Instruction::CasinoStartGame {
                game_type: GameType::Baccarat,
                bet: 2000,
                session_id,
            },
        ));
        txs.push(Transaction::sign(
            &bot.keypair,
            bot.next_nonce(),
            Instruction::CasinoGameMove {
                session_id,
                payload: vec![0, 1], // Banker
            },
        ));
        txs.push(Transaction::sign(
            &bot.keypair,
            bot.next_nonce(),
            Instruction::CasinoGameMove {
                session_id,
                payload: vec![1], // Deal
            },
        ));

        // 2. Stake Winnings (every ~10s)
        if start.elapsed().as_secs() % 10 == 0 {
            txs.push(Transaction::sign(
                &bot.keypair,
                bot.next_nonce(),
                Instruction::Stake {
                    amount: 1000,
                    duration: 1000,
                },
            ));
        }

        flush_batch(&client, &mut txs).await;
    }
}

// === Tournament Grinder ===
async fn run_tournament_grinder(client: Arc<Client>, bot: Arc<Bot>, duration: Duration) {
    let mut rng = StdRng::from_entropy();
    let start = Instant::now();
    let mut tournament_id = 1000;

    flush_tx(
        &client,
        Transaction::sign(
            &bot.keypair,
            bot.next_nonce(),
            Instruction::CasinoRegister {
                name: bot.name.clone(),
            },
        ),
    )
    .await;

    let mut interval = time::interval(Duration::from_millis(2000)); // 2s actions
    while start.elapsed() < duration {
        interval.tick().await;

        // Join (fire and forget)
        let join_tx = Transaction::sign(
            &bot.keypair,
            bot.next_nonce(),
            Instruction::CasinoJoinTournament { tournament_id },
        );
        flush_tx(&client, join_tx).await;

        // Play to accumulate chips
        if rng.gen_bool(0.5) {
            let session_id = rng.gen::<u64>();
            let mut txs = Vec::new();
            txs.push(Transaction::sign(
                &bot.keypair,
                bot.next_nonce(),
                Instruction::CasinoStartGame {
                    game_type: GameType::Baccarat,
                    bet: 1000,
                    session_id,
                },
            ));
            txs.push(Transaction::sign(
                &bot.keypair,
                bot.next_nonce(),
                Instruction::CasinoGameMove {
                    session_id,
                    payload: vec![0, 1], // Banker
                },
            ));
            txs.push(Transaction::sign(
                &bot.keypair,
                bot.next_nonce(),
                Instruction::CasinoGameMove {
                    session_id,
                    payload: vec![1], // Deal
                },
            ));
            flush_batch(&client, &mut txs).await;
        }

        // Simulating Tournament cycle
        if start.elapsed().as_secs() % 5 == 0 {
            tournament_id += 1;
        }
    }
}

// === Tournament Organizer ===
async fn run_tournaments(client: Arc<Client>, organizer: Arc<Bot>, duration: Duration) {
    let start = Instant::now();
    let mut tournament_id = 1000;

    while start.elapsed() < duration {
        // Start Active Phase
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        flush_tx(
            &client,
            Transaction::sign(
                &organizer.keypair,
                organizer.next_nonce(),
                Instruction::CasinoStartTournament {
                    tournament_id,
                    start_time_ms: now,
                    end_time_ms: now + 5000, // 5s duration for sim
                },
            ),
        )
        .await;

        // Wait for duration
        time::sleep(Duration::from_secs(5)).await;

        // End & Payout
        flush_tx(
            &client,
            Transaction::sign(
                &organizer.keypair,
                organizer.next_nonce(),
                Instruction::CasinoEndTournament { tournament_id },
            ),
        )
        .await;

        tournament_id += 1;
    }
}

#[derive(Default)]
struct ActivityTally {
    swap_count: u64,
    buy_volume_vusdt: u64,
    sell_volume_rng: u64,
    whale_volume_vusdt: u64,
    retail_volume_vusdt: u64,
    maximizer_game_bet_volume: u64,
    grinder_tournament_joins: u64,
    game_bet_volume: u64,
    game_net_payout: i64,
    game_starts: u64,
    tournament_game_bet_volume: u64,
    tournament_game_net_payout: i64,
    tournament_game_starts: u64,
    stakes_in: u64,
    unstake_actions: u64,
    claim_actions: u64,
    errors_invalid_move: u64,
    errors_invalid_bet: u64,
    errors_insufficient: u64,
    errors_player_not_found: u64,
    errors_session_exists: u64,
    errors_session_not_found: u64,
    errors_session_not_owned: u64,
    errors_session_complete: u64,
    errors_tournament_not_registering: u64,
    errors_already_in_tournament: u64,
    errors_tournament_limit_reached: u64,
    errors_rate_limited: u64,
    errors_other: u64,
    vault_collateral: u64,
    vusd_borrowed: u64,
    vusd_repaid: u64,
    liquidity_rng_added: u64,
    liquidity_vusd_added: u64,
    liquidity_shares_removed: u64,
    tournament_started: u64,
    tournament_joined: u64,
    tournament_ended: u64,
    epoch_calls: u64,
    errors: u64,
}

#[derive(Clone, Serialize)]
struct GameStat {
    game_type: String,
    bet_volume: u64,
    net_payout: i64,
    house_edge: i64,
}

#[derive(Clone, Serialize)]
struct PlayerStat {
    player: String,
    game_pnl: i64,
    bet_volume: u64,
    sessions: u64,
}

#[derive(Clone, Copy)]
struct SessionMeta {
    bet: u64,
    is_tournament: bool,
}

// === Monitor ===
async fn run_monitor(
    client: Arc<Client>,
    maximizer: Arc<Bot>,
    whales: Vec<PublicKey>,
    retail: Vec<PublicKey>,
    grinders: Vec<PublicKey>,
    maximizer_pk: PublicKey,
    duration: Duration,
) {
    let start = Instant::now();
    let mut log = Vec::new();
    let mut last_price = 1.0f64;
    let mut last_submit_failures = 0u64;
    let mut game_stats: HashMap<String, (u64, i64)> = HashMap::new();
    let mut player_stats: HashMap<String, (u64, i64, u64)> = HashMap::new(); // bet_volume, game_pnl, sessions
    let mut freeroll_game_stats: HashMap<String, (u64, i64)> = HashMap::new();
    let mut freeroll_player_stats: HashMap<String, (u64, i64, u64)> = HashMap::new();
    let mut session_bets: HashMap<u64, SessionMeta> = HashMap::new();

    info!("Starting Monitor (Block-based)...");

    // Connect to updates stream to get blocks/txs
    let mut stream = match client.connect_updates(UpdatesFilter::All).await {
        Ok(s) => s,
        Err(e) => {
            error!("Failed to connect to updates stream: {}", e);
            return;
        }
    };

    // Initial State
    let mut last_house = HouseState::new(0);
    let mut last_amm: Option<AmmPool> = None;
    // Try to fetch initial state
    if let Ok(Some(lookup)) = client.query_state(&Key::House).await {
        if let Some(Value::House(h)) = lookup.operation.value() {
            last_house = h.clone();
        }
    }

    while let Some(msg) = stream.next().await {
        if start.elapsed() > duration {
            break;
        }

        let update = match msg {
            Ok(u) => u,
            Err(e) => {
                warn!("Stream error: {}", e);
                continue;
            }
        };

        if let Update::Events(events) = update {
            let block_height = events.progress.height;
            let mut metrics = ActivityTally::default();

            // 1. Process Transactions for Volume & Fees
            let mut volume_vusdt = 0u64;
            let mut tx_count = 0;

            // Fetch current AMM state for price conversion
            let amm = match client.query_state(&Key::AmmPool).await {
                Ok(Some(lookup)) => {
                    if let Some(Value::AmmPool(p)) = lookup.operation.value() {
                        Some(p.clone())
                    } else {
                        None
                    }
                }
                _ => None,
            };
            let a = amm.clone().unwrap_or_default();
            let price = if a.reserve_rng > 0 && a.reserve_vusdt > 0 {
                let p = a.reserve_vusdt as f64 / a.reserve_rng as f64;
                last_price = p;
                p
            } else {
                last_price
            };
            let pool_tvl_vusdt = a.reserve_vusdt as f64 + a.reserve_rng as f64 * price;
            let lp_share_price_vusdt = if a.total_shares > 0 {
                pool_tvl_vusdt / a.total_shares as f64
            } else {
                0.0
            };
            let amm_invariant_k = a.reserve_rng as u128 * a.reserve_vusdt as u128;
            let submit_failures_delta = SUBMIT_FAILURES
                .load(Ordering::Relaxed)
                .saturating_sub(last_submit_failures);
            let mut liquidity_rng_added = metrics.liquidity_rng_added;
            let mut liquidity_vusd_added = metrics.liquidity_vusd_added;
            let mut liquidity_shares_removed = metrics.liquidity_shares_removed;

            if let Some(prev) = &last_amm {
                if a.total_shares > prev.total_shares {
                    if prev.total_shares == 0 {
                        liquidity_rng_added = liquidity_rng_added.saturating_add(a.reserve_rng);
                        liquidity_vusd_added = liquidity_vusd_added.saturating_add(a.reserve_vusdt);
                    } else {
                        let share_delta = a.total_shares - prev.total_shares;
                        let add_rng = ((share_delta as u128 * prev.reserve_rng as u128)
                            / prev.total_shares as u128)
                            as u64;
                        let add_vusd = ((share_delta as u128 * prev.reserve_vusdt as u128)
                            / prev.total_shares as u128)
                            as u64;
                        liquidity_rng_added = liquidity_rng_added.saturating_add(add_rng);
                        liquidity_vusd_added = liquidity_vusd_added.saturating_add(add_vusd);
                    }
                } else if a.total_shares < prev.total_shares {
                    liquidity_shares_removed =
                        liquidity_shares_removed.saturating_add(prev.total_shares - a.total_shares);
                }
            } else if a.total_shares > 0 {
                liquidity_rng_added = liquidity_rng_added.saturating_add(a.reserve_rng);
                liquidity_vusd_added = liquidity_vusd_added.saturating_add(a.reserve_vusdt);
            }

            for op in events.events_proof_ops {
                // Keyless has Append variant.
                if let Keyless::Append(output) = op {
                    match output {
                        Output::Transaction(tx) => {
                            tx_count += 1;
                            match &tx.instruction {
                                Instruction::Swap {
                                    amount_in,
                                    is_buying_rng,
                                    ..
                                } => {
                                    metrics.swap_count += 1;
                                    let is_whale = whales.contains(&tx.public);
                                    let is_retail = retail.contains(&tx.public);
                                    if *is_buying_rng {
                                        volume_vusdt += amount_in;
                                        metrics.buy_volume_vusdt += amount_in;
                                        if is_whale {
                                            metrics.whale_volume_vusdt += amount_in;
                                        } else if is_retail {
                                            metrics.retail_volume_vusdt += amount_in;
                                        }
                                    } else {
                                        let vusd_val = (*amount_in as f64 * price) as u64;
                                        volume_vusdt += vusd_val;
                                        metrics.sell_volume_rng += *amount_in;
                                        if is_whale {
                                            metrics.whale_volume_vusdt += vusd_val;
                                        } else if is_retail {
                                            metrics.retail_volume_vusdt += vusd_val;
                                        }
                                    }
                                }
                                Instruction::Stake { amount, .. } => metrics.stakes_in += *amount,
                                Instruction::Unstake => metrics.unstake_actions += 1,
                                Instruction::ClaimRewards => metrics.claim_actions += 1,
                                Instruction::DepositCollateral { amount } => {
                                    metrics.vault_collateral += *amount
                                }
                                Instruction::BorrowUSDT { amount } => {
                                    metrics.vusd_borrowed += *amount
                                }
                                Instruction::RepayUSDT { amount } => metrics.vusd_repaid += *amount,
                                Instruction::AddLiquidity {
                                    rng_amount,
                                    usdt_amount,
                                } => {
                                    metrics.liquidity_rng_added += *rng_amount;
                                    metrics.liquidity_vusd_added += *usdt_amount;
                                }
                                Instruction::RemoveLiquidity { shares } => {
                                    metrics.liquidity_shares_removed += *shares
                                }
                                Instruction::CasinoStartGame {
                                    bet,
                                    game_type,
                                    session_id,
                                } => {
                                    // Determine if this is a freeroll tournament session
                                    let is_tournament = match client
                                        .query_state(&Key::CasinoSession(*session_id))
                                        .await
                                    {
                                        Ok(Some(lookup)) => match lookup.operation.value() {
                                            Some(Value::CasinoSession(s)) => s.is_tournament,
                                            _ => false,
                                        },
                                        _ => false,
                                    };

                                    session_bets.insert(
                                        *session_id,
                                        SessionMeta {
                                            bet: *bet,
                                            is_tournament,
                                        },
                                    );

                                    if is_tournament {
                                        metrics.tournament_game_starts += 1;
                                        metrics.tournament_game_bet_volume += *bet;
                                        let game_name = format!("{:?}", game_type);
                                        let entry =
                                            freeroll_game_stats.entry(game_name).or_insert((0, 0));
                                        entry.0 = entry.0.saturating_add(*bet);
                                        let player_key = to_hex(tx.public.as_ref());
                                        let entry_p = freeroll_player_stats
                                            .entry(player_key)
                                            .or_insert((0, 0, 0));
                                        entry_p.0 = entry_p.0.saturating_add(*bet);
                                        entry_p.2 = entry_p.2.saturating_add(1);
                                    } else {
                                        metrics.game_starts += 1;
                                        metrics.game_bet_volume += *bet;
                                        if tx.public == maximizer_pk {
                                            metrics.maximizer_game_bet_volume += *bet;
                                        }
                                        // Track per-game bet volume and player sessions
                                        let game_name = format!("{:?}", game_type);
                                        let entry = game_stats.entry(game_name).or_insert((0, 0));
                                        entry.0 = entry.0.saturating_add(*bet);
                                        let player_key = to_hex(tx.public.as_ref());
                                        let entry_p =
                                            player_stats.entry(player_key).or_insert((0, 0, 0));
                                        entry_p.0 = entry_p.0.saturating_add(*bet);
                                        entry_p.2 = entry_p.2.saturating_add(1);
                                    }
                                }
                                Instruction::CasinoStartTournament { .. } => {
                                    metrics.tournament_started += 1
                                }
                                Instruction::CasinoJoinTournament { .. } => {
                                    metrics.tournament_joined += 1;
                                    if grinders.contains(&tx.public) {
                                        metrics.grinder_tournament_joins += 1;
                                    }
                                }
                                Instruction::CasinoEndTournament { .. } => {
                                    metrics.tournament_ended += 1
                                }
                                Instruction::ProcessEpoch => metrics.epoch_calls += 1,
                                _ => {}
                            }
                        }
                        Output::Event(ev) => match ev {
                            Event::CasinoGameCompleted {
                                session_id,
                                payout,
                                game_type,
                                player,
                                ..
                            } => {
                                let meta = session_bets.remove(&session_id);
                                let bet_for_session = meta.map(|m| m.bet).unwrap_or(0);
                                let is_tournament = meta.map(|m| m.is_tournament).unwrap_or(false);
                                // Net PnL is payout minus original wager for wins/pushes,
                                // but raw payout already contains the loss for busts.
                                let net_pnl = if payout >= 0 {
                                    payout - bet_for_session as i64
                                } else {
                                    payout
                                };
                                if is_tournament {
                                    metrics.tournament_game_net_payout += net_pnl;
                                    let game_name = format!("{:?}", game_type);
                                    let entry =
                                        freeroll_game_stats.entry(game_name).or_insert((0, 0));
                                    entry.1 += net_pnl;
                                    let player_key = to_hex(player.as_ref());
                                    let entry_p = freeroll_player_stats
                                        .entry(player_key)
                                        .or_insert((0, 0, 0));
                                    entry_p.1 += net_pnl;
                                } else {
                                    metrics.game_net_payout += net_pnl;
                                    let game_name = format!("{:?}", game_type);
                                    let entry = game_stats.entry(game_name).or_insert((0, 0));
                                    entry.1 += net_pnl;
                                    let player_key = to_hex(player.as_ref());
                                    let entry_p =
                                        player_stats.entry(player_key).or_insert((0, 0, 0));
                                    entry_p.1 += net_pnl;
                                }
                            }
                            Event::TournamentStarted { .. } => metrics.tournament_started += 1,
                            Event::PlayerJoined { .. } => metrics.tournament_joined += 1,
                            Event::TournamentEnded { .. } => metrics.tournament_ended += 1,
                            Event::CasinoError { error_code, .. } => {
                                metrics.errors += 1;
                                match error_code {
                                    nullspace_types::casino::ERROR_INVALID_MOVE => {
                                        metrics.errors_invalid_move += 1;
                                    }
                                    nullspace_types::casino::ERROR_INVALID_BET => {
                                        metrics.errors_invalid_bet += 1;
                                    }
                                    nullspace_types::casino::ERROR_INSUFFICIENT_FUNDS => {
                                        metrics.errors_insufficient += 1;
                                    }
                                    nullspace_types::casino::ERROR_PLAYER_NOT_FOUND => {
                                        metrics.errors_player_not_found += 1;
                                    }
                                    nullspace_types::casino::ERROR_SESSION_EXISTS => {
                                        metrics.errors_session_exists += 1;
                                    }
                                    nullspace_types::casino::ERROR_SESSION_NOT_FOUND => {
                                        metrics.errors_session_not_found += 1;
                                    }
                                    nullspace_types::casino::ERROR_SESSION_NOT_OWNED => {
                                        metrics.errors_session_not_owned += 1;
                                    }
                                    nullspace_types::casino::ERROR_SESSION_COMPLETE => {
                                        metrics.errors_session_complete += 1;
                                    }
                                    nullspace_types::casino::ERROR_TOURNAMENT_NOT_REGISTERING => {
                                        metrics.errors_tournament_not_registering += 1;
                                    }
                                    nullspace_types::casino::ERROR_ALREADY_IN_TOURNAMENT => {
                                        metrics.errors_already_in_tournament += 1;
                                    }
                                    nullspace_types::casino::ERROR_TOURNAMENT_LIMIT_REACHED => {
                                        metrics.errors_tournament_limit_reached += 1;
                                    }
                                    nullspace_types::casino::ERROR_RATE_LIMITED => {
                                        metrics.errors_rate_limited += 1;
                                    }
                                    _ => metrics.errors_other += 1,
                                }
                            }
                            _ => {}
                        },
                        _ => {}
                    }
                }
            }

            // 2. Fetch Global State Deltas
            let current_house = match client.query_state(&Key::House).await {
                Ok(Some(lookup)) => {
                    if let Some(Value::House(h)) = lookup.operation.value() {
                        h.clone()
                    } else {
                        last_house.clone()
                    }
                }
                _ => last_house.clone(),
            };

            let burn_delta = current_house
                .total_burned
                .saturating_sub(last_house.total_burned);
            let mint_delta = current_house
                .total_issuance
                .saturating_sub(last_house.total_issuance);
            let fee_delta = current_house
                .accumulated_fees
                .saturating_sub(last_house.accumulated_fees); // Approx global fees

            // 3a. Aggregate game stats and top players
            let mut game_stats_vec: Vec<GameStat> = game_stats
                .iter()
                .map(|(name, (bet_volume, net_payout))| GameStat {
                    game_type: name.clone(),
                    bet_volume: *bet_volume,
                    net_payout: *net_payout,
                    house_edge: -*net_payout,
                })
                .collect();
            game_stats_vec.sort_by(|a, b| b.bet_volume.cmp(&a.bet_volume));

            let mut freeroll_game_stats_vec: Vec<GameStat> = freeroll_game_stats
                .iter()
                .map(|(name, (bet_volume, net_payout))| GameStat {
                    game_type: name.clone(),
                    bet_volume: *bet_volume,
                    net_payout: *net_payout,
                    house_edge: 0, // Freeroll: no house edge
                })
                .collect();
            freeroll_game_stats_vec.sort_by(|a, b| b.bet_volume.cmp(&a.bet_volume));

            let mut top_players_vec: Vec<PlayerStat> = player_stats
                .iter()
                .map(|(pk, (bet_volume, pnl, sessions))| PlayerStat {
                    player: pk.clone(),
                    game_pnl: *pnl,
                    bet_volume: *bet_volume,
                    sessions: *sessions,
                })
                .collect();
            top_players_vec.sort_by(|a, b| b.game_pnl.cmp(&a.game_pnl));
            top_players_vec.truncate(10);

            let mut freeroll_top_players_vec: Vec<PlayerStat> = freeroll_player_stats
                .iter()
                .map(|(pk, (bet_volume, pnl, sessions))| PlayerStat {
                    player: pk.clone(),
                    game_pnl: *pnl,
                    bet_volume: *bet_volume,
                    sessions: *sessions,
                })
                .collect();
            freeroll_top_players_vec.sort_by(|a, b| b.game_pnl.cmp(&a.game_pnl));
            freeroll_top_players_vec.truncate(10);

            // 3. Maximizer NW
            let mut max_nw = 0i64;
            let mut max_debt = 0u64;
            if let Ok(Some(lookup)) = client
                .query_state(&Key::CasinoPlayer(maximizer.public_key()))
                .await
            {
                if let Some(Value::CasinoPlayer(p)) = lookup.operation.value() {
                    if let Ok(Some(vault_lookup)) = client
                        .query_state(&Key::Vault(maximizer.public_key()))
                        .await
                    {
                        if let Some(Value::Vault(v)) = vault_lookup.operation.value() {
                            max_debt = v.debt_vusdt;
                        }
                    }
                    let vusdt_val = p.vusdt_balance as f64;
                    let rng_val = (p.chips as f64) * price;
                    max_nw = (rng_val + vusdt_val - max_debt as f64).round() as i64;
                }
            }

            // Log Snapshot
            log.push(EconomySnapshot {
                block_height,
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64,
                house_pnl: current_house.net_pnl,
                rng_price: price,
                total_burned: current_house.total_burned,
                total_issuance: current_house.total_issuance,
                amm_rng: a.reserve_rng,
                amm_vusdt: a.reserve_vusdt,
                maximizer_nw: max_nw,
                tx_count,
                volume_vusdt,
                fees_vusdt: fee_delta,
                burn_rng: burn_delta,
                mint_rng: mint_delta,
                epoch: current_house.current_epoch,
                lp_shares: a.total_shares,
                total_staked: current_house.total_staked_amount,
                swap_count: metrics.swap_count,
                buy_volume_vusdt: metrics.buy_volume_vusdt,
                sell_volume_rng: metrics.sell_volume_rng,
                game_bet_volume: metrics.game_bet_volume,
                game_net_payout: metrics.game_net_payout,
                game_starts: metrics.game_starts,
                tournament_game_bet_volume: metrics.tournament_game_bet_volume,
                tournament_game_net_payout: metrics.tournament_game_net_payout,
                tournament_game_starts: metrics.tournament_game_starts,
                stakes_in: metrics.stakes_in,
                unstake_actions: metrics.unstake_actions,
                claim_actions: metrics.claim_actions,
                pool_tvl_vusdt,
                amm_invariant_k,
                lp_share_price_vusdt,
                whale_volume_vusdt: metrics.whale_volume_vusdt,
                retail_volume_vusdt: metrics.retail_volume_vusdt,
                grinder_tournament_joins: metrics.grinder_tournament_joins,
                maximizer_game_bet_volume: metrics.maximizer_game_bet_volume,
                errors_invalid_move: metrics.errors_invalid_move,
                errors_invalid_bet: metrics.errors_invalid_bet,
                errors_insufficient: metrics.errors_insufficient,
                errors_player_not_found: metrics.errors_player_not_found,
                errors_session_exists: metrics.errors_session_exists,
                errors_session_not_found: metrics.errors_session_not_found,
                errors_session_not_owned: metrics.errors_session_not_owned,
                errors_session_complete: metrics.errors_session_complete,
                errors_tournament_not_registering: metrics.errors_tournament_not_registering,
                errors_already_in_tournament: metrics.errors_already_in_tournament,
                errors_tournament_limit_reached: metrics.errors_tournament_limit_reached,
                errors_rate_limited: metrics.errors_rate_limited,
                errors_other: metrics.errors_other,
                submit_failures: submit_failures_delta,
                vault_collateral: metrics.vault_collateral,
                vusd_borrowed: metrics.vusd_borrowed,
                vusd_repaid: metrics.vusd_repaid,
                liquidity_rng_added,
                liquidity_vusd_added,
                liquidity_shares_removed,
                tournament_started: metrics.tournament_started,
                tournament_joined: metrics.tournament_joined,
                tournament_ended: metrics.tournament_ended,
                epoch_calls: metrics.epoch_calls,
                errors: metrics.errors,
                game_stats: game_stats_vec.clone(),
                top_players: top_players_vec.clone(),
                freeroll_game_stats: freeroll_game_stats_vec.clone(),
                freeroll_top_players: freeroll_top_players_vec.clone(),
            });

            // Write to file
            if let Ok(json) = serde_json::to_string_pretty(&log) {
                let _ =
                    File::create("economy_log.json").and_then(|mut f| f.write_all(json.as_bytes()));
            }

            // Update state for next delta
            last_house = current_house;
            last_amm = Some(a);
            last_submit_failures = SUBMIT_FAILURES.load(Ordering::Relaxed);

            // Debug Logs
            info!(
                "Block {}: Price=${:.4} Volume=${} Swaps={} Burn={} Mint={}",
                block_height, price, volume_vusdt, metrics.swap_count, burn_delta, mint_delta
            );
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    let identity_bytes = commonware_utils::from_hex(&args.identity).ok_or("Invalid identity")?;
    let identity = Identity::decode(&mut identity_bytes.as_slice())?;
    let client = Arc::new(Client::new(&args.url, identity)?);
    let mut rng = StdRng::from_entropy();

    info!("Starting Enhanced Ecosystem Simulation");

    // Agents
    let bootstrapper = Arc::new(Bot::new("Bootstrapper", &mut rng));
    let organizer = Arc::new(Bot::new("Organizer", &mut rng));
    let keeper = Arc::new(Bot::new("Keeper", &mut rng));
    let maximizer = Arc::new(Bot::new("Maximizer", &mut rng));
    let whales: Vec<_> = (0..2)
        .map(|i| Arc::new(Bot::new(&format!("Whale{}", i), &mut rng)))
        .collect();
    let retail: Vec<_> = (0..50)
        .map(|i| Arc::new(Bot::new(&format!("Retail{}", i), &mut rng)))
        .collect();
    let grinders: Vec<_> = (0..100)
        .map(|i| Arc::new(Bot::new(&format!("Grinder{}", i), &mut rng)))
        .collect();

    // Funding
    flush_tx(
        &client,
        Transaction::sign(
            &organizer.keypair,
            organizer.next_nonce(),
            Instruction::CasinoRegister {
                name: "Organizer".to_string(),
            },
        ),
    )
    .await;
    bootstrap_amm(client.clone(), bootstrapper.clone()).await;

    // Spawn
    let duration = Duration::from_secs(args.duration);
    let mut handles = Vec::new();

    // Monitor
    let c = client.clone();
    let m = maximizer.clone();
    let whale_pks: Vec<PublicKey> = whales.iter().map(|w| w.public_key()).collect();
    let retail_pks: Vec<PublicKey> = retail.iter().map(|r| r.public_key()).collect();
    let grinder_pks: Vec<PublicKey> = grinders.iter().map(|g| g.public_key()).collect();
    let maximizer_pk = maximizer.public_key();
    handles.push(tokio::spawn(async move {
        run_monitor(
            c,
            m,
            whale_pks,
            retail_pks,
            grinder_pks,
            maximizer_pk,
            duration,
        )
        .await;
    }));

    // Keeper
    let c = client.clone();
    let k = keeper.clone();
    handles.push(tokio::spawn(async move {
        run_keeper(c, k, duration).await;
    }));

    // Organizer
    let c = client.clone();
    let o = organizer.clone();
    handles.push(tokio::spawn(async move {
        run_tournaments(c, o, duration).await;
    }));

    // Maximizer
    let c = client.clone();
    let m = maximizer.clone();
    handles.push(tokio::spawn(async move {
        run_maximizer(c, m, duration).await;
    }));

    // Whales
    for bot in whales {
        let c = client.clone();
        handles.push(tokio::spawn(async move {
            run_whale(c, bot, duration).await;
        }));
    }

    // Retail
    for bot in retail {
        let c = client.clone();
        handles.push(tokio::spawn(async move {
            run_retail(c, bot, duration).await;
        }));
    }

    // Grinders
    for bot in grinders {
        let c = client.clone();
        handles.push(tokio::spawn(async move {
            run_tournament_grinder(c, bot, duration).await;
        }));
    }

    // Wait
    for handle in handles {
        let _ = handle.await;
    }

    info!("Simulation Complete");
    Ok(())
}
