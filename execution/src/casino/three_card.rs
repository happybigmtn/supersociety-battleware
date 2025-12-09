//! Three Card Poker implementation.
//!
//! State blob format:
//! [playerCard1:u8] [playerCard2:u8] [playerCard3:u8]
//! [dealerCard1:u8] [dealerCard2:u8] [dealerCard3:u8]
//! [stage:u8]
//!
//! Stage: 0 = Ante posted, waiting for play/fold
//!        1 = Complete
//!
//! Payload format:
//! [0] = Play (match ante)
//! [1] = Fold (lose ante)

use super::super_mode::apply_super_multiplier_cards;
use super::{CasinoGame, GameError, GameResult, GameRng};
use nullspace_types::casino::GameSession;

/// Three Card Poker stages.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Ante = 0,
    Complete = 1,
}

impl TryFrom<u8> for Stage {
    type Error = GameError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Stage::Ante),
            1 => Ok(Stage::Complete),
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
}

impl TryFrom<u8> for Move {
    type Error = GameError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Move::Play),
            1 => Ok(Move::Fold),
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

/// Get card rank (1-13, Ace = 14 for comparison).
fn card_rank(card: u8) -> u8 {
    let r = (card % 13) + 1;
    if r == 1 { 14 } else { r } // Ace high
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

    // Check for straight
    let mut sorted_ranks = ranks.clone();
    sorted_ranks.sort_unstable();
    let is_straight = {
        let r = &sorted_ranks;
        // Normal straight
        (r[2] - r[0] == 2 && r[1] - r[0] == 1) ||
        // Ace-low (A-2-3)
        (sorted_ranks == vec![2, 3, 14])
    };

    // Check for pairs/trips
    let is_pair = ranks[0] == ranks[1] || ranks[1] == ranks[2] || ranks[0] == ranks[2];
    let is_trips = ranks[0] == ranks[1] && ranks[1] == ranks[2];

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

/// Compare two hands, returns Ordering.
fn compare_hands(h1: &(HandRank, [u8; 3]), h2: &(HandRank, [u8; 3])) -> std::cmp::Ordering {
    match h1.0.cmp(&h2.0) {
        std::cmp::Ordering::Equal => {
            // Compare high cards
            h1.1.cmp(&h2.1)
        }
        other => other,
    }
}

/// Ante bonus payout multiplier.
fn ante_bonus(hand_rank: HandRank) -> u64 {
    match hand_rank {
        HandRank::StraightFlush => 5,
        HandRank::ThreeOfAKind => 4,
        HandRank::Straight => 1,
        _ => 0,
    }
}

fn parse_state(state: &[u8]) -> Option<([u8; 3], [u8; 3], Stage)> {
    if state.len() < 7 {
        return None;
    }
    let player = [state[0], state[1], state[2]];
    let dealer = [state[3], state[4], state[5]];
    let stage = Stage::try_from(state[6]).ok()?;
    Some((player, dealer, stage))
}

fn serialize_state(player: &[u8; 3], dealer: &[u8; 3], stage: Stage) -> Vec<u8> {
    vec![
        player[0], player[1], player[2],
        dealer[0], dealer[1], dealer[2],
        stage as u8,
    ]
}

pub struct ThreeCardPoker;

impl CasinoGame for ThreeCardPoker {
    fn init(session: &mut GameSession, rng: &mut GameRng) -> GameResult {
        // Deal 3 cards each
        let mut deck = rng.create_deck();
        let player = [
            rng.draw_card(&mut deck).unwrap_or(0),
            rng.draw_card(&mut deck).unwrap_or(1),
            rng.draw_card(&mut deck).unwrap_or(2),
        ];
        let dealer = [
            rng.draw_card(&mut deck).unwrap_or(3),
            rng.draw_card(&mut deck).unwrap_or(4),
            rng.draw_card(&mut deck).unwrap_or(5),
        ];

        session.state_blob = serialize_state(&player, &dealer, Stage::Ante);
        GameResult::Continue
    }

    fn process_move(
        session: &mut GameSession,
        payload: &[u8],
        _rng: &mut GameRng,
    ) -> Result<GameResult, GameError> {
        if session.is_complete {
            return Err(GameError::GameAlreadyComplete);
        }

        if payload.is_empty() {
            return Err(GameError::InvalidPayload);
        }

        let mv = Move::try_from(payload[0])?;
        let (player_cards, dealer_cards, stage) =
            parse_state(&session.state_blob).ok_or(GameError::InvalidPayload)?;

        if stage != Stage::Ante {
            return Err(GameError::GameAlreadyComplete);
        }

        session.move_count += 1;
        session.state_blob = serialize_state(&player_cards, &dealer_cards, Stage::Complete);
        session.is_complete = true;

        match mv {
            Move::Fold => {
                // Lose ante
                Ok(GameResult::Loss)
            }
            Move::Play => {
                let player_hand = evaluate_hand(&player_cards);
                let dealer_hand = evaluate_hand(&dealer_cards);

                // Dealer needs Queen high to qualify
                let dealer_qualifies = dealer_hand.0 >= HandRank::Pair ||
                    dealer_hand.1[0] >= 12; // Queen or higher

                // Calculate ante bonus (paid regardless of dealer) with overflow protection
                let bonus = session.bet.saturating_mul(ante_bonus(player_hand.0));

                // NOTE: play_bet was NOT charged at StartGame, so we must adjust payouts.
                // play_bet = ante = session.bet
                let play_bet = session.bet;

                if !dealer_qualifies {
                    // Ante pays 1:1 (2x return), play bet pushes (1x return), plus bonus
                    // Calculated return: 2*Ante + 1*Play + Bonus = 3*bet + Bonus
                    // Actual return: subtract play_bet (wasn't charged) = 2*bet + Bonus
                    let base_return = session.bet.saturating_mul(2).saturating_add(bonus);
                    // Apply super mode multipliers if active
                    let final_return = if session.super_mode.is_active {
                        apply_super_multiplier_cards(
                            &player_cards,
                            &session.super_mode.multipliers,
                            base_return,
                        )
                    } else {
                        base_return
                    };
                    Ok(GameResult::Win(final_return))
                } else {
                    // Compare hands
                    match compare_hands(&player_hand, &dealer_hand) {
                        std::cmp::Ordering::Greater => {
                            // Player wins: ante and play both pay 1:1
                            // Calculated return: 2*Ante + 2*Play + Bonus = 4*bet + Bonus
                            // Actual return: subtract play_bet = 3*bet + Bonus
                            let base_return = session.bet.saturating_mul(3).saturating_add(bonus);
                            // Apply super mode multipliers if active
                            let final_return = if session.super_mode.is_active {
                                apply_super_multiplier_cards(
                                    &player_cards,
                                    &session.super_mode.multipliers,
                                    base_return,
                                )
                            } else {
                                base_return
                            };
                            Ok(GameResult::Win(final_return))
                        }
                        std::cmp::Ordering::Less => {
                            // Dealer wins: lose ante and play
                            // Play bet was NOT charged, so need LossWithExtraDeduction
                            // Bonus is paid regardless - it reduces the loss
                            if bonus > 0 {
                                // Net: -ante - play + bonus
                                // Since only ante was charged, we need to deduct play_bet
                                // and add the bonus
                                if bonus > play_bet {
                                    // Bonus covers play_bet loss, return remainder
                                    Ok(GameResult::Win(bonus.saturating_sub(play_bet)))
                                } else {
                                    // Play_bet loss exceeds bonus
                                    Ok(GameResult::LossWithExtraDeduction(play_bet.saturating_sub(bonus)))
                                }
                            } else {
                                Ok(GameResult::LossWithExtraDeduction(play_bet))
                            }
                        }
                        std::cmp::Ordering::Equal => {
                            // Push - Return Ante + Play + Bonus
                            // Actual return: just Ante + Bonus (play_bet wasn't charged)
                            let base_return = session.bet.saturating_add(bonus);
                            // Apply super mode multipliers if active (even on push with bonus)
                            let final_return = if session.super_mode.is_active && bonus > 0 {
                                apply_super_multiplier_cards(
                                    &player_cards,
                                    &session.super_mode.multipliers,
                                    base_return,
                                )
                            } else {
                                base_return
                            };
                            Ok(GameResult::Win(final_return))
                        }
                    }
                }
            }
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
        }
    }

    #[test]
    fn test_evaluate_straight_flush() {
        let cards = [0, 1, 2]; // A-2-3 of spades
        let (rank, _) = evaluate_hand(&cards);
        assert_eq!(rank, HandRank::StraightFlush);
    }

    #[test]
    fn test_evaluate_three_of_a_kind() {
        let cards = [0, 13, 26]; // A-A-A
        let (rank, _) = evaluate_hand(&cards);
        assert_eq!(rank, HandRank::ThreeOfAKind);
    }

    #[test]
    fn test_evaluate_straight() {
        let cards = [4, 18, 32]; // 5-6-7 different suits
        let (rank, _) = evaluate_hand(&cards);
        assert_eq!(rank, HandRank::Straight);
    }

    #[test]
    fn test_evaluate_flush() {
        let cards = [0, 3, 7]; // A-4-8 of spades
        let (rank, _) = evaluate_hand(&cards);
        assert_eq!(rank, HandRank::Flush);
    }

    #[test]
    fn test_evaluate_pair() {
        let cards = [0, 13, 2]; // A-A-3
        let (rank, _) = evaluate_hand(&cards);
        assert_eq!(rank, HandRank::Pair);
    }

    #[test]
    fn test_evaluate_high_card() {
        let cards = [0, 15, 30]; // A-3-5 different suits
        let (rank, _) = evaluate_hand(&cards);
        assert_eq!(rank, HandRank::HighCard);
    }

    #[test]
    fn test_ante_bonus() {
        assert_eq!(ante_bonus(HandRank::StraightFlush), 5);
        assert_eq!(ante_bonus(HandRank::ThreeOfAKind), 4);
        assert_eq!(ante_bonus(HandRank::Straight), 1);
        assert_eq!(ante_bonus(HandRank::Flush), 0);
        assert_eq!(ante_bonus(HandRank::Pair), 0);
    }

    #[test]
    fn test_fold() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        ThreeCardPoker::init(&mut session, &mut rng);

        let mut rng = GameRng::new(&seed, session.id, 1);
        let result = ThreeCardPoker::process_move(&mut session, &[1], &mut rng); // Fold

        assert!(matches!(result, Ok(GameResult::Loss)));
        assert!(session.is_complete);
    }

    #[test]
    fn test_play() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        ThreeCardPoker::init(&mut session, &mut rng);

        let mut rng = GameRng::new(&seed, session.id, 1);
        let result = ThreeCardPoker::process_move(&mut session, &[0], &mut rng); // Play

        assert!(result.is_ok());
        assert!(session.is_complete);

        // Result should be Win, Loss, or Push
        match result.expect("Failed to process move") {
            GameResult::Win(_) | GameResult::Loss | GameResult::Push => {}
            _ => panic!("Invalid result"),
        }
    }

    #[test]
    fn test_init_deals_cards() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        ThreeCardPoker::init(&mut session, &mut rng);

        let (player, dealer, stage) = parse_state(&session.state_blob).expect("Failed to parse state");
        assert_eq!(stage, Stage::Ante);

        for card in player.iter().chain(dealer.iter()) {
            assert!(*card < 52);
        }

        // All cards should be unique
        let mut all_cards = player.to_vec();
        all_cards.extend_from_slice(&dealer);
        all_cards.sort_unstable();
        all_cards.dedup();
        assert_eq!(all_cards.len(), 6);
    }
}
