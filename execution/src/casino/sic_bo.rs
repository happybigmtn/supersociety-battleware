//! Sic Bo game implementation with multi-bet support.
//!
//! State blob format:
//! [bet_count:u8] [bets:SicBoBet×count] [die1:u8]? [die2:u8]? [die3:u8]?
//!
//! Each SicBoBet (10 bytes):
//! [bet_type:u8] [number:u8] [amount:u64 BE]
//!
//! Payload format:
//! Action 0: Place bet - [0, bet_type, number, amount_bytes...]
//! Action 1: Roll dice and resolve - [1]
//! Action 2: Clear bets - [2]
//!
//! Bet types:
//! 0 = Small (4-10, 1:1) - loses on triple
//! 1 = Big (11-17, 1:1) - loses on triple
//! 2 = Odd total (1:1)
//! 3 = Even total (1:1)
//! 4 = Specific triple (150:1) - number = 1-6
//! 5 = Any triple (24:1)
//! 6 = Specific double (8:1) - number = 1-6
//! 7 = Total of N (various payouts) - number = 4-17
//! 8 = Single number appears (1:1 to 3:1) - number = 1-6

use super::super_mode::apply_super_multiplier_total;
use super::{CasinoGame, GameError, GameResult, GameRng};
use nullspace_types::casino::GameSession;

/// Sic Bo bet types.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BetType {
    Small = 0,          // 4-10, loses on triple (1:1)
    Big = 1,            // 11-17, loses on triple (1:1)
    Odd = 2,            // Odd total (1:1)
    Even = 3,           // Even total (1:1)
    SpecificTriple = 4, // All three same specific (150:1)
    AnyTriple = 5,      // Any triple (24:1)
    SpecificDouble = 6, // At least two of specific (8:1)
    Total = 7,          // Specific total (various)
    Single = 8,         // Single number appears 1-3 times (1:1 to 3:1)
}

impl TryFrom<u8> for BetType {
    type Error = GameError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(BetType::Small),
            1 => Ok(BetType::Big),
            2 => Ok(BetType::Odd),
            3 => Ok(BetType::Even),
            4 => Ok(BetType::SpecificTriple),
            5 => Ok(BetType::AnyTriple),
            6 => Ok(BetType::SpecificDouble),
            7 => Ok(BetType::Total),
            8 => Ok(BetType::Single),
            _ => Err(GameError::InvalidPayload),
        }
    }
}

/// A single bet in Sic Bo (10 bytes).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SicBoBet {
    pub bet_type: BetType,
    pub number: u8,
    pub amount: u64,
}

impl SicBoBet {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(10);
        bytes.push(self.bet_type as u8);
        bytes.push(self.number);
        bytes.extend_from_slice(&self.amount.to_be_bytes());
        bytes
    }

    pub fn from_bytes(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < 10 {
            return None;
        }
        let bet_type = BetType::try_from(bytes[0]).ok()?;
        let number = bytes[1];
        let amount = u64::from_be_bytes(bytes[2..10].try_into().ok()?);
        Some(Self { bet_type, number, amount })
    }
}

/// Sic Bo game state.
struct SicBoState {
    bets: Vec<SicBoBet>,
    dice: Option<[u8; 3]>,
}

impl SicBoState {
    fn new() -> Self {
        Self {
            bets: Vec::new(),
            dice: None,
        }
    }

    fn from_bytes(bytes: &[u8]) -> Option<Self> {
        if bytes.is_empty() {
            return Some(Self::new());
        }

        let bet_count = bytes[0] as usize;

        // Validate bet count against maximum to prevent DoS via large allocations
        const MAX_BETS: usize = 20;
        if bet_count > MAX_BETS {
            return None;
        }

        let expected_bet_bytes = bet_count * 10;

        if bytes.len() < 1 + expected_bet_bytes {
            return None;
        }

        let mut bets = Vec::with_capacity(bet_count);
        let mut offset = 1;
        for _ in 0..bet_count {
            let bet = SicBoBet::from_bytes(&bytes[offset..])?;
            bets.push(bet);
            offset += 10;
        }

        // Optional dice result (3 bytes)
        let dice = if bytes.len() >= offset + 3 {
            Some([bytes[offset], bytes[offset + 1], bytes[offset + 2]])
        } else {
            None
        };

        Some(Self { bets, dice })
    }

    fn to_bytes(&self) -> Vec<u8> {
        // Capacity: 1 (bet count) + bets (10 bytes each) + 3 (optional dice)
        let capacity = 1 + (self.bets.len() * 10) + if self.dice.is_some() { 3 } else { 0 };
        let mut bytes = Vec::with_capacity(capacity);
        bytes.push(self.bets.len() as u8);
        for bet in &self.bets {
            bytes.extend(bet.to_bytes());
        }
        if let Some(dice) = self.dice {
            bytes.extend_from_slice(&dice);
        }
        bytes
    }
}

