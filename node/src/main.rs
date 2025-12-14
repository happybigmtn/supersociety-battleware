use anyhow::{Context, Result};
use clap::{Arg, ArgAction, Command};
use commonware_codec::DecodeExt;
use commonware_cryptography::{ed25519::PublicKey, Signer};
use commonware_deployer::ec2::Hosts;
use commonware_p2p::authenticated::discovery as authenticated;
use commonware_runtime::{tokio, Metrics, Runner};
use commonware_utils::{from_hex_formatted, union_unique, NZUsize};
use futures::future::try_join_all;
use governor::Quota;
use nullspace_client::Client;
use nullspace_node::{engine, parse_peer_public_key, Config, Peers};
use nullspace_types::NAMESPACE;
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    num::{NonZeroU32, NonZeroUsize},
    path::PathBuf,
    str::FromStr,
    time::Duration,
};
use tracing::{error, info, Level};

const PENDING_CHANNEL: u32 = 0;
const RECOVERED_CHANNEL: u32 = 1;
const RESOLVER_CHANNEL: u32 = 2;
const BROADCASTER_CHANNEL: u32 = 3;
const BACKFILL_BY_DIGEST_CHANNEL: u32 = 4;
const SEEDER_CHANNEL: u32 = 5;
const AGGREGATOR_CHANNEL: u32 = 6;
const AGGREGATION_CHANNEL: u32 = 7;

const LEADER_TIMEOUT: Duration = Duration::from_secs(1);
const NOTARIZATION_TIMEOUT: Duration = Duration::from_secs(2);
const NULLIFY_RETRY: Duration = Duration::from_secs(10);
const ACTIVITY_TIMEOUT: u64 = 256;
const SKIP_TIMEOUT: u64 = 32;
const FETCH_TIMEOUT: Duration = Duration::from_secs(2);
const FETCH_CONCURRENT: usize = 16;
const MAX_MESSAGE_SIZE: usize = 10 * 1024 * 1024; // 10MB
const MAX_FETCH_COUNT: usize = 16;
const MAX_FETCH_SIZE: usize = 1024 * 1024; // 1MB
const BLOCKS_FREEZER_TABLE_INITIAL_SIZE: u32 = 2u32.pow(21); // 100MB
const FINALIZED_FREEZER_TABLE_INITIAL_SIZE: u32 = 2u32.pow(21); // 100MB
const BUFFER_POOL_PAGE_SIZE: NonZeroUsize = NZUsize!(4_096); // 4KB
const BUFFER_POOL_CAPACITY: NonZeroUsize = NZUsize!(32_768); // 128MB
const MAX_UPLOADS_OUTSTANDING: usize = 4;

type PeerList = Vec<PublicKey>;
type BootstrapList = Vec<(PublicKey, SocketAddr)>;
type PeerConfig = (IpAddr, PeerList, BootstrapList);

fn load_peers(
    hosts_file: Option<String>,
    peers_file: Option<String>,
    bootstrappers: &[String],
    port: u16,
    public_key: &PublicKey,
) -> Result<PeerConfig> {
    if let Some(hosts_file) = hosts_file {
        let hosts_file = std::fs::read_to_string(&hosts_file)
            .with_context(|| format!("Could not read hosts file {hosts_file}"))?;
        let hosts: Hosts =
            serde_yaml::from_str(&hosts_file).context("Could not parse hosts file")?;
        let peers: HashMap<PublicKey, IpAddr> = hosts
            .hosts
            .into_iter()
            .filter_map(|peer| match parse_peer_public_key(&peer.name) {
                Some(key) => Some((key, peer.ip)),
                None => {
                    info!(name = peer.name, "Skipping non-peer host");
                    None
                }
            })
            .collect();

        let peer_keys = peers.keys().cloned().collect::<Vec<_>>();
        let mut bootstrap_sockets = Vec::new();
        for bootstrapper in bootstrappers {
            let key = from_hex_formatted(bootstrapper)
                .with_context(|| format!("Could not parse bootstrapper key {bootstrapper}"))?;
            let key = PublicKey::decode(key.as_ref())
                .with_context(|| format!("Bootstrapper key is invalid: {bootstrapper}"))?;
            let ip = peers
                .get(&key)
                .with_context(|| format!("Could not find bootstrapper {bootstrapper} in hosts"))?;
            bootstrap_sockets.push((key, SocketAddr::new(*ip, port)));
        }
        let ip = peers
            .get(public_key)
            .context("Could not find self in hosts")?;
        return Ok((*ip, peer_keys, bootstrap_sockets));
    }

    let peers_file = peers_file.context("missing --peers")?;
    let peers_file = std::fs::read_to_string(&peers_file)
        .with_context(|| format!("Could not read peers file {peers_file}"))?;
    let peers: Peers = serde_yaml::from_str(&peers_file).context("Could not parse peers file")?;
    let peers: HashMap<PublicKey, SocketAddr> = peers
        .addresses
        .into_iter()
        .filter_map(|peer| match parse_peer_public_key(&peer.0) {
            Some(key) => Some((key, peer.1)),
            None => {
                info!(name = peer.0, "Skipping non-peer address");
                None
            }
        })
        .collect();

    let peer_keys = peers.keys().cloned().collect::<Vec<_>>();
    let mut bootstrap_sockets = Vec::new();
    for bootstrapper in bootstrappers {
        let key = from_hex_formatted(bootstrapper)
            .with_context(|| format!("Could not parse bootstrapper key {bootstrapper}"))?;
        let key = PublicKey::decode(key.as_ref())
            .with_context(|| format!("Bootstrapper key is invalid: {bootstrapper}"))?;
        let socket = peers
            .get(&key)
            .with_context(|| format!("Could not find bootstrapper {bootstrapper} in peers"))?;
        bootstrap_sockets.push((key, *socket));
    }
    let ip = peers
        .get(public_key)
        .context("Could not find self in peers")?
        .ip();
    Ok((ip, peer_keys, bootstrap_sockets))
}

