//! Enhanced Craps game implementation with a multi-bet menu.
//!
//! State blob format:
//! [version:u8=2]
//! [phase:u8]
//! [main_point:u8]
//! [d1:u8] [d2:u8]
//! [made_points_mask:u8] (Fire Bet: bits for 4/5/6/8/9/10 made)
//! [epoch_point_established:u8] (0/1, becomes 1 after the first point is established in an epoch)
//! [bet_count:u8]
//! [bets:CrapsBetEntry×count]
//! [field_paytable:u8]? [buy_commission_timing:u8]? (optional, post-bets rules bytes)
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

const STATE_VERSION_V1: u8 = 1;
const STATE_VERSION: u8 = 2;
const MAX_BETS: usize = 20;
const BUY_COMMISSION_BPS: u64 = 500; // 5.00%
const BUY_COMMISSION_DENOM: u64 = 10_000;

#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FieldPaytable {
    /// 2 and 12 pay double (2:1).
    Double2And12 = 0,
    /// 2 pays double (2:1) and 12 pays triple (3:1).
    Double2Triple12 = 1,
}

impl Default for FieldPaytable {
    fn default() -> Self {
        Self::Double2And12
    }
}

impl TryFrom<u8> for FieldPaytable {
    type Error = ();

    fn try_from(v: u8) -> Result<Self, ()> {
        match v {
            0 => Ok(FieldPaytable::Double2And12),
            1 => Ok(FieldPaytable::Double2Triple12),
            _ => Err(()),
        }
    }
}

#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BuyCommissionTiming {
    /// Commission is charged at bet placement (up-front).
    AtPlacement = 0,
    /// Commission is charged only when the buy bet wins.
    OnWin = 1,
}

impl Default for BuyCommissionTiming {
    fn default() -> Self {
        Self::AtPlacement
    }
}

impl TryFrom<u8> for BuyCommissionTiming {
    type Error = ();

    fn try_from(v: u8) -> Result<Self, ()> {
        match v {
            0 => Ok(BuyCommissionTiming::AtPlacement),
            1 => Ok(BuyCommissionTiming::OnWin),
            _ => Err(()),
        }
    }
}

// All Tall Small (ATS) pay table ("to 1").
const ATS_SMALL_PAYOUT_TO_1: u64 = 34;
const ATS_TALL_PAYOUT_TO_1: u64 = 34;
const ATS_ALL_PAYOUT_TO_1: u64 = 175;

// ATS progress bitmask (stored in `odds_amount` for ATS bet entries).
// Bits: 2..6 => 0..4, 8..12 => 5..9.
const ATS_SMALL_MASK: u64 = (1u64 << 0) | (1u64 << 1) | (1u64 << 2) | (1u64 << 3) | (1u64 << 4);
const ATS_TALL_MASK: u64 = (1u64 << 5) | (1u64 << 6) | (1u64 << 7) | (1u64 << 8) | (1u64 << 9);
const ATS_ALL_MASK: u64 = ATS_SMALL_MASK | ATS_TALL_MASK;

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

/// Supported bet types in craps.
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
    Fire = 12,      // Fire Bet side bet (Pay Table A)
    Buy = 13,       // Buy bet: place-style, fair odds with commission
    AtsSmall = 15,  // All Tall Small: Small (2-6) before seven-out
    AtsTall = 16,   // All Tall Small: Tall (8-12) before seven-out
    AtsAll = 17,    // All Tall Small: All (Small + Tall) before seven-out
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
            12 => Ok(BetType::Fire),
            13 => Ok(BetType::Buy),
            15 => Ok(BetType::AtsSmall),
            16 => Ok(BetType::AtsTall),
            17 => Ok(BetType::AtsAll),
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
    /// Amount to credit to player balance (stake already deducted at bet placement).
    return_amount: u64,
    /// Total amount wagered on this bet (used to report losses when completing).
    wagered: u64,
    resolved: bool,
}

/// Game state.
struct CrapsState {
    phase: Phase,
    main_point: u8,
    d1: u8,
    d2: u8,
    made_points_mask: u8,
    epoch_point_established: bool,
    field_paytable: FieldPaytable,
    buy_commission_timing: BuyCommissionTiming,
    bets: Vec<CrapsBet>,
}

impl CrapsState {
    /// Serialize state to blob
    fn to_blob(&self) -> Vec<u8> {
        // Capacity: 8 (header) + bets (19 bytes each) + 2 (optional rules bytes)
        let capacity = 8 + (self.bets.len() * 19) + 2;
        let mut blob = Vec::with_capacity(capacity);
        blob.push(STATE_VERSION);
        blob.push(self.phase as u8);
        blob.push(self.main_point);
        blob.push(self.d1);
        blob.push(self.d2);
        blob.push(self.made_points_mask);
        blob.push(self.epoch_point_established as u8);
        blob.push(self.bets.len() as u8);

        for bet in &self.bets {
            blob.extend_from_slice(&bet.to_bytes());
        }

        // Post-bets optional rules bytes (kept at the end so legacy parsers remain compatible).
        blob.push(self.field_paytable as u8);
        blob.push(self.buy_commission_timing as u8);

        blob
    }

