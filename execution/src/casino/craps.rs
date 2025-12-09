//! Enhanced Craps game implementation with all 12 bet types.
//!
//! State blob format:
//! [phase:u8] [main_point:u8] [d1:u8] [d2:u8] [bet_count:u8] [bets:CrapsBetEntry×count]
//!
//! Each CrapsBetEntry (19 bytes):
//! [bet_type:u8] [target:u8] [status:u8] [amount:u64 BE] [odds_amount:u64 BE]
//!
//! Phases:
//! 0 = Come out (initial roll)
//! 1 = Point phase (rolling for point)
//!
//! Payload format:
//! [0, bet_type, target, amount_bytes...] - Place bet
//! [1, amount_bytes...] - Add odds to last contract bet
//! [2] - Roll dice
//! [3] - Clear all bets (only before first roll)

use super::super_mode::apply_super_multiplier_total;
use super::{CasinoGame, GameError, GameResult, GameRng};
use nullspace_types::casino::GameSession;

/// Number of ways to roll each total with 2d6
const WAYS: [u8; 13] = [0, 0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1];
//                      0  1  2  3  4  5  6  7  8  9 10 11 12

/// Craps phases.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    ComeOut = 0,
    Point = 1,
}

impl TryFrom<u8> for Phase {
    type Error = ();

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Phase::ComeOut),
            1 => Ok(Phase::Point),
            _ => Err(()),
        }
    }
}

/// All 12 bet types in craps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum BetType {
    Pass = 0,       // Come-out: 7/11 win, 2/3/12 lose, else point
    DontPass = 1,   // Come-out: 2/3 win, 7/11 lose, 12 push
    Come = 2,       // Like PASS but during point phase
    DontCome = 3,   // Like DONT_PASS but during point phase
    Field = 4,      // Single roll: 2,12=2x, 3,4,9,10,11=1x
    Yes = 5,        // Place bet: target hits before 7
    No = 6,         // Lay bet: 7 hits before target
    Next = 7,       // Hop bet: exact total on next roll
    Hardway4 = 8,   // 2+2 before 7 or easy 4
    Hardway6 = 9,   // 3+3 before 7 or easy 6
    Hardway8 = 10,  // 4+4 before 7 or easy 8
    Hardway10 = 11, // 5+5 before 7 or easy 10
}

impl TryFrom<u8> for BetType {
    type Error = ();

    fn try_from(v: u8) -> Result<Self, ()> {
        match v {
            0 => Ok(BetType::Pass),
            1 => Ok(BetType::DontPass),
            2 => Ok(BetType::Come),
            3 => Ok(BetType::DontCome),
            4 => Ok(BetType::Field),
            5 => Ok(BetType::Yes),
            6 => Ok(BetType::No),
            7 => Ok(BetType::Next),
            8 => Ok(BetType::Hardway4),
            9 => Ok(BetType::Hardway6),
            10 => Ok(BetType::Hardway8),
            11 => Ok(BetType::Hardway10),
            _ => Err(()),
        }
    }
}

/// Bet status for contract bets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum BetStatus {
    On = 0,      // Bet is working
    Pending = 1, // Come/Don't Come waiting to travel
}

impl TryFrom<u8> for BetStatus {
    type Error = ();

    fn try_from(v: u8) -> Result<Self, ()> {
        match v {
            0 => Ok(BetStatus::On),
            1 => Ok(BetStatus::Pending),
            _ => Err(()),
        }
    }
}

/// Individual bet in craps.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrapsBet {
    pub bet_type: BetType,
    pub target: u8,        // Point for COME/YES/NO, number for NEXT/HARDWAY
    pub status: BetStatus, // ON or PENDING
    pub amount: u64,
    pub odds_amount: u64, // Free odds behind contract bets
}

impl CrapsBet {
    /// Serialize to 19 bytes
    fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(19);
        bytes.push(self.bet_type as u8);
        bytes.push(self.target);
        bytes.push(self.status as u8);
        bytes.extend_from_slice(&self.amount.to_be_bytes());
        bytes.extend_from_slice(&self.odds_amount.to_be_bytes());
        bytes
    }

    /// Deserialize from 19 bytes
    fn from_bytes(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < 19 {
            return None;
        }
        let bet_type = BetType::try_from(bytes[0]).ok()?;
        let target = bytes[1];
        let status = BetStatus::try_from(bytes[2]).ok()?;
        let amount = u64::from_be_bytes(bytes[3..11].try_into().ok()?);
        let odds_amount = u64::from_be_bytes(bytes[11..19].try_into().ok()?);
        Some(CrapsBet {
            bet_type,
            target,
            status,
            amount,
            odds_amount,
        })
    }
}

