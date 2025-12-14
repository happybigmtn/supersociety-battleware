//! Ultimate Texas Hold'em implementation.
//!
//! This implementation supports:
//! - Standard Ante + Blind (both equal to `session.bet`)
//! - Optional Trips side bet (WoO pay table 1)
//! - Optional Progressive side bet (WoO "Common Progressive", for-one; based on hole cards + flop)
//! - Progressive reveal of community/dealer cards (no hidden cards stored before reveal)
//!
//! State blob format:
//! v3 (40 bytes):
//! [version:u8=3]
//! [stage:u8]
//! [playerCard1:u8] [playerCard2:u8]                   (0xFF if not dealt yet)
//! [community1:u8] [community2:u8] [community3:u8] [community4:u8] [community5:u8] (0xFF if unrevealed)
//! [dealerCard1:u8] [dealerCard2:u8]                   (0xFF if unrevealed)
//! [playBetMultiplier:u8]                              (0 = none, 1/2/3/4 = multiplier of ante)
//! [bonus1:u8] [bonus2:u8] [bonus3:u8] [bonus4:u8]     (0xFF if unrevealed; used for 6-card bonus)
//! [tripsBetAmount:u64 BE]
//! [sixCardBonusBetAmount:u64 BE]
//! [progressiveBetAmount:u64 BE]
//!
//! v2 (32 bytes):
//! [version:u8=2]
//! [stage:u8]
//! [playerCard1:u8] [playerCard2:u8]                   (0xFF if not dealt yet)
//! [community1:u8] [community2:u8] [community3:u8] [community4:u8] [community5:u8] (0xFF if unrevealed)
//! [dealerCard1:u8] [dealerCard2:u8]                   (0xFF if unrevealed)
//! [playBetMultiplier:u8]                              (0 = none, 1/2/3/4 = multiplier of ante)
//! [bonus1:u8] [bonus2:u8] [bonus3:u8] [bonus4:u8]     (0xFF if unrevealed; used for 6-card bonus)
//! [tripsBetAmount:u64 BE]
//! [sixCardBonusBetAmount:u64 BE]
//!
//! v1 (legacy, 20 bytes):
//! [version:u8=1]
//! [stage:u8]
//! [playerCard1:u8] [playerCard2:u8]
//! [community1:u8] [community2:u8] [community3:u8] [community4:u8] [community5:u8]
//! [dealerCard1:u8] [dealerCard2:u8]
//! [playBetMultiplier:u8]
//! [tripsBetAmount:u64 BE]
//!
//! Stages:
//! 0 = Betting (optional Trips, then Deal)
//! 1 = Preflop (check or bet 4x)
//! 2 = Flop (check or bet 2x)
//! 3 = River (bet 1x or fold)
//! 4 = AwaitingReveal (play bet placed; reveal/resolve next)
//! 5 = Showdown (complete)
//!
//! Payload format:
//! [action:u8] [optional amount:u64 BE]
//! 0 = Check
//! 1 = Bet 4x
//! 8 = Bet 3x
//! 2 = Bet 2x
//! 3 = Bet 1x
//! 4 = Fold
//! 5 = Deal (optional u64 = Trips bet)
//! 6 = Set Trips bet (u64)
//! 7 = Reveal (resolve showdown)
//! 9 = Set 6-Card Bonus bet (u64)
//! 10 = Set Progressive bet (u64)

use super::super_mode::apply_super_multiplier_cards;
use super::{CasinoGame, GameError, GameResult, GameRng};
use nullspace_types::casino::{GameSession, UTH_PROGRESSIVE_BASE_JACKPOT};

const STATE_VERSION_V1: u8 = 1;
const STATE_VERSION_V2: u8 = 2;
const STATE_VERSION_V3: u8 = 3;
const CARD_UNKNOWN: u8 = 0xFF;
const STATE_LEN_V1: usize = 20;
const STATE_LEN_V2: usize = 32;
const STATE_LEN_V3: usize = 40;

const PROGRESSIVE_BET_UNIT: u64 = 1;

/// Game stages.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Stage {
    Betting = 0,
    Preflop = 1,
    Flop = 2,
    River = 3,
    AwaitingReveal = 4,
    Showdown = 5,
}

impl TryFrom<u8> for Stage {
    type Error = GameError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Stage::Betting),
            1 => Ok(Stage::Preflop),
            2 => Ok(Stage::Flop),
            3 => Ok(Stage::River),
            4 => Ok(Stage::AwaitingReveal),
            5 => Ok(Stage::Showdown),
            _ => Err(GameError::InvalidPayload),
        }
    }
}

/// Player actions.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Check = 0,
    Bet4x = 1,
    Bet2x = 2,
    Bet1x = 3,
    Fold = 4,
    Deal = 5,
    SetTrips = 6,
    Reveal = 7,
    Bet3x = 8,
    SetSixCardBonus = 9,
    SetProgressive = 10,
}

