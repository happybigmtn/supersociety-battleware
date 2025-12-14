//! Three Card Poker implementation.
//!
//! This implementation supports:
//! - Ante (`session.bet`, deducted by CasinoStartGame)
//! - Optional Pairplus side bet (placed before deal)
//! - Optional 6-card bonus side bet (placed before deal)
//! - Optional Progressive side bet (placed before deal; WoO Progressive v2A, for-one)
//! - Play/Fold decision (Play bet equals Ante; charged before reveal)
//! - Dealer qualification: Q-6-4 or better (per WoO)
//! - Ante bonus (pay table #1: SF 5, Trips 4, Straight 1), paid when player plays
//!
//! State blob format:
//! v3 (32 bytes):
//! [version:u8=3]
//! [stage:u8]
//! [playerCard1:u8] [playerCard2:u8] [playerCard3:u8]   (0xFF if not dealt yet)
//! [dealerCard1:u8] [dealerCard2:u8] [dealerCard3:u8]   (0xFF if unrevealed)
//! [pairplusBetAmount:u64 BE]
//! [sixCardBonusBetAmount:u64 BE]
//! [progressiveBetAmount:u64 BE]
//!
//! v2 (24 bytes):
//! [version:u8=2]
//! [stage:u8]
//! [playerCard1:u8] [playerCard2:u8] [playerCard3:u8]   (0xFF if not dealt yet)
//! [dealerCard1:u8] [dealerCard2:u8] [dealerCard3:u8]   (0xFF if unrevealed)
//! [pairplusBetAmount:u64 BE]
//! [sixCardBonusBetAmount:u64 BE]
//!
//! v1 (legacy, 16 bytes):
//! [version:u8=1]
//! [stage:u8]
//! [playerCard1:u8] [playerCard2:u8] [playerCard3:u8]
//! [dealerCard1:u8] [dealerCard2:u8] [dealerCard3:u8]
//! [pairplusBetAmount:u64 BE]
//!
//! Stages:
//! 0 = Betting (optional Pairplus, then Deal)
//! 1 = Decision (player cards dealt; Play/Fold)
//! 2 = AwaitingReveal (Play bet deducted; Reveal resolves)
//! 3 = Complete
//!
//! Payload format:
//! [move:u8] [optional amount:u64 BE]
//! 0 = Play
//! 1 = Fold
//! 2 = Deal (optional u64 = Pairplus bet)
//! 3 = Set Pairplus bet (u64)
//! 4 = Reveal
//! 5 = Set 6-Card Bonus bet (u64)
//! 6 = Set Progressive bet (u64)

use super::super_mode::apply_super_multiplier_cards;
use super::{CasinoGame, GameError, GameResult, GameRng};
use nullspace_types::casino::{GameSession, THREE_CARD_PROGRESSIVE_BASE_JACKPOT};

const STATE_VERSION_V1: u8 = 1;
const STATE_VERSION_V2: u8 = 2;
const STATE_VERSION_V3: u8 = 3;
const CARD_UNKNOWN: u8 = 0xFF;
const STATE_LEN_V1: usize = 16;
const STATE_LEN_V2: usize = 24;
const STATE_LEN_V3: usize = 32;

const PROGRESSIVE_BET_UNIT: u64 = 1;

/// Three Card Poker stages.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Betting = 0,
    Decision = 1,
    AwaitingReveal = 2,
    Complete = 3,
}

impl TryFrom<u8> for Stage {
    type Error = GameError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Stage::Betting),
            1 => Ok(Stage::Decision),
            2 => Ok(Stage::AwaitingReveal),
            3 => Ok(Stage::Complete),
            _ => Err(GameError::InvalidPayload),
        }
    }
}

/// Player moves.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Move {
    Play = 0,
    Fold = 1,
    Deal = 2,
    SetPairPlus = 3,
    Reveal = 4,
    SetSixCardBonus = 5,
    SetProgressive = 6,
}