/// Result of processing a bet after a roll.
#[derive(Debug)]
struct BetResult {
    bet_idx: usize,
    payout: i64,
    resolved: bool,
}

/// Game state.
struct CrapsState {
    phase: Phase,
    main_point: u8,
    d1: u8,
    d2: u8,
    bets: Vec<CrapsBet>,
}

impl CrapsState {
    /// Serialize state to blob
    fn to_blob(&self) -> Vec<u8> {
        // Capacity: 5 (phase, main_point, d1, d2, bet_count) + bets (19 bytes each)
        let capacity = 5 + (self.bets.len() * 19);
        let mut blob = Vec::with_capacity(capacity);
        blob.push(self.phase as u8);
        blob.push(self.main_point);
        blob.push(self.d1);
        blob.push(self.d2);
        blob.push(self.bets.len() as u8);

        for bet in &self.bets {
            blob.extend_from_slice(&bet.to_bytes());
        }

        blob
    }

    /// Deserialize state from blob
    fn from_blob(blob: &[u8]) -> Option<Self> {
        if blob.len() < 5 {
            return None;
        }

        let phase = Phase::try_from(blob[0]).ok()?;
        let main_point = blob[1];
        let d1 = blob[2];
        let d2 = blob[3];
        let bet_count = blob[4] as usize;

        let mut bets = Vec::with_capacity(bet_count);
        let mut offset = 5;

        for _ in 0..bet_count {
            if offset + 19 > blob.len() {
                return None;
            }
            let bet = CrapsBet::from_bytes(&blob[offset..offset + 19])?;
            bets.push(bet);
            offset += 19;
        }

        Some(CrapsState {
            phase,
            main_point,
            d1,
            d2,
            bets,
        })
    }
}

// ============================================================================
// Payout Calculations
// ============================================================================

/// Calculate pass/don't pass payout (1:1 on flat bet + odds)
fn calculate_pass_payout(bet: &CrapsBet, won: bool, is_pass: bool) -> i64 {
    if won {
        // Flat bet pays 1:1 -> Return 2x
        let flat = bet.amount.saturating_mul(2) as i64;
        let odds = if bet.odds_amount > 0 && bet.target > 0 {
            // Odds bet returns stake + winnings
            let winnings = calculate_odds_payout(bet.target, bet.odds_amount, is_pass);
            bet.odds_amount.saturating_add(winnings) as i64
        } else {
            0
        };
        flat.saturating_add(odds)
    } else {
        -((bet.amount.saturating_add(bet.odds_amount)) as i64)
    }
}

/// Calculate true odds payout (WINNINGS ONLY)
fn calculate_odds_payout(point: u8, odds_amount: u64, is_pass: bool) -> u64 {
    match point {
        4 | 10 => {
            if is_pass {
                odds_amount.saturating_mul(2) // 2:1
            } else {
                odds_amount.saturating_div(2) // 1:2
            }
        }
        5 | 9 => {
            if is_pass {
                odds_amount.saturating_mul(3).saturating_div(2) // 3:2
            } else {
                odds_amount.saturating_mul(2).saturating_div(3) // 2:3
            }
        }
        6 | 8 => {
            if is_pass {
                odds_amount.saturating_mul(6).saturating_div(5) // 6:5
            } else {
                odds_amount.saturating_mul(5).saturating_div(6) // 5:6
            }
        }
        _ => 0,
    }
}

/// Calculate field bet payout
fn calculate_field_payout(total: u8, amount: u64) -> i64 {
    match total {
        2 | 12 => amount.saturating_mul(3) as i64, // 2:1 -> 3x
        3 | 4 | 9 | 10 | 11 => amount.saturating_mul(2) as i64, // 1:1 -> 2x
        _ => -(amount as i64),                     // 5,6,7,8 lose
    }
}

/// Calculate YES (place) bet payout with 1% commission
fn calculate_yes_payout(target: u8, amount: u64, hit: bool) -> i64 {
    if !hit {
        return -(amount as i64);
    }

    let true_odds = match target {
        4 | 10 => amount.saturating_mul(2),                   // 6:3 = 2:1
        5 | 9 => amount.saturating_mul(3).saturating_div(2),  // 6:4 = 3:2
        6 | 8 => amount.saturating_mul(6).saturating_div(5),  // 6:5
        _ => amount,
    };

    // 1% commission on winnings
    let commission = true_odds.saturating_div(100);
    let winnings = true_odds.saturating_sub(commission);
    winnings.saturating_add(amount) as i64
}

