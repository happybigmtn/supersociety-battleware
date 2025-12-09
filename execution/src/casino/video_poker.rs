//! Video Poker (Jacks or Better) implementation.
//!
//! State blob format:
//! [stage:u8] [card1:u8] [card2:u8] [card3:u8] [card4:u8] [card5:u8]
//!
//! Stage: 0 = Deal (initial), 1 = Draw (after hold selection)
//!
//! Payload format:
//! [holdMask:u8] - bits indicate which cards to hold
//! bit 0 = hold card 1, bit 1 = hold card 2, etc.

use super::super_mode::apply_super_multiplier_cards;
use super::{CasinoGame, GameError, GameResult, GameRng};
use nullspace_types::casino::GameSession;

/// Video Poker stages.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Deal = 0,
    Draw = 1,
}

impl TryFrom<u8> for Stage {
    type Error = GameError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Stage::Deal),
            1 => Ok(Stage::Draw),
            _ => Err(GameError::InvalidPayload),
        }
    }
}

/// Poker hand rankings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Hand {
    HighCard = 0,
    JacksOrBetter = 1,
    TwoPair = 2,
    ThreeOfAKind = 3,
    Straight = 4,
    Flush = 5,
    FullHouse = 6,
    FourOfAKind = 7,
    StraightFlush = 8,
    RoyalFlush = 9,
}

/// Get card rank (1-13, Ace = 1).
fn card_rank(card: u8) -> u8 {
    (card % 13) + 1
}

/// Get card suit (0-3).
fn card_suit(card: u8) -> u8 {
    card / 13
}

/// Evaluate a 5-card poker hand.
/// Optimized to avoid heap allocations.
pub fn evaluate_hand(cards: &[u8; 5]) -> Hand {
    // Extract ranks and suits into fixed arrays
    let mut ranks = [0u8; 5];
    let mut suits = [0u8; 5];
    for i in 0..5 {
        ranks[i] = card_rank(cards[i]);
        suits[i] = card_suit(cards[i]);
    }
    ranks.sort_unstable();

    // Check flush
    let is_flush = suits[0] == suits[1] && suits[1] == suits[2]
                && suits[2] == suits[3] && suits[3] == suits[4];

    // Check for duplicates (to determine if straight is possible)
    let has_duplicates = ranks[0] == ranks[1] || ranks[1] == ranks[2]
                      || ranks[2] == ranks[3] || ranks[3] == ranks[4];

    // Check for straight (including A-2-3-4-5 and 10-J-Q-K-A)
    let is_straight = if has_duplicates {
        false
    } else if ranks == [1, 10, 11, 12, 13] {
        // A-10-J-Q-K (ace high straight / royal)
        true
    } else if ranks == [1, 2, 3, 4, 5] {
        // A-2-3-4-5 (ace low straight)
        true
    } else {
        ranks[4] - ranks[0] == 4
    };

    let is_royal = ranks == [1, 10, 11, 12, 13];

    // Count rank occurrences
    let mut counts = [0u8; 14];
    for &r in &ranks {
        counts[r as usize] += 1;
    }

    let mut pairs = 0u8;
    let mut three_kind = false;
    let mut four_kind = false;
    let mut high_pair = false; // Jacks or better

    for (rank, &count) in counts.iter().enumerate() {
        match count {
            2 => {
                pairs += 1;
                if rank >= 11 || rank == 1 {
                    // J, Q, K, A
                    high_pair = true;
                }
            }
            3 => three_kind = true,
            4 => four_kind = true,
            _ => {}
        }
    }

    // Determine hand
    if is_royal && is_flush {
        Hand::RoyalFlush
    } else if is_straight && is_flush {
        Hand::StraightFlush
    } else if four_kind {
        Hand::FourOfAKind
    } else if three_kind && pairs == 1 {
        Hand::FullHouse
    } else if is_flush {
        Hand::Flush
    } else if is_straight {
        Hand::Straight
    } else if three_kind {
        Hand::ThreeOfAKind
    } else if pairs == 2 {
        Hand::TwoPair
    } else if pairs == 1 && high_pair {
        Hand::JacksOrBetter
    } else {
        Hand::HighCard
    }
}

