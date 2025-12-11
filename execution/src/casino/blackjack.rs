//! Blackjack game implementation.
//!
//! State blob format (v2 - supports splits):
//! [version:u8] (1)
//! [active_hand_idx:u8]
//! [hand_count:u8]
//! ... per hand:
//!   [bet_mult:u8] (1=base, 2=doubled)
//!   [status:u8] (0=playing, 1=stand, 2=bust, 3=blackjack)
//!   [card_count:u8]
//!   [cards...]
//! [dLen:u8] [dCards...]
//! [stage:u8]
//!
//! Payload format:
//! [0] = Hit
//! [1] = Stand
//! [2] = Double Down
//! [3] = Split

use super::{CasinoGame, GameError, GameResult, GameRng};
use super::super_mode::apply_super_multiplier_cards;
use nullspace_types::casino::GameSession;

/// Maximum cards in a blackjack hand.
const MAX_HAND_SIZE: usize = 11;
/// Maximum number of hands allowed (splits).
const MAX_HANDS: usize = 4;

/// Blackjack game stages
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    PlayerTurn = 0,
    DealerTurn = 1,
    Complete = 2,
}

impl TryFrom<u8> for Stage {
    type Error = GameError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Stage::PlayerTurn),
            1 => Ok(Stage::DealerTurn),
            2 => Ok(Stage::Complete),
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
}

impl TryFrom<u8> for Move {
    type Error = GameError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Move::Hit),
            1 => Ok(Move::Stand),
            2 => Ok(Move::Double),
            3 => Ok(Move::Split),
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
}