impl TryFrom<u8> for Action {
    type Error = GameError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Action::Check),
            1 => Ok(Action::Bet4x),
            2 => Ok(Action::Bet2x),
            3 => Ok(Action::Bet1x),
            4 => Ok(Action::Fold),
            5 => Ok(Action::Deal),
            6 => Ok(Action::SetTrips),
            7 => Ok(Action::Reveal),
            8 => Ok(Action::Bet3x),
            9 => Ok(Action::SetSixCardBonus),
            10 => Ok(Action::SetProgressive),
            _ => Err(GameError::InvalidPayload),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct UthState {
    stage: Stage,
    player: [u8; 2],
    community: [u8; 5],
    dealer: [u8; 2],
    play_mult: u8,
    trips_bet: u64,
    bonus: [u8; 4],
    six_card_bonus_bet: u64,
    progressive_bet: u64,
}

fn parse_state(state: &[u8]) -> Option<UthState> {
    if state.len() == STATE_LEN_V1 && state[0] == STATE_VERSION_V1 {
        let stage = Stage::try_from(state[1]).ok()?;
        let player = [state[2], state[3]];
        let community = [state[4], state[5], state[6], state[7], state[8]];
        let dealer = [state[9], state[10]];
        let play_mult = state[11];
        let trips_bet = u64::from_be_bytes(state[12..20].try_into().ok()?);

        return Some(UthState {
            stage,
            player,
            community,
            dealer,
            play_mult,
            trips_bet,
            bonus: [CARD_UNKNOWN; 4],
            six_card_bonus_bet: 0,
            progressive_bet: 0,
        });
    }

    if state.len() == STATE_LEN_V2 && state[0] == STATE_VERSION_V2 {
        let stage = Stage::try_from(state[1]).ok()?;
        let player = [state[2], state[3]];
        let community = [state[4], state[5], state[6], state[7], state[8]];
        let dealer = [state[9], state[10]];
        let play_mult = state[11];
        let bonus = [state[12], state[13], state[14], state[15]];
        let trips_bet = u64::from_be_bytes(state[16..24].try_into().ok()?);
        let six_card_bonus_bet = u64::from_be_bytes(state[24..32].try_into().ok()?);

        return Some(UthState {
            stage,
            player,
            community,
            dealer,
            play_mult,
            trips_bet,
            bonus,
            six_card_bonus_bet,
            progressive_bet: 0,
        });
    }

    if state.len() == STATE_LEN_V3 && state[0] == STATE_VERSION_V3 {
        let stage = Stage::try_from(state[1]).ok()?;
        let player = [state[2], state[3]];
        let community = [state[4], state[5], state[6], state[7], state[8]];
        let dealer = [state[9], state[10]];
        let play_mult = state[11];
        let bonus = [state[12], state[13], state[14], state[15]];
        let trips_bet = u64::from_be_bytes(state[16..24].try_into().ok()?);
        let six_card_bonus_bet = u64::from_be_bytes(state[24..32].try_into().ok()?);
        let progressive_bet = u64::from_be_bytes(state[32..40].try_into().ok()?);

        return Some(UthState {
            stage,
            player,
            community,
            dealer,
            play_mult,
            trips_bet,
            bonus,
            six_card_bonus_bet,
            progressive_bet,
        });
    }

    None
}

fn serialize_state(state: &UthState) -> Vec<u8> {
    let mut out = Vec::with_capacity(STATE_LEN_V3);
    out.push(STATE_VERSION_V3);
    out.push(state.stage as u8);
    out.extend_from_slice(&state.player);
    out.extend_from_slice(&state.community);
    out.extend_from_slice(&state.dealer);
    out.push(state.play_mult);
    out.extend_from_slice(&state.bonus);
    out.extend_from_slice(&state.trips_bet.to_be_bytes());
    out.extend_from_slice(&state.six_card_bonus_bet.to_be_bytes());
    out.extend_from_slice(&state.progressive_bet.to_be_bytes());
    out
}

fn is_known_card(card: u8) -> bool {
    card < 52
}

fn known_cards_in_state(state: &UthState) -> Vec<u8> {
    let mut used = Vec::with_capacity(2 + 5 + 2);
    for &c in state
        .player
        .iter()
        .chain(state.community.iter())
        .chain(state.dealer.iter())
        .chain(state.bonus.iter())
    {
        if is_known_card(c) {
            used.push(c);
        }
    }
    used
}

fn parse_u64_be(payload: &[u8], offset: usize) -> Result<u64, GameError> {
    let end = offset.saturating_add(8);
    if payload.len() < end {
        return Err(GameError::InvalidPayload);
    }
    Ok(u64::from_be_bytes(
        payload[offset..end]
            .try_into()
            .map_err(|_| GameError::InvalidPayload)?,
    ))
}