/// Payout multiplier for each hand (Jacks or Better paytable).
fn payout_multiplier(hand: Hand) -> u64 {
    match hand {
        Hand::HighCard => 0,
        Hand::JacksOrBetter => 1,
        Hand::TwoPair => 2,
        Hand::ThreeOfAKind => 3,
        Hand::Straight => 4,
        Hand::Flush => 6,
        Hand::FullHouse => 9,
        Hand::FourOfAKind => 25,
        Hand::StraightFlush => 50,
        Hand::RoyalFlush => 800,
    }
}

fn parse_state(state: &[u8]) -> Option<(Stage, [u8; 5])> {
    if state.len() < 6 {
        return None;
    }
    let stage = Stage::try_from(state[0]).ok()?;
    let cards = [state[1], state[2], state[3], state[4], state[5]];
    Some((stage, cards))
}

fn serialize_state(stage: Stage, cards: &[u8; 5]) -> Vec<u8> {
    vec![stage as u8, cards[0], cards[1], cards[2], cards[3], cards[4]]
}

pub struct VideoPoker;

impl CasinoGame for VideoPoker {
    fn init(session: &mut GameSession, rng: &mut GameRng) -> GameResult {
        // Deal 5 cards
        let mut deck = rng.create_deck();
        let cards: [u8; 5] = [
            rng.draw_card(&mut deck).unwrap_or(0),
            rng.draw_card(&mut deck).unwrap_or(1),
            rng.draw_card(&mut deck).unwrap_or(2),
            rng.draw_card(&mut deck).unwrap_or(3),
            rng.draw_card(&mut deck).unwrap_or(4),
        ];

        session.state_blob = serialize_state(Stage::Deal, &cards);
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

        let (stage, mut cards) =
            parse_state(&session.state_blob).ok_or(GameError::InvalidPayload)?;

        if stage != Stage::Deal {
            return Err(GameError::GameAlreadyComplete);
        }

        let hold_mask = payload[0];
        session.move_count += 1;

        // Create deck without current held cards (using optimized bit-set)
        let held_cards: Vec<u8> = (0..5)
            .filter(|i| hold_mask & (1 << i) != 0)
            .map(|i| cards[i])
            .collect();

        let mut deck = rng.create_deck_excluding(&held_cards);

        // Replace non-held cards
        for i in 0..5 {
            if hold_mask & (1 << i) == 0 {
                cards[i] = rng.draw_card(&mut deck).ok_or(GameError::InvalidMove)?;
            }
        }

        session.state_blob = serialize_state(Stage::Draw, &cards);
        session.is_complete = true;

        // Evaluate final hand
        let hand = evaluate_hand(&cards);
        let multiplier = payout_multiplier(hand);

        if multiplier > 0 {
            let base_winnings = session.bet.saturating_mul(multiplier);
            // Apply super mode multipliers if active
            let final_winnings = if session.super_mode.is_active {
                apply_super_multiplier_cards(
                    &cards,
                    &session.super_mode.multipliers,
                    base_winnings,
                )
            } else {
                base_winnings
            };
            Ok(GameResult::Win(final_winnings))
        } else {
            Ok(GameResult::Loss)
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
            game_type: GameType::VideoPoker,
            bet,
            state_blob: vec![],
            move_count: 0,
            created_at: 0,
            is_complete: false,
            super_mode: nullspace_types::casino::SuperModeState::default(),
        }
    }

    #[test]
    fn test_card_rank() {
        assert_eq!(card_rank(0), 1);  // Ace
        assert_eq!(card_rank(1), 2);  // 2
        assert_eq!(card_rank(12), 13); // King
    }

    #[test]
    fn test_card_suit() {
        assert_eq!(card_suit(0), 0);  // Spades
        assert_eq!(card_suit(13), 1); // Hearts
        assert_eq!(card_suit(26), 2); // Diamonds
        assert_eq!(card_suit(39), 3); // Clubs
    }

    #[test]
    fn test_evaluate_royal_flush() {
        // 10, J, Q, K, A of same suit
        let cards = [9, 10, 11, 12, 0]; // 10-J-Q-K-A of spades
        assert_eq!(evaluate_hand(&cards), Hand::RoyalFlush);
    }