    /// Deserialize state from blob
    fn from_blob(blob: &[u8]) -> Option<Self> {
        if blob.len() < 7 {
            return None;
        }

        let version = blob[0];

        let (
            phase,
            main_point,
            d1,
            d2,
            made_points_mask,
            epoch_point_established,
            bet_count,
            header_len,
        ) = if version == STATE_VERSION {
            if blob.len() < 8 {
                return None;
            }
            let phase = Phase::try_from(blob[1]).ok()?;
            let main_point = blob[2];
            let d1 = blob[3];
            let d2 = blob[4];
            let made_points_mask = blob[5];
            let epoch_point_established = blob[6] != 0;
            let bet_count = blob[7] as usize;
            (
                phase,
                main_point,
                d1,
                d2,
                made_points_mask,
                epoch_point_established,
                bet_count,
                8usize,
            )
        } else if version == STATE_VERSION_V1 {
            // v1 header (7 bytes): [v=1][phase][main_point][d1][d2][made_points_mask][bet_count]
            let phase = Phase::try_from(blob[1]).ok()?;
            let main_point = blob[2];
            let d1 = blob[3];
            let d2 = blob[4];
            let made_points_mask = blob[5];
            let bet_count = blob[6] as usize;

            // Best-effort derivation for legacy states: if we're currently in Point phase
            // or have ever made a point, treat the epoch as having established a point.
            let epoch_point_established =
                phase == Phase::Point || main_point != 0 || made_points_mask != 0;

            (
                phase,
                main_point,
                d1,
                d2,
                made_points_mask,
                epoch_point_established,
                bet_count,
                7usize,
            )
        } else {
            return None;
        };

        // Validate bet count against maximum to prevent DoS via large allocations
        if bet_count > MAX_BETS {
            return None;
        }

        // Validate we have enough bytes for all bets before allocating
        let required_len = header_len + (bet_count * 19);
        if blob.len() < required_len {
            return None;
        }

        let mut bets = Vec::with_capacity(bet_count);
        let mut offset = header_len;

        for _ in 0..bet_count {
            if offset + 19 > blob.len() {
                return None;
            }
            let bet = CrapsBet::from_bytes(&blob[offset..offset + 19])?;
            bets.push(bet);
            offset += 19;
        }

        let (field_paytable, buy_commission_timing) = if blob.len() >= offset + 2 {
            (
                FieldPaytable::try_from(blob[offset]).ok()?,
                BuyCommissionTiming::try_from(blob[offset + 1]).ok()?,
            )
        } else {
            (FieldPaytable::default(), BuyCommissionTiming::default())
        };

        Some(CrapsState {
            phase,
            main_point,
            d1,
            d2,
            made_points_mask,
            epoch_point_established,
            field_paytable,
            buy_commission_timing,
            bets,
        })
    }
}

// ============================================================================
// Payout Calculations
// ============================================================================