fn apply_trips_update(state: &mut UthState, new_trips_bet: u64) -> Result<i64, GameError> {
    let old = state.trips_bet as i128;
    let new = new_trips_bet as i128;
    let delta = new - old;
    if delta > i64::MAX as i128 || delta < i64::MIN as i128 {
        return Err(GameError::InvalidMove);
    }
    state.trips_bet = new_trips_bet;
    // Deduct positive increases, refund decreases.
    Ok(-(delta as i64))
}

fn apply_six_card_bonus_update(state: &mut UthState, new_bet: u64) -> Result<i64, GameError> {
    let old = state.six_card_bonus_bet as i128;
    let new = new_bet as i128;
    let delta = new - old;
    if delta > i64::MAX as i128 || delta < i64::MIN as i128 {
        return Err(GameError::InvalidMove);
    }
    state.six_card_bonus_bet = new_bet;
    Ok(-(delta as i64))
}

fn apply_progressive_update(state: &mut UthState, new_bet: u64) -> Result<i64, GameError> {
    let old = state.progressive_bet as i128;
    let new = new_bet as i128;
    let delta = new - old;
    if delta > i64::MAX as i128 || delta < i64::MIN as i128 {
        return Err(GameError::InvalidMove);
    }
    state.progressive_bet = new_bet;
    Ok(-(delta as i64))
}

fn draw_into_unknowns(
    state: &mut UthState,
    rng: &mut GameRng,
    need_dealer: bool,
) -> Result<(), GameError> {
    let used = known_cards_in_state(state);
    let mut deck = rng.create_deck_excluding(&used);

    for card in &mut state.community {
        if !is_known_card(*card) {
            *card = rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
        }
    }

    if need_dealer {
        for card in &mut state.dealer {
            if !is_known_card(*card) {
                *card = rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
            }
        }
    }

    if state.six_card_bonus_bet > 0 {
        for card in &mut state.bonus {
            if !is_known_card(*card) {
                *card = rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
            }
        }
    }

    Ok(())
}

// === Hand evaluation ===

/// Texas Hold'em hand rankings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum HandRank {
    HighCard = 0,
    Pair = 1,
    TwoPair = 2,
    ThreeOfAKind = 3,
    Straight = 4,
    Flush = 5,
    FullHouse = 6,
    FourOfAKind = 7,
    StraightFlush = 8,
    RoyalFlush = 9,
}

/// Get card rank (1-13, but Ace = 14 for comparison).
fn card_rank(card: u8) -> u8 {
    let r = (card % 13) + 1;
    if r == 1 {
        14
    } else {
        r
    }
}

/// Get card suit.
fn card_suit(card: u8) -> u8 {
    card / 13
}

/// Evaluate best 5-card hand from 7 cards.
/// Returns (HandRank, high cards for tiebreaker).
pub fn evaluate_best_hand(cards: &[u8; 7]) -> (HandRank, [u8; 5]) {
    let mut best_rank = HandRank::HighCard;
    let mut best_kickers = [0u8; 5];

    // Iterate over which 2 cards to skip (C(7,5) = 21 combos)
    for i in 0..7 {
        for j in (i + 1)..7 {
            let mut hand = [0u8; 5];
            let mut k = 0;
            for (idx, &card) in cards.iter().enumerate() {
                if idx != i && idx != j {
                    hand[k] = card;
                    k += 1;
                }
            }
            if k == 5 {
                let (rank, kickers) = evaluate_5_card_fast(&hand);
                if rank > best_rank || (rank == best_rank && kickers > best_kickers) {
                    best_rank = rank;
                    best_kickers = kickers;
                }
            }
        }
    }

    (best_rank, best_kickers)
}

fn evaluate_best_6_card_bonus(cards: &[u8; 6]) -> HandRank {
    let mut best_rank = HandRank::HighCard;

    // Iterate over which 1 card to skip (C(6,5) = 6 combos)
    for skip in 0..6 {
        let mut hand = [0u8; 5];
        let mut idx = 0;
        for (i, &card) in cards.iter().enumerate() {
            if i == skip {
                continue;
            }
            hand[idx] = card;
            idx += 1;
        }
        if idx == 5 {
            let (rank, _kickers) = evaluate_5_card_fast(&hand);
            if rank > best_rank {
                best_rank = rank;
            }
        }
    }

    best_rank
}