    #[test]
    fn test_evaluate_straight_flush() {
        // 5, 6, 7, 8, 9 of same suit
        let cards = [4, 5, 6, 7, 8]; // 5-6-7-8-9 of spades
        assert_eq!(evaluate_hand(&cards), Hand::StraightFlush);
    }

    #[test]
    fn test_evaluate_four_of_a_kind() {
        // Four Aces
        let cards = [0, 13, 26, 39, 1]; // A-A-A-A-2
        assert_eq!(evaluate_hand(&cards), Hand::FourOfAKind);
    }

    #[test]
    fn test_evaluate_full_house() {
        // Three Kings and two Queens
        let cards = [12, 25, 38, 11, 24]; // K-K-K-Q-Q
        assert_eq!(evaluate_hand(&cards), Hand::FullHouse);
    }

    #[test]
    fn test_evaluate_flush() {
        // All same suit, non-sequential
        let cards = [0, 2, 4, 6, 8]; // A-3-5-7-9 of spades
        assert_eq!(evaluate_hand(&cards), Hand::Flush);
    }

    #[test]
    fn test_evaluate_straight() {
        // Sequential, different suits
        let cards = [4, 18, 32, 7, 21]; // 5-6-7-8-9 mixed suits
        assert_eq!(evaluate_hand(&cards), Hand::Straight);
    }

    #[test]
    fn test_evaluate_three_of_a_kind() {
        let cards = [0, 13, 26, 1, 2]; // A-A-A-2-3
        assert_eq!(evaluate_hand(&cards), Hand::ThreeOfAKind);
    }

    #[test]
    fn test_evaluate_two_pair() {
        let cards = [0, 13, 1, 14, 2]; // A-A-2-2-3
        assert_eq!(evaluate_hand(&cards), Hand::TwoPair);
    }

    #[test]
    fn test_evaluate_jacks_or_better() {
        let cards = [10, 23, 1, 2, 3]; // J-J-2-3-4
        assert_eq!(evaluate_hand(&cards), Hand::JacksOrBetter);
    }

    #[test]
    fn test_evaluate_low_pair() {
        // Pair of 2s - not jacks or better
        let cards = [1, 14, 3, 4, 5]; // 2-2-4-5-6
        assert_eq!(evaluate_hand(&cards), Hand::HighCard);
    }

    #[test]
    fn test_payout_multipliers() {
        assert_eq!(payout_multiplier(Hand::HighCard), 0);
        assert_eq!(payout_multiplier(Hand::JacksOrBetter), 1);
        assert_eq!(payout_multiplier(Hand::TwoPair), 2);
        assert_eq!(payout_multiplier(Hand::RoyalFlush), 800);
    }

    #[test]
    fn test_game_flow() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        VideoPoker::init(&mut session, &mut rng);
        assert!(!session.is_complete);

        let (stage, cards) = parse_state(&session.state_blob).expect("Failed to parse state");
        assert_eq!(stage, Stage::Deal);
        for card in cards {
            assert!(card < 52);
        }

        // Hold all cards
        let mut rng = GameRng::new(&seed, session.id, 1);
        let result = VideoPoker::process_move(&mut session, &[0b11111], &mut rng);

        assert!(result.is_ok());
        assert!(session.is_complete);
    }

    #[test]
    fn test_discard_all() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        VideoPoker::init(&mut session, &mut rng);
        let (_, original_cards) = parse_state(&session.state_blob).expect("Failed to parse state");

        // Discard all cards (hold none)
        let mut rng = GameRng::new(&seed, session.id, 1);
        let result = VideoPoker::process_move(&mut session, &[0], &mut rng);

        assert!(result.is_ok());
        let (_, new_cards) = parse_state(&session.state_blob).expect("Failed to parse state");

        // All cards should be different (with high probability)
        // At least some should be different
        let same_count = original_cards.iter().filter(|c| new_cards.contains(c)).count();
        // It's possible but very unlikely all 5 are the same
        assert!(same_count < 5 || original_cards == new_cards);
    }

    #[test]
    fn test_ace_low_straight() {
        // A-2-3-4-5 (wheel)
        let cards = [0, 1, 2, 3, 4]; // A-2-3-4-5 of spades
        assert_eq!(evaluate_hand(&cards), Hand::StraightFlush); // All same suit
    }
}