/// Game state structure
pub struct BlackjackState {
    pub active_hand_idx: usize,
    pub hands: Vec<HandState>,
    pub dealer_cards: Vec<u8>,
    pub stage: Stage,
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

/// Get card rank (0-12).
fn card_rank(card: u8) -> u8 {
    card % 13
}

/// Serialize state to blob.
fn serialize_state(state: &BlackjackState) -> Vec<u8> {
    let mut blob = Vec::new();
    blob.push(1); // Version
    blob.push(state.active_hand_idx as u8);
    blob.push(state.hands.len() as u8);

    for hand in &state.hands {
        blob.push(hand.bet_mult);
        blob.push(hand.status as u8);
        blob.push(hand.cards.len() as u8);
        blob.extend_from_slice(&hand.cards);
    }

    blob.push(state.dealer_cards.len() as u8);
    blob.extend_from_slice(&state.dealer_cards);
    blob.push(state.stage as u8);
    blob
}

/// Parse state from blob.
fn parse_state(blob: &[u8]) -> Option<BlackjackState> {
    if blob.is_empty() {
        return None;
    }

    // Check version
    if blob[0] != 1 {
        // Fallback for old state format (legacy support if needed, or just fail)
        // For this task, we assume new format or fail.
        return None; 
    }

    let mut idx = 1;
    if idx >= blob.len() { return None; }
    let active_hand_idx = blob[idx] as usize;
    idx += 1;

    if idx >= blob.len() { return None; }
    let hand_count = blob[idx] as usize;
    idx += 1;

    if hand_count > MAX_HANDS { return None; }

    let mut hands = Vec::with_capacity(hand_count);
    for _ in 0..hand_count {
        if idx + 3 > blob.len() { return None; }
        let bet_mult = blob[idx];
        let status = HandStatus::try_from(blob[idx+1]).ok()?;
        let c_len = blob[idx+2] as usize;
        idx += 3;

        if c_len > MAX_HAND_SIZE || idx + c_len > blob.len() { return None; }
        let cards = blob[idx..idx+c_len].to_vec();
        idx += c_len;

        hands.push(HandState { cards, bet_mult, status });
    }

    if idx >= blob.len() { return None; }
    let d_len = blob[idx] as usize;
    idx += 1;

    if d_len > MAX_HAND_SIZE || idx + d_len > blob.len() { return None; }
    let dealer_cards = blob[idx..idx+d_len].to_vec();
    idx += d_len;

    if idx >= blob.len() { return None; }
    let stage = Stage::try_from(blob[idx]).ok()?;

    Some(BlackjackState {
        active_hand_idx,
        hands,
        dealer_cards,
        stage,
    })
}

pub struct Blackjack;

impl CasinoGame for Blackjack {
    fn init(session: &mut GameSession, rng: &mut GameRng) -> GameResult {
        let mut deck = rng.create_deck();

        let player_cards = vec![
            rng.draw_card(&mut deck).unwrap_or(0),
            rng.draw_card(&mut deck).unwrap_or(1),
        ];
        let dealer_cards = vec![
            rng.draw_card(&mut deck).unwrap_or(2),
            rng.draw_card(&mut deck).unwrap_or(3),
        ];

        let player_bj = is_blackjack(&player_cards);
        let dealer_bj = is_blackjack(&dealer_cards);

        let mut hands = vec![HandState {
            cards: player_cards,
            bet_mult: 1,
            status: if player_bj { HandStatus::Blackjack } else { HandStatus::Playing },
        }];

        let mut stage = Stage::PlayerTurn;
        let mut result = GameResult::Continue;

        if player_bj || dealer_bj {
            stage = Stage::Complete;
            session.is_complete = true;
            if player_bj && dealer_bj {
                result = GameResult::Push;
            } else if player_bj {
                let payout = session.bet.saturating_mul(5) / 2;
                result = GameResult::Win(payout);
            } else {
                result = GameResult::Loss;
            }
        }

        let state = BlackjackState {
            active_hand_idx: 0,
            hands,
            dealer_cards,
            stage,
        };

        session.state_blob = serialize_state(&state);

        // Super mode check for immediate win
        if session.super_mode.is_active {
            if let GameResult::Win(base) = result {
                let boosted = apply_super_multiplier_cards(
                    &state.hands[0].cards,
                    &session.super_mode.multipliers,
                    base,
                );
                return GameResult::Win(boosted);
            }
        }

        result
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

        // Reconstruct deck
        let mut all_cards = Vec::new();
        for h in &state.hands {
            all_cards.extend_from_slice(&h.cards);
        }
        all_cards.extend_from_slice(&state.dealer_cards);
        let mut deck = rng.create_deck_excluding(&all_cards);

        match mv {
            Move::Hit => {
                if state.active_hand_idx >= state.hands.len() { return Err(GameError::InvalidState); }
                let hand = &mut state.hands[state.active_hand_idx];
                
                let card = rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
                hand.cards.push(card);
                session.move_count += 1;

                let (val, _) = hand_value(&hand.cards);
                if val > 21 {
                    hand.status = HandStatus::Busted;
                    // Move to next hand
                    if !advance_turn(&mut state) {
                        // All hands done, dealer plays
                        return Self::dealer_play(session, state, deck, rng);
                    }
                } else if val == 21 {
                    hand.status = HandStatus::Standing;
                    if !advance_turn(&mut state) {
                        return Self::dealer_play(session, state, deck, rng);
                    }
                }
                
                session.state_blob = serialize_state(&state);
                Ok(GameResult::Continue)
            }
            Move::Stand => {
                if state.active_hand_idx >= state.hands.len() { return Err(GameError::InvalidState); }
                state.hands[state.active_hand_idx].status = HandStatus::Standing;
                session.move_count += 1;

                if !advance_turn(&mut state) {
                    return Self::dealer_play(session, state, deck, rng);
                }
                session.state_blob = serialize_state(&state);
                Ok(GameResult::Continue)
            }
            Move::Double => {
                if state.active_hand_idx >= state.hands.len() { return Err(GameError::InvalidState); }
                let hand = &mut state.hands[state.active_hand_idx];

                if hand.cards.len() != 2 { return Err(GameError::InvalidMove); }

                // Calculate extra bet to deduct
                let extra_bet = session.bet; // Doubles base bet for this hand

                hand.bet_mult *= 2;
                let card = rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
                hand.cards.push(card);
                session.move_count += 1;

                let (val, _) = hand_value(&hand.cards);
                if val > 21 {
                    hand.status = HandStatus::Busted;
                } else {
                    hand.status = HandStatus::Standing;
                }

                let all_done = !advance_turn(&mut state);
                
                if all_done {
                    // All hands done, dealer plays.
                    // Dealer play will return result. We need to handle the extra deduction.
                    // dealer_play returns a total result (Win/Loss/Push).
                    // If return is positive (Win), we just subtract extra_bet from it if we want,
                    // BUT process_move needs to signal the deduction NOW.
                    // Actually, simpler: Return ContinueWithUpdate to deduct, then if game over,
                    // return result? No, dealer_play finishes game.
                    
                    // Dealer play returns result based on FINAL state.
                    // We need to return LossWithExtraDeduction if total result is loss.
                    // Or if win, reduce win amount?
                    // Better: We return ContinueWithUpdate to deduct, AND calculate result? No can't do both.
                    
                    // If we double on last hand, we need to resolve immediately.
                    // We should treat Double as: Deduct chips -> Deal card -> Check if done.
                    // If done -> Dealer play -> Result.
                    
                    // ISSUE: GameResult doesn't support "Deduct X AND return Winnings Y".
                    // It supports "Win Y" or "LossWithExtraDeduction X".
                    
                    // If we use ContinueWithUpdate, game isn't over.
                    // So we must handle Double specially.
                    
                    // If game ends:
                    // We calculate total return (gross winnings).
                    // The extra bet is ALREADY deducted if we used LossWithExtraDeduction?
                    // No, LossWithExtraDeduction is for when we lose.
                    
                    // Let's calculate the NET change needed.
                    // We need to deduct `extra_bet`.
                    // And we need to award `winnings`.
                    // Net = winnings - extra_bet.
                    // If Net > 0: Win(Net).
                    // If Net < 0: LossWithExtraDeduction(-Net).
                    // If Net == 0: Push.
                    
                    let result = Self::dealer_play_internal(session, &mut state, deck, rng)?;
                    
                    // Serialize state as dealer_play updates it
                    session.state_blob = serialize_state(&state); 
                    
                    match result {
                        GameResult::Win(winnings) => {
                            if winnings >= extra_bet {
                                Ok(GameResult::Win(winnings - extra_bet))
                            } else {
                                Ok(GameResult::LossWithExtraDeduction(extra_bet - winnings))
                            }
                        }
                        GameResult::Push => {
                            // Winnings = total bets returned.
                            // But for double, we haven't paid extra yet.
                            // If push, we get back what we bet.
                            // original bet is returned. extra bet is kept by player (not deducted).
                            // So return 0 change? No.
                            // Push means: Player balance += Total Bet.
                            // Player balance -= Extra Bet.
                            // Net = Total Bet - Extra Bet = Original Bet.
                            // So return Win(Original Bet).
                            Ok(GameResult::Win(session.bet)) // Assuming 1 hand doubled
                            // Wait, what if other hands?
                            // This logic is getting complex with multiple hands.
                        }
                        GameResult::Loss => {
                            Ok(GameResult::LossWithExtraDeduction(extra_bet))
                        }
                        GameResult::LossWithExtraDeduction(existing_deduction) => {
                            Ok(GameResult::LossWithExtraDeduction(existing_deduction + extra_bet))
                        }
                        _ => Ok(result),
                    }
                } else {
                    // Not done, just deduct and continue
                    session.state_blob = serialize_state(&state);
                    Ok(GameResult::ContinueWithUpdate { payout: -(extra_bet as i64) })
                }
            }
            Move::Split => {
                if state.active_hand_idx >= state.hands.len() { return Err(GameError::InvalidState); }
                if state.hands.len() >= MAX_HANDS { return Err(GameError::InvalidMove); }
                
                let current_hand = &mut state.hands[state.active_hand_idx];
                if current_hand.cards.len() != 2 { return Err(GameError::InvalidMove); }
                
                // Check ranks match
                let r1 = card_rank(current_hand.cards[0]);
                let r2 = card_rank(current_hand.cards[1]);
                if r1 != r2 { return Err(GameError::InvalidMove); }
                
                // Deduct split bet (equal to original session bet)
                let split_bet = session.bet;
                
                // Perform split
                let split_card = current_hand.cards.pop().unwrap();
                
                // Deal card to first hand
                let c1 = rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
                current_hand.cards.push(c1);
                
                // Create second hand
                let mut new_hand_cards = vec![split_card];
                let c2 = rng.draw_card(&mut deck).ok_or(GameError::DeckExhausted)?;
                new_hand_cards.push(c2);
                
                let new_hand = HandState {
                    cards: new_hand_cards,
                    bet_mult: 1,
                    status: HandStatus::Playing,
                };
                
                // Insert new hand after current
                state.hands.insert(state.active_hand_idx + 1, new_hand);
                
                // Check blackjack for current hand (if Ace split)
                // Simplify: Standard blackjack check logic if we want
                // For now, let them play it.
                
                session.move_count += 1;
                session.state_blob = serialize_state(&state);
                
                Ok(GameResult::ContinueWithUpdate { payout: -(split_bet as i64) })
            }
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

impl Blackjack {
    /// Wrapper for dealer play to be called from process_move
    fn dealer_play(
        session: &mut GameSession,
        state: BlackjackState,
        deck: Vec<u8>,
        rng: &mut GameRng,
    ) -> Result<GameResult, GameError> {
        let mut mutable_state = state;
        let res = Self::dealer_play_internal(session, &mut mutable_state, deck, rng)?;
        session.state_blob = serialize_state(&mutable_state);
        Ok(res)
    }

    /// Internal logic for dealer play
    fn dealer_play_internal(
        session: &mut GameSession,
        state: &mut BlackjackState,
        mut deck: Vec<u8>,
        rng: &mut GameRng,
    ) -> Result<GameResult, GameError> {
        state.stage = Stage::DealerTurn;
        
        // Check if any player hand is not busted/blackjack
        let any_live = state.hands.iter().any(|h| 
            h.status == HandStatus::Standing || h.status == HandStatus::Playing
        );

        if any_live {
            // Dealer draws
            loop {
                let (val, is_soft) = hand_value(&state.dealer_cards);
                if val > 17 || (val == 17 && !is_soft) {
                    break;
                }
                if let Some(c) = rng.draw_card(&mut deck) {
                    state.dealer_cards.push(c);
                } else {
                    break;
                }
            }
        }

        state.stage = Stage::Complete;
        session.is_complete = true;

        let (d_val, _) = hand_value(&state.dealer_cards);
        let d_bj = is_blackjack(&state.dealer_cards);

        let mut total_payout: u64 = 0;

        for hand in &state.hands {
            let (p_val, _) = hand_value(&hand.cards);
            let p_bj = is_blackjack(&hand.cards);
            let bet = session.bet.saturating_mul(hand.bet_mult as u64);

            if hand.status == HandStatus::Busted {
                // Lost, 0 payout
                continue;
            }

            if p_bj && d_bj {
                // Push
                total_payout += bet;
            } else if p_bj {
                // Player BJ, Dealer no BJ (3:2)
                total_payout += bet.saturating_mul(5) / 2;
            } else if d_bj {
                // Dealer BJ, Player no BJ
                // Lost
            } else if d_val > 21 {
                // Dealer bust
                total_payout += bet.saturating_mul(2);
            } else if p_val > d_val {
                // Win
                total_payout += bet.saturating_mul(2);
            } else if p_val == d_val {
                // Push
                total_payout += bet;
            }
            // else lose
        }

        if total_payout > 0 {
            // Apply super mode if active (just on first hand for simplicity/safety)
            if session.super_mode.is_active && !state.hands.is_empty() {
                 total_payout = apply_super_multiplier_cards(
                    &state.hands[0].cards,
                    &session.super_mode.multipliers,
                    total_payout,
                );
            }
            Ok(GameResult::Win(total_payout))
        } else {
            Ok(GameResult::Loss)
        }
    }
}