/// Calculate NO (lay) bet payout with 1% commission
fn calculate_no_payout(target: u8, amount: u64, seven_hit: bool) -> i64 {
    if !seven_hit {
        return -(amount as i64);
    }

    let true_odds = match target {
        4 | 10 => amount.saturating_div(2),                   // 3:6 = 1:2
        5 | 9 => amount.saturating_mul(2).saturating_div(3),  // 4:6 = 2:3
        6 | 8 => amount.saturating_mul(5).saturating_div(6),  // 5:6
        _ => amount,
    };

    // 1% commission
    let commission = true_odds.saturating_div(100);
    let winnings = true_odds.saturating_sub(commission);
    winnings.saturating_add(amount) as i64
}

/// Calculate NEXT (hop) bet payout with 1% commission
fn calculate_next_payout(target: u8, total: u8, amount: u64) -> i64 {
    if total != target {
        return -(amount as i64);
    }

    // Payout based on probability
    let ways = WAYS[target as usize];
    let multiplier = match ways {
        1 => 35, // 2 or 12
        2 => 17, // 3 or 11
        3 => 11, // 4 or 10
        4 => 8,  // 5 or 9
        5 => 6,  // 6 or 8 (rounded from 6.2)
        6 => 5,  // 7
        _ => 1,
    };

    let winnings = amount.saturating_mul(multiplier);
    let commission = winnings.saturating_div(100);
    winnings.saturating_sub(commission).saturating_add(amount) as i64
}

/// Calculate hardway bet payout
/// Returns Some(payout) if resolved, None if still working
fn calculate_hardway_payout(target: u8, d1: u8, d2: u8, total: u8, amount: u64) -> Option<i64> {
    let is_hard = d1 == d2 && d1.saturating_mul(2) == target;
    let is_easy = !is_hard && total == target;
    let is_seven = total == 7;

    if is_hard {
        // Win!
        let payout = match target {
            4 | 10 => amount.saturating_mul(7), // 7:1
            6 | 8 => amount.saturating_mul(9),  // 9:1
            _ => amount,
        };
        Some(payout.saturating_add(amount) as i64)
    } else if is_easy || is_seven {
        // Lose
        Some(-(amount as i64))
    } else {
        // Still working
        None
    }
}

// ============================================================================
// Roll Processing
// ============================================================================

