//! Roulette game implementation with multi-bet support.
//!
//! State blob format:
//! [bet_count:u8] [bets:RouletteBet×count] [result:u8]?
//!
//! Each RouletteBet (10 bytes):
//! [bet_type:u8] [number:u8] [amount:u64 BE]
//!
//! Payload format:
//! [0, bet_type, number, amount_bytes...] - Place bet (adds to pending bets)
//! [1] - Spin wheel and resolve all bets
//! [2] - Clear all pending bets
//!
//! Bet types:
//! 0 = Straight (single number, 35:1)
//! 1 = Red (1:1)
//! 2 = Black (1:1)
//! 3 = Even (1:1)
//! 4 = Odd (1:1)
//! 5 = Low (1-18, 1:1)
//! 6 = High (19-36, 1:1)
//! 7 = Dozen (1-12, 13-24, 25-36, 2:1) - number = 0/1/2
//! 8 = Column (2:1) - number = 0/1/2

use super::super_mode::apply_super_multiplier_number;
use super::{CasinoGame, GameError, GameResult, GameRng};
use nullspace_types::casino::GameSession;

/// Maximum number of bets per session.
const MAX_BETS: usize = 20;

/// Red numbers on a roulette wheel.
const RED_NUMBERS: [u8; 18] = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];

/// Roulette bet types.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BetType {
    Straight = 0, // Single number (35:1)
    Red = 1,      // Red (1:1)
    Black = 2,    // Black (1:1)
    Even = 3,     // Even (1:1)
    Odd = 4,      // Odd (1:1)
    Low = 5,      // 1-18 (1:1)
    High = 6,     // 19-36 (1:1)
    Dozen = 7,    // 1-12, 13-24, 25-36 (2:1)
    Column = 8,   // First, second, third column (2:1)
}

impl TryFrom<u8> for BetType {
    type Error = GameError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(BetType::Straight),
            1 => Ok(BetType::Red),
            2 => Ok(BetType::Black),
            3 => Ok(BetType::Even),
            4 => Ok(BetType::Odd),
            5 => Ok(BetType::Low),
            6 => Ok(BetType::High),
            7 => Ok(BetType::Dozen),
            8 => Ok(BetType::Column),
            _ => Err(GameError::InvalidPayload),
        }
    }
}

/// Check if a number is red.
fn is_red(number: u8) -> bool {
    RED_NUMBERS.contains(&number)
}

/// Check if a bet wins for a given result.
fn bet_wins(bet_type: BetType, bet_number: u8, result: u8) -> bool {
    // Zero loses all except straight bet on 0
    if result == 0 {
        return bet_type == BetType::Straight && bet_number == 0;
    }

    match bet_type {
        BetType::Straight => bet_number == result,
        BetType::Red => is_red(result),
        BetType::Black => !is_red(result),
        BetType::Even => result % 2 == 0,
        BetType::Odd => result % 2 == 1,
        BetType::Low => result >= 1 && result <= 18,
        BetType::High => result >= 19 && result <= 36,
        BetType::Dozen => {
            let dozen = (result - 1) / 12; // 0, 1, or 2
            dozen == bet_number
        }
        BetType::Column => {
            // Column 0: 1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34
            // Column 1: 2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35
            // Column 2: 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36
            let column = (result - 1) % 3;
            column == bet_number
        }
    }
}

/// Get the payout multiplier for a bet type (excludes original bet).
fn payout_multiplier(bet_type: BetType) -> u64 {
    match bet_type {
        BetType::Straight => 35,
        BetType::Red | BetType::Black | BetType::Even | BetType::Odd | BetType::Low | BetType::High => 1,
        BetType::Dozen | BetType::Column => 2,
    }
}

/// Individual bet in roulette.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouletteBet {
    pub bet_type: BetType,
    pub number: u8,
    pub amount: u64,
}

impl RouletteBet {
    /// Serialize to 10 bytes: [bet_type:u8] [number:u8] [amount:u64 BE]
    fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(10);
        bytes.push(self.bet_type as u8);
        bytes.push(self.number);
        bytes.extend_from_slice(&self.amount.to_be_bytes());
        bytes
    }

    /// Deserialize from 10 bytes
    fn from_bytes(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < 10 {
            return None;
        }
        let bet_type = BetType::try_from(bytes[0]).ok()?;
        let number = bytes[1];
        let amount = u64::from_be_bytes(bytes[2..10].try_into().ok()?);
        Some(RouletteBet { bet_type, number, amount })
    }
}