fn main() {
    if let Err(err) = main_result() {
        eprintln!("{err:?}");
        std::process::exit(1);
    }
}

fn main_result() -> Result<()> {
    // Parse arguments
    let matches = Command::new("node")
        .about("Node for a nullspace chain.")
        .arg(Arg::new("hosts").long("hosts").required(false))
        .arg(Arg::new("peers").long("peers").required(false))
        .arg(
            Arg::new("dry-run")
                .long("dry-run")
                .help("Validate config/peers and exit without starting the node")
                .action(ArgAction::SetTrue),
        )
        .arg(Arg::new("config").long("config").required(true))
        .get_matches();

    // Load ip file
    let hosts_file = matches.get_one::<String>("hosts").cloned();
    let peers_file = matches.get_one::<String>("peers").cloned();
    let dry_run = matches.get_flag("dry-run");
    if hosts_file.is_none() && peers_file.is_none() {
        anyhow::bail!("Either --hosts or --peers must be provided");
    }

    // Load config
    let config_file = matches
        .get_one::<String>("config")
        .context("missing --config")?;
    let config_file = std::fs::read_to_string(config_file)
        .with_context(|| format!("Could not read config file {config_file}"))?;
    let config: Config =
        serde_yaml::from_str(&config_file).context("Could not parse config file")?;

    if dry_run {
        let signer = config.parse_signer().context("Private key is invalid")?;
        let public_key = signer.public_key();

        let (_ip, peers, _bootstrappers) = load_peers(
            hosts_file,
            peers_file,
            &config.bootstrappers,
            config.port,
            &public_key,
        )?;
        let peers_u32 = peers.len() as u32;

        let config = config.validate_with_signer(signer, peers_u32)?;
        let _indexer = Client::new(&config.indexer, config.identity)
            .context("Failed to create indexer client")?;

        println!("config ok");
        return Ok(());
    }

    // Initialize runtime
    let cfg = tokio::Config::default()
        .with_tcp_nodelay(Some(true))
        .with_worker_threads(config.worker_threads)
        .with_storage_directory(PathBuf::from(&config.directory))
        .with_catch_panics(true);
    let executor = tokio::Runner::new(cfg);

    // Start runtime
    executor.start(|context| async move {
        let result: Result<()> = async {
            let use_json_logs = hosts_file.is_some();

            // Configure telemetry
            let log_level = Level::from_str(&config.log_level).context("Invalid log level")?;
            tokio::telemetry::init(
                context.with_label("telemetry"),
                tokio::telemetry::Logging {
                    level: log_level,
                    // If we are using `commonware-deployer`, we should use structured logging.
                    json: use_json_logs,
                },
                Some(SocketAddr::new(
                    IpAddr::V4(Ipv4Addr::UNSPECIFIED),
                    config.metrics_port,
                )),
                None,
            );

            let signer = config.parse_signer().context("Private key is invalid")?;
            let public_key = signer.public_key();

            // Load peers
            let (ip, peers, bootstrappers) = load_peers(
                hosts_file,
                peers_file,
                &config.bootstrappers,
                config.port,
                &public_key,
            )?;
            info!(peers = peers.len(), "loaded peers");
            let peers_u32 = peers.len() as u32;

            let config = config.validate_with_signer(signer, peers_u32)?;
            let identity = config.identity;
            info!(
                ?config.public_key,
                ?identity,
                ?ip,
                port = config.port,
                "loaded config"
            );

            // Configure network
            let p2p_namespace = union_unique(NAMESPACE, b"_P2P");
            let mut p2p_cfg = authenticated::Config::aggressive(
                config.signer.clone(),
                &p2p_namespace,
                SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), config.port),
                SocketAddr::new(ip, config.port),
                bootstrappers,
                MAX_MESSAGE_SIZE,
            );
            p2p_cfg.mailbox_size = config.mailbox_size;

            // Start p2p
            let (mut network, mut oracle) =
                authenticated::Network::new(context.with_label("network"), p2p_cfg);

            // Provide authorized peers
            oracle.register(0, peers.clone()).await;

            // Register pending channel
            let pending_limit = Quota::per_second(NonZeroU32::new(128).unwrap());
            let pending = network.register(PENDING_CHANNEL, pending_limit, config.message_backlog);

            // Register recovered channel
            let recovered_limit = Quota::per_second(NonZeroU32::new(128).unwrap());
            let recovered =
                network.register(RECOVERED_CHANNEL, recovered_limit, config.message_backlog);

            // Register resolver channel
            let resolver_limit = Quota::per_second(NonZeroU32::new(128).unwrap());
            let resolver =
                network.register(RESOLVER_CHANNEL, resolver_limit, config.message_backlog);

            // Register broadcast channel
            let broadcaster_limit = Quota::per_second(NonZeroU32::new(32).unwrap()); // Increased for faster block propagation
            let broadcaster = network.register(
                BROADCASTER_CHANNEL,
                broadcaster_limit,
                config.message_backlog,
            );

            // Register backfill channel
            let backfill_quota = Quota::per_second(NonZeroU32::new(8).unwrap());
            let backfill = network.register(
                BACKFILL_BY_DIGEST_CHANNEL,
                backfill_quota,
                config.message_backlog,
            );

            // Register seeder channel
            let seeder = network.register(SEEDER_CHANNEL, backfill_quota, config.message_backlog);

            // Register aggregator channel
            let aggregator =
                network.register(AGGREGATOR_CHANNEL, backfill_quota, config.message_backlog);

            // Register aggregation channel
            let aggregation_quota = Quota::per_second(NonZeroU32::new(128).unwrap());
            let aggregation = network.register(
                AGGREGATION_CHANNEL,
                aggregation_quota,
                config.message_backlog,
            );

            // Create network
            let p2p = network.start();

            // Create indexer
            let indexer = Client::new(&config.indexer, identity)
                .context("Failed to create indexer client")?;

            // Create engine
            let config = engine::Config {
                blocker: oracle,
                partition_prefix: "engine".to_string(),
                blocks_freezer_table_initial_size: BLOCKS_FREEZER_TABLE_INITIAL_SIZE,
                finalized_freezer_table_initial_size: FINALIZED_FREEZER_TABLE_INITIAL_SIZE,
                signer: config.signer,
                polynomial: config.polynomial,
                share: config.share,
                participants: peers,
                mailbox_size: config.mailbox_size,
                deque_size: config.deque_size,
                backfill_quota,
                leader_timeout: LEADER_TIMEOUT,
                notarization_timeout: NOTARIZATION_TIMEOUT,
                nullify_retry: NULLIFY_RETRY,
                activity_timeout: ACTIVITY_TIMEOUT,
                skip_timeout: SKIP_TIMEOUT,
                fetch_timeout: FETCH_TIMEOUT,
                max_fetch_count: MAX_FETCH_COUNT,
                max_fetch_size: MAX_FETCH_SIZE,
                fetch_concurrent: FETCH_CONCURRENT,
                fetch_rate_per_peer: resolver_limit,
                buffer_pool_page_size: BUFFER_POOL_PAGE_SIZE,
                buffer_pool_capacity: BUFFER_POOL_CAPACITY,
                indexer,
                execution_concurrency: config.execution_concurrency,
                max_uploads_outstanding: MAX_UPLOADS_OUTSTANDING,
                mempool_max_backlog: config.mempool_max_backlog,
                mempool_max_transactions: config.mempool_max_transactions,
            };
            let engine = engine::Engine::new(context.with_label("engine"), config).await;

            // Start engine
            let engine = engine.start(
                pending,
                recovered,
                resolver,
                broadcaster,
                backfill,
                seeder,
                aggregator,
                aggregation,
            );

            // Wait for any task to error
            if let Err(e) = try_join_all(vec![p2p, engine]).await {
                error!(?e, "task failed");
            }
            Ok(())
        }
        .await;

        if let Err(e) = result {
            error!(?e, "node initialization failed");
        }
    });

    Ok(())
}
