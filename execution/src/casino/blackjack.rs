//! Blackjack game implementation.
//!
//! State blob format:
//! [pLen:u8] [pCards:u8×pLen] [dLen:u8] [dCards:u8×dLen] [stage:u8]
//!
//! Payload format:
//! [0] = Hit
//! [1] = Stand
//! [2] = Double Down

use super::{CasinoGame, GameError, GameResult, GameRng};
use super::super_mode::apply_super_multiplier_cards;
use nullspace_types::casino::GameSession;

/// Maximum cards in a blackjack hand (prevents DoS via large allocations).
/// Theoretical max is ~11 cards (4 aces at 1 + 4 twos + 3 threes = 21).
const MAX_HAND_SIZE: usize = 11;

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
}

impl TryFrom<u8> for Move {
    type Error = GameError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Move::Hit),
            1 => Ok(Move::Stand),
            2 => Ok(Move::Double),
            _ => Err(GameError::InvalidPayload),
        }
    }
}

/// Calculate the value of a blackjack hand.
/// Returns (value, is_soft) where is_soft indicates an ace counted as 11.
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

    // Reduce aces from 11 to 1 as needed
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

/// Parse the state blob into player cards, dealer cards, and stage.
fn parse_state(state: &[u8]) -> Option<(Vec<u8>, Vec<u8>, Stage)> {
    if state.is_empty() {
        return None;
    }

    let mut idx = 0;

    // Read player cards
    if idx >= state.len() {
        return None;
    }
    let p_len = state[idx] as usize;
    idx += 1;
    // Bounds check: reject impossibly large hand sizes
    if p_len > MAX_HAND_SIZE || idx + p_len > state.len() {
        return None;
    }
    let player_cards: Vec<u8> = state[idx..idx + p_len].to_vec();
    idx += p_len;

    // Read dealer cards
    if idx >= state.len() {
        return None;
    }
    let d_len = state[idx] as usize;
    idx += 1;
    // Bounds check: reject impossibly large hand sizes
    if d_len > MAX_HAND_SIZE || idx + d_len > state.len() {
        return None;
    }
    let dealer_cards: Vec<u8> = state[idx..idx + d_len].to_vec();
    idx += d_len;

    // Read stage
    if idx >= state.len() {
        return None;
    }
    let stage = Stage::try_from(state[idx]).ok()?;

    Some((player_cards, dealer_cards, stage))
}

/// Serialize state to blob.
fn serialize_state(player_cards: &[u8], dealer_cards: &[u8], stage: Stage) -> Vec<u8> {
    let mut state = Vec::with_capacity(2 + player_cards.len() + dealer_cards.len() + 1);
    state.push(player_cards.len() as u8);
    state.extend_from_slice(player_cards);
    state.push(dealer_cards.len() as u8);
    state.extend_from_slice(dealer_cards);
    state.push(stage as u8);
    state
}

pub struct Blackjack;

