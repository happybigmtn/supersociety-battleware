//! Blackjack game implementation.
//!
//! This implementation supports:
//! - Standard blackjack main wager (`session.bet`, deducted by `CasinoStartGame`)
//! - Splits (up to 4 hands) + doubles (deducted via `ContinueWithUpdate`)
//! - 21+3 side bet (optional, placed before deal)
//!
//! House rules (executor):
//! - 8-deck shoe, dealer hits soft 17 (H17)
//! - No surrender, no on-chain insurance
//! - No dealer peek (dealer hole card is drawn at `Reveal` for hidden-info safety)
//!
//! State blob format (v2):
//! [version:u8=2]
//! [stage:u8]
//! [sideBet21Plus3Amount:u64 BE]
//! [initialPlayerCard1:u8] [initialPlayerCard2:u8]   (0xFF if not dealt yet)
//! [active_hand_idx:u8]
//! [hand_count:u8]
//! ... per hand:
//!   [bet_mult:u8] (1=base, 2=doubled)
//!   [status:u8] (0=playing, 1=stand, 2=bust, 3=blackjack)
//!   [was_split:u8] (0/1; split hands cannot be a natural blackjack)
//!   [card_count:u8]
//!   [cards...]
//! [dealer_count:u8] [dealer_cards...]
//!
//! Stages:
//! 0 = Betting (optional 21+3, then Deal)
//! 1 = PlayerTurn
//! 2 = AwaitingReveal (player done; Reveal resolves)
//! 3 = Complete
//!
//! Payload format:
//! [move:u8] [optional amount:u64 BE]
//! 0 = Hit
//! 1 = Stand
//! 2 = Double Down
//! 3 = Split
//! 4 = Deal
//! 5 = Set 21+3 side bet (u64)
//! 6 = Reveal

use super::super_mode::apply_super_multiplier_cards;
use super::{CasinoGame, GameError, GameResult, GameRng};
use nullspace_types::casino::GameSession;

/// Maximum cards in a blackjack hand.
const MAX_HAND_SIZE: usize = 11;
/// Maximum number of hands allowed (splits).
const MAX_HANDS: usize = 4;
const STATE_VERSION: u8 = 2;
const CARD_UNKNOWN: u8 = 0xFF;
/// WoO notes blackjack is commonly dealt from multi-deck shoes; we use 8 decks.
const BLACKJACK_DECKS: u8 = 8;

/// Blackjack game stages
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Betting = 0,
    PlayerTurn = 1,
    AwaitingReveal = 2,
    Complete = 3,
}

impl TryFrom<u8> for Stage {
    type Error = GameError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Stage::Betting),
            1 => Ok(Stage::PlayerTurn),
            2 => Ok(Stage::AwaitingReveal),
            3 => Ok(Stage::Complete),
            _ => Err(GameError::InvalidPayload),
        }
    }
}

/// Blackjack move types
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Move {
    Hit = 0,
    Stand = 1,
    Double = 2,
    Split = 3,
    Deal = 4,
    Set21Plus3 = 5,
    Reveal = 6,
}

impl TryFrom<u8> for Move {
    type Error = GameError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Move::Hit),
            1 => Ok(Move::Stand),
            2 => Ok(Move::Double),
            3 => Ok(Move::Split),
            4 => Ok(Move::Deal),
            5 => Ok(Move::Set21Plus3),
            6 => Ok(Move::Reveal),
            _ => Err(GameError::InvalidPayload),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HandStatus {
    Playing = 0,
    Standing = 1,
    Busted = 2,
    Blackjack = 3,
}

impl TryFrom<u8> for HandStatus {
    type Error = GameError;
    fn try_from(v: u8) -> Result<Self, Self::Error> {
        match v {
            0 => Ok(HandStatus::Playing),
            1 => Ok(HandStatus::Standing),
            2 => Ok(HandStatus::Busted),
            3 => Ok(HandStatus::Blackjack),
            _ => Err(GameError::InvalidPayload),
        }
    }
}