/// Process a roll and return bet results
fn process_roll(state: &mut CrapsState, d1: u8, d2: u8) -> Vec<BetResult> {
    let total = d1.saturating_add(d2);
    let mut results = Vec::with_capacity(state.bets.len());

    // 1. Single-roll bets (FIELD, NEXT) - always resolve
    for (idx, bet) in state.bets.iter().enumerate() {
        if bet.bet_type == BetType::Field {
            results.push(BetResult {
                bet_idx: idx,
                payout: calculate_field_payout(total, bet.amount),
                resolved: true,
            });
        }
        if bet.bet_type == BetType::Next {
            results.push(BetResult {
                bet_idx: idx,
                payout: calculate_next_payout(bet.target, total, bet.amount),
                resolved: true,
            });
        }
    }

    // 2. HARDWAY bets (check for 7 or easy way)
    for (idx, bet) in state.bets.iter().enumerate() {
        if matches!(
            bet.bet_type,
            BetType::Hardway4 | BetType::Hardway6 | BetType::Hardway8 | BetType::Hardway10
        ) {
            let target = match bet.bet_type {
                BetType::Hardway4 => 4,
                BetType::Hardway6 => 6,
                BetType::Hardway8 => 8,
                BetType::Hardway10 => 10,
                _ => continue,
            };
            if let Some(payout) = calculate_hardway_payout(target, d1, d2, total, bet.amount) {
                results.push(BetResult {
                    bet_idx: idx,
                    payout,
                    resolved: true,
                });
            }
        }
    }

    // 3. YES/NO bets (working bets only)
    for (idx, bet) in state.bets.iter().enumerate() {
        if bet.status != BetStatus::On {
            continue;
        }

        match bet.bet_type {
            BetType::Yes => {
                if total == bet.target {
                    results.push(BetResult {
                        bet_idx: idx,
                        payout: calculate_yes_payout(bet.target, bet.amount, true),
                        resolved: true,
                    });
                } else if total == 7 {
                    results.push(BetResult {
                        bet_idx: idx,
                        payout: calculate_yes_payout(bet.target, bet.amount, false),
                        resolved: true,
                    });
                }
            }
            BetType::No => {
                if total == 7 {
                    results.push(BetResult {
                        bet_idx: idx,
                        payout: calculate_no_payout(bet.target, bet.amount, true),
                        resolved: true,
                    });
                } else if total == bet.target {
                    results.push(BetResult {
                        bet_idx: idx,
                        payout: calculate_no_payout(bet.target, bet.amount, false),
                        resolved: true,
                    });
                }
            }
            _ => {}
        }
    }

    // 4. COME/DONT_COME bets
    for (idx, bet) in state.bets.iter_mut().enumerate() {
        match (bet.bet_type, bet.status) {
            (BetType::Come, BetStatus::Pending) => {
                // Act like come-out roll
                match total {
                    7 | 11 => {
                        results.push(BetResult {
                            bet_idx: idx,
                            payout: bet.amount as i64,
                            resolved: true,
                        });
                    }
                    2 | 3 | 12 => {
                        results.push(BetResult {
                            bet_idx: idx,
                            payout: -(bet.amount as i64),
                            resolved: true,
                        });
                    }
                    _ => {
                        // Travel to point
                        bet.target = total;
                        bet.status = BetStatus::On;
                    }
                }
            }
            (BetType::Come, BetStatus::On) => {
                if total == bet.target {
                    // Win!
                    let odds_payout = calculate_odds_payout(bet.target, bet.odds_amount, true);
                    let total_payout = (bet.amount.saturating_add(bet.odds_amount).saturating_add(odds_payout)) as i64;
                    results.push(BetResult {
                        bet_idx: idx,
                        payout: total_payout,
                        resolved: true,
                    });
                } else if total == 7 {
                    // Lose
                    results.push(BetResult {
                        bet_idx: idx,
                        payout: -((bet.amount.saturating_add(bet.odds_amount)) as i64),
                        resolved: true,
                    });
                }
            }
            (BetType::DontCome, BetStatus::Pending) => {
                match total {
                    2 | 3 => {
                        results.push(BetResult {
                            bet_idx: idx,
                            payout: bet.amount as i64,
                            resolved: true,
                        });
                    }
                    12 => {
                        // Push
                        results.push(BetResult {
                            bet_idx: idx,
                            payout: 0,
                            resolved: true,
                        });
                    }
                    7 | 11 => {
                        results.push(BetResult {
                            bet_idx: idx,
                            payout: -(bet.amount as i64),
                            resolved: true,
                        });
                    }
                    _ => {
                        bet.target = total;
                        bet.status = BetStatus::On;
                    }
                }
            }
            (BetType::DontCome, BetStatus::On) => {
                if total == 7 {
                    // Win!
                    let odds_payout = calculate_odds_payout(bet.target, bet.odds_amount, false);
                    let total_payout = (bet.amount.saturating_add(bet.odds_amount).saturating_add(odds_payout)) as i64;
                    results.push(BetResult {
                        bet_idx: idx,
                        payout: total_payout,
                        resolved: true,
                    });
                } else if total == bet.target {
                    results.push(BetResult {
                        bet_idx: idx,
                        payout: -((bet.amount.saturating_add(bet.odds_amount)) as i64),
                        resolved: true,
                    });
                }
            }
            _ => {}
        }
    }

    // 5. PASS/DONT_PASS
    process_pass_bets(state, total, &mut results);

    // 6. Update phase and main point
    update_phase(state, total);

    results
}

/// Process PASS/DONT_PASS bets based on phase
fn process_pass_bets(state: &CrapsState, total: u8, results: &mut Vec<BetResult>) {
    for (idx, bet) in state.bets.iter().enumerate() {
        match (bet.bet_type, state.phase) {
            (BetType::Pass, Phase::ComeOut) => {
                match total {
                    7 | 11 => {
                        // Win on come out
                        results.push(BetResult {
                            bet_idx: idx,
                            payout: bet.amount as i64,
                            resolved: true,
                        });
                    }
                    2 | 3 | 12 => {
                        // Lose on come out (craps)
                        results.push(BetResult {
                            bet_idx: idx,
                            payout: -(bet.amount as i64),
                            resolved: true,
                        });
                    }
                    _ => {
                        // Point established - bet stays
                    }
                }
            }
            (BetType::Pass, Phase::Point) => {
                if total == state.main_point {
                    // Hit the point - win
                    let payout = calculate_pass_payout(bet, true, true);
                    results.push(BetResult {
                        bet_idx: idx,
                        payout,
                        resolved: true,
                    });
                } else if total == 7 {
                    // Seven out - lose
                    let payout = calculate_pass_payout(bet, false, true);
                    results.push(BetResult {
                        bet_idx: idx,
                        payout,
                        resolved: true,
                    });
                }
            }
            (BetType::DontPass, Phase::ComeOut) => {
                match total {
                    7 | 11 => {
                        // Lose on come out
                        results.push(BetResult {
                            bet_idx: idx,
                            payout: -(bet.amount as i64),
                            resolved: true,
                        });
                    }
                    2 | 3 => {
                        // Win on come out (craps)
                        results.push(BetResult {
                            bet_idx: idx,
                            payout: bet.amount as i64,
                            resolved: true,
                        });
                    }
                    12 => {
                        // Push on 12 (bar)
                        results.push(BetResult {
                            bet_idx: idx,
                            payout: 0,
                            resolved: true,
                        });
                    }
                    _ => {
                        // Point established - bet stays
                    }
                }
            }
            (BetType::DontPass, Phase::Point) => {
                if total == 7 {
                    // Seven out - win for don't pass
                    let payout = calculate_pass_payout(bet, true, false);
                    results.push(BetResult {
                        bet_idx: idx,
                        payout,
                        resolved: true,
                    });
                } else if total == state.main_point {
                    // Hit the point - lose for don't pass
                    let payout = calculate_pass_payout(bet, false, false);
                    results.push(BetResult {
                        bet_idx: idx,
                        payout,
                        resolved: true,
                    });
                }
            }
            _ => {}
        }
    }
}