impl CasinoGame for Blackjack {
    fn init(session: &mut GameSession, rng: &mut GameRng) -> GameResult {
        let mut deck = rng.create_deck();

        // Deal initial cards: player gets 2, dealer gets 2 (second hidden)
        let player_cards = vec![
            rng.draw_card(&mut deck).unwrap_or(0),
            rng.draw_card(&mut deck).unwrap_or(1),
        ];
        let dealer_cards = vec![
            rng.draw_card(&mut deck).unwrap_or(2),
            rng.draw_card(&mut deck).unwrap_or(3),
        ];

        // Check for immediate blackjack
        let player_bj = is_blackjack(&player_cards);
        let dealer_bj = is_blackjack(&dealer_cards);

        let (stage, base_result) = if player_bj || dealer_bj {
            session.is_complete = true;
            if player_bj && dealer_bj {
                (Stage::Complete, GameResult::Push)
            } else if player_bj {
                // Player blackjack pays 3:2 (return stake + 1.5x)
                let payout = session.bet.saturating_mul(5) / 2;
                (Stage::Complete, GameResult::Win(payout))
            } else {
                (Stage::Complete, GameResult::Loss)
            }
        } else {
            (Stage::PlayerTurn, GameResult::Continue)
        };

        session.state_blob = serialize_state(&player_cards, &dealer_cards, stage);

        // Apply super mode multipliers if active and player won
        if session.super_mode.is_active {
            if let GameResult::Win(base_payout) = base_result {
                let boosted_payout = apply_super_multiplier_cards(
                    &player_cards,
                    &session.super_mode.multipliers,
                    base_payout,
                );
                return GameResult::Win(boosted_payout);
            }
        }
        base_result
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
        let (mut player_cards, dealer_cards, stage) =
            parse_state(&session.state_blob).ok_or(GameError::InvalidPayload)?;

        if stage == Stage::Complete {
            return Err(GameError::GameAlreadyComplete);
        }

        // Recreate deck excluding dealt cards (using optimized bit-set)
        let mut all_cards = Vec::with_capacity(player_cards.len() + dealer_cards.len());
        all_cards.extend_from_slice(&player_cards);
        all_cards.extend_from_slice(&dealer_cards);
        let mut deck = rng.create_deck_excluding(&all_cards);

        match stage {
            Stage::PlayerTurn => {
                match mv {
                    Move::Hit => {
                        // Draw a card
                        let card = rng.draw_card(&mut deck).ok_or(GameError::InvalidMove)?;
                        player_cards.push(card);
                        session.move_count += 1;

                        let (value, _) = hand_value(&player_cards);
                        if value > 21 {
                            // Player busts
                            session.state_blob =
                                serialize_state(&player_cards, &dealer_cards, Stage::Complete);
                            session.is_complete = true;
                            return Ok(GameResult::Loss);
                        } else if value == 21 {
                            // Auto-stand on 21
                            return Self::dealer_play(
                                session,
                                player_cards,
                                dealer_cards,
                                deck,
                                rng,
                            );
                        }

                        session.state_blob =
                            serialize_state(&player_cards, &dealer_cards, Stage::PlayerTurn);
                        Ok(GameResult::Continue)
                    }
                    Move::Stand => {
                        session.move_count += 1;
                        Self::dealer_play(session, player_cards, dealer_cards, deck, rng)
                    }
                    Move::Double => {
                        // Can only double on first move (2 cards)
                        if player_cards.len() != 2 {
                            return Err(GameError::InvalidMove);
                        }

                        // Record the extra bet amount (not charged by Layer)
                        let extra_bet = session.bet;

                        // Draw exactly one card
                        let card = rng.draw_card(&mut deck).ok_or(GameError::InvalidMove)?;
                        player_cards.push(card);
                        session.move_count += 1;

                        // Double the bet with overflow protection
                        session.bet = session.bet
                            .checked_mul(2)
                            .ok_or(GameError::InvalidMove)?;

                        let (value, _) = hand_value(&player_cards);
                        if value > 21 {
                            // Player busts - need to deduct the extra bet that wasn't charged
                            session.state_blob =
                                serialize_state(&player_cards, &dealer_cards, Stage::Complete);
                            session.is_complete = true;
                            return Ok(GameResult::LossWithExtraDeduction(extra_bet));
                        }

                        // Must stand after double - get result and adjust for uncharged extra bet
                        let result = Self::dealer_play(session, player_cards, dealer_cards, deck, rng)?;
                        Ok(match result {
                            GameResult::Win(payout) => {
                                // Reduce payout by extra_bet since it wasn't charged
                                GameResult::Win(payout.saturating_sub(extra_bet))
                            }
                            GameResult::Loss => {
                                // Need to deduct the extra bet
                                GameResult::LossWithExtraDeduction(extra_bet)
                            }
                            GameResult::Push => {
                                // Push returns bet, but only half was charged
                                // Return only what was actually charged (original bet)
                                GameResult::Win(extra_bet)
                            }
                            other => other,
                        })
                    }
                }
            }
            _ => Err(GameError::InvalidMove),
        }
    }
}