/// Payout table for total bets.
fn total_payout(total: u8) -> u64 {
    match total {
        4 | 17 => 50,
        5 | 16 => 18,
        6 | 15 => 14,
        7 | 14 => 12,
        8 | 13 => 8,
        9 | 12 => 6,
        10 | 11 => 6,
        _ => 0,
    }
}

/// Check if dice form a triple (all same).
fn is_triple(dice: &[u8; 3]) -> bool {
    dice[0] == dice[1] && dice[1] == dice[2]
}

/// Count occurrences of a specific number.
fn count_number(dice: &[u8; 3], number: u8) -> u8 {
    dice.iter().filter(|&&d| d == number).count() as u8
}

/// Calculate payout for a single bet given the dice result.
fn calculate_bet_payout(bet: &SicBoBet, dice: &[u8; 3]) -> u64 {
    let total: u8 = dice.iter().sum();
    let triple = is_triple(dice);

    match bet.bet_type {
        BetType::Small => {
            if !triple && total >= 4 && total <= 10 {
                bet.amount.saturating_mul(2) // 1:1 -> 2x
            } else {
                0
            }
        }
        BetType::Big => {
            if !triple && total >= 11 && total <= 17 {
                bet.amount.saturating_mul(2)
            } else {
                0
            }
        }
        BetType::Odd => {
            if total % 2 == 1 && !triple {
                bet.amount.saturating_mul(2)
            } else {
                0
            }
        }
        BetType::Even => {
            if total % 2 == 0 && !triple {
                bet.amount.saturating_mul(2)
            } else {
                0
            }
        }
        BetType::SpecificTriple => {
            if triple && dice[0] == bet.number {
                bet.amount.saturating_mul(151) // 150:1 -> 151x
            } else {
                0
            }
        }
        BetType::AnyTriple => {
            if triple {
                bet.amount.saturating_mul(25) // 24:1 -> 25x
            } else {
                0
            }
        }
        BetType::SpecificDouble => {
            if count_number(dice, bet.number) >= 2 {
                bet.amount.saturating_mul(9) // 8:1 -> 9x
            } else {
                0
            }
        }
        BetType::Total => {
            if total == bet.number {
                bet.amount.saturating_mul(total_payout(bet.number) + 1)
            } else {
                0
            }
        }
        BetType::Single => {
            let count = count_number(dice, bet.number);
            match count {
                1 => bet.amount.saturating_mul(2),  // 1:1 -> 2x
                2 => bet.amount.saturating_mul(3),  // 2:1 -> 3x
                3 => bet.amount.saturating_mul(4),  // 3:1 -> 4x
                _ => 0,
            }
        }
    }
}

pub struct SicBo;