/// Game state for multi-bet roulette.
struct RouletteState {
    bets: Vec<RouletteBet>,
    result: Option<u8>,
}

impl RouletteState {
    fn new() -> Self {
        RouletteState {
            bets: Vec::new(),
            result: None,
        }
    }

    /// Serialize state to blob
    fn to_blob(&self) -> Vec<u8> {
        // Capacity: 1 (bet count) + bets (10 bytes each) + 1 (optional result)
        let capacity = 1 + (self.bets.len() * 10) + if self.result.is_some() { 1 } else { 0 };
        let mut blob = Vec::with_capacity(capacity);
        blob.push(self.bets.len() as u8);
        for bet in &self.bets {
            blob.extend_from_slice(&bet.to_bytes());
        }
        if let Some(result) = self.result {
            blob.push(result);
        }
        blob
    }

    /// Deserialize state from blob
    fn from_blob(blob: &[u8]) -> Option<Self> {
        if blob.is_empty() {
            return Some(RouletteState::new());
        }

        let mut offset = 0;

        // Parse bets
        if offset >= blob.len() {
            return None;
        }
        let bet_count = blob[offset] as usize;
        offset += 1;

        // Validate bet count against maximum to prevent DoS via large allocations
        const MAX_BETS: usize = 20;
        if bet_count > MAX_BETS {
            return None;
        }

        // Validate we have enough bytes before allocating
        let required_len = offset + (bet_count * 10);
        if blob.len() < required_len {
            return None;
        }

        let mut bets = Vec::with_capacity(bet_count);
        for _ in 0..bet_count {
            if offset + 10 > blob.len() {
                return None;
            }
            let bet = RouletteBet::from_bytes(&blob[offset..offset + 10])?;
            bets.push(bet);
            offset += 10;
        }

        // Parse result (if present)
        let result = if offset < blob.len() {
            Some(blob[offset])
        } else {
            None
        };

        Some(RouletteState { bets, result })
    }
}

pub struct Roulette;

impl CasinoGame for Roulette {
    fn init(session: &mut GameSession, _rng: &mut GameRng) -> GameResult {
        // Initialize with empty state
        let state = RouletteState::new();
        session.state_blob = state.to_blob();
        GameResult::Continue
    }