impl TryFrom<u8> for Move {
    type Error = GameError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Move::Play),
            1 => Ok(Move::Fold),
            2 => Ok(Move::Deal),
            3 => Ok(Move::SetPairPlus),
            4 => Ok(Move::Reveal),
            5 => Ok(Move::SetSixCardBonus),
            6 => Ok(Move::SetProgressive),
            _ => Err(GameError::InvalidPayload),
        }
    }
}

/// Three card hand rankings (higher is better).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum HandRank {
    HighCard = 0,
    Pair = 1,
    Flush = 2,
    Straight = 3,
    ThreeOfAKind = 4,
    StraightFlush = 5,
}

/// Get card rank (2-14, Ace = 14 for comparison).
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

/// Evaluate a 3-card hand, returns (HandRank, high cards for tiebreaker).
pub fn evaluate_hand(cards: &[u8; 3]) -> (HandRank, [u8; 3]) {
    let mut ranks: Vec<u8> = cards.iter().map(|&c| card_rank(c)).collect();
    ranks.sort_unstable_by(|a, b| b.cmp(a)); // Descending
    let high_cards = [ranks[0], ranks[1], ranks[2]];

    let suits: Vec<u8> = cards.iter().map(|&c| card_suit(c)).collect();
    let is_flush = suits[0] == suits[1] && suits[1] == suits[2];

    // Check straight (including A-2-3)
    let mut sorted_ranks = ranks.clone();
    sorted_ranks.sort_unstable();
    let is_straight = {
        let r = &sorted_ranks;
        (r[2] - r[0] == 2 && r[1] - r[0] == 1) || (sorted_ranks == vec![2, 3, 14])
    };

    let is_trips = ranks[0] == ranks[1] && ranks[1] == ranks[2];
    let is_pair = ranks[0] == ranks[1] || ranks[1] == ranks[2] || ranks[0] == ranks[2];

    let hand_rank = if is_straight && is_flush {
        HandRank::StraightFlush
    } else if is_trips {
        HandRank::ThreeOfAKind
    } else if is_straight {
        HandRank::Straight
    } else if is_flush {
        HandRank::Flush
    } else if is_pair {
        HandRank::Pair
    } else {
        HandRank::HighCard
    };

    (hand_rank, high_cards)
}

fn compare_hands(h1: &(HandRank, [u8; 3]), h2: &(HandRank, [u8; 3])) -> std::cmp::Ordering {
    match h1.0.cmp(&h2.0) {
        std::cmp::Ordering::Equal => h1.1.cmp(&h2.1),
        other => other,
    }
}

fn ante_bonus_multiplier(hand_rank: HandRank) -> u64 {
    match hand_rank {
        HandRank::StraightFlush => 5,
        HandRank::ThreeOfAKind => 4,
        HandRank::Straight => 1,
        _ => 0,
    }
}

fn pairplus_multiplier(hand_rank: HandRank) -> u64 {
    match hand_rank {
        HandRank::StraightFlush => 40,
        HandRank::ThreeOfAKind => 30,
        HandRank::Straight => 6,
        HandRank::Flush => 3,
        HandRank::Pair => 1,
        _ => 0,
    }
}