/// Calculate pass/don't pass return (TOTAL RETURN: stake + winnings).
/// Stake is assumed already deducted at bet placement.
fn calculate_pass_return(bet: &CrapsBet, won: bool, is_pass: bool) -> u64 {
    if !won {
        return 0;
    }

    let flat_return = bet.amount.saturating_mul(2);
    let odds_return = if bet.odds_amount > 0 && bet.target > 0 {
        let winnings = calculate_odds_payout(bet.target, bet.odds_amount, is_pass);
        bet.odds_amount.saturating_add(winnings)
    } else {
        0
    };

    flat_return.saturating_add(odds_return)
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

/// Calculate field bet return (TOTAL RETURN: stake + winnings).
fn calculate_field_payout(total: u8, amount: u64, paytable: FieldPaytable) -> u64 {
    match paytable {
        FieldPaytable::Double2And12 => match total {
            2 | 12 => amount.saturating_mul(3), // 2:1 -> 3x total
            3 | 4 | 9 | 10 | 11 => amount.saturating_mul(2), // 1:1 -> 2x total
            _ => 0,
        },
        FieldPaytable::Double2Triple12 => match total {
            2 => amount.saturating_mul(3),  // 2:1 -> 3x total
            12 => amount.saturating_mul(4), // 3:1 -> 4x total
            3 | 4 | 9 | 10 | 11 => amount.saturating_mul(2),
            _ => 0,
        },
    }
}

/// Calculate YES (place) bet return with a 1% commission on winnings.
fn calculate_yes_payout(target: u8, amount: u64, hit: bool) -> u64 {
    if !hit {
        return 0;
    }

    let true_odds = match target {
        4 | 10 => amount.saturating_mul(2),                  // 6:3 = 2:1
        5 | 9 => amount.saturating_mul(3).saturating_div(2), // 6:4 = 3:2
        6 | 8 => amount.saturating_mul(6).saturating_div(5), // 6:5
        _ => amount,
    };

    let commission = true_odds.saturating_div(100);
    let winnings = true_odds.saturating_sub(commission);
    amount.saturating_add(winnings)
}

/// Calculate NO (lay) bet return with a 1% commission on winnings.
fn calculate_no_payout(target: u8, amount: u64, seven_hit: bool) -> u64 {
    if !seven_hit {
        return 0;
    }

    let true_odds = match target {
        4 | 10 => amount.saturating_div(2),                  // 3:6 = 1:2
        5 | 9 => amount.saturating_mul(2).saturating_div(3), // 4:6 = 2:3
        6 | 8 => amount.saturating_mul(5).saturating_div(6), // 5:6
        _ => amount,
    };

    let commission = true_odds.saturating_div(100);
    let winnings = true_odds.saturating_sub(commission);
    amount.saturating_add(winnings)
}

fn calculate_buy_commission(amount: u64) -> u64 {
    // 5% commission, rounded up to the nearest chip.
    //
    // WoO: "Buy bets are like Odds or Place bets ... except you have to pay a 5% commission
    // ... based on the bet amount."
    // https://wizardofodds.com/games/craps/basics/#buy
    amount
        .saturating_mul(BUY_COMMISSION_BPS)
        .saturating_add(BUY_COMMISSION_DENOM.saturating_sub(1))
        .saturating_div(BUY_COMMISSION_DENOM)
}

/// Calculate BUY bet return (TOTAL RETURN: stake + winnings). Commission is charged separately.
fn calculate_buy_payout(target: u8, amount: u64, hit: bool) -> u64 {
    if !hit {
        return 0;
    }

    // Fair odds on the number.
    let winnings = match target {
        4 | 10 => amount.saturating_mul(2),                  // 2:1
        5 | 9 => amount.saturating_mul(3).saturating_div(2), // 3:2
        6 | 8 => amount.saturating_mul(6).saturating_div(5), // 6:5
        _ => 0,
    };

    amount.saturating_add(winnings)
}

/// Calculate NEXT bet return (TOTAL RETURN: stake + winnings) with a 1% commission on winnings.
fn calculate_next_payout(target: u8, total: u8, amount: u64) -> u64 {
    if total != target {
        return 0;
    }

    // Payout based on probability
    let ways = WAYS[target as usize];
    let multiplier: u64 = match ways {
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
    let winnings = winnings.saturating_sub(commission);
    amount.saturating_add(winnings)
}

fn ats_bit_for_total(total: u8) -> u64 {
    match total {
        2 => 1u64 << 0,
        3 => 1u64 << 1,
        4 => 1u64 << 2,
        5 => 1u64 << 3,
        6 => 1u64 << 4,
        8 => 1u64 << 5,
        9 => 1u64 << 6,
        10 => 1u64 << 7,
        11 => 1u64 << 8,
        12 => 1u64 << 9,
        _ => 0,
    }
}

fn ats_required_mask(bet_type: BetType) -> u64 {
    match bet_type {
        BetType::AtsSmall => ATS_SMALL_MASK,
        BetType::AtsTall => ATS_TALL_MASK,
        BetType::AtsAll => ATS_ALL_MASK,
        _ => 0,
    }
}

fn ats_payout_to_1(bet_type: BetType) -> u64 {
    match bet_type {
        BetType::AtsSmall => ATS_SMALL_PAYOUT_TO_1,
        BetType::AtsTall => ATS_TALL_PAYOUT_TO_1,
        BetType::AtsAll => ATS_ALL_PAYOUT_TO_1,
        _ => 0,
    }
}

/// Calculate hardway bet payout
/// Returns Some(payout) if resolved, None if still working
fn calculate_hardway_payout(target: u8, d1: u8, d2: u8, total: u8, amount: u64) -> Option<u64> {
    let is_hard = d1 == d2 && d1.saturating_mul(2) == target;
    let is_easy = !is_hard && total == target;
    let is_seven = total == 7;

    if is_hard {
        // Win!
        let winnings = match target {
            4 | 10 => amount.saturating_mul(7), // 7:1
            6 | 8 => amount.saturating_mul(9),  // 9:1
            _ => amount,
        };
        Some(amount.saturating_add(winnings))
    } else if is_easy || is_seven {
        // Lose
        Some(0)
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
                return_amount: calculate_field_payout(total, bet.amount, state.field_paytable),
                wagered: bet.amount,
                resolved: true,
            });
        }
        if bet.bet_type == BetType::Next {
            results.push(BetResult {
                bet_idx: idx,
                return_amount: calculate_next_payout(bet.target, total, bet.amount),
                wagered: bet.amount,
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
                    return_amount: payout,
                    wagered: bet.amount,
                    resolved: true,
                });
            }
        }
    }

    // 3. YES/NO/BUY bets (working bets only)
    for (idx, bet) in state.bets.iter().enumerate() {
        if bet.status != BetStatus::On {
            continue;
        }

        match bet.bet_type {
            BetType::Yes => {
                if total == bet.target {
                    results.push(BetResult {
                        bet_idx: idx,
                        return_amount: calculate_yes_payout(bet.target, bet.amount, true),
                        wagered: bet.amount,
                        resolved: true,
                    });
                } else if total == 7 {
                    results.push(BetResult {
                        bet_idx: idx,
                        return_amount: calculate_yes_payout(bet.target, bet.amount, false),
                        wagered: bet.amount,
                        resolved: true,
                    });
                }
            }
            BetType::No => {
                if total == 7 {
                    results.push(BetResult {
                        bet_idx: idx,
                        return_amount: calculate_no_payout(bet.target, bet.amount, true),
                        wagered: bet.amount,
                        resolved: true,
                    });
                } else if total == bet.target {
                    results.push(BetResult {
                        bet_idx: idx,
                        return_amount: calculate_no_payout(bet.target, bet.amount, false),
                        wagered: bet.amount,
                        resolved: true,
                    });
                }
            }
            BetType::Buy => {
                if total == bet.target {
                    let commission = calculate_buy_commission(bet.amount);
                    let return_amount = match state.buy_commission_timing {
                        BuyCommissionTiming::AtPlacement => {
                            // Commission already paid at placement.
                            calculate_buy_payout(bet.target, bet.amount, true)
                        }
                        BuyCommissionTiming::OnWin => {
                            calculate_buy_payout(bet.target, bet.amount, true)
                                .saturating_sub(commission)
                        }
                    };
                    let wagered = match state.buy_commission_timing {
                        BuyCommissionTiming::AtPlacement => bet.amount.saturating_add(commission),
                        BuyCommissionTiming::OnWin => bet.amount,
                    };
                    results.push(BetResult {
                        bet_idx: idx,
                        return_amount,
                        wagered,
                        resolved: true,
                    });
                } else if total == 7 {
                    let commission = calculate_buy_commission(bet.amount);
                    let wagered = match state.buy_commission_timing {
                        BuyCommissionTiming::AtPlacement => bet.amount.saturating_add(commission),
                        BuyCommissionTiming::OnWin => bet.amount,
                    };
                    results.push(BetResult {
                        bet_idx: idx,
                        return_amount: 0,
                        wagered,
                        resolved: true,
                    });
                }
            }
            _ => {}
        }
    }

    // 4. ATS progress + early wins (resolves immediately when completed).
    let ats_bit = ats_bit_for_total(total);
    if ats_bit != 0 {
        for (idx, bet) in state.bets.iter_mut().enumerate() {
            if !matches!(
                bet.bet_type,
                BetType::AtsSmall | BetType::AtsTall | BetType::AtsAll
            ) {
                continue;
            }
            bet.odds_amount |= ats_bit;
            let required = ats_required_mask(bet.bet_type);
            if required != 0 && (bet.odds_amount & required) == required {
                let mult = ats_payout_to_1(bet.bet_type);
                let return_amount = bet.amount.saturating_mul(mult.saturating_add(1));
                results.push(BetResult {
                    bet_idx: idx,
                    return_amount,
                    wagered: bet.amount,
                    resolved: true,
                });
            }
        }
    }

    // 5. COME/DONT_COME bets
    for (idx, bet) in state.bets.iter_mut().enumerate() {
        match (bet.bet_type, bet.status) {
            (BetType::Come, BetStatus::Pending) => {
                // Act like come-out roll
                match total {
                    7 | 11 => {
                        results.push(BetResult {
                            bet_idx: idx,
                            return_amount: bet.amount.saturating_mul(2),
                            wagered: bet.amount,
                            resolved: true,
                        });
                    }
                    2 | 3 | 12 => {
                        results.push(BetResult {
                            bet_idx: idx,
                            return_amount: 0,
                            wagered: bet.amount,
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
                    let total_payout = bet
                        .amount
                        .saturating_mul(2)
                        .saturating_add(bet.odds_amount)
                        .saturating_add(odds_payout);
                    results.push(BetResult {
                        bet_idx: idx,
                        return_amount: total_payout,
                        wagered: bet.amount.saturating_add(bet.odds_amount),
                        resolved: true,
                    });
                } else if total == 7 {
                    // Lose
                    results.push(BetResult {
                        bet_idx: idx,
                        return_amount: 0,
                        wagered: bet.amount.saturating_add(bet.odds_amount),
                        resolved: true,
                    });
                }
            }
            (BetType::DontCome, BetStatus::Pending) => {
                match total {
                    2 | 3 => {
                        results.push(BetResult {
                            bet_idx: idx,
                            return_amount: bet.amount.saturating_mul(2),
                            wagered: bet.amount,
                            resolved: true,
                        });
                    }
                    12 => {
                        // Push
                        results.push(BetResult {
                            bet_idx: idx,
                            return_amount: bet.amount,
                            wagered: bet.amount,
                            resolved: true,
                        });
                    }
                    7 | 11 => {
                        results.push(BetResult {
                            bet_idx: idx,
                            return_amount: 0,
                            wagered: bet.amount,
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
                    let total_payout = bet
                        .amount
                        .saturating_mul(2)
                        .saturating_add(bet.odds_amount)
                        .saturating_add(odds_payout);
                    results.push(BetResult {
                        bet_idx: idx,
                        return_amount: total_payout,
                        wagered: bet.amount.saturating_add(bet.odds_amount),
                        resolved: true,
                    });
                } else if total == bet.target {
                    results.push(BetResult {
                        bet_idx: idx,
                        return_amount: 0,
                        wagered: bet.amount.saturating_add(bet.odds_amount),
                        resolved: true,
                    });
                }
            }
            _ => {}
        }
    }

    // 6. PASS/DONT_PASS
    process_pass_bets(state, total, &mut results);

    // 7. Update phase and main point
    let phase_event = update_phase(state, total);
    match phase_event {
        PhaseEvent::PointEstablished(point) => {
            // Fix pass/don't pass odds tracking: set bet.target to the main point.
            for bet in state.bets.iter_mut() {
                if matches!(bet.bet_type, BetType::Pass | BetType::DontPass)
                    && bet.status == BetStatus::On
                {
                    bet.target = point;
                }
            }
        }
        PhaseEvent::PointMade(point) => {
            if let Some(bit) = point_to_fire_bit(point) {
                state.made_points_mask |= 1u8 << bit;
            }
        }
        _ => {}
    }

    // Fire bet resolves on seven-out.
    if matches!(phase_event, PhaseEvent::SevenOut) {
        let points_made = state.made_points_mask.count_ones() as u8;
        let mult = fire_bet_multiplier(points_made);
        for (idx, bet) in state.bets.iter().enumerate() {
            if bet.bet_type != BetType::Fire {
                continue;
            }
            let return_amount = if mult == 0 {
                0
            } else {
                bet.amount.saturating_mul(mult.saturating_add(1))
            };
            results.push(BetResult {
                bet_idx: idx,
                return_amount,
                wagered: bet.amount,
                resolved: true,
            });
        }
    }

    // ATS bets lose on seven-out if not already completed.
    if matches!(phase_event, PhaseEvent::SevenOut) {
        for (idx, bet) in state.bets.iter().enumerate() {
            if !matches!(
                bet.bet_type,
                BetType::AtsSmall | BetType::AtsTall | BetType::AtsAll
            ) {
                continue;
            }
            results.push(BetResult {
                bet_idx: idx,
                return_amount: 0,
                wagered: bet.amount,
                resolved: true,
            });
        }
    }

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
                            return_amount: bet.amount.saturating_mul(2),
                            wagered: bet.amount,
                            resolved: true,
                        });
                    }
                    2 | 3 | 12 => {
                        // Lose on come out (craps)
                        results.push(BetResult {
                            bet_idx: idx,
                            return_amount: 0,
                            wagered: bet.amount,
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
                    let return_amount = calculate_pass_return(bet, true, true);
                    results.push(BetResult {
                        bet_idx: idx,
                        return_amount,
                        wagered: bet.amount.saturating_add(bet.odds_amount),
                        resolved: true,
                    });
                } else if total == 7 {
                    // Seven out - lose
                    results.push(BetResult {
                        bet_idx: idx,
                        return_amount: 0,
                        wagered: bet.amount.saturating_add(bet.odds_amount),
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
                            return_amount: 0,
                            wagered: bet.amount,
                            resolved: true,
                        });
                    }
                    2 | 3 => {
                        // Win on come out (craps)
                        results.push(BetResult {
                            bet_idx: idx,
                            return_amount: bet.amount.saturating_mul(2),
                            wagered: bet.amount,
                            resolved: true,
                        });
                    }
                    12 => {
                        // Push on 12 (bar)
                        results.push(BetResult {
                            bet_idx: idx,
                            return_amount: bet.amount,
                            wagered: bet.amount,
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
                    let return_amount = calculate_pass_return(bet, true, false);
                    results.push(BetResult {
                        bet_idx: idx,
                        return_amount,
                        wagered: bet.amount.saturating_add(bet.odds_amount),
                        resolved: true,
                    });
                } else if total == state.main_point {
                    // Hit the point - lose for don't pass
                    results.push(BetResult {
                        bet_idx: idx,
                        return_amount: 0,
                        wagered: bet.amount.saturating_add(bet.odds_amount),
                        resolved: true,
                    });
                }
            }
            _ => {}
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PhaseEvent {
    None,
    PointEstablished(u8),
    PointMade(u8),
    SevenOut,
}

fn point_to_fire_bit(point: u8) -> Option<u8> {
    match point {
        4 => Some(0),
        5 => Some(1),
        6 => Some(2),
        8 => Some(3),
        9 => Some(4),
        10 => Some(5),
        _ => None,
    }
}

fn fire_bet_multiplier(points_made: u8) -> u64 {
    // WoO Fire Bet Pay Table A (pays "to 1"): 4->24, 5->249, 6->999.
    // https://wizardofodds.com/games/craps/side-bets/fire-bet/
    match points_made {
        4 => 24,
        5 => 249,
        6 => 999,
        _ => 0,
    }
}

/// Update phase and main point after a roll.
fn update_phase(state: &mut CrapsState, total: u8) -> PhaseEvent {
    match state.phase {
        Phase::ComeOut => {
            if ![2, 3, 7, 11, 12].contains(&total) {
                state.phase = Phase::Point;
                state.main_point = total;
                state.epoch_point_established = true;
                PhaseEvent::PointEstablished(total)
            } else {
                PhaseEvent::None
            }
        }
        Phase::Point => {
            if total == state.main_point {
                let point = state.main_point;
                state.phase = Phase::ComeOut;
                state.main_point = 0;
                PhaseEvent::PointMade(point)
            } else if total == 7 {
                state.phase = Phase::ComeOut;
                state.main_point = 0;
                state.epoch_point_established = false;
                PhaseEvent::SevenOut
            } else {
                PhaseEvent::None
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
        let state = CrapsState {
            phase: Phase::ComeOut,
            main_point: 0,
            d1: 0,
            d2: 0,
            made_points_mask: 0,
            epoch_point_established: false,
            field_paytable: FieldPaytable::default(),
            buy_commission_timing: BuyCommissionTiming::default(),
            bets: Vec::new(),
        };
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

        // Parse state (or initialize if legacy-empty).
        let mut state = if session.state_blob.is_empty() {
            CrapsState {
                phase: Phase::ComeOut,
                main_point: 0,
                d1: 0,
                d2: 0,
                made_points_mask: 0,
                epoch_point_established: false,
                field_paytable: FieldPaytable::default(),
                buy_commission_timing: BuyCommissionTiming::default(),
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
                let bet_type =
                    BetType::try_from(payload[1]).map_err(|_| GameError::InvalidPayload)?;
                let target = payload[2];
                let amount = u64::from_be_bytes(
                    payload[3..11]
                        .try_into()
                        .map_err(|_| GameError::InvalidPayload)?,
                );

                // Validate bet
                if amount == 0 {
                    return Err(GameError::InvalidPayload);
                }
                if state.bets.len() >= MAX_BETS {
                    return Err(GameError::InvalidMove);
                }

                // Validate target + timing rules.
                match bet_type {
                    BetType::Pass
                    | BetType::DontPass
                    | BetType::Field
                    | BetType::Fire
                    | BetType::AtsSmall
                    | BetType::AtsTall
                    | BetType::AtsAll => {
                        if target != 0 {
                            return Err(GameError::InvalidPayload);
                        }
                    }
                    BetType::Come | BetType::DontCome => {
                        if target != 0 {
                            return Err(GameError::InvalidPayload);
                        }
                        // Come/DontCome are only allowed once a point is established.
                        if state.phase != Phase::Point {
                            return Err(GameError::InvalidMove);
                        }
                    }
                    BetType::Yes | BetType::No | BetType::Buy => {
                        if ![4u8, 5, 6, 8, 9, 10].contains(&target) {
                            return Err(GameError::InvalidPayload);
                        }
                    }
                    BetType::Next => {
                        if !(2..=12).contains(&target) {
                            return Err(GameError::InvalidPayload);
                        }
                    }
                    BetType::Hardway4
                    | BetType::Hardway6
                    | BetType::Hardway8
                    | BetType::Hardway10 => {
                        if target != 0 {
                            return Err(GameError::InvalidPayload);
                        }
                    }
                }

                if bet_type == BetType::Fire {
                    // Fire bet may only be placed before the first roll of the shooter hand.
                    if state.d1 != 0 || state.d2 != 0 || state.made_points_mask != 0 {
                        return Err(GameError::InvalidMove);
                    }
                    if state.bets.iter().any(|b| b.bet_type == BetType::Fire) {
                        return Err(GameError::InvalidMove);
                    }
                }

                if matches!(
                    bet_type,
                    BetType::AtsSmall | BetType::AtsTall | BetType::AtsAll
                ) {
                    // ATS bets are tracked for the entire shooter epoch.
                    // Allow placement before any roll, and also after a 7 (no-point roll) so long as a point has not yet
                    // been established in the current epoch.
                    let has_rolled = state.d1 != 0 || state.d2 != 0;
                    let last_total = state.d1.saturating_add(state.d2);
                    let can_place = !state.epoch_point_established
                        && (!has_rolled || (state.phase == Phase::ComeOut && last_total == 7));
                    if !can_place {
                        return Err(GameError::InvalidMove);
                    }
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

                let deduction = if bet_type == BetType::Buy {
                    match state.buy_commission_timing {
                        BuyCommissionTiming::AtPlacement => {
                            amount.saturating_add(calculate_buy_commission(amount))
                        }
                        BuyCommissionTiming::OnWin => amount,
                    }
                } else {
                    amount
                };
                let deduction_i64 =
                    i64::try_from(deduction).map_err(|_| GameError::InvalidPayload)?;
                Ok(GameResult::ContinueWithUpdate {
                    payout: -deduction_i64,
                })
            }

            // [1, amount_bytes...] - Add odds to last contract bet
            1 => {
                if payload.len() < 9 {
                    return Err(GameError::InvalidPayload);
                }
                let odds_amount = u64::from_be_bytes(
                    payload[1..9]
                        .try_into()
                        .map_err(|_| GameError::InvalidPayload)?,
                );
                if odds_amount == 0 {
                    return Err(GameError::InvalidPayload);
                }

                // Find last contract bet (PASS, DONT_PASS, COME, DONT_COME with status ON)
                let mut found = false;
                for bet in state.bets.iter_mut().rev() {
                    if matches!(
                        bet.bet_type,
                        BetType::Pass | BetType::DontPass | BetType::Come | BetType::DontCome
                    ) && bet.status == BetStatus::On
                    {
                        if ![4u8, 5, 6, 8, 9, 10].contains(&bet.target) {
                            return Err(GameError::InvalidMove);
                        }
                        bet.odds_amount = bet.odds_amount.saturating_add(odds_amount);
                        found = true;
                        break;
                    }
                }

                if !found {
                    return Err(GameError::InvalidMove);
                }

                session.state_blob = state.to_blob();
                Ok(GameResult::ContinueWithUpdate {
                    payout: -(odds_amount as i64),
                })
            }

            // [2] - Roll dice
            2 => {
                if state.bets.is_empty() {
                    return Err(GameError::InvalidMove);
                }
                let d1 = rng.roll_die();
                let d2 = rng.roll_die();
                state.d1 = d1;
                state.d2 = d2;

                // Process roll
                let results = process_roll(&mut state, d1, d2);

                // Calculate credited return and (for completion reporting) loss amount.
                let mut total_return: u64 = 0;
                let mut total_loss: u64 = 0;
                let mut resolved_indices = Vec::with_capacity(state.bets.len());

                for result in results {
                    if result.resolved {
                        total_return = total_return.saturating_add(result.return_amount);
                        if result.return_amount == 0 {
                            total_loss = total_loss.saturating_add(result.wagered);
                        }
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
                    if total_return > 0 {
                        // Apply super mode multipliers if active
                        let final_return = if session.super_mode.is_active {
                            let dice_total = d1.saturating_add(d2);
                            apply_super_multiplier_total(
                                dice_total,
                                &session.super_mode.multipliers,
                                total_return,
                            )
                        } else {
                            total_return
                        };
                        Ok(GameResult::Win(final_return))
                    } else {
                        Ok(GameResult::LossPreDeducted(total_loss))
                    }
                } else {
                    // Game continues with active bets
                    // Credit any wins/pushes this roll; losses were already deducted at placement.
                    if total_return > 0 {
                        let payout =
                            i64::try_from(total_return).map_err(|_| GameError::InvalidMove)?;
                        Ok(GameResult::ContinueWithUpdate { payout })
                    } else {
                        Ok(GameResult::Continue)
                    }
                }
            }

            // [3] - Clear all bets (only before first roll)
            3 => {
                if state.d1 != 0 || state.d2 != 0 {
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
            is_tournament: false,
            tournament_id: None,
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
            made_points_mask: 0b001011, // arbitrary
            epoch_point_established: true,
            field_paytable: FieldPaytable::default(),
            buy_commission_timing: BuyCommissionTiming::default(),
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
        assert_eq!(blob[0], STATE_VERSION);
        assert_eq!(blob[1], Phase::Point as u8);
        assert_eq!(blob[2], 6);
        assert_eq!(blob[5], state.made_points_mask);
        assert_eq!(blob[6], 1); // epoch_point_established
        assert_eq!(blob[7], 2); // bet count

        let deserialized = CrapsState::from_blob(&blob).expect("Failed to parse state");
        assert_eq!(deserialized.phase, state.phase);
        assert_eq!(deserialized.main_point, state.main_point);
        assert_eq!(deserialized.made_points_mask, state.made_points_mask);
        assert_eq!(
            deserialized.epoch_point_established,
            state.epoch_point_established
        );
        assert_eq!(deserialized.bets.len(), 2);
    }

    #[test]
    fn test_field_payout() {
        // Payouts are TOTAL RETURN (stake + winnings)
        assert_eq!(
            calculate_field_payout(2, 100, FieldPaytable::Double2And12),
            300
        ); // 2:1 -> 3x total
        assert_eq!(
            calculate_field_payout(12, 100, FieldPaytable::Double2And12),
            300
        ); // 2:1 -> 3x total
        assert_eq!(
            calculate_field_payout(3, 100, FieldPaytable::Double2And12),
            200
        ); // 1:1 -> 2x total
        assert_eq!(
            calculate_field_payout(11, 100, FieldPaytable::Double2And12),
            200
        ); // 1:1 -> 2x total
        assert_eq!(
            calculate_field_payout(7, 100, FieldPaytable::Double2And12),
            0
        ); // lose
    }

    #[test]
    fn test_yes_payout() {
        // YES pays true odds with a 1% commission on winnings.
        // 6:5 on a 60 bet -> 72 winnings + 60 stake = 132 total.
        assert_eq!(calculate_yes_payout(6, 60, true), 132);
        // Miss
        assert_eq!(calculate_yes_payout(6, 60, false), 0);
    }

    #[test]
    fn test_next_payout() {
        // NEXT pays with a 1% commission on winnings.
        assert_eq!(calculate_next_payout(7, 7, 100), 595); // winnings 500 -> -5 commission
        assert_eq!(calculate_next_payout(2, 2, 100), 3565); // winnings 3500 -> -35 commission
                                                            // Miss
        assert_eq!(calculate_next_payout(7, 6, 100), 0);
    }

    #[test]
    fn test_buy_commission_rounds_up() {
        assert_eq!(calculate_buy_commission(100), 5);
        assert_eq!(calculate_buy_commission(1), 1);
        assert_eq!(calculate_buy_commission(20), 1);
    }

    #[test]
    fn test_buy_payout() {
        assert_eq!(calculate_buy_payout(4, 100, true), 300); // 2:1 -> 3x total
        assert_eq!(calculate_buy_payout(5, 100, true), 250); // 3:2 -> 2.5x total
        assert_eq!(calculate_buy_payout(6, 100, true), 220); // 6:5 -> 2.2x total
        assert_eq!(calculate_buy_payout(4, 100, false), 0);
    }

    #[test]
    fn test_ats_small_completes_and_pays() {
        let mut state = CrapsState {
            phase: Phase::ComeOut,
            main_point: 0,
            d1: 0,
            d2: 0,
            made_points_mask: 0,
            epoch_point_established: false,
            field_paytable: FieldPaytable::default(),
            buy_commission_timing: BuyCommissionTiming::default(),
            bets: vec![CrapsBet {
                bet_type: BetType::AtsSmall,
                target: 0,
                status: BetStatus::On,
                amount: 10,
                odds_amount: 0,
            }],
        };

        for (d1, d2) in [(1, 1), (1, 2), (2, 2), (2, 3), (3, 3)] {
            let results = process_roll(&mut state, d1, d2);
            let resolved: Vec<_> = results.into_iter().filter(|r| r.resolved).collect();
            if d1 + d2 == 6 {
                assert_eq!(resolved.len(), 1);
                assert_eq!(resolved[0].return_amount, 350); // 34:1 -> 35x total
                assert_eq!(resolved[0].bet_idx, 0);
                state.bets.clear();
            } else {
                assert!(resolved.is_empty());
            }
        }
    }

    #[test]
    fn test_ats_loses_on_seven_out() {
        let mut state = CrapsState {
            phase: Phase::Point,
            main_point: 6,
            d1: 0,
            d2: 0,
            made_points_mask: 0,
            epoch_point_established: true,
            field_paytable: FieldPaytable::default(),
            buy_commission_timing: BuyCommissionTiming::default(),
            bets: vec![CrapsBet {
                bet_type: BetType::AtsTall,
                target: 0,
                status: BetStatus::On,
                amount: 10,
                odds_amount: 0,
            }],
        };

        let results = process_roll(&mut state, 3, 4);
        let ats = results
            .into_iter()
            .find(|r| r.resolved && r.bet_idx == 0)
            .expect("expected ATS bet to resolve on seven-out");
        assert_eq!(ats.return_amount, 0);
        assert_eq!(ats.wagered, 10);
    }

    #[test]
    fn test_hardway_payout() {
        // Hard 6 (3,3) wins - 9:1 = 900 + 100 stake = 1000 total
        assert_eq!(calculate_hardway_payout(6, 3, 3, 6, 100), Some(1000));
        // Easy 6 (2,4) loses
        assert_eq!(calculate_hardway_payout(6, 2, 4, 6, 100), Some(0));
        // Seven out loses
        assert_eq!(calculate_hardway_payout(6, 4, 3, 7, 100), Some(0));
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

        // Force point phase (come bets are only allowed after a point is established).
        let mut state = CrapsState::from_blob(&session.state_blob).expect("Failed to parse state");
        state.phase = Phase::Point;
        state.main_point = 4;
        session.state_blob = state.to_blob();

        // Place come bet
        let mut payload = vec![0, BetType::Come as u8, 0];
        payload.extend_from_slice(&100u64.to_be_bytes());

        let mut rng = GameRng::new(&seed, session.id, 1);
        Craps::process_move(&mut session, &payload, &mut rng).expect("Failed to process move");

        let state = CrapsState::from_blob(&session.state_blob).expect("Failed to parse state");
        assert_eq!(state.bets[0].status, BetStatus::Pending);

        // Roll a point number (6) to travel the come bet.
        let mut state = CrapsState::from_blob(&session.state_blob).expect("Failed to parse state");
        process_roll(&mut state, 3, 3);
        assert_eq!(state.bets[0].status, BetStatus::On);
        assert_eq!(state.bets[0].target, 6);
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
        let bets = vec![(BetType::Pass, 0, 100u64), (BetType::Field, 0, 50u64)];

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
        assert!(
            state.bets.len() < initial_bet_count,
            "At least field bet should resolve"
        );
        // No field bet should remain (it's always a single-roll bet)
        assert!(!state.bets.iter().any(|b| b.bet_type == BetType::Field));
    }

    #[test]
    fn test_ways_constant() {
        assert_eq!(WAYS[2], 1); // One way to roll 2 (1,1)
        assert_eq!(WAYS[7], 6); // Six ways to roll 7
        assert_eq!(WAYS[12], 1); // One way to roll 12 (6,6)
    }

    #[test]
    fn test_fire_bet_pays_on_seven_out() {
        let mut state = CrapsState {
            phase: Phase::ComeOut,
            main_point: 0,
            d1: 0,
            d2: 0,
            made_points_mask: 0,
            epoch_point_established: false,
            field_paytable: FieldPaytable::default(),
            buy_commission_timing: BuyCommissionTiming::default(),
            bets: vec![CrapsBet {
                bet_type: BetType::Fire,
                target: 0,
                status: BetStatus::On,
                amount: 10,
                odds_amount: 0,
            }],
        };

        // Make 4, 5, 6, 8.
        for (d1, d2) in [
            (2, 2),
            (2, 2),
            (2, 3),
            (2, 3),
            (3, 3),
            (3, 3),
            (4, 4),
            (4, 4),
        ] {
            process_roll(&mut state, d1, d2);
        }
        assert_eq!(state.made_points_mask.count_ones(), 4);

        // Establish a point, then seven-out to resolve Fire bet.
        process_roll(&mut state, 4, 5); // 9 establishes a point
        let results = process_roll(&mut state, 3, 4); // 7 out
        assert_eq!(results.len(), 1);
        assert!(results[0].resolved);
        assert_eq!(results[0].return_amount, 250); // 10 * (24 + 1)
    }

    #[test]
    fn test_fire_bet_loses_under_four_points() {
        let mut state = CrapsState {
            phase: Phase::ComeOut,
            main_point: 0,
            d1: 0,
            d2: 0,
            made_points_mask: 0,
            epoch_point_established: false,
            field_paytable: FieldPaytable::default(),
            buy_commission_timing: BuyCommissionTiming::default(),
            bets: vec![CrapsBet {
                bet_type: BetType::Fire,
                target: 0,
                status: BetStatus::On,
                amount: 10,
                odds_amount: 0,
            }],
        };

        // Make 4, 5, 6 (only 3 points).
        for (d1, d2) in [(2, 2), (2, 2), (2, 3), (2, 3), (3, 3), (3, 3)] {
            process_roll(&mut state, d1, d2);
        }
        assert_eq!(state.made_points_mask.count_ones(), 3);

        process_roll(&mut state, 4, 5); // 9 establishes a point
        let results = process_roll(&mut state, 3, 4); // 7 out
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].return_amount, 0);
    }
}