#[derive(Clone, Debug)]
pub struct HandState {
    pub cards: Vec<u8>,
    pub bet_mult: u8,
    pub status: HandStatus,
    pub was_split: bool,
}

/// Game state structure
pub struct BlackjackState {
    pub stage: Stage,
    pub side_bet_21plus3: u64,
    pub initial_player_cards: [u8; 2],
    pub active_hand_idx: usize,
    pub hands: Vec<HandState>,
    pub dealer_cards: Vec<u8>,
}

/// Calculate the value of a blackjack hand.
pub fn hand_value(cards: &[u8]) -> (u8, bool) {
    let mut value: u16 = 0;
    let mut aces: u8 = 0;

    for &card in cards {
        let rank = (card % 13) + 1; // 1=Ace, 2-10, 11=J, 12=Q, 13=K
        if rank == 1 {
            aces += 1;
            value += 11;
        } else if rank >= 10 {
            value += 10;
        } else {
            value += rank as u16;
        }
    }

    while value > 21 && aces > 0 {
        value -= 10;
        aces -= 1;
    }

    let is_soft = aces > 0 && value <= 21;
    (value.min(255) as u8, is_soft)
}

/// Check if hand is a blackjack (21 with 2 cards).
pub fn is_blackjack(cards: &[u8]) -> bool {
    cards.len() == 2 && hand_value(cards).0 == 21
}

fn is_natural_blackjack(hand: &HandState) -> bool {
    !hand.was_split && is_blackjack(&hand.cards)
}

/// Get card rank (0-12).
fn card_rank(card: u8) -> u8 {
    card % 13
}

fn card_rank_ace_high(card: u8) -> u8 {
    let r = (card % 13) + 1;
    if r == 1 {
        14
    } else {
        r
    }
}

fn card_suit(card: u8) -> u8 {
    card / 13
}

fn is_21plus3_straight(ranks: &mut [u8; 3]) -> bool {
    ranks.sort_unstable();
    let is_wheel = *ranks == [2, 3, 14];
    let is_run = ranks[1] == ranks[0].saturating_add(1) && ranks[2] == ranks[1].saturating_add(1);
    is_wheel || is_run
}

fn eval_21plus3_multiplier(cards: [u8; 3]) -> u64 {
    // WoO 21+3 "Version 4" / "Xtreme" pay table: 30-20-10-5 (to-1).
    // https://wizardofodds.com/games/blackjack/side-bets/21plus3/
    let suits = [
        card_suit(cards[0]),
        card_suit(cards[1]),
        card_suit(cards[2]),
    ];
    let is_flush = suits[0] == suits[1] && suits[1] == suits[2];

    let r1 = card_rank(cards[0]);
    let r2 = card_rank(cards[1]);
    let r3 = card_rank(cards[2]);
    let is_trips = r1 == r2 && r2 == r3;

    let mut ranks = [
        card_rank_ace_high(cards[0]),
        card_rank_ace_high(cards[1]),
        card_rank_ace_high(cards[2]),
    ];
    let is_straight = is_21plus3_straight(&mut ranks);

    match (is_straight, is_flush, is_trips) {
        (_, _, true) => 20,
        (true, true, false) => 30,
        (true, false, false) => 10,
        (false, true, false) => 5,
        _ => 0,
    }
}