impl CasinoGame for SicBo {
    fn init(session: &mut GameSession, _rng: &mut GameRng) -> GameResult {
        let state = SicBoState::new();
        session.state_blob = state.to_bytes();
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

        let action = payload[0];
        let mut state = SicBoState::from_bytes(&session.state_blob)
            .ok_or(GameError::InvalidMove)?;

        match action {
            // Action 0: Place bet
            0 => {
                if payload.len() < 11 {
                    return Err(GameError::InvalidPayload);
                }

                let bet_type = BetType::try_from(payload[1])?;
                let number = payload[2];
                let amount = u64::from_be_bytes(
                    payload[3..11].try_into().map_err(|_| GameError::InvalidPayload)?
                );

                // Validate number for bet types that need it
                match bet_type {
                    BetType::SpecificTriple | BetType::SpecificDouble | BetType::Single => {
                        if number < 1 || number > 6 {
                            return Err(GameError::InvalidPayload);
                        }
                    }
                    BetType::Total => {
                        if number < 4 || number > 17 {
                            return Err(GameError::InvalidPayload);
                        }
                    }
                    _ => {}
                }

                if amount == 0 {
                    return Err(GameError::InvalidPayload);
                }

                state.bets.push(SicBoBet { bet_type, number, amount });
                session.state_blob = state.to_bytes();
                session.move_count += 1;
                Ok(GameResult::ContinueWithUpdate { payout: -(amount as i64) })
            }

            // Action 1: Roll dice and resolve all bets
            1 => {
                if state.bets.is_empty() {
                    return Err(GameError::InvalidPayload); // Must have at least one bet
                }

                // Roll three dice
                let dice: [u8; 3] = [rng.roll_die(), rng.roll_die(), rng.roll_die()];
                state.dice = Some(dice);

                // Calculate total winnings and losses
                let total_bet: u64 = state.bets.iter().map(|b| b.amount).sum();
                let total_winnings: u64 = state.bets.iter()
                    .map(|bet| calculate_bet_payout(bet, &dice))
                    .sum();

                session.state_blob = state.to_bytes();
                session.move_count += 1;
                session.is_complete = true;

                // Determine overall result
                if total_winnings > total_bet {
                    // Net win
                    // Apply super mode multipliers if active
                    let final_winnings = if session.super_mode.is_active {
                        let dice_total = dice.iter().sum::<u8>();
                        apply_super_multiplier_total(
                            dice_total,
                            &session.super_mode.multipliers,
                            total_winnings,
                        )
                    } else {
                        total_winnings
                    };
                    Ok(GameResult::Win(final_winnings))
                } else if total_winnings == total_bet {
                    // Push - return original bet
                    Ok(GameResult::Push)
                } else if total_winnings > 0 {
                    // Partial win (still a loss overall) - apply multiplier
                    let final_winnings = if session.super_mode.is_active {
                        let dice_total = dice.iter().sum::<u8>();
                        apply_super_multiplier_total(
                            dice_total,
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

            // Action 2: Clear all bets
            2 => {
                state.bets.clear();
                session.state_blob = state.to_bytes();
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
            game_type: GameType::SicBo,
            bet,
            state_blob: vec![],
            move_count: 0,
            created_at: 0,
            is_complete: false,
            super_mode: nullspace_types::casino::SuperModeState::default(),
        }
    }

    /// Helper to create a place bet payload.
    fn place_bet_payload(bet_type: u8, number: u8, amount: u64) -> Vec<u8> {
        let mut payload = vec![0, bet_type, number];
        payload.extend_from_slice(&amount.to_be_bytes());
        payload
    }

    #[test]
    fn test_is_triple() {
        assert!(is_triple(&[1, 1, 1]));
        assert!(is_triple(&[6, 6, 6]));
        assert!(!is_triple(&[1, 1, 2]));
        assert!(!is_triple(&[1, 2, 3]));
    }

    #[test]
    fn test_count_number() {
        assert_eq!(count_number(&[1, 1, 1], 1), 3);
        assert_eq!(count_number(&[1, 1, 2], 1), 2);
        assert_eq!(count_number(&[1, 2, 3], 1), 1);
        assert_eq!(count_number(&[2, 2, 3], 1), 0);
    }

    #[test]
    fn test_total_payout() {
        assert_eq!(total_payout(4), 50);
        assert_eq!(total_payout(17), 50);
        assert_eq!(total_payout(5), 18);
        assert_eq!(total_payout(10), 6);
        assert_eq!(total_payout(11), 6);
    }

    #[test]
    fn test_small_bet() {
        // Small: total 4-10, loses on triple
        // Total 6 (non-triple) = win
        let dice = [1, 2, 3]; // total 6
        let total: u8 = dice.iter().sum();
        let triple = is_triple(&dice);

        assert!(!triple && total >= 4 && total <= 10);
    }

    #[test]
    fn test_big_bet() {
        // Big: total 11-17, loses on triple
        let dice = [4, 5, 6]; // total 15
        let total: u8 = dice.iter().sum();
        let triple = is_triple(&dice);

        assert!(!triple && total >= 11 && total <= 17);
    }

    #[test]
    fn test_place_bet() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        SicBo::init(&mut session, &mut rng);
        assert!(!session.is_complete);

        // Place a Small bet
        let payload = place_bet_payload(0, 0, 100); // Small bet, number doesn't matter, 100 amount
        let mut rng = GameRng::new(&seed, session.id, 1);
        let result = SicBo::process_move(&mut session, &payload, &mut rng);

        assert!(result.is_ok());
        assert!(!session.is_complete); // Not complete until dice rolled
        assert!(matches!(result.expect("Failed to process move"), GameResult::Continue));

        // Verify bet was stored
        let state = SicBoState::from_bytes(&session.state_blob).expect("Failed to parse state");
        assert_eq!(state.bets.len(), 1);
        assert_eq!(state.bets[0].bet_type, BetType::Small);
        assert_eq!(state.bets[0].amount, 100);
    }

    #[test]
    fn test_game_completes() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        SicBo::init(&mut session, &mut rng);
        assert!(!session.is_complete);

        // Place a Small bet
        let payload = place_bet_payload(0, 0, 100);
        let mut rng = GameRng::new(&seed, session.id, 1);
        let result = SicBo::process_move(&mut session, &payload, &mut rng);
        assert!(result.is_ok());
        assert!(!session.is_complete);

        // Roll dice
        let mut rng = GameRng::new(&seed, session.id, 2);
        let result = SicBo::process_move(&mut session, &[1], &mut rng);

        assert!(result.is_ok());
        assert!(session.is_complete);

        // Verify dice were rolled and stored
        let state = SicBoState::from_bytes(&session.state_blob).expect("Failed to parse state");
        assert!(state.dice.is_some());
        let dice = state.dice.expect("Dice should be rolled");
        for die in dice.iter() {
            assert!(*die >= 1 && *die <= 6);
        }
    }

    #[test]
    fn test_invalid_number() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        SicBo::init(&mut session, &mut rng);

        let mut rng = GameRng::new(&seed, session.id, 1);

        // Single bet with invalid number (0)
        let payload = place_bet_payload(8, 0, 100);
        let result = SicBo::process_move(&mut session, &payload, &mut rng);
        assert!(matches!(result, Err(GameError::InvalidPayload)));

        // Single bet with invalid number (7)
        let payload = place_bet_payload(8, 7, 100);
        let result = SicBo::process_move(&mut session, &payload, &mut rng);
        assert!(matches!(result, Err(GameError::InvalidPayload)));

        // Total bet with invalid number (3)
        let payload = place_bet_payload(7, 3, 100);
        let result = SicBo::process_move(&mut session, &payload, &mut rng);
        assert!(matches!(result, Err(GameError::InvalidPayload)));
    }

    #[test]
    fn test_roll_without_bets() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        SicBo::init(&mut session, &mut rng);

        // Try to roll without placing any bets
        let mut rng = GameRng::new(&seed, session.id, 1);
        let result = SicBo::process_move(&mut session, &[1], &mut rng);

        assert!(matches!(result, Err(GameError::InvalidPayload)));
    }

    #[test]
    fn test_clear_bets() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        SicBo::init(&mut session, &mut rng);

        // Place a bet
        let payload = place_bet_payload(0, 0, 100);
        let mut rng = GameRng::new(&seed, session.id, 1);
        SicBo::process_move(&mut session, &payload, &mut rng).expect("Failed to process move");

        // Verify bet was placed
        let state = SicBoState::from_bytes(&session.state_blob).expect("Failed to parse state");
        assert_eq!(state.bets.len(), 1);

        // Clear bets
        let mut rng = GameRng::new(&seed, session.id, 2);
        let result = SicBo::process_move(&mut session, &[2], &mut rng);
        assert!(result.is_ok());

        // Verify bets were cleared
        let state = SicBoState::from_bytes(&session.state_blob).expect("Failed to parse state");
        assert_eq!(state.bets.len(), 0);
    }