fn dealer_qualifies(dealer_hand: &(HandRank, [u8; 3])) -> bool {
    if dealer_hand.0 >= HandRank::Pair {
        return true;
    }
    // High-card qualification threshold: Q-6-4.
    dealer_hand.1 >= [12, 6, 4]
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TcState {
    stage: Stage,
    player: [u8; 3],
    dealer: [u8; 3],
    pairplus_bet: u64,
    six_card_bonus_bet: u64,
    progressive_bet: u64,
}

fn parse_state(state: &[u8]) -> Option<TcState> {
    if state.len() == STATE_LEN_V1 && state[0] == STATE_VERSION_V1 {
        let stage = Stage::try_from(state[1]).ok()?;
        let player = [state[2], state[3], state[4]];
        let dealer = [state[5], state[6], state[7]];
        let pairplus_bet = u64::from_be_bytes(state[8..16].try_into().ok()?);
        return Some(TcState {
            stage,
            player,
            dealer,
            pairplus_bet,
            six_card_bonus_bet: 0,
            progressive_bet: 0,
        });
    }

    if state.len() == STATE_LEN_V2 && state[0] == STATE_VERSION_V2 {
        let stage = Stage::try_from(state[1]).ok()?;
        let player = [state[2], state[3], state[4]];
        let dealer = [state[5], state[6], state[7]];
        let pairplus_bet = u64::from_be_bytes(state[8..16].try_into().ok()?);
        let six_card_bonus_bet = u64::from_be_bytes(state[16..24].try_into().ok()?);
        return Some(TcState {
            stage,
            player,
            dealer,
            pairplus_bet,
            six_card_bonus_bet,
            progressive_bet: 0,
        });
    }

    if state.len() == STATE_LEN_V3 && state[0] == STATE_VERSION_V3 {
        let stage = Stage::try_from(state[1]).ok()?;
        let player = [state[2], state[3], state[4]];
        let dealer = [state[5], state[6], state[7]];
        let pairplus_bet = u64::from_be_bytes(state[8..16].try_into().ok()?);
        let six_card_bonus_bet = u64::from_be_bytes(state[16..24].try_into().ok()?);
        let progressive_bet = u64::from_be_bytes(state[24..32].try_into().ok()?);
        return Some(TcState {
            stage,
            player,
            dealer,
            pairplus_bet,
            six_card_bonus_bet,
            progressive_bet,
        });
    }

    None
}

fn serialize_state(state: &TcState) -> Vec<u8> {
    let mut out = Vec::with_capacity(STATE_LEN_V3);
    out.push(STATE_VERSION_V3);
    out.push(state.stage as u8);
    out.extend_from_slice(&state.player);
    out.extend_from_slice(&state.dealer);
    out.extend_from_slice(&state.pairplus_bet.to_be_bytes());
    out.extend_from_slice(&state.six_card_bonus_bet.to_be_bytes());
    out.extend_from_slice(&state.progressive_bet.to_be_bytes());
    out
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

fn apply_pairplus_update(state: &mut TcState, new_bet: u64) -> Result<i64, GameError> {
    let old = state.pairplus_bet as i128;
    let new = new_bet as i128;
    let delta = new - old;
    if delta > i64::MAX as i128 || delta < i64::MIN as i128 {
        return Err(GameError::InvalidMove);
    }
    state.pairplus_bet = new_bet;
    Ok(-(delta as i64))
}

fn apply_six_card_bonus_update(state: &mut TcState, new_bet: u64) -> Result<i64, GameError> {
    let old = state.six_card_bonus_bet as i128;
    let new = new_bet as i128;
    let delta = new - old;
    if delta > i64::MAX as i128 || delta < i64::MIN as i128 {
        return Err(GameError::InvalidMove);
    }
    state.six_card_bonus_bet = new_bet;
    Ok(-(delta as i64))
}

fn apply_progressive_update(state: &mut TcState, new_bet: u64) -> Result<i64, GameError> {
    let old = state.progressive_bet as i128;
    let new = new_bet as i128;
    let delta = new - old;
    if delta > i64::MAX as i128 || delta < i64::MIN as i128 {
        return Err(GameError::InvalidMove);
    }
    state.progressive_bet = new_bet;
    Ok(-(delta as i64))
}

fn is_known_card(card: u8) -> bool {
    card < 52
}

fn resolve_pairplus_return(player_cards: &[u8; 3], pairplus_bet: u64) -> u64 {
    if pairplus_bet == 0 {
        return 0;
    }
    let player_hand = evaluate_hand(player_cards);
    let mult = pairplus_multiplier(player_hand.0);
    if mult == 0 {
        0
    } else {
        pairplus_bet.saturating_mul(mult.saturating_add(1))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum SixCardBonusRank {
    None = 0,
    ThreeOfAKind = 1,
    Straight = 2,
    Flush = 3,
    FullHouse = 4,
    FourOfAKind = 5,
    StraightFlush = 6,
    RoyalFlush = 7,
}

fn evaluate_5_card_bonus_rank(cards: &[u8; 5]) -> SixCardBonusRank {
    let mut ranks = [0u8; 5];
    let mut suits = [0u8; 5];
    for i in 0..5 {
        ranks[i] = card_rank(cards[i]);
        suits[i] = card_suit(cards[i]);
    }

    ranks.sort_unstable_by(|a, b| b.cmp(a));

    let is_flush = suits[0] == suits[1]
        && suits[1] == suits[2]
        && suits[2] == suits[3]
        && suits[3] == suits[4];

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

    if is_royal && is_flush {
        SixCardBonusRank::RoyalFlush
    } else if is_straight && is_flush {
        SixCardBonusRank::StraightFlush
    } else if has_quads {
        SixCardBonusRank::FourOfAKind
    } else if has_trips && pair_count >= 1 {
        SixCardBonusRank::FullHouse
    } else if is_flush {
        SixCardBonusRank::Flush
    } else if is_straight {
        SixCardBonusRank::Straight
    } else if has_trips {
        SixCardBonusRank::ThreeOfAKind
    } else {
        SixCardBonusRank::None
    }
}

fn evaluate_best_5_of_6_bonus_rank(cards: &[u8; 6]) -> SixCardBonusRank {
    let mut best = SixCardBonusRank::None;
    for skip in 0..6 {
        let mut hand = [0u8; 5];
        let mut idx = 0;
        for (i, &c) in cards.iter().enumerate() {
            if i == skip {
                continue;
            }
            hand[idx] = c;
            idx += 1;
        }
        let rank = evaluate_5_card_bonus_rank(&hand);
        if rank > best {
            best = rank;
        }
    }
    best
}

fn six_card_bonus_multiplier(rank: SixCardBonusRank) -> u64 {
    // WoO 6-Card Bonus, Version 1-A.
    match rank {
        SixCardBonusRank::RoyalFlush => 1000,
        SixCardBonusRank::StraightFlush => 200,
        SixCardBonusRank::FourOfAKind => 100,
        SixCardBonusRank::FullHouse => 20,
        SixCardBonusRank::Flush => 15,
        SixCardBonusRank::Straight => 10,
        SixCardBonusRank::ThreeOfAKind => 7,
        SixCardBonusRank::None => 0,
    }
}

fn resolve_six_card_bonus_return(player_cards: &[u8; 3], dealer_cards: &[u8; 3], bet: u64) -> u64 {
    if bet == 0 {
        return 0;
    }
    let cards = [
        player_cards[0],
        player_cards[1],
        player_cards[2],
        dealer_cards[0],
        dealer_cards[1],
        dealer_cards[2],
    ];
    let rank = evaluate_best_5_of_6_bonus_rank(&cards);
    let mult = six_card_bonus_multiplier(rank);
    if mult == 0 {
        0
    } else {
        bet.saturating_mul(mult.saturating_add(1))
    }
}

fn resolve_progressive_return(player_cards: &[u8; 3], progressive_bet: u64) -> u64 {
    if progressive_bet == 0 {
        return 0;
    }
    let player_hand = evaluate_hand(player_cards);
    match player_hand.0 {
        HandRank::StraightFlush => {
            // Mini-royal is A-K-Q suited.
            if player_hand.1 == [14, 13, 12] {
                let is_spades = player_cards.iter().all(|&c| card_suit(c) == 0);
                if is_spades {
                    progressive_bet.saturating_mul(THREE_CARD_PROGRESSIVE_BASE_JACKPOT)
                } else {
                    progressive_bet.saturating_mul(500)
                }
            } else {
                progressive_bet.saturating_mul(70)
            }
        }
        HandRank::ThreeOfAKind => progressive_bet.saturating_mul(60),
        HandRank::Straight => progressive_bet.saturating_mul(6),
        _ => 0,
    }
}

pub struct ThreeCardPoker;

impl CasinoGame for ThreeCardPoker {
    fn init(session: &mut GameSession, _rng: &mut GameRng) -> GameResult {
        // Start in a betting stage so Pairplus can be placed before any cards are dealt.
        let state = TcState {
            stage: Stage::Betting,
            player: [CARD_UNKNOWN; 3],
            dealer: [CARD_UNKNOWN; 3],
            pairplus_bet: 0,
            six_card_bonus_bet: 0,
            progressive_bet: 0,
        };
        session.state_blob = serialize_state(&state);
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

        let mv = Move::try_from(payload[0])?;
        let mut state = parse_state(&session.state_blob).ok_or(GameError::InvalidPayload)?;

        match state.stage {
            Stage::Betting => match mv {
                Move::SetPairPlus => {
                    let new_bet = parse_u64_be(payload, 1)?;
                    let payout = apply_pairplus_update(&mut state, new_bet)?;
                    session.state_blob = serialize_state(&state);
                    Ok(if payout == 0 {
                        GameResult::Continue
                    } else {
                        GameResult::ContinueWithUpdate { payout }
                    })
                }
                Move::Deal => {
                    if is_known_card(state.player[0]) {
                        return Err(GameError::InvalidMove);
                    }

                    let mut payout_update: i64 = 0;
                    if payload.len() == 9 {
                        let new_bet = parse_u64_be(payload, 1)?;
                        payout_update = apply_pairplus_update(&mut state, new_bet)?;
                    } else if payload.len() != 1 {
                        return Err(GameError::InvalidPayload);
                    }

                    let mut deck = rng.create_deck();
                    state.player[0] = rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
                    state.player[1] = rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
                    state.player[2] = rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
                    state.stage = Stage::Decision;

                    session.state_blob = serialize_state(&state);
                    Ok(if payout_update == 0 {
                        GameResult::Continue
                    } else {
                        GameResult::ContinueWithUpdate {
                            payout: payout_update,
                        }
                    })
                }
                Move::SetSixCardBonus => {
                    let new_bet = parse_u64_be(payload, 1)?;
                    let payout = apply_six_card_bonus_update(&mut state, new_bet)?;
                    session.state_blob = serialize_state(&state);
                    Ok(if payout == 0 {
                        GameResult::Continue
                    } else {
                        GameResult::ContinueWithUpdate { payout }
                    })
                }
                Move::SetProgressive => {
                    let new_bet = parse_u64_be(payload, 1)?;
                    if new_bet != 0 && new_bet != PROGRESSIVE_BET_UNIT {
                        return Err(GameError::InvalidMove);
                    }
                    let payout = apply_progressive_update(&mut state, new_bet)?;
                    session.state_blob = serialize_state(&state);
                    Ok(if payout == 0 {
                        GameResult::Continue
                    } else {
                        GameResult::ContinueWithUpdate { payout }
                    })
                }
                _ => Err(GameError::InvalidMove),
            },
            Stage::Decision => match mv {
                Move::Fold => {
                    // Fold: lose ante, Pairplus still resolves.
                    // Reveal dealer cards for display.
                    let used = state.player.to_vec();
                    let mut deck = rng.create_deck_excluding(&used);
                    state.dealer[0] = rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
                    state.dealer[1] = rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
                    state.dealer[2] = rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
                    state.stage = Stage::Complete;
                    session.is_complete = true;

                    let pairplus_return =
                        resolve_pairplus_return(&state.player, state.pairplus_bet);
                    let six_card_return = resolve_six_card_bonus_return(
                        &state.player,
                        &state.dealer,
                        state.six_card_bonus_bet,
                    );
                    let progressive_return =
                        resolve_progressive_return(&state.player, state.progressive_bet);
                    let mut total_return = pairplus_return
                        .saturating_add(six_card_return)
                        .saturating_add(progressive_return);

                    if session.super_mode.is_active && total_return > 0 {
                        total_return = apply_super_multiplier_cards(
                            &state.player,
                            &session.super_mode.multipliers,
                            total_return,
                        );
                    }

                    let total_wagered = session
                        .bet
                        .saturating_add(state.pairplus_bet)
                        .saturating_add(state.six_card_bonus_bet)
                        .saturating_add(state.progressive_bet);

                    session.state_blob = serialize_state(&state);

                    if total_return == 0 {
                        Ok(GameResult::LossPreDeducted(total_wagered))
                    } else {
                        Ok(GameResult::Win(total_return))
                    }
                }
                Move::Play => {
                    // Charge Play bet (equal to ante) now; resolve on Reveal.
                    state.stage = Stage::AwaitingReveal;
                    session.state_blob = serialize_state(&state);
                    Ok(GameResult::ContinueWithUpdate {
                        payout: -(session.bet as i64),
                    })
                }
                _ => Err(GameError::InvalidMove),
            },
            Stage::AwaitingReveal => match mv {
                Move::Reveal => {
                    // Reveal dealer cards and resolve all bets.
                    let used = state.player.to_vec();
                    let mut deck = rng.create_deck_excluding(&used);
                    state.dealer[0] = rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
                    state.dealer[1] = rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
                    state.dealer[2] = rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
                    state.stage = Stage::Complete;
                    session.is_complete = true;

                    let player_hand = evaluate_hand(&state.player);
                    let dealer_hand = evaluate_hand(&state.dealer);
                    let dealer_ok = dealer_qualifies(&dealer_hand);

                    let pairplus_return =
                        resolve_pairplus_return(&state.player, state.pairplus_bet);
                    let six_card_return = resolve_six_card_bonus_return(
                        &state.player,
                        &state.dealer,
                        state.six_card_bonus_bet,
                    );
                    let progressive_return =
                        resolve_progressive_return(&state.player, state.progressive_bet);

                    // Ante bonus is paid when the player plays, regardless of dealer qualification/outcome.
                    let ante_bonus = session
                        .bet
                        .saturating_mul(ante_bonus_multiplier(player_hand.0));

                    // Main bets: Ante (already deducted) and Play (deducted on Play move).
                    let mut main_return: u64 = 0;
                    if !dealer_ok {
                        // Dealer doesn't qualify: Ante wins 1:1, Play pushes.
                        main_return = main_return
                            .saturating_add(session.bet.saturating_mul(2))
                            .saturating_add(session.bet);
                    } else {
                        match compare_hands(&player_hand, &dealer_hand) {
                            std::cmp::Ordering::Greater => {
                                main_return = main_return
                                    .saturating_add(session.bet.saturating_mul(2))
                                    .saturating_add(session.bet.saturating_mul(2));
                            }
                            std::cmp::Ordering::Equal => {
                                main_return = main_return
                                    .saturating_add(session.bet)
                                    .saturating_add(session.bet);
                            }
                            std::cmp::Ordering::Less => {
                                // Lose both.
                            }
                        }
                    }

                    let mut total_return = pairplus_return
                        .saturating_add(main_return)
                        .saturating_add(ante_bonus)
                        .saturating_add(six_card_return)
                        .saturating_add(progressive_return);

                    if session.super_mode.is_active && total_return > 0 {
                        total_return = apply_super_multiplier_cards(
                            &state.player,
                            &session.super_mode.multipliers,
                            total_return,
                        );
                    }

                    let total_wagered = session
                        .bet
                        .saturating_mul(2)
                        .saturating_add(state.pairplus_bet)
                        .saturating_add(state.six_card_bonus_bet)
                        .saturating_add(state.progressive_bet);

                    session.state_blob = serialize_state(&state);

                    if total_return == 0 {
                        Ok(GameResult::LossPreDeducted(total_wagered))
                    } else {
                        Ok(GameResult::Win(total_return))
                    }
                }
                _ => Err(GameError::InvalidMove),
            },
            Stage::Complete => Err(GameError::GameAlreadyComplete),
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
            game_type: GameType::ThreeCard,
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
    fn test_dealer_qualification_threshold() {
        // Q-6-4 qualifies; Q-6-3 does not.
        let qualifies = dealer_qualifies(&(HandRank::HighCard, [12, 6, 4]));
        assert!(qualifies);
        let qualifies = dealer_qualifies(&(HandRank::HighCard, [12, 6, 3]));
        assert!(!qualifies);
    }

    #[test]
    fn test_pairplus_multiplier_table() {
        assert_eq!(pairplus_multiplier(HandRank::StraightFlush), 40);
        assert_eq!(pairplus_multiplier(HandRank::ThreeOfAKind), 30);
        assert_eq!(pairplus_multiplier(HandRank::Straight), 6);
        assert_eq!(pairplus_multiplier(HandRank::Flush), 3);
        assert_eq!(pairplus_multiplier(HandRank::Pair), 1);
        assert_eq!(pairplus_multiplier(HandRank::HighCard), 0);
    }

    #[test]
    fn test_basic_flow_deal_play_reveal() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);

        // Init
        let mut rng = GameRng::new(&seed, session.id, 0);
        ThreeCardPoker::init(&mut session, &mut rng);

        // Deal (no pairplus)
        let mut rng = GameRng::new(&seed, session.id, 1);
        ThreeCardPoker::process_move(&mut session, &[Move::Deal as u8], &mut rng).unwrap();

        // Play (deduct play bet)
        let mut rng = GameRng::new(&seed, session.id, 2);
        let res =
            ThreeCardPoker::process_move(&mut session, &[Move::Play as u8], &mut rng).unwrap();
        assert!(matches!(
            res,
            GameResult::ContinueWithUpdate { payout: -100 }
        ));

        // Reveal resolves
        let mut rng = GameRng::new(&seed, session.id, 3);
        let res =
            ThreeCardPoker::process_move(&mut session, &[Move::Reveal as u8], &mut rng).unwrap();
        assert!(matches!(
            res,
            GameResult::Win(_) | GameResult::LossPreDeducted(_)
        ));
        assert!(session.is_complete);
    }

    #[test]
    fn test_six_card_bonus_multiplier_examples() {
        // Royal flush in diamonds + junk.
        let cards = [26u8, 35u8, 36u8, 37u8, 38u8, 0u8];
        assert_eq!(
            evaluate_best_5_of_6_bonus_rank(&cards),
            SixCardBonusRank::RoyalFlush
        );
        assert_eq!(
            six_card_bonus_multiplier(SixCardBonusRank::RoyalFlush),
            1000
        );

        // Quads (four aces) + junk.
        let cards = [0u8, 13u8, 26u8, 39u8, 1u8, 2u8]; // A♠ A♥ A♦ A♣ 2♠ 3♠
        assert_eq!(
            evaluate_best_5_of_6_bonus_rank(&cards),
            SixCardBonusRank::FourOfAKind
        );
        assert_eq!(
            six_card_bonus_multiplier(SixCardBonusRank::FourOfAKind),
            100
        );
    }

    #[test]
    fn test_progressive_paytable_examples() {
        // Mini-royal in spades: A♠ K♠ Q♠.
        let player = [0u8, 12u8, 11u8];
        assert_eq!(
            resolve_progressive_return(&player, PROGRESSIVE_BET_UNIT),
            THREE_CARD_PROGRESSIVE_BASE_JACKPOT
        );

        // Mini-royal in hearts: A♥ K♥ Q♥.
        let player = [13u8, 25u8, 24u8];
        assert_eq!(
            resolve_progressive_return(&player, PROGRESSIVE_BET_UNIT),
            500
        );

        // Straight flush: 2♠ 3♠ 4♠.
        let player = [1u8, 2u8, 3u8];
        assert_eq!(
            resolve_progressive_return(&player, PROGRESSIVE_BET_UNIT),
            70
        );

        // Trips: 5♠ 5♥ 5♦.
        let player = [4u8, 17u8, 30u8];
        assert_eq!(
            resolve_progressive_return(&player, PROGRESSIVE_BET_UNIT),
            60
        );

        // Straight: 2♠ 3♥ 4♦.
        let player = [1u8, 15u8, 29u8];
        assert_eq!(resolve_progressive_return(&player, PROGRESSIVE_BET_UNIT), 6);
    }
}