    fn process_move(
        session: &mut GameSession,
        payload: &[u8],
        rng: &mut GameRng,
    ) -> Result<GameResult, GameError> {
        if session.is_complete {
            return Err(GameError::GameAlreadyComplete);
        }

        if payload.is_empty() {
            return Err(GameError::InvalidPayload);
        }

        // Parse current state
        let mut state = RouletteState::from_blob(&session.state_blob)
            .ok_or(GameError::InvalidPayload)?;

        match payload[0] {
            // [0, bet_type, number, amount_bytes...] - Place bet
            0 => {
                if payload.len() < 11 {
                    return Err(GameError::InvalidPayload);
                }

                // Wheel already spun - can't place more bets
                if state.result.is_some() {
                    return Err(GameError::InvalidMove);
                }

                let bet_type = BetType::try_from(payload[1])?;
                let number = payload[2];
                let amount = u64::from_be_bytes(
                    payload[3..11].try_into().map_err(|_| GameError::InvalidPayload)?
                );

                if amount == 0 {
                    return Err(GameError::InvalidPayload);
                }

                // Validate bet number
                match bet_type {
                    BetType::Straight => {
                        if number > 36 {
                            return Err(GameError::InvalidPayload);
                        }
                    }
                    BetType::Dozen | BetType::Column => {
                        if number > 2 {
                            return Err(GameError::InvalidPayload);
                        }
                    }
                    _ => {} // No number needed for other bets
                }

                // Check max bets limit
                if state.bets.len() >= MAX_BETS {
                    return Err(GameError::InvalidMove);
                }

                // Add bet (allow duplicates for roulette - bet on same spot multiple times)
                state.bets.push(RouletteBet { bet_type, number, amount });

                session.state_blob = state.to_blob();
                Ok(GameResult::Continue)
            }

            // [1] - Spin wheel and resolve all bets
            1 => {
                // Must have at least one bet
                if state.bets.is_empty() {
                    return Err(GameError::InvalidMove);
                }

                // Wheel already spun
                if state.result.is_some() {
                    return Err(GameError::InvalidMove);
                }

                // Spin the wheel
                let result = rng.spin_roulette();
                state.result = Some(result);

                // Calculate total payout across all bets
                let mut total_wagered: u64 = 0;
                let mut total_winnings: u64 = 0;

                for bet in &state.bets {
                    total_wagered = total_wagered.saturating_add(bet.amount);
                    if bet_wins(bet.bet_type, bet.number, result) {
                        // Win: return stake + winnings
                        let multiplier = payout_multiplier(bet.bet_type).saturating_add(1);
                        total_winnings = total_winnings.saturating_add(bet.amount.saturating_mul(multiplier));
                    }
                    // Loss: nothing added to winnings
                }

                session.state_blob = state.to_blob();
                session.move_count += 1;
                session.is_complete = true;

                // Determine final result
                if total_winnings > 0 {
                    // Apply super mode multipliers if active
                    let final_winnings = if session.super_mode.is_active {
                        // Lucky Number: multiplier applies to the winning number
                        apply_super_multiplier_number(
                            result,
                            &session.super_mode.multipliers,
                            total_winnings,
                        )
                    } else {
                        total_winnings
                    };
                    Ok(GameResult::Win(final_winnings))
                } else {
                    Ok(GameResult::Loss)
                }
            }

            // [2] - Clear all pending bets
            2 => {
                // Can't clear after wheel spun
                if state.result.is_some() {
                    return Err(GameError::InvalidMove);
                }

                state.bets.clear();
                session.state_blob = state.to_blob();
                Ok(GameResult::Continue)
            }

            _ => Err(GameError::InvalidPayload),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mocks::{create_account_keypair, create_network_keypair, create_seed};
    use nullspace_types::casino::GameType;

    fn create_test_seed() -> nullspace_types::Seed {
        let (network_secret, _) = create_network_keypair();
        create_seed(&network_secret, 1)
    }

    fn create_test_session(bet: u64) -> GameSession {
        let (_, pk) = create_account_keypair(1);
        GameSession {
            id: 1,
            player: pk,
            game_type: GameType::Roulette,
            bet,
            state_blob: vec![],
            move_count: 0,
            created_at: 0,
            is_complete: false,
            super_mode: nullspace_types::casino::SuperModeState::default(),
        }
    }

    #[test]
    fn test_is_red() {
        assert!(is_red(1));
        assert!(is_red(3));
        assert!(is_red(32));
        assert!(!is_red(2));
        assert!(!is_red(4));
        assert!(!is_red(0));
    }

    #[test]
    fn test_bet_wins_straight() {
        assert!(bet_wins(BetType::Straight, 17, 17));
        assert!(!bet_wins(BetType::Straight, 17, 18));
        assert!(bet_wins(BetType::Straight, 0, 0));
        assert!(!bet_wins(BetType::Straight, 1, 0)); // 0 loses non-zero straight
    }

    #[test]
    fn test_bet_wins_colors() {
        // Red numbers
        assert!(bet_wins(BetType::Red, 0, 1));
        assert!(bet_wins(BetType::Red, 0, 3));
        assert!(!bet_wins(BetType::Red, 0, 2));
        assert!(!bet_wins(BetType::Red, 0, 0)); // Zero loses

        // Black numbers
        assert!(bet_wins(BetType::Black, 0, 2));
        assert!(bet_wins(BetType::Black, 0, 4));
        assert!(!bet_wins(BetType::Black, 0, 1));
        assert!(!bet_wins(BetType::Black, 0, 0)); // Zero loses
    }

    #[test]
    fn test_bet_wins_even_odd() {
        assert!(bet_wins(BetType::Even, 0, 2));
        assert!(bet_wins(BetType::Even, 0, 36));
        assert!(!bet_wins(BetType::Even, 0, 1));
        assert!(!bet_wins(BetType::Even, 0, 0)); // Zero loses

        assert!(bet_wins(BetType::Odd, 0, 1));
        assert!(bet_wins(BetType::Odd, 0, 35));
        assert!(!bet_wins(BetType::Odd, 0, 2));
        assert!(!bet_wins(BetType::Odd, 0, 0)); // Zero loses
    }

    #[test]
    fn test_bet_wins_low_high() {
        assert!(bet_wins(BetType::Low, 0, 1));
        assert!(bet_wins(BetType::Low, 0, 18));
        assert!(!bet_wins(BetType::Low, 0, 19));
        assert!(!bet_wins(BetType::Low, 0, 0));

        assert!(bet_wins(BetType::High, 0, 19));
        assert!(bet_wins(BetType::High, 0, 36));
        assert!(!bet_wins(BetType::High, 0, 18));
        assert!(!bet_wins(BetType::High, 0, 0));
    }

    #[test]
    fn test_bet_wins_dozen() {
        // First dozen (1-12)
        assert!(bet_wins(BetType::Dozen, 0, 1));
        assert!(bet_wins(BetType::Dozen, 0, 12));
        assert!(!bet_wins(BetType::Dozen, 0, 13));

        // Second dozen (13-24)
        assert!(bet_wins(BetType::Dozen, 1, 13));
        assert!(bet_wins(BetType::Dozen, 1, 24));
        assert!(!bet_wins(BetType::Dozen, 1, 12));

        // Third dozen (25-36)
        assert!(bet_wins(BetType::Dozen, 2, 25));
        assert!(bet_wins(BetType::Dozen, 2, 36));
        assert!(!bet_wins(BetType::Dozen, 2, 24));
    }

    #[test]
    fn test_bet_wins_column() {
        // First column (1, 4, 7, ...)
        assert!(bet_wins(BetType::Column, 0, 1));
        assert!(bet_wins(BetType::Column, 0, 4));
        assert!(bet_wins(BetType::Column, 0, 34));
        assert!(!bet_wins(BetType::Column, 0, 2));

        // Second column (2, 5, 8, ...)
        assert!(bet_wins(BetType::Column, 1, 2));
        assert!(bet_wins(BetType::Column, 1, 35));
        assert!(!bet_wins(BetType::Column, 1, 3));

        // Third column (3, 6, 9, ...)
        assert!(bet_wins(BetType::Column, 2, 3));
        assert!(bet_wins(BetType::Column, 2, 36));
        assert!(!bet_wins(BetType::Column, 2, 1));
    }

    #[test]
    fn test_payout_multipliers() {
        assert_eq!(payout_multiplier(BetType::Straight), 35);
        assert_eq!(payout_multiplier(BetType::Red), 1);
        assert_eq!(payout_multiplier(BetType::Black), 1);
        assert_eq!(payout_multiplier(BetType::Dozen), 2);
        assert_eq!(payout_multiplier(BetType::Column), 2);
    }

    /// Helper to create place bet payload
    fn place_bet_payload(bet_type: BetType, number: u8, amount: u64) -> Vec<u8> {
        let mut payload = vec![0, bet_type as u8, number];
        payload.extend_from_slice(&amount.to_be_bytes());
        payload
    }

    #[test]
    fn test_place_bet() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        Roulette::init(&mut session, &mut rng);
        assert!(!session.is_complete);

        // Place a red bet
        let mut rng = GameRng::new(&seed, session.id, 1);
        let payload = place_bet_payload(BetType::Red, 0, 100);
        let result = Roulette::process_move(&mut session, &payload, &mut rng);

        assert!(result.is_ok());
        assert!(!session.is_complete); // Game continues - need to spin

        // Verify bet was stored
        let state = RouletteState::from_blob(&session.state_blob).expect("Failed to parse state");
        assert_eq!(state.bets.len(), 1);
        assert_eq!(state.bets[0].bet_type, BetType::Red);
        assert_eq!(state.bets[0].amount, 100);
    }

    #[test]
    fn test_game_completes_after_spin() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        Roulette::init(&mut session, &mut rng);
        assert!(!session.is_complete);

        // Place a red bet
        let mut rng = GameRng::new(&seed, session.id, 1);
        let payload = place_bet_payload(BetType::Red, 0, 100);
        Roulette::process_move(&mut session, &payload, &mut rng).expect("Failed to process move");

        // Spin the wheel
        let mut rng = GameRng::new(&seed, session.id, 2);
        let result = Roulette::process_move(&mut session, &[1], &mut rng);

        assert!(result.is_ok());
        assert!(session.is_complete);

        // State should have bet and result
        let state = RouletteState::from_blob(&session.state_blob).expect("Failed to parse state");
        assert!(state.result.is_some());
        assert!(state.result.expect("Result should be set") <= 36);
    }