    #[test]
    fn test_multi_bet() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        SicBo::init(&mut session, &mut rng);

        // Place Small bet
        let payload = place_bet_payload(0, 0, 50);
        let mut rng = GameRng::new(&seed, session.id, 1);
        SicBo::process_move(&mut session, &payload, &mut rng).expect("Failed to process move");

        // Place Big bet
        let payload = place_bet_payload(1, 0, 50);
        let mut rng = GameRng::new(&seed, session.id, 2);
        SicBo::process_move(&mut session, &payload, &mut rng).expect("Failed to process move");

        // Verify both bets were placed
        let state = SicBoState::from_bytes(&session.state_blob).expect("Failed to parse state");
        assert_eq!(state.bets.len(), 2);
        assert_eq!(state.bets[0].bet_type, BetType::Small);
        assert_eq!(state.bets[1].bet_type, BetType::Big);

        // Roll dice
        let mut rng = GameRng::new(&seed, session.id, 3);
        let result = SicBo::process_move(&mut session, &[1], &mut rng);

        assert!(result.is_ok());
        assert!(session.is_complete);
    }

    #[test]
    fn test_various_outcomes() {
        let seed = create_test_seed();

        for session_id in 1..30 {
            let mut session = create_test_session(100);
            session.id = session_id;

            let mut rng = GameRng::new(&seed, session_id, 0);
            SicBo::init(&mut session, &mut rng);

            // Place Small bet
            let payload = place_bet_payload(0, 0, 100);
            let mut rng = GameRng::new(&seed, session_id, 1);
            SicBo::process_move(&mut session, &payload, &mut rng).expect("Failed to process move");

            // Roll dice
            let mut rng = GameRng::new(&seed, session_id, 2);
            let result = SicBo::process_move(&mut session, &[1], &mut rng);

            assert!(result.is_ok());
            assert!(session.is_complete);

            match result.expect("Failed to process move") {
                GameResult::Win(_) | GameResult::Loss | GameResult::Push => {}
                _ => panic!("SicBo should complete with Win, Loss, or Push"),
            }
        }
    }
}