impl Blackjack {
    /// Dealer plays their hand and determine outcome.
    fn dealer_play(
        session: &mut GameSession,
        player_cards: Vec<u8>,
        mut dealer_cards: Vec<u8>,
        mut deck: Vec<u8>,
        rng: &mut GameRng,
    ) -> Result<GameResult, GameError> {
        // Dealer draws until 17 or higher
        loop {
            let (value, is_soft) = hand_value(&dealer_cards);
            // Dealer hits on soft 17, stands on hard 17+
            if value > 17 || (value == 17 && !is_soft) {
                break;
            }
            if let Some(card) = rng.draw_card(&mut deck) {
                dealer_cards.push(card);
            } else {
                break;
            }
        }

        let (player_value, _) = hand_value(&player_cards);
        let (dealer_value, _) = hand_value(&dealer_cards);
        let player_bj = is_blackjack(&player_cards);
        let dealer_bj = is_blackjack(&dealer_cards);

        session.state_blob = serialize_state(&player_cards, &dealer_cards, Stage::Complete);
        session.is_complete = true;

        // Determine outcome
        let base_result = if player_bj && dealer_bj {
            // Both blackjack = push
            GameResult::Push
        } else if player_bj {
            // Player blackjack pays 3:2 (with overflow protection)
            let payout = session.bet.saturating_mul(3) / 2;
            GameResult::Win(payout)
        } else if dealer_bj {
            // Dealer blackjack
            GameResult::Loss
        } else if dealer_value > 21 {
            // Dealer busts
            GameResult::Win(session.bet.saturating_mul(2))
        } else if player_value > dealer_value {
            // Player wins
            GameResult::Win(session.bet.saturating_mul(2))
        } else if player_value < dealer_value {
            // Dealer wins
            GameResult::Loss
        } else {
            // Push
            GameResult::Push
        };

        // Apply super mode multipliers if active and player won
        let result = if session.super_mode.is_active {
            if let GameResult::Win(base_payout) = base_result {
                // Strike Cards: multipliers apply to player's winning cards
                let boosted_payout = apply_super_multiplier_cards(
                    &player_cards,
                    &session.super_mode.multipliers,
                    base_payout,
                );
                GameResult::Win(boosted_payout)
            } else {
                base_result
            }
        } else {
            base_result
        };

        Ok(result)
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
            game_type: GameType::Blackjack,
            bet,
            state_blob: vec![],
            move_count: 0,
            created_at: 0,
            is_complete: false,
            super_mode: nullspace_types::casino::SuperModeState::default(),
        }
    }

    #[test]
    fn test_hand_value_simple() {
        // 5 + 7 = 12
        assert_eq!(hand_value(&[4, 6]), (12, false));

        // K + 5 = 15
        assert_eq!(hand_value(&[12, 4]), (15, false));

        // A + 5 = 16 (soft)
        assert_eq!(hand_value(&[0, 4]), (16, true));

        // A + K = 21 (blackjack)
        assert_eq!(hand_value(&[0, 12]), (21, true));
    }

    #[test]
    fn test_hand_value_multiple_aces() {
        // A + A = 12 (one ace is 11, one is 1)
        assert_eq!(hand_value(&[0, 13]), (12, true));

        // A + A + A = 13
        assert_eq!(hand_value(&[0, 13, 26]), (13, true));

        // A + A + 9 = 21
        assert_eq!(hand_value(&[0, 13, 8]), (21, true));
    }

    #[test]
    fn test_hand_value_bust_with_aces() {
        // A + 5 + 10 = 16 (ace becomes 1)
        assert_eq!(hand_value(&[0, 4, 9]), (16, false));

        // A + 5 + 10 + 7 = 23 bust
        assert_eq!(hand_value(&[0, 4, 9, 6]), (23, false));
    }

    #[test]
    fn test_is_blackjack() {
        // A + K = blackjack
        assert!(is_blackjack(&[0, 12]));

        // A + 10 = blackjack
        assert!(is_blackjack(&[0, 9]));

        // Not blackjack: 3 cards to 21
        assert!(!is_blackjack(&[6, 6, 8])); // 7+7+7=21

        // Not blackjack: 2 cards not 21
        assert!(!is_blackjack(&[0, 4])); // A+5=16
    }

    #[test]
    fn test_parse_serialize_roundtrip() {
        let player = vec![0, 12]; // A, K
        let dealer = vec![9, 5]; // 10, 6
        let stage = Stage::PlayerTurn;

        let state = serialize_state(&player, &dealer, stage);
        let (p, d, s) = parse_state(&state).expect("Failed to parse state");

        assert_eq!(p, player);
        assert_eq!(d, dealer);
        assert_eq!(s, stage);
    }

    #[test]
    fn test_init_deals_cards() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        Blackjack::init(&mut session, &mut rng);

        let (player, dealer, stage) = parse_state(&session.state_blob).expect("Failed to parse state");

        assert_eq!(player.len(), 2);
        assert_eq!(dealer.len(), 2);

        // All cards should be unique
        let all_cards: Vec<u8> = player.iter().chain(dealer.iter()).cloned().collect();
        for (i, &c1) in all_cards.iter().enumerate() {
            for &c2 in all_cards.iter().skip(i + 1) {
                assert_ne!(c1, c2, "Duplicate card dealt");
            }
        }

        // Stage depends on whether there's a blackjack
        let player_bj = is_blackjack(&player);
        let dealer_bj = is_blackjack(&dealer);
        if player_bj || dealer_bj {
            assert_eq!(stage, Stage::Complete);
        } else {
            assert_eq!(stage, Stage::PlayerTurn);
        }
    }

    #[test]
    fn test_hit_adds_card() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        Blackjack::init(&mut session, &mut rng);

        // Skip if game completed on deal (blackjack)
        let (_, _, stage) = parse_state(&session.state_blob).expect("Failed to parse state");
        if stage == Stage::Complete {
            return;
        }

        let initial_cards = parse_state(&session.state_blob).expect("Failed to parse state").0.len();

        let mut rng = GameRng::new(&seed, session.id, 1);
        let result = Blackjack::process_move(&mut session, &[0], &mut rng); // Hit

        assert!(result.is_ok());
        let (player, _, _) = parse_state(&session.state_blob).expect("Failed to parse state");

        // Either got a new card or busted (which also adds a card)
        assert!(player.len() > initial_cards);
    }

    #[test]
    fn test_stand_triggers_dealer() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        Blackjack::init(&mut session, &mut rng);

        let (_, _, stage) = parse_state(&session.state_blob).expect("Failed to parse state");
        if stage == Stage::Complete {
            return;
        }

        let mut rng = GameRng::new(&seed, session.id, 1);
        let result = Blackjack::process_move(&mut session, &[1], &mut rng); // Stand

        assert!(result.is_ok());
        assert!(session.is_complete);

        let (_, _, stage) = parse_state(&session.state_blob).expect("Failed to parse state");
        assert_eq!(stage, Stage::Complete);
    }

    #[test]
    fn test_double_doubles_bet() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        Blackjack::init(&mut session, &mut rng);

        let (_, _, stage) = parse_state(&session.state_blob).expect("Failed to parse state");
        if stage == Stage::Complete {
            return;
        }

        let initial_bet = session.bet;

        let mut rng = GameRng::new(&seed, session.id, 1);
        let result = Blackjack::process_move(&mut session, &[2], &mut rng); // Double

        assert!(result.is_ok());
        assert!(session.is_complete);
        assert_eq!(session.bet, initial_bet * 2);
    }

    #[test]
    fn test_cannot_double_after_hit() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        Blackjack::init(&mut session, &mut rng);

        let (_, _, stage) = parse_state(&session.state_blob).expect("Failed to parse state");
        if stage == Stage::Complete {
            return;
        }

        // Hit first
        let mut rng = GameRng::new(&seed, session.id, 1);
        let result = Blackjack::process_move(&mut session, &[0], &mut rng);
        if session.is_complete {
            return; // Busted or got 21
        }
        assert!(result.is_ok());

        // Try to double
        let mut rng = GameRng::new(&seed, session.id, 2);
        let result = Blackjack::process_move(&mut session, &[2], &mut rng);
        assert!(matches!(result, Err(GameError::InvalidMove)));
    }
}