fn evaluate_5_card_fast(cards: &[u8; 5]) -> (HandRank, [u8; 5]) {
    let mut ranks = [0u8; 5];
    let mut suits = [0u8; 5];
    for i in 0..5 {
        ranks[i] = card_rank(cards[i]);
        suits[i] = card_suit(cards[i]);
    }

    // Sort ranks descending for kickers
    ranks.sort_unstable_by(|a, b| b.cmp(a));

    // Flush?
    let is_flush = suits[0] == suits[1]
        && suits[1] == suits[2]
        && suits[2] == suits[3]
        && suits[3] == suits[4];

    // Straight?
    let mut sorted = ranks;
    sorted.sort_unstable();
    let has_duplicates = sorted[0] == sorted[1]
        || sorted[1] == sorted[2]
        || sorted[2] == sorted[3]
        || sorted[3] == sorted[4];
    let is_straight = if has_duplicates {
        false
    } else if sorted[4] - sorted[0] == 4 {
        true
    } else {
        // Wheel A-2-3-4-5
        sorted == [2, 3, 4, 5, 14]
    };

    let is_royal = sorted == [10, 11, 12, 13, 14];

    // Count ranks
    let mut counts = [0u8; 15];
    for &r in &ranks {
        counts[r as usize] += 1;
    }

    let mut pair_count = 0u8;
    let mut has_trips = false;
    let mut has_quads = false;
    for &count in &counts {
        match count {
            2 => pair_count += 1,
            3 => has_trips = true,
            4 => has_quads = true,
            _ => {}
        }
    }

    let hand_rank = if is_royal && is_flush {
        HandRank::RoyalFlush
    } else if is_straight && is_flush {
        HandRank::StraightFlush
    } else if has_quads {
        HandRank::FourOfAKind
    } else if has_trips && pair_count >= 1 {
        HandRank::FullHouse
    } else if is_flush {
        HandRank::Flush
    } else if is_straight {
        HandRank::Straight
    } else if has_trips {
        HandRank::ThreeOfAKind
    } else if pair_count >= 2 {
        HandRank::TwoPair
    } else if pair_count == 1 {
        HandRank::Pair
    } else {
        HandRank::HighCard
    };

    (hand_rank, ranks)
}

fn blind_bonus_winnings(ante: u64, player_rank: HandRank) -> u64 {
    match player_rank {
        HandRank::RoyalFlush => ante.saturating_mul(500),
        HandRank::StraightFlush => ante.saturating_mul(50),
        HandRank::FourOfAKind => ante.saturating_mul(10),
        HandRank::FullHouse => ante.saturating_mul(3),
        HandRank::Flush => ante.saturating_mul(3).saturating_div(2), // 3:2
        HandRank::Straight => ante,
        _ => 0,
    }
}

fn trips_multiplier(player_rank: HandRank) -> u64 {
    match player_rank {
        HandRank::RoyalFlush => 50,
        HandRank::StraightFlush => 40,
        HandRank::FourOfAKind => 30,
        HandRank::FullHouse => 9,
        HandRank::Flush => 7,
        HandRank::Straight => 4,
        HandRank::ThreeOfAKind => 3,
        _ => 0,
    }
}

fn six_card_bonus_multiplier(rank: HandRank) -> u64 {
    // WoO 6-Card Bonus, Version 1-A.
    match rank {
        HandRank::RoyalFlush => 1000,
        HandRank::StraightFlush => 200,
        HandRank::FourOfAKind => 100,
        HandRank::FullHouse => 20,
        HandRank::Flush => 15,
        HandRank::Straight => 10,
        HandRank::ThreeOfAKind => 7,
        _ => 0,
    }
}

fn uth_progressive_return(hole: &[u8; 2], flop: &[u8; 3], progressive_bet: u64) -> u64 {
    if progressive_bet == 0 {
        return 0;
    }
    let cards = [hole[0], hole[1], flop[0], flop[1], flop[2]];
    let (rank, _kickers) = evaluate_5_card_fast(&cards);
    match rank {
        HandRank::RoyalFlush => progressive_bet.saturating_mul(UTH_PROGRESSIVE_BASE_JACKPOT),
        HandRank::StraightFlush => {
            progressive_bet.saturating_mul(UTH_PROGRESSIVE_BASE_JACKPOT / 10)
        }
        HandRank::FourOfAKind => progressive_bet.saturating_mul(300),
        HandRank::FullHouse => progressive_bet.saturating_mul(50),
        HandRank::Flush => progressive_bet.saturating_mul(40),
        HandRank::Straight => progressive_bet.saturating_mul(30),
        HandRank::ThreeOfAKind => progressive_bet.saturating_mul(9),
        _ => 0,
    }
}