    #[test]
    fn test_multi_bet() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        Roulette::init(&mut session, &mut rng);

        // Place multiple bets
        let mut rng = GameRng::new(&seed, session.id, 1);
        let payload = place_bet_payload(BetType::Red, 0, 50);
        Roulette::process_move(&mut session, &payload, &mut rng).expect("Failed to process move");

        let mut rng = GameRng::new(&seed, session.id, 2);
        let payload = place_bet_payload(BetType::Straight, 17, 25);
        Roulette::process_move(&mut session, &payload, &mut rng).expect("Failed to process move");

        let mut rng = GameRng::new(&seed, session.id, 3);
        let payload = place_bet_payload(BetType::Odd, 0, 25);
        Roulette::process_move(&mut session, &payload, &mut rng).expect("Failed to process move");

        // Verify all bets stored
        let state = RouletteState::from_blob(&session.state_blob).expect("Failed to parse state");
        assert_eq!(state.bets.len(), 3);

        // Spin
        let mut rng = GameRng::new(&seed, session.id, 4);
        let result = Roulette::process_move(&mut session, &[1], &mut rng);

        assert!(result.is_ok());
        assert!(session.is_complete);
    }

    #[test]
    fn test_invalid_bet_number() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        Roulette::init(&mut session, &mut rng);

        let mut rng = GameRng::new(&seed, session.id, 1);
        // Straight bet on 37 (invalid)
        let payload = place_bet_payload(BetType::Straight, 37, 100);
        let result = Roulette::process_move(&mut session, &payload, &mut rng);
        assert!(matches!(result, Err(GameError::InvalidPayload)));

        // Dozen bet on 3 (invalid, should be 0, 1, or 2)
        let payload = place_bet_payload(BetType::Dozen, 3, 100);
        let result = Roulette::process_move(&mut session, &payload, &mut rng);
        assert!(matches!(result, Err(GameError::InvalidPayload)));
    }

    #[test]
    fn test_spin_without_bets() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        Roulette::init(&mut session, &mut rng);

        // Try to spin without placing bets
        let mut rng = GameRng::new(&seed, session.id, 1);
        let result = Roulette::process_move(&mut session, &[1], &mut rng);

        assert!(matches!(result, Err(GameError::InvalidMove)));
    }

    #[test]
    fn test_clear_bets() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        Roulette::init(&mut session, &mut rng);

        // Place a bet
        let mut rng = GameRng::new(&seed, session.id, 1);
        let payload = place_bet_payload(BetType::Red, 0, 100);
        Roulette::process_move(&mut session, &payload, &mut rng).expect("Failed to process move");

        // Clear bets
        let mut rng = GameRng::new(&seed, session.id, 2);
        let result = Roulette::process_move(&mut session, &[2], &mut rng);
        assert!(result.is_ok());

        // Verify bets cleared
        let state = RouletteState::from_blob(&session.state_blob).expect("Failed to parse state");
        assert!(state.bets.is_empty());
    }

    #[test]
    fn test_straight_win_payout() {
        let seed = create_test_seed();

        // Find a session that produces a known result
        for session_id in 1..100 {
            let mut test_session = create_test_session(100);
            test_session.id = session_id;
            let mut rng = GameRng::new(&seed, session_id, 0);
            Roulette::init(&mut test_session, &mut rng);

            // Place bet on number 0
            let mut rng = GameRng::new(&seed, session_id, 1);
            let payload = place_bet_payload(BetType::Straight, 0, 100);
            Roulette::process_move(&mut test_session, &payload, &mut rng).expect("Failed to process move");

            // Spin
            let mut rng = GameRng::new(&seed, session_id, 2);
            let result = Roulette::process_move(&mut test_session, &[1], &mut rng);

            if let Ok(GameResult::Win(amount)) = result {
                // Straight bet pays 35:1 plus stake returned = 36x total
                assert_eq!(amount, 100 * 36);
                return; // Found a winning case
            }
        }
        // Note: It's statistically unlikely to hit 0 in 100 tries (expected ~2-3 times)
        // but not guaranteed. This test just verifies the logic works.
    }
}