/// Update phase and main point after a roll
fn update_phase(state: &mut CrapsState, total: u8) {
    match state.phase {
        Phase::ComeOut => {
            if ![2, 3, 7, 11, 12].contains(&total) {
                // Point established
                state.phase = Phase::Point;
                state.main_point = total;
            }
        }
        Phase::Point => {
            if total == 7 || total == state.main_point {
                // Seven out or point hit - back to come out
                state.phase = Phase::ComeOut;
                state.main_point = 0;
            }
        }
    }
}

// ============================================================================
// CasinoGame Implementation
// ============================================================================

pub struct Craps;

impl CasinoGame for Craps {
    fn init(session: &mut GameSession, _rng: &mut GameRng) -> GameResult {
        session.state_blob = vec![];
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

        // Parse or initialize state
        let mut state = if session.state_blob.is_empty() {
            CrapsState {
                phase: Phase::ComeOut,
                main_point: 0,
                d1: 0,
                d2: 0,
                bets: Vec::new(),
            }
        } else {
            CrapsState::from_blob(&session.state_blob).ok_or(GameError::InvalidPayload)?
        };

        if payload.is_empty() {
            return Err(GameError::InvalidPayload);
        }

        match payload[0] {
            // [0, bet_type, target, amount_bytes...] - Place bet
            0 => {
                if payload.len() < 11 {
                    return Err(GameError::InvalidPayload);
                }
                let bet_type = BetType::try_from(payload[1]).map_err(|_| GameError::InvalidPayload)?;
                let target = payload[2];
                let amount = u64::from_be_bytes(
                    payload[3..11].try_into().map_err(|_| GameError::InvalidPayload)?
                );

                // Validate bet
                if amount == 0 {
                    return Err(GameError::InvalidPayload);
                }

                // Determine initial status
                let status = match bet_type {
                    BetType::Come | BetType::DontCome => BetStatus::Pending,
                    _ => BetStatus::On,
                };

                state.bets.push(CrapsBet {
                    bet_type,
                    target,
                    status,
                    amount,
                    odds_amount: 0,
                });

                session.state_blob = state.to_blob();
                Ok(GameResult::Continue)
            }

            // [1, amount_bytes...] - Add odds to last contract bet
            1 => {
                if payload.len() < 9 {
                    return Err(GameError::InvalidPayload);
                }
                let odds_amount = u64::from_be_bytes(
                    payload[1..9].try_into().map_err(|_| GameError::InvalidPayload)?
                );

                // Find last contract bet (PASS, DONT_PASS, COME, DONT_COME with status ON)
                let mut found = false;
                for bet in state.bets.iter_mut().rev() {
                    if matches!(
                        bet.bet_type,
                        BetType::Pass | BetType::DontPass | BetType::Come | BetType::DontCome
                    ) && bet.status == BetStatus::On
                    {
                        bet.odds_amount = bet.odds_amount.saturating_add(odds_amount);
                        found = true;
                        break;
                    }
                }

                if !found {
                    return Err(GameError::InvalidMove);
                }

                session.state_blob = state.to_blob();
                Ok(GameResult::Continue)
            }

            // [2] - Roll dice
            2 => {
                let d1 = rng.roll_die();
                let d2 = rng.roll_die();
                state.d1 = d1;
                state.d2 = d2;

                session.move_count = session.move_count.saturating_add(1);

                // Process roll
                let results = process_roll(&mut state, d1, d2);

                // Calculate total payout
                let mut total_payout: i64 = 0;
                let mut resolved_indices = Vec::with_capacity(state.bets.len());

                for result in results {
                    total_payout = total_payout.saturating_add(result.payout);
                    if result.resolved {
                        resolved_indices.push(result.bet_idx);
                    }
                }

                // Remove resolved bets (in reverse order to maintain indices)
                resolved_indices.sort_unstable();
                for idx in resolved_indices.iter().rev() {
                    state.bets.remove(*idx);
                }

                // Update state
                session.state_blob = state.to_blob();

                // Check if game is complete (no bets left)
                if state.bets.is_empty() {
                    session.is_complete = true;
                    if total_payout > 0 {
                        // Apply super mode multipliers if active
                        let final_payout = if session.super_mode.is_active {
                            let total = d1.saturating_add(d2);
                            apply_super_multiplier_total(
                                total,
                                &session.super_mode.multipliers,
                                total_payout as u64,
                            )
                        } else {
                            total_payout as u64
                        };
                        Ok(GameResult::Win(final_payout))
                    } else if total_payout < 0 {
                        Ok(GameResult::Loss)
                    } else {
                        Ok(GameResult::Push)
                    }
                } else {
                    // Game continues with active bets
                    // Use ContinueWithUpdate if there are intermediate payouts/losses
                    if total_payout != 0 {
                        Ok(GameResult::ContinueWithUpdate { payout: total_payout })
                    } else {
                        Ok(GameResult::Continue)
                    }
                }
            }

            // [3] - Clear all bets (only before first roll)
            3 => {
                if session.move_count > 0 {
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
            game_type: GameType::Craps,
            bet,
            state_blob: vec![],
            move_count: 0,
            created_at: 0,
            is_complete: false,
            super_mode: nullspace_types::casino::SuperModeState::default(),
        }
    }

    #[test]
    fn test_bet_serialization() {
        let bet = CrapsBet {
            bet_type: BetType::Pass,
            target: 6,
            status: BetStatus::On,
            amount: 100,
            odds_amount: 50,
        };

        let bytes = bet.to_bytes();
        assert_eq!(bytes.len(), 19);

        let deserialized = CrapsBet::from_bytes(&bytes).expect("Failed to parse bet");
        assert_eq!(deserialized, bet);
    }

    #[test]
    fn test_state_serialization() {
        let state = CrapsState {
            phase: Phase::Point,
            main_point: 6,
            d1: 3,
            d2: 3,
            bets: vec![
                CrapsBet {
                    bet_type: BetType::Pass,
                    target: 0,
                    status: BetStatus::On,
                    amount: 100,
                    odds_amount: 50,
                },
                CrapsBet {
                    bet_type: BetType::Field,
                    target: 0,
                    status: BetStatus::On,
                    amount: 25,
                    odds_amount: 0,
                },
            ],
        };

        let blob = state.to_blob();
        assert_eq!(blob[0], Phase::Point as u8);
        assert_eq!(blob[1], 6);
        assert_eq!(blob[4], 2); // bet count

        let deserialized = CrapsState::from_blob(&blob).expect("Failed to parse state");
        assert_eq!(deserialized.phase, state.phase);
        assert_eq!(deserialized.main_point, state.main_point);
        assert_eq!(deserialized.bets.len(), 2);
    }

    #[test]
    fn test_field_payout() {
        // Payouts are TOTAL RETURN (stake + winnings)
        assert_eq!(calculate_field_payout(2, 100), 300);  // 2:1 -> 3x total
        assert_eq!(calculate_field_payout(12, 100), 300); // 2:1 -> 3x total
        assert_eq!(calculate_field_payout(3, 100), 200);  // 1:1 -> 2x total
        assert_eq!(calculate_field_payout(11, 100), 200); // 1:1 -> 2x total
        assert_eq!(calculate_field_payout(7, 100), -100); // lose
    }

    #[test]
    fn test_yes_payout() {
        // Place 6 hits - returns stake + (winnings - commission)
        // 6:5 odds = 120 winnings, 1% commission = 1, so 119 + 100 = 219 total
        assert_eq!(calculate_yes_payout(6, 100, true), 219);
        // Place 6 misses (7 rolled)
        assert_eq!(calculate_yes_payout(6, 100, false), -100);
    }

    #[test]
    fn test_next_payout() {
        // Hop on 7: 5x multiplier = 500, 1% commission = 5, so 495 + 100 = 595 total
        assert_eq!(calculate_next_payout(7, 7, 100), 595);
        // Hop on 2: 35x multiplier = 3500, 1% commission = 35, so 3465 + 100 = 3565 total
        assert_eq!(calculate_next_payout(2, 2, 100), 3565);
        // Miss
        assert_eq!(calculate_next_payout(7, 6, 100), -100);
    }

    #[test]
    fn test_hardway_payout() {
        // Hard 6 (3,3) wins - 9:1 = 900 + 100 stake = 1000 total
        assert_eq!(calculate_hardway_payout(6, 3, 3, 6, 100), Some(1000));
        // Easy 6 (2,4) loses
        assert_eq!(calculate_hardway_payout(6, 2, 4, 6, 100), Some(-100));
        // Seven out loses
        assert_eq!(calculate_hardway_payout(6, 4, 3, 7, 100), Some(-100));
        // Still working
        assert_eq!(calculate_hardway_payout(6, 2, 3, 5, 100), None);
    }

    #[test]
    fn test_place_bet() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        Craps::init(&mut session, &mut rng);

        // Place a field bet
        let mut payload = vec![0, BetType::Field as u8, 0];
        payload.extend_from_slice(&100u64.to_be_bytes());

        let mut rng = GameRng::new(&seed, session.id, 1);
        let result = Craps::process_move(&mut session, &payload, &mut rng);
        assert!(result.is_ok());
        assert!(!session.is_complete);

        // Verify state
        let state = CrapsState::from_blob(&session.state_blob).expect("Failed to parse state");
        assert_eq!(state.bets.len(), 1);
        assert_eq!(state.bets[0].bet_type, BetType::Field);
    }

    #[test]
    fn test_roll_resolves_field_bet() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        Craps::init(&mut session, &mut rng);

        // Place a field bet
        let mut payload = vec![0, BetType::Field as u8, 0];
        payload.extend_from_slice(&100u64.to_be_bytes());

        let mut rng = GameRng::new(&seed, session.id, 1);
        Craps::process_move(&mut session, &payload, &mut rng).expect("Failed to process move");

        // Roll dice
        let mut rng = GameRng::new(&seed, session.id, 2);
        let result = Craps::process_move(&mut session, &[2], &mut rng);
        assert!(result.is_ok());

        // Field bet should be resolved, game complete
        assert!(session.is_complete);
    }