fn resolve_showdown(
    session: &mut GameSession,
    state: &mut UthState,
) -> Result<GameResult, GameError> {
    // Validate required cards
    if !state.player.iter().all(|&c| is_known_card(c)) {
        return Err(GameError::InvalidState);
    }
    if !state.community.iter().all(|&c| is_known_card(c)) {
        return Err(GameError::InvalidState);
    }
    if !state.dealer.iter().all(|&c| is_known_card(c)) {
        return Err(GameError::InvalidState);
    }
    if state.six_card_bonus_bet > 0 && !state.bonus.iter().all(|&c| is_known_card(c)) {
        return Err(GameError::InvalidState);
    }

    let ante = session.bet;
    let blind = session.bet;
    let play_bet = ante.saturating_mul(state.play_mult as u64);
    let trips_bet = state.trips_bet;
    let six_card_bonus_bet = state.six_card_bonus_bet;
    let progressive_bet = state.progressive_bet;
    let total_wagered = ante
        .saturating_add(blind)
        .saturating_add(play_bet)
        .saturating_add(trips_bet)
        .saturating_add(six_card_bonus_bet)
        .saturating_add(progressive_bet);

    let player_cards = [
        state.player[0],
        state.player[1],
        state.community[0],
        state.community[1],
        state.community[2],
        state.community[3],
        state.community[4],
    ];
    let dealer_cards = [
        state.dealer[0],
        state.dealer[1],
        state.community[0],
        state.community[1],
        state.community[2],
        state.community[3],
        state.community[4],
    ];

    let player_hand = evaluate_best_hand(&player_cards);
    let dealer_hand = evaluate_best_hand(&dealer_cards);
    let dealer_qualifies = dealer_hand.0 >= HandRank::Pair;

    let player_wins = player_hand.0 > dealer_hand.0
        || (player_hand.0 == dealer_hand.0 && player_hand.1 > dealer_hand.1);
    let tie = player_hand.0 == dealer_hand.0 && player_hand.1 == dealer_hand.1;

    let mut total_return: u64 = 0;

    // Progressive side bet (independent of dealer; based on hole + flop only).
    if progressive_bet > 0 {
        let flop = [state.community[0], state.community[1], state.community[2]];
        total_return = total_return.saturating_add(uth_progressive_return(
            &state.player,
            &flop,
            progressive_bet,
        ));
    }

    // Trips side bet (independent of dealer).
    if trips_bet > 0 {
        let mult = trips_multiplier(player_hand.0);
        if mult > 0 {
            total_return =
                total_return.saturating_add(trips_bet.saturating_mul(mult.saturating_add(1)));
        }
    }

    // 6-card bonus side bet (independent of dealer).
    if six_card_bonus_bet > 0 {
        let cards = [
            state.player[0],
            state.player[1],
            state.bonus[0],
            state.bonus[1],
            state.bonus[2],
            state.bonus[3],
        ];
        let rank = evaluate_best_6_card_bonus(&cards);
        let mult = six_card_bonus_multiplier(rank);
        if mult > 0 {
            total_return = total_return
                .saturating_add(six_card_bonus_bet.saturating_mul(mult.saturating_add(1)));
        }
    }

    // Main bets.
    if state.play_mult == 0 {
        // Fold: lose Ante and Blind; only Trips can return.
    } else if tie {
        // All main bets push on tie.
        total_return = total_return
            .saturating_add(ante)
            .saturating_add(blind)
            .saturating_add(play_bet);
    } else if player_wins {
        // Play always pays 1:1 when player wins.
        total_return = total_return.saturating_add(play_bet.saturating_mul(2));

        // Ante: pushes if dealer doesn't qualify, otherwise pays 1:1.
        if dealer_qualifies {
            total_return = total_return.saturating_add(ante.saturating_mul(2));
        } else {
            total_return = total_return.saturating_add(ante);
        }

        // Blind: pays bonus on straight+; otherwise pushes (on a win).
        let blind_bonus = blind_bonus_winnings(ante, player_hand.0);
        total_return = total_return.saturating_add(blind.saturating_add(blind_bonus));
    } else {
        // Player loses.
        // Ante pushes if dealer doesn't qualify; otherwise it loses.
        if !dealer_qualifies {
            total_return = total_return.saturating_add(ante);
        }
        // Blind and Play lose.
    }

    // Apply super mode multiplier (if any) to the full credited return.
    if session.super_mode.is_active && total_return > 0 {
        total_return = apply_super_multiplier_cards(
            &player_cards,
            &session.super_mode.multipliers,
            total_return,
        );
    }

    state.stage = Stage::Showdown;
    session.is_complete = true;

    if total_return == 0 {
        Ok(GameResult::LossPreDeducted(total_wagered))
    } else {
        Ok(GameResult::Win(total_return))
    }
}

pub struct UltimateHoldem;

