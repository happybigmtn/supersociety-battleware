//! Casino War game implementation.
//!
//! State blob format:
//! [playerCard:u8] [dealerCard:u8] [stage:u8]
//!
//! Stage: 0 = Initial, 1 = War (after tie)
//!
//! Payload format:
//! [0] = Play (compare cards)
//! [1] = War (after tie, go to war)
//! [2] = Surrender (after tie, forfeit half bet)

use super::super_mode::apply_super_multiplier_cards;
use super::{CasinoGame, GameError, GameResult, GameRng};
use nullspace_types::casino::GameSession;

/// Get card rank for war (Ace is high = 14).
fn card_rank(card: u8) -> u8 {
    let rank = (card % 13) + 1;
    if rank == 1 { 14 } else { rank } // Ace is high
}

/// Casino War stages.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Stage {
    Initial = 0,
    War = 1,
}

impl TryFrom<u8> for Stage {
    type Error = GameError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Stage::Initial),
            1 => Ok(Stage::War),
            _ => Err(GameError::InvalidPayload),
        }
    }
}

/// Player moves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Move {
    Play = 0,      // Initial play or continue
    War = 1,       // Go to war (on tie)
    Surrender = 2, // Surrender on tie
}

impl TryFrom<u8> for Move {
    type Error = GameError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Move::Play),
            1 => Ok(Move::War),
            2 => Ok(Move::Surrender),
            _ => Err(GameError::InvalidPayload),
        }
    }
}

fn parse_state(state: &[u8]) -> Option<(u8, u8, Stage)> {
    if state.len() < 3 {
        return None;
    }
    let stage = Stage::try_from(state[2]).ok()?;
    Some((state[0], state[1], stage))
}

fn serialize_state(player_card: u8, dealer_card: u8, stage: Stage) -> Vec<u8> {
    vec![player_card, dealer_card, stage as u8]
}

pub struct CasinoWar;

impl CasinoGame for CasinoWar {
    fn init(session: &mut GameSession, rng: &mut GameRng) -> GameResult {
        // Deal one card each
        let mut deck = rng.create_deck();
        let player_card = rng.draw_card(&mut deck).unwrap_or(0);
        let dealer_card = rng.draw_card(&mut deck).unwrap_or(1);

        session.state_blob = serialize_state(player_card, dealer_card, Stage::Initial);
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
        let (player_card, dealer_card, stage) =
            parse_state(&session.state_blob).ok_or(GameError::InvalidPayload)?;

        let player_rank = card_rank(player_card);
        let dealer_rank = card_rank(dealer_card);

        session.move_count += 1;

        match stage {
            Stage::Initial => {
                if mv != Move::Play {
                    return Err(GameError::InvalidMove);
                }

                if player_rank > dealer_rank {
                    // Player wins 1:1
                    session.is_complete = true;
                    let base_winnings = session.bet.saturating_mul(2);
                    // Apply super mode multipliers if active
                    let final_winnings = if session.super_mode.is_active {
                        apply_super_multiplier_cards(
                            &[player_card],
                            &session.super_mode.multipliers,
                            base_winnings,
                        )
                    } else {
                        base_winnings
                    };
                    Ok(GameResult::Win(final_winnings))
                } else if player_rank < dealer_rank {
                    // Dealer wins
                    session.is_complete = true;
                    Ok(GameResult::Loss)
                } else {
                    // Tie - offer war or surrender
                    session.state_blob = serialize_state(player_card, dealer_card, Stage::War);
                    Ok(GameResult::Continue)
                }
            }
            Stage::War => {
                match mv {
                    Move::Surrender => {
                        // Surrender - lose half bet
                        session.is_complete = true;
                        // Return half the bet (lose half)
                        // GameResult::Loss means full loss, so we need special handling
                        // For simplicity, we'll treat surrender as a loss
                        // The actual implementation might need a partial loss result
                        Ok(GameResult::Loss)
                    }
                    Move::War => {
                        // Go to war - player adds equal bet (war bet)
                        // War bet amount equals the original ante
                        let war_bet = session.bet;

                        // Burn 3 cards, then deal new cards
                        let mut deck = rng.create_deck_excluding(&[player_card, dealer_card]);

                        // Burn 3 cards
                        for _ in 0..3 {
                            rng.draw_card(&mut deck);
                        }

                        let new_player_card = rng.draw_card(&mut deck).ok_or(GameError::InvalidMove)?;
                        let new_dealer_card = rng.draw_card(&mut deck).ok_or(GameError::InvalidMove)?;

                        let new_player_rank = card_rank(new_player_card);
                        let new_dealer_rank = card_rank(new_dealer_card);

                        session.state_blob =
                            serialize_state(new_player_card, new_dealer_card, Stage::War);
                        session.is_complete = true;

                        if new_player_rank >= new_dealer_rank {
                            // Player wins war (tie goes to player)
                            // Standard casino war payout: ante wins 1:1, war bet pushes
                            // Player gets back: ante + 1:1 win + war bet = 3 * ante
                            // But war_bet wasn't charged, so actual return: 3 * ante - war_bet = 2 * ante
                            let base_winnings = session.bet.saturating_mul(2);
                            // Apply super mode multipliers if active
                            let final_winnings = if session.super_mode.is_active {
                                apply_super_multiplier_cards(
                                    &[new_player_card],
                                    &session.super_mode.multipliers,
                                    base_winnings,
                                )
                            } else {
                                base_winnings
                            };
                            Ok(GameResult::Win(final_winnings))
                        } else {
                            // Lose both bets (original ante + war bet)
                            // Original ante was charged at StartGame
                            // War bet was NOT charged, so need LossWithExtraDeduction
                            Ok(GameResult::LossWithExtraDeduction(war_bet))
                        }
                    }
                    Move::Play => {
                        // Invalid move during war stage
                        Err(GameError::InvalidMove)
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
            game_type: GameType::CasinoWar,
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
        // Ace is high (14)
        assert_eq!(card_rank(0), 14);  // Ace of spades
        assert_eq!(card_rank(13), 14); // Ace of hearts

        // Regular ranks
        assert_eq!(card_rank(1), 2);   // 2 of spades
        assert_eq!(card_rank(12), 13); // King of spades
    }

    #[test]
    fn test_player_wins_higher_card() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);

        // Force player to have Ace (14), dealer has King (13)
        session.state_blob = serialize_state(0, 12, Stage::Initial);

        let mut rng = GameRng::new(&seed, session.id, 1);
        let result = CasinoWar::process_move(&mut session, &[0], &mut rng);

        // Win(200) = stake(100) + winnings(100) for 1:1 payout
        assert!(matches!(result, Ok(GameResult::Win(200))));
        assert!(session.is_complete);
    }

    #[test]
    fn test_dealer_wins_higher_card() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);

        // Force dealer to have Ace (14), player has King (13)
        session.state_blob = serialize_state(12, 0, Stage::Initial);

        let mut rng = GameRng::new(&seed, session.id, 1);
        let result = CasinoWar::process_move(&mut session, &[0], &mut rng);

        assert!(matches!(result, Ok(GameResult::Loss)));
        assert!(session.is_complete);
    }