fn resolve_21plus3_return(state: &BlackjackState) -> u64 {
    let bet = state.side_bet_21plus3;
    if bet == 0 {
        return 0;
    }
    if !state.initial_player_cards.iter().all(|&c| c < 52) {
        return 0;
    }
    let dealer_up = match state.dealer_cards.first().copied() {
        Some(c) if c < 52 => c,
        _ => return 0,
    };
    let cards = [
        state.initial_player_cards[0],
        state.initial_player_cards[1],
        dealer_up,
    ];
    let mult = eval_21plus3_multiplier(cards);
    if mult == 0 {
        0
    } else {
        bet.saturating_mul(mult.saturating_add(1))
    }
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

fn apply_21plus3_update(state: &mut BlackjackState, new_bet: u64) -> Result<i64, GameError> {
    let old = state.side_bet_21plus3 as i128;
    let new = new_bet as i128;
    let delta = new.saturating_sub(old);
    if delta > i64::MAX as i128 || delta < i64::MIN as i128 {
        return Err(GameError::InvalidMove);
    }
    state.side_bet_21plus3 = new_bet;
    Ok(-(delta as i64))
}

/// Serialize state to blob.
fn serialize_state(state: &BlackjackState) -> Vec<u8> {
    let mut blob = Vec::new();
    blob.push(STATE_VERSION);
    blob.push(state.stage as u8);
    blob.extend_from_slice(&state.side_bet_21plus3.to_be_bytes());
    blob.push(state.initial_player_cards[0]);
    blob.push(state.initial_player_cards[1]);
    blob.push(state.active_hand_idx as u8);
    blob.push(state.hands.len() as u8);

    for hand in &state.hands {
        blob.push(hand.bet_mult);
        blob.push(hand.status as u8);
        blob.push(hand.was_split as u8);
        blob.push(hand.cards.len() as u8);
        blob.extend_from_slice(&hand.cards);
    }

    blob.push(state.dealer_cards.len() as u8);
    blob.extend_from_slice(&state.dealer_cards);
    blob
}

/// Parse state from blob.
fn parse_state(blob: &[u8]) -> Option<BlackjackState> {
    if blob.len() < 14 {
        return None;
    }

    if blob[0] != STATE_VERSION {
        return None;
    }

    let stage = Stage::try_from(blob[1]).ok()?;
    let mut idx = 2;
    let side_bet_21plus3 = u64::from_be_bytes(blob[idx..idx + 8].try_into().ok()?);
    idx += 8;

    let initial_player_cards = [blob[idx], blob[idx + 1]];
    idx += 2;

    let active_hand_idx = blob[idx] as usize;
    idx += 1;

    let hand_count = blob[idx] as usize;
    idx += 1;
    if hand_count > MAX_HANDS {
        return None;
    }

    let mut hands = Vec::with_capacity(hand_count);
    for _ in 0..hand_count {
        if idx + 4 > blob.len() {
            return None;
        }
        let bet_mult = blob[idx];
        let status = HandStatus::try_from(blob[idx + 1]).ok()?;
        let was_split = blob[idx + 2] != 0;
        let c_len = blob[idx + 3] as usize;
        idx += 4;

        if c_len > MAX_HAND_SIZE || idx + c_len > blob.len() {
            return None;
        }
        let cards = blob[idx..idx + c_len].to_vec();
        idx += c_len;

        hands.push(HandState {
            cards,
            bet_mult,
            status,
            was_split,
        });
    }

    if idx >= blob.len() {
        return None;
    }
    let d_len = blob[idx] as usize;
    idx += 1;

    if d_len > MAX_HAND_SIZE || idx + d_len > blob.len() {
        return None;
    }
    let dealer_cards = blob[idx..idx + d_len].to_vec();
    idx += d_len;

    if idx != blob.len() {
        return None;
    }

    Some(BlackjackState {
        stage,
        side_bet_21plus3,
        initial_player_cards,
        active_hand_idx,
        hands,
        dealer_cards,
    })
}

pub struct Blackjack;

impl CasinoGame for Blackjack {
    fn init(session: &mut GameSession, _rng: &mut GameRng) -> GameResult {
        // Start in a betting stage so side bets can be placed before any cards are dealt.
        let state = BlackjackState {
            stage: Stage::Betting,
            side_bet_21plus3: 0,
            initial_player_cards: [CARD_UNKNOWN; 2],
            active_hand_idx: 0,
            hands: Vec::new(),
            dealer_cards: Vec::new(),
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

        if state.stage == Stage::Complete {
            return Err(GameError::GameAlreadyComplete);
        }

        match state.stage {
            Stage::Betting => match mv {
                Move::Set21Plus3 => {
                    let new_bet = parse_u64_be(payload, 1)?;
                    let payout = apply_21plus3_update(&mut state, new_bet)?;
                    session.state_blob = serialize_state(&state);
                    Ok(if payout == 0 {
                        GameResult::Continue
                    } else {
                        GameResult::ContinueWithUpdate { payout }
                    })
                }
                Move::Deal => {
                    if payload.len() != 1 {
                        return Err(GameError::InvalidPayload);
                    }
                    if !state.hands.is_empty() || !state.dealer_cards.is_empty() {
                        return Err(GameError::InvalidMove);
                    }

                    let mut deck = rng.create_shoe(BLACKJACK_DECKS);
                    let p1 = rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
                    let p2 = rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
                    let dealer_up = rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;

                    state.initial_player_cards = [p1, p2];
                    let player_cards = vec![p1, p2];
                    let player_bj = is_blackjack(&player_cards);

                    state.hands = vec![HandState {
                        cards: player_cards,
                        bet_mult: 1,
                        status: if player_bj {
                            HandStatus::Blackjack
                        } else {
                            HandStatus::Playing
                        },
                        was_split: false,
                    }];
                    state.dealer_cards = vec![dealer_up];
                    state.active_hand_idx = 0;
                    state.stage = if player_bj {
                        Stage::AwaitingReveal
                    } else {
                        Stage::PlayerTurn
                    };

                    // If the only hand is already non-playing (natural BJ), we can skip directly to
                    // reveal stage.
                    if state.stage == Stage::PlayerTurn && !advance_turn(&mut state) {
                        state.stage = Stage::AwaitingReveal;
                    }

                    session.state_blob = serialize_state(&state);
                    Ok(GameResult::Continue)
                }
                _ => Err(GameError::InvalidMove),
            },
            Stage::PlayerTurn => {
                // Reconstruct deck (excludes only visible/known cards).
                let mut all_cards = Vec::new();
                for h in &state.hands {
                    all_cards.extend_from_slice(&h.cards);
                }
                all_cards.extend_from_slice(&state.dealer_cards);
                let mut deck = rng.create_shoe_excluding(&all_cards, BLACKJACK_DECKS);

                match mv {
                    Move::Hit => {
                        if state.active_hand_idx >= state.hands.len() {
                            return Err(GameError::InvalidState);
                        }
                        let hand = &mut state.hands[state.active_hand_idx];
                        if hand.status != HandStatus::Playing {
                            return Err(GameError::InvalidMove);
                        }

                        let card = rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
                        hand.cards.push(card);
                        session.move_count = session.move_count.saturating_add(1);

                        let (val, _) = hand_value(&hand.cards);
                        if val > 21 {
                            hand.status = HandStatus::Busted;
                            if !advance_turn(&mut state) {
                                // If all hands are busted, dealer play/reveal is irrelevant.
                                let all_busted =
                                    state.hands.iter().all(|h| h.status == HandStatus::Busted);
                                if all_busted {
                                    let total_return = resolve_21plus3_return(&state);

                                    state.stage = Stage::Complete;
                                    session.is_complete = true;
                                    session.state_blob = serialize_state(&state);

                                    return Ok(finalize_game_result(session, &state, total_return));
                                }

                                state.stage = Stage::AwaitingReveal;
                            }
                        } else if val == 21 {
                            hand.status = HandStatus::Standing;
                            if !advance_turn(&mut state) {
                                state.stage = Stage::AwaitingReveal;
                            }
                        }

                        session.state_blob = serialize_state(&state);
                        Ok(GameResult::Continue)
                    }
                    Move::Stand => {
                        if state.active_hand_idx >= state.hands.len() {
                            return Err(GameError::InvalidState);
                        }
                        let hand = &mut state.hands[state.active_hand_idx];
                        if hand.status != HandStatus::Playing {
                            return Err(GameError::InvalidMove);
                        }
                        hand.status = HandStatus::Standing;
                        session.move_count = session.move_count.saturating_add(1);

                        if !advance_turn(&mut state) {
                            state.stage = Stage::AwaitingReveal;
                        }

                        session.state_blob = serialize_state(&state);
                        Ok(GameResult::Continue)
                    }
                    Move::Double => {
                        if state.active_hand_idx >= state.hands.len() {
                            return Err(GameError::InvalidState);
                        }
                        let hand = &mut state.hands[state.active_hand_idx];
                        if hand.status != HandStatus::Playing
                            || hand.cards.len() != 2
                            || hand.bet_mult != 1
                        {
                            return Err(GameError::InvalidMove);
                        }

                        let extra_bet = session.bet;
                        hand.bet_mult = 2;

                        let card = rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
                        hand.cards.push(card);
                        session.move_count = session.move_count.saturating_add(1);

                        let (val, _) = hand_value(&hand.cards);
                        hand.status = if val > 21 {
                            HandStatus::Busted
                        } else {
                            HandStatus::Standing
                        };

                        if !advance_turn(&mut state) {
                            // If all hands are busted, dealer play/reveal is irrelevant.
                            let all_busted =
                                state.hands.iter().all(|h| h.status == HandStatus::Busted);
                            if all_busted {
                                let total_return = resolve_21plus3_return(&state);

                                state.stage = Stage::Complete;
                                session.is_complete = true;
                                session.state_blob = serialize_state(&state);

                                return Ok(finalize_game_result(session, &state, total_return));
                            }

                            state.stage = Stage::AwaitingReveal;
                        }

                        session.state_blob = serialize_state(&state);
                        Ok(GameResult::ContinueWithUpdate {
                            payout: -(extra_bet as i64),
                        })
                    }
                    Move::Split => {
                        if state.active_hand_idx >= state.hands.len() {
                            return Err(GameError::InvalidState);
                        }
                        if state.hands.len() >= MAX_HANDS {
                            return Err(GameError::InvalidMove);
                        }

                        let current_hand = &mut state.hands[state.active_hand_idx];
                        if current_hand.status != HandStatus::Playing
                            || current_hand.cards.len() != 2
                        {
                            return Err(GameError::InvalidMove);
                        }

                        let r1 = card_rank(current_hand.cards[0]);
                        let r2 = card_rank(current_hand.cards[1]);
                        if r1 != r2 {
                            return Err(GameError::InvalidMove);
                        }

                        let split_bet = session.bet;

                        // Perform split
                        let split_card = current_hand.cards.pop().ok_or(GameError::InvalidState)?;
                        current_hand.was_split = true;

                        // Deal a card to each split hand
                        let c1 = rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
                        current_hand.cards.push(c1);

                        let c2 = rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
                        let new_hand = HandState {
                            cards: vec![split_card, c2],
                            bet_mult: 1,
                            status: HandStatus::Playing,
                            was_split: true,
                        };

                        state.hands.insert(state.active_hand_idx + 1, new_hand);

                        session.move_count = session.move_count.saturating_add(1);
                        session.state_blob = serialize_state(&state);
                        Ok(GameResult::ContinueWithUpdate {
                            payout: -(split_bet as i64),
                        })
                    }
                    _ => Err(GameError::InvalidMove),
                }
            }
            Stage::AwaitingReveal => match mv {
                Move::Reveal => {
                    if payload.len() != 1 {
                        return Err(GameError::InvalidPayload);
                    }

                    // Reconstruct deck excluding all known cards (player hands + dealer up).
                    let mut all_cards = Vec::new();
                    for h in &state.hands {
                        all_cards.extend_from_slice(&h.cards);
                    }
                    all_cards.extend_from_slice(&state.dealer_cards);
                    let mut deck = rng.create_shoe_excluding(&all_cards, BLACKJACK_DECKS);

                    // Reveal dealer hole card.
                    let hole = rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
                    state.dealer_cards.push(hole);

                    let any_live = state.hands.iter().any(|h| h.status != HandStatus::Busted);
                    if any_live {
                        loop {
                            let (val, is_soft) = hand_value(&state.dealer_cards);
                            if val > 17 || (val == 17 && !is_soft) {
                                break;
                            }
                            let c = rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
                            state.dealer_cards.push(c);
                        }
                    }

                    let (d_val, _) = hand_value(&state.dealer_cards);
                    let d_bj = is_blackjack(&state.dealer_cards);

                    let mut total_return: u64 = 0;
                    for hand in &state.hands {
                        let bet = session.bet.saturating_mul(hand.bet_mult as u64);
                        if hand.status == HandStatus::Busted {
                            continue;
                        }

                        let (p_val, _) = hand_value(&hand.cards);
                        let p_bj = is_natural_blackjack(hand);

                        if p_bj && d_bj {
                            total_return = total_return.saturating_add(bet);
                        } else if p_bj {
                            total_return = total_return.saturating_add(bet.saturating_mul(5) / 2);
                        } else if d_bj {
                            // Lose.
                        } else if d_val > 21 {
                            total_return = total_return.saturating_add(bet.saturating_mul(2));
                        } else if p_val > d_val {
                            total_return = total_return.saturating_add(bet.saturating_mul(2));
                        } else if p_val == d_val {
                            total_return = total_return.saturating_add(bet);
                        }
                    }

                    total_return = total_return.saturating_add(resolve_21plus3_return(&state));

                    state.stage = Stage::Complete;
                    session.is_complete = true;
                    session.state_blob = serialize_state(&state);

                    Ok(finalize_game_result(session, &state, total_return))
                }
                _ => Err(GameError::InvalidMove),
            },
            Stage::Complete => Err(GameError::GameAlreadyComplete),
        }
    }
}

/// Advance active turn to next playing hand. Returns true if there is a hand to play.
fn advance_turn(state: &mut BlackjackState) -> bool {
    while state.active_hand_idx < state.hands.len() {
        if state.hands[state.active_hand_idx].status == HandStatus::Playing {
            return true;
        }
        state.active_hand_idx += 1;
    }
    false
}

fn total_wagered(session: &GameSession, state: &BlackjackState) -> u64 {
    let main_wagered: u64 = state
        .hands
        .iter()
        .map(|h| session.bet.saturating_mul(h.bet_mult as u64))
        .sum();
    main_wagered.saturating_add(state.side_bet_21plus3)
}

fn apply_super_multiplier(session: &GameSession, state: &BlackjackState, total_return: u64) -> u64 {
    if !session.super_mode.is_active || total_return == 0 {
        return total_return;
    }
    let Some(hand) = state.hands.first() else {
        return total_return;
    };
    apply_super_multiplier_cards(&hand.cards, &session.super_mode.multipliers, total_return)
}

fn finalize_game_result(
    session: &GameSession,
    state: &BlackjackState,
    total_return: u64,
) -> GameResult {
    let total_wagered = total_wagered(session, state);
    let total_return = apply_super_multiplier(session, state, total_return);
    if total_return == 0 {
        GameResult::LossPreDeducted(total_wagered)
    } else {
        GameResult::Win(total_return)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nullspace_types::casino::GameType;
    use nullspace_types::casino::SuperModeState;

    #[test]
    fn test_21plus3_multiplier_table() {
        // Straight flush (2-3-4 suited)
        assert_eq!(eval_21plus3_multiplier([1, 2, 3]), 30);

        // Trips (three 7s)
        assert_eq!(eval_21plus3_multiplier([6, 19, 32]), 20);

        // Straight (10-J-Q unsuited)
        assert_eq!(eval_21plus3_multiplier([9, 23, 37]), 10);

        // Flush (A-5-9 suited, not straight)
        assert_eq!(eval_21plus3_multiplier([0, 4, 8]), 5);

        // Nothing
        assert_eq!(eval_21plus3_multiplier([0, 10, 25]), 0);
    }

    #[test]
    fn test_split_hand_is_not_natural_blackjack() {
        let hand = HandState {
            cards: vec![0, 9], // A + 10
            bet_mult: 1,
            status: HandStatus::Standing,
            was_split: true,
        };
        assert!(!is_natural_blackjack(&hand));
    }

    #[test]
    fn test_hit_all_busted_returns_loss_prededucted() {
        let (network_secret, _) = crate::mocks::create_network_keypair();
        let seed = crate::mocks::create_seed(&network_secret, 1);
        let (_, public) = crate::mocks::create_account_keypair(1);

        let state = BlackjackState {
            stage: Stage::PlayerTurn,
            side_bet_21plus3: 0,
            initial_player_cards: [9, 12],
            active_hand_idx: 0,
            hands: vec![HandState {
                cards: vec![9, 12], // 10 + K = 20
                bet_mult: 1,
                status: HandStatus::Playing,
                was_split: false,
            }],
            dealer_cards: vec![0],
        };

        let base_session = GameSession {
            id: 0,
            player: public,
            game_type: GameType::Blackjack,
            bet: 100,
            state_blob: serialize_state(&state),
            move_count: 1,
            created_at: 0,
            is_complete: false,
            super_mode: SuperModeState::default(),
            is_tournament: false,
            tournament_id: None,
        };

        let mut found = None;
        for session_id in 0u64..64 {
            let mut session = base_session.clone();
            session.id = session_id;
            let mut rng = GameRng::new(&seed, session_id, 1);
            match Blackjack::process_move(&mut session, &[Move::Hit as u8], &mut rng).unwrap() {
                GameResult::LossPreDeducted(total_wagered) => {
                    found = Some(total_wagered);
                    break;
                }
                _ => continue,
            }
        }

        assert_eq!(found, Some(100));
    }

    #[test]
    fn test_hit_all_busted_side_bet_win_returns_win() {
        let (network_secret, _) = crate::mocks::create_network_keypair();
        let seed = crate::mocks::create_seed(&network_secret, 1);
        let (_, public) = crate::mocks::create_account_keypair(1);

        let state = BlackjackState {
            stage: Stage::PlayerTurn,
            side_bet_21plus3: 10,
            initial_player_cards: [1, 2],
            active_hand_idx: 0,
            hands: vec![HandState {
                cards: vec![1, 2, 9, 4], // 2 + 3 + 10 + 5 = 20
                bet_mult: 1,
                status: HandStatus::Playing,
                was_split: false,
            }],
            dealer_cards: vec![3],
        };

        let base_session = GameSession {
            id: 0,
            player: public,
            game_type: GameType::Blackjack,
            bet: 100,
            state_blob: serialize_state(&state),
            move_count: 1,
            created_at: 0,
            is_complete: false,
            super_mode: SuperModeState::default(),
            is_tournament: false,
            tournament_id: None,
        };

        let mut found = None;
        for session_id in 0u64..64 {
            let mut session = base_session.clone();
            session.id = session_id;
            let mut rng = GameRng::new(&seed, session_id, 1);
            match Blackjack::process_move(&mut session, &[Move::Hit as u8], &mut rng).unwrap() {
                GameResult::Win(total_return) => {
                    found = Some(total_return);
                    break;
                }
                _ => continue,
            }
        }

        assert_eq!(found, Some(310));
    }
}