impl CasinoGame for UltimateHoldem {
    fn init(session: &mut GameSession, _rng: &mut GameRng) -> GameResult {
        // Start in a betting stage so optional side bets (Trips) can be placed before any cards
        // are dealt. Ante was deducted by CasinoStartGame; deduct Blind here.
        let state = UthState {
            stage: Stage::Betting,
            player: [CARD_UNKNOWN; 2],
            community: [CARD_UNKNOWN; 5],
            dealer: [CARD_UNKNOWN; 2],
            play_mult: 0,
            trips_bet: 0,
            bonus: [CARD_UNKNOWN; 4],
            six_card_bonus_bet: 0,
            progressive_bet: 0,
        };
        session.state_blob = serialize_state(&state);
        GameResult::ContinueWithUpdate {
            payout: -(session.bet as i64),
        }
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

        let action = Action::try_from(payload[0])?;
        let mut state = parse_state(&session.state_blob).ok_or(GameError::InvalidPayload)?;

        let mut payout_update: i64 = 0;

        match state.stage {
            Stage::Betting => match action {
                Action::SetTrips => {
                    let new_trips = parse_u64_be(payload, 1)?;
                    payout_update = apply_trips_update(&mut state, new_trips)?;
                    session.state_blob = serialize_state(&state);
                    Ok(if payout_update == 0 {
                        GameResult::Continue
                    } else {
                        GameResult::ContinueWithUpdate {
                            payout: payout_update,
                        }
                    })
                }
                Action::SetSixCardBonus => {
                    let new_bet = parse_u64_be(payload, 1)?;
                    payout_update = apply_six_card_bonus_update(&mut state, new_bet)?;
                    session.state_blob = serialize_state(&state);
                    Ok(if payout_update == 0 {
                        GameResult::Continue
                    } else {
                        GameResult::ContinueWithUpdate {
                            payout: payout_update,
                        }
                    })
                }
                Action::SetProgressive => {
                    let new_bet = parse_u64_be(payload, 1)?;
                    if new_bet != 0 && new_bet != PROGRESSIVE_BET_UNIT {
                        return Err(GameError::InvalidMove);
                    }
                    payout_update = apply_progressive_update(&mut state, new_bet)?;
                    session.state_blob = serialize_state(&state);
                    Ok(if payout_update == 0 {
                        GameResult::Continue
                    } else {
                        GameResult::ContinueWithUpdate {
                            payout: payout_update,
                        }
                    })
                }
                Action::Deal => {
                    if is_known_card(state.player[0]) || is_known_card(state.player[1]) {
                        return Err(GameError::InvalidMove);
                    }

                    if payload.len() == 9 {
                        let new_trips = parse_u64_be(payload, 1)?;
                        payout_update = apply_trips_update(&mut state, new_trips)?;
                    } else if payload.len() != 1 {
                        return Err(GameError::InvalidPayload);
                    }

                    // Deal player hole cards.
                    let mut deck = rng.create_deck();
                    state.player[0] = rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
                    state.player[1] = rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
                    state.stage = Stage::Preflop;

                    session.state_blob = serialize_state(&state);
                    Ok(if payout_update == 0 {
                        GameResult::Continue
                    } else {
                        GameResult::ContinueWithUpdate {
                            payout: payout_update,
                        }
                    })
                }
                _ => Err(GameError::InvalidMove),
            },
            Stage::Preflop => match action {
                Action::Check => {
                    // Reveal flop (3 community cards).
                    let used = known_cards_in_state(&state);
                    let mut deck = rng.create_deck_excluding(&used);
                    for i in 0..3 {
                        if !is_known_card(state.community[i]) {
                            state.community[i] =
                                rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
                        }
                    }
                    state.stage = Stage::Flop;
                    session.state_blob = serialize_state(&state);
                    Ok(GameResult::Continue)
                }
                Action::Bet4x => {
                    if state.play_mult != 0 {
                        return Err(GameError::InvalidMove);
                    }
                    let play_bet = session.bet.saturating_mul(4);
                    state.play_mult = 4;
                    state.stage = Stage::AwaitingReveal;
                    session.state_blob = serialize_state(&state);
                    Ok(GameResult::ContinueWithUpdate {
                        payout: -(play_bet as i64),
                    })
                }
                Action::Bet3x => {
                    if state.play_mult != 0 {
                        return Err(GameError::InvalidMove);
                    }
                    let play_bet = session.bet.saturating_mul(3);
                    state.play_mult = 3;
                    state.stage = Stage::AwaitingReveal;
                    session.state_blob = serialize_state(&state);
                    Ok(GameResult::ContinueWithUpdate {
                        payout: -(play_bet as i64),
                    })
                }
                _ => Err(GameError::InvalidMove),
            },
            Stage::Flop => match action {
                Action::Check => {
                    // Reveal turn+river (2 cards).
                    let used = known_cards_in_state(&state);
                    let mut deck = rng.create_deck_excluding(&used);
                    for i in 3..5 {
                        if !is_known_card(state.community[i]) {
                            state.community[i] =
                                rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
                        }
                    }
                    state.stage = Stage::River;
                    session.state_blob = serialize_state(&state);
                    Ok(GameResult::Continue)
                }
                Action::Bet2x => {
                    if state.play_mult != 0 {
                        return Err(GameError::InvalidMove);
                    }
                    let play_bet = session.bet.saturating_mul(2);
                    state.play_mult = 2;
                    state.stage = Stage::AwaitingReveal;
                    session.state_blob = serialize_state(&state);
                    Ok(GameResult::ContinueWithUpdate {
                        payout: -(play_bet as i64),
                    })
                }
                _ => Err(GameError::InvalidMove),
            },
            Stage::River => match action {
                Action::Bet1x => {
                    if state.play_mult != 0 {
                        return Err(GameError::InvalidMove);
                    }
                    let play_bet = session.bet;
                    state.play_mult = 1;
                    state.stage = Stage::AwaitingReveal;
                    session.state_blob = serialize_state(&state);
                    Ok(GameResult::ContinueWithUpdate {
                        payout: -(play_bet as i64),
                    })
                }
                Action::Fold => {
                    // Reveal dealer (optional) and resolve Trips only.
                    draw_into_unknowns(&mut state, rng, true)?;
                    state.play_mult = 0;
                    // Resolve as a showdown with fold semantics (no main-bet returns).
                    let result = resolve_showdown(session, &mut state)?;
                    session.state_blob = serialize_state(&state);
                    Ok(result)
                }
                _ => Err(GameError::InvalidMove),
            },
            Stage::AwaitingReveal => match action {
                Action::Reveal => {
                    if state.play_mult == 0 {
                        return Err(GameError::InvalidMove);
                    }
                    draw_into_unknowns(&mut state, rng, true)?;
                    let result = resolve_showdown(session, &mut state)?;
                    session.state_blob = serialize_state(&state);
                    Ok(result)
                }
                _ => Err(GameError::InvalidMove),
            },
            Stage::Showdown => Err(GameError::GameAlreadyComplete),
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
            game_type: GameType::UltimateHoldem,
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
    fn test_init_starts_in_betting_and_deducts_blind() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        let result = UltimateHoldem::init(&mut session, &mut rng);
        assert!(matches!(
            result,
            GameResult::ContinueWithUpdate { payout: -100 }
        ));

        let state = parse_state(&session.state_blob).expect("Failed to parse state");
        assert_eq!(state.stage, Stage::Betting);
        assert_eq!(state.player, [CARD_UNKNOWN; 2]);
    }

    #[test]
    fn test_set_trips_then_deal() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        UltimateHoldem::init(&mut session, &mut rng);

        // Set Trips to 25
        let mut payload = vec![Action::SetTrips as u8];
        payload.extend_from_slice(&25u64.to_be_bytes());
        let mut rng = GameRng::new(&seed, session.id, 1);
        let res = UltimateHoldem::process_move(&mut session, &payload, &mut rng).unwrap();
        assert!(matches!(
            res,
            GameResult::ContinueWithUpdate { payout: -25 }
        ));

        // Deal
        let mut rng = GameRng::new(&seed, session.id, 2);
        let res =
            UltimateHoldem::process_move(&mut session, &[Action::Deal as u8], &mut rng).unwrap();
        assert!(matches!(res, GameResult::Continue));

        let state = parse_state(&session.state_blob).expect("Failed to parse state");
        assert_eq!(state.stage, Stage::Preflop);
        assert!(state.player.iter().all(|&c| is_known_card(c)));
        assert_eq!(state.trips_bet, 25);
    }