    #[test]
    fn test_pass_line_flow() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        Craps::init(&mut session, &mut rng);

        // Place pass line bet
        let mut payload = vec![0, BetType::Pass as u8, 0];
        payload.extend_from_slice(&100u64.to_be_bytes());

        let mut rng = GameRng::new(&seed, session.id, 1);
        Craps::process_move(&mut session, &payload, &mut rng).expect("Failed to process move");

        // Roll until game completes
        let mut move_num = 2;
        while !session.is_complete && move_num < 100 {
            let mut rng = GameRng::new(&seed, session.id, move_num);
            let result = Craps::process_move(&mut session, &[2], &mut rng);
            assert!(result.is_ok());
            move_num += 1;
        }

        assert!(session.is_complete);
    }

    #[test]
    fn test_add_odds() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        Craps::init(&mut session, &mut rng);

        // Place pass line bet
        let mut payload = vec![0, BetType::Pass as u8, 0];
        payload.extend_from_slice(&100u64.to_be_bytes());

        let mut rng = GameRng::new(&seed, session.id, 1);
        Craps::process_move(&mut session, &payload, &mut rng).expect("Failed to process move");

        // Roll to establish point
        let mut rng = GameRng::new(&seed, session.id, 2);
        Craps::process_move(&mut session, &[2], &mut rng).expect("Failed to process move");

        let state = CrapsState::from_blob(&session.state_blob).expect("Failed to parse state");
        if state.phase == Phase::Point {
            // Add odds
            let mut odds_payload = vec![1];
            odds_payload.extend_from_slice(&200u64.to_be_bytes());

            let mut rng = GameRng::new(&seed, session.id, 3);
            let result = Craps::process_move(&mut session, &odds_payload, &mut rng);
            assert!(result.is_ok());

            // Verify odds added
            let state = CrapsState::from_blob(&session.state_blob).expect("Failed to parse state");
            assert_eq!(state.bets[0].odds_amount, 200);
        }
    }

    #[test]
    fn test_come_bet_pending_to_on() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        Craps::init(&mut session, &mut rng);

        // Place come bet
        let mut payload = vec![0, BetType::Come as u8, 0];
        payload.extend_from_slice(&100u64.to_be_bytes());

        let mut rng = GameRng::new(&seed, session.id, 1);
        Craps::process_move(&mut session, &payload, &mut rng).expect("Failed to process move");

        let state = CrapsState::from_blob(&session.state_blob).expect("Failed to parse state");
        assert_eq!(state.bets[0].status, BetStatus::Pending);

        // Roll a point (e.g., force a 6 by checking what we get)
        let mut move_num = 2;
        while move_num < 50 {
            let state_before = CrapsState::from_blob(&session.state_blob).expect("Failed to parse state");
            if state_before.bets.is_empty() {
                break; // Bet resolved
            }

            let mut rng = GameRng::new(&seed, session.id, move_num);
            Craps::process_move(&mut session, &[2], &mut rng).expect("Failed to process move");

            let state_after = CrapsState::from_blob(&session.state_blob).expect("Failed to parse state");
            if !state_after.bets.is_empty() && state_after.bets[0].status == BetStatus::On {
                // Come bet traveled
                assert!(state_after.bets[0].target > 0);
                break;
            }

            move_num += 1;
        }
    }

    #[test]
    fn test_clear_bets() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        Craps::init(&mut session, &mut rng);

        // Place a bet
        let mut payload = vec![0, BetType::Field as u8, 0];
        payload.extend_from_slice(&100u64.to_be_bytes());

        let mut rng = GameRng::new(&seed, session.id, 1);
        Craps::process_move(&mut session, &payload, &mut rng).expect("Failed to process move");

        // Clear bets before rolling should succeed
        let mut rng = GameRng::new(&seed, session.id, 2);
        let result = Craps::process_move(&mut session, &[3], &mut rng);
        assert!(result.is_ok());

        // Verify bets are cleared
        let state = CrapsState::from_blob(&session.state_blob).expect("Failed to parse state");
        assert!(state.bets.is_empty());

        // Place another bet and roll
        let mut payload = vec![0, BetType::Field as u8, 0];
        payload.extend_from_slice(&100u64.to_be_bytes());
        let mut rng = GameRng::new(&seed, session.id, 3);
        Craps::process_move(&mut session, &payload, &mut rng).expect("Failed to process move");

        // Roll dice (this increments move_count)
        let mut rng = GameRng::new(&seed, session.id, 4);
        Craps::process_move(&mut session, &[2], &mut rng).expect("Failed to process move");

        // Clear bets after rolling should fail
        let mut rng = GameRng::new(&seed, session.id, 5);
        let result = Craps::process_move(&mut session, &[3], &mut rng);
        assert!(result.is_err());
    }

    #[test]
    fn test_multiple_bets() {
        let seed = create_test_seed();
        let mut session = create_test_session(500);
        let mut rng = GameRng::new(&seed, session.id, 0);

        Craps::init(&mut session, &mut rng);

        // Place multiple bets
        let bets = vec![
            (BetType::Pass, 0, 100u64),
            (BetType::Field, 0, 50u64),
        ];

        for (idx, (bet_type, target, amount)) in bets.iter().enumerate() {
            let mut payload = vec![0, *bet_type as u8, *target];
            payload.extend_from_slice(&amount.to_be_bytes());

            let mut rng = GameRng::new(&seed, session.id, (idx + 1) as u32);
            let result = Craps::process_move(&mut session, &payload, &mut rng);
            assert!(result.is_ok());
        }

        let state = CrapsState::from_blob(&session.state_blob).expect("Failed to parse state");
        assert_eq!(state.bets.len(), 2);

        // Verify we have Pass and Field bets
        assert!(state.bets.iter().any(|b| b.bet_type == BetType::Pass));
        assert!(state.bets.iter().any(|b| b.bet_type == BetType::Field));

        // Roll dice - field bet should always resolve (single-roll)
        // Other bets may or may not resolve depending on dice
        let initial_bet_count = state.bets.len();
        let mut rng = GameRng::new(&seed, session.id, 3);
        Craps::process_move(&mut session, &[2], &mut rng).expect("Failed to process move");

        let state = CrapsState::from_blob(&session.state_blob).expect("Failed to parse state");
        // Field bet always resolves on first roll, so at least that bet is gone
        // Remaining bets depend on actual dice roll (Pass may resolve on 7/11/2/3/12)
        assert!(state.bets.len() < initial_bet_count, "At least field bet should resolve");
        // No field bet should remain (it's always a single-roll bet)
        assert!(!state.bets.iter().any(|b| b.bet_type == BetType::Field));
    }

    #[test]
    fn test_ways_constant() {
        assert_eq!(WAYS[2], 1); // One way to roll 2 (1,1)
        assert_eq!(WAYS[7], 6); // Six ways to roll 7
        assert_eq!(WAYS[12], 1); // One way to roll 12 (6,6)
    }
}
