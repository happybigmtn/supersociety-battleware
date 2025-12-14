/// Maximum name length for player registration
pub const MAX_NAME_LENGTH: usize = 32;

/// Maximum payload length for game moves
pub const MAX_PAYLOAD_LENGTH: usize = 256;

/// Starting chips for new players
pub const STARTING_CHIPS: u64 = 1_000;

/// Starting shields per tournament
pub const STARTING_SHIELDS: u32 = 3;

/// Starting doubles per tournament
pub const STARTING_DOUBLES: u32 = 3;

/// Game session expiry in blocks
pub const SESSION_EXPIRY: u64 = 100;

/// Faucet deposit amount (dev mode only)
pub const FAUCET_AMOUNT: u64 = 1_000;

/// Faucet rate limit in blocks (100 blocks ≈ 5 minutes at 3s/block)
pub const FAUCET_RATE_LIMIT: u64 = 100;

/// Initial chips granted on registration
pub const INITIAL_CHIPS: u64 = 1_000;

/// Tokenomics Constants
pub const TOTAL_SUPPLY: u64 = 1_000_000_000;
/// Annual emission rate (basis points) used for freeroll tournament prizes.
/// 5% per year (down from earlier 10% versions).
pub const ANNUAL_EMISSION_RATE_BPS: u64 = 500;
/// Reward pool reserved for tournament emissions.
/// Target: distribute 25% of total supply over ~5 years (≈5%/year).
pub const REWARD_POOL_BPS: u64 = 2500;
/// Tournaments per day (registration 60s + active 300s = 360s): floor(86400/360) = 240
pub const TOURNAMENTS_PER_DAY: u64 = 240;

// Progressive base jackpots (chip-denominated; meters, if enabled, reset to these values).
pub const THREE_CARD_PROGRESSIVE_BASE_JACKPOT: u64 = 10_000;
pub const UTH_PROGRESSIVE_BASE_JACKPOT: u64 = 10_000;

/// Error codes for CasinoError events
pub const ERROR_PLAYER_ALREADY_REGISTERED: u8 = 1;
pub const ERROR_PLAYER_NOT_FOUND: u8 = 2;
pub const ERROR_INSUFFICIENT_FUNDS: u8 = 3;
pub const ERROR_INVALID_BET: u8 = 4;
pub const ERROR_SESSION_EXISTS: u8 = 5;
pub const ERROR_SESSION_NOT_FOUND: u8 = 6;
pub const ERROR_SESSION_NOT_OWNED: u8 = 7;
pub const ERROR_SESSION_COMPLETE: u8 = 8;
pub const ERROR_INVALID_MOVE: u8 = 9;
pub const ERROR_RATE_LIMITED: u8 = 10;
pub const ERROR_TOURNAMENT_NOT_REGISTERING: u8 = 11;
pub const ERROR_ALREADY_IN_TOURNAMENT: u8 = 12;
pub const ERROR_TOURNAMENT_LIMIT_REACHED: u8 = 13;

/// Tournament duration in seconds (5 minutes)
pub const TOURNAMENT_DURATION_SECS: u64 = 5 * 60;