    #[test]
    fn test_trips_refund_on_decrease() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        UltimateHoldem::init(&mut session, &mut rng);

        // Set Trips to 25
        let mut payload = vec![Action::SetTrips as u8];
        payload.extend_from_slice(&25u64.to_be_bytes());
        let mut rng = GameRng::new(&seed, session.id, 1);
        let res = UltimateHoldem::process_move(&mut session, &payload, &mut rng).unwrap();
        assert!(matches!(
            res,
            GameResult::ContinueWithUpdate { payout: -25 }
        ));

        // Set Trips back to 0 (refund)
        let mut payload = vec![Action::SetTrips as u8];
        payload.extend_from_slice(&0u64.to_be_bytes());
        let mut rng = GameRng::new(&seed, session.id, 2);
        let res = UltimateHoldem::process_move(&mut session, &payload, &mut rng).unwrap();
        assert!(matches!(res, GameResult::ContinueWithUpdate { payout: 25 }));

        let state = parse_state(&session.state_blob).expect("Failed to parse state");
        assert_eq!(state.trips_bet, 0);
    }

    #[test]
    fn test_set_six_card_bonus_then_reveal_draws_bonus_cards() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);

        // Init
        let mut rng = GameRng::new(&seed, session.id, 0);
        UltimateHoldem::init(&mut session, &mut rng);

        // Set 6-card bonus to 25
        let mut payload = vec![Action::SetSixCardBonus as u8];
        payload.extend_from_slice(&25u64.to_be_bytes());
        let mut rng = GameRng::new(&seed, session.id, 1);
        let res = UltimateHoldem::process_move(&mut session, &payload, &mut rng).unwrap();
        assert!(matches!(
            res,
            GameResult::ContinueWithUpdate { payout: -25 }
        ));

        // Deal
        let mut rng = GameRng::new(&seed, session.id, 2);
        UltimateHoldem::process_move(&mut session, &[Action::Deal as u8], &mut rng).unwrap();

        // Bet 4x to go to reveal
        let mut rng = GameRng::new(&seed, session.id, 3);
        UltimateHoldem::process_move(&mut session, &[Action::Bet4x as u8], &mut rng).unwrap();

        // Reveal resolves (and should draw bonus cards)
        let mut rng = GameRng::new(&seed, session.id, 4);
        UltimateHoldem::process_move(&mut session, &[Action::Reveal as u8], &mut rng).unwrap();

        let state = parse_state(&session.state_blob).expect("Failed to parse state");
        assert!(state.bonus.iter().all(|&c| is_known_card(c)));
        assert_eq!(state.six_card_bonus_bet, 25);
    }

    #[test]
    fn test_preflop_bet_then_reveal_completes() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);

        // Init
        let mut rng = GameRng::new(&seed, session.id, 0);
        UltimateHoldem::init(&mut session, &mut rng);

        // Deal
        let mut rng = GameRng::new(&seed, session.id, 1);
        UltimateHoldem::process_move(&mut session, &[Action::Deal as u8], &mut rng).unwrap();

        // Bet 4x (deduct play bet)
        let mut rng = GameRng::new(&seed, session.id, 2);
        let res =
            UltimateHoldem::process_move(&mut session, &[Action::Bet4x as u8], &mut rng).unwrap();
        assert!(matches!(
            res,
            GameResult::ContinueWithUpdate { payout: -400 }
        ));

        // Reveal resolves
        let mut rng = GameRng::new(&seed, session.id, 3);
        let res =
            UltimateHoldem::process_move(&mut session, &[Action::Reveal as u8], &mut rng).unwrap();
        assert!(matches!(
            res,
            GameResult::Win(_) | GameResult::LossPreDeducted(_)
        ));
        assert!(session.is_complete);
    }

    #[test]
    fn test_preflop_bet3x_then_reveal_completes() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);

        // Init
        let mut rng = GameRng::new(&seed, session.id, 0);
        UltimateHoldem::init(&mut session, &mut rng);

        // Deal
        let mut rng = GameRng::new(&seed, session.id, 1);
        UltimateHoldem::process_move(&mut session, &[Action::Deal as u8], &mut rng).unwrap();

        // Bet 3x (deduct play bet)
        let mut rng = GameRng::new(&seed, session.id, 2);
        let res =
            UltimateHoldem::process_move(&mut session, &[Action::Bet3x as u8], &mut rng).unwrap();
        assert!(matches!(
            res,
            GameResult::ContinueWithUpdate { payout: -300 }
        ));

        // Reveal resolves
        let mut rng = GameRng::new(&seed, session.id, 3);
        let res =
            UltimateHoldem::process_move(&mut session, &[Action::Reveal as u8], &mut rng).unwrap();
        assert!(matches!(
            res,
            GameResult::Win(_) | GameResult::LossPreDeducted(_)
        ));
        assert!(session.is_complete);
    }

    #[test]
    fn test_check_check_fold_flow() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);

        // Init
        let mut rng = GameRng::new(&seed, session.id, 0);
        UltimateHoldem::init(&mut session, &mut rng);

        // Deal
        let mut rng = GameRng::new(&seed, session.id, 1);
        UltimateHoldem::process_move(&mut session, &[Action::Deal as u8], &mut rng).unwrap();

        // Check to flop
        let mut rng = GameRng::new(&seed, session.id, 2);
        UltimateHoldem::process_move(&mut session, &[Action::Check as u8], &mut rng).unwrap();

        // Check to river
        let mut rng = GameRng::new(&seed, session.id, 3);
        UltimateHoldem::process_move(&mut session, &[Action::Check as u8], &mut rng).unwrap();

        // Fold
        let mut rng = GameRng::new(&seed, session.id, 4);
        let res =
            UltimateHoldem::process_move(&mut session, &[Action::Fold as u8], &mut rng).unwrap();
        assert!(matches!(
            res,
            GameResult::Win(_) | GameResult::LossPreDeducted(_)
        ));
        assert!(session.is_complete);
    }

    #[test]
    fn test_progressive_paytable_examples() {
        // Royal flush: 10♠ J♠ (hole) + Q♠ K♠ A♠ (flop).
        let hole = [9u8, 10u8];
        let flop = [11u8, 12u8, 0u8];
        assert_eq!(
            uth_progressive_return(&hole, &flop, PROGRESSIVE_BET_UNIT),
            UTH_PROGRESSIVE_BASE_JACKPOT
        );

        // Quads: A♠ A♥ (hole) + A♦ A♣ 2♠ (flop).
        let hole = [0u8, 13u8];
        let flop = [26u8, 39u8, 1u8];
        assert_eq!(
            uth_progressive_return(&hole, &flop, PROGRESSIVE_BET_UNIT),
            300
        );
    }
}