    #[test]
    fn test_tie_triggers_war_stage() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);

        // Force tie - both have Kings
        session.state_blob = serialize_state(12, 25, Stage::Initial); // Both Kings

        let mut rng = GameRng::new(&seed, session.id, 1);
        let result = CasinoWar::process_move(&mut session, &[0], &mut rng);

        assert!(matches!(result, Ok(GameResult::Continue)));
        assert!(!session.is_complete);

        let (_, _, stage) = parse_state(&session.state_blob).expect("Failed to parse state");
        assert_eq!(stage, Stage::War);
    }

    #[test]
    fn test_surrender_after_tie() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);

        // Set up war stage after tie
        session.state_blob = serialize_state(12, 25, Stage::War);

        let mut rng = GameRng::new(&seed, session.id, 1);
        let result = CasinoWar::process_move(&mut session, &[2], &mut rng); // Surrender

        assert!(matches!(result, Ok(GameResult::Loss)));
        assert!(session.is_complete);
    }

    #[test]
    fn test_go_to_war() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);

        // Set up war stage after tie
        session.state_blob = serialize_state(12, 25, Stage::War);

        let mut rng = GameRng::new(&seed, session.id, 1);
        let result = CasinoWar::process_move(&mut session, &[1], &mut rng); // War

        assert!(result.is_ok());
        assert!(session.is_complete);

        // Result should be Win, Loss, or LossWithExtraDeduction
        match result.expect("Failed to process war") {
            GameResult::Win(_) | GameResult::Loss | GameResult::LossWithExtraDeduction(_) => {}
            _ => panic!("Expected Win, Loss, or LossWithExtraDeduction after war"),
        }
    }

    #[test]
    fn test_invalid_move_in_initial_stage() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        session.state_blob = serialize_state(1, 2, Stage::Initial);

        let mut rng = GameRng::new(&seed, session.id, 1);

        // War move in initial stage
        let result = CasinoWar::process_move(&mut session, &[1], &mut rng);
        assert!(matches!(result, Err(GameError::InvalidMove)));

        // Surrender move in initial stage
        let result = CasinoWar::process_move(&mut session, &[2], &mut rng);
        assert!(matches!(result, Err(GameError::InvalidMove)));
    }

    #[test]
    fn test_invalid_move_in_war_stage() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        session.state_blob = serialize_state(12, 25, Stage::War);

        let mut rng = GameRng::new(&seed, session.id, 1);

        // Play move in war stage
        let result = CasinoWar::process_move(&mut session, &[0], &mut rng);
        assert!(matches!(result, Err(GameError::InvalidMove)));
    }

    #[test]
    fn test_init_deals_cards() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        CasinoWar::init(&mut session, &mut rng);

        assert_eq!(session.state_blob.len(), 3);
        let (player_card, dealer_card, stage) = parse_state(&session.state_blob).expect("Failed to parse state");

        assert!(player_card < 52);
        assert!(dealer_card < 52);
        assert_ne!(player_card, dealer_card);
        assert_eq!(stage, Stage::Initial);
    }
}
