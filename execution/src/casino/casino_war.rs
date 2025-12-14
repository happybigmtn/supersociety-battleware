//! Casino War game implementation.
//!
//! State blob format:
//! v1: [version:u8=1] [stage:u8] [playerCard:u8] [dealerCard:u8] [tie_bet:u64 BE]
//! legacy: [playerCard:u8] [dealerCard:u8] [stage:u8]
//!
//! v1 Stage: 0 = Betting (pre-deal), 1 = War (after tie), 2 = Complete
//! legacy Stage: 0 = Initial, 1 = War (after tie)
//!
//! Payload format:
//! [0] = Play (in v1 Betting: deal + compare; in legacy Initial: compare)
//! [1] = War (after tie, go to war)
//! [2] = Surrender (after tie, forfeit half bet)
//! [3, tie_bet:u64 BE] = Set tie bet (v1 Betting only)

use super::super_mode::apply_super_multiplier_cards;
use super::{CasinoGame, GameError, GameResult, GameRng};
use nullspace_types::casino::GameSession;

const STATE_VERSION_V1: u8 = 1;
const HIDDEN_CARD: u8 = 0xFF;
const TIE_BET_PAYOUT_TO_1: u64 = 10;
const TIE_AFTER_TIE_BONUS_MULTIPLIER: u64 = 1;
/// WoO: Casino War is played with six decks.
const CASINO_WAR_DECKS: u8 = 6;

/// Get card rank for war (Ace is high = 14).
fn card_rank(card: u8) -> u8 {
    let rank = (card % 13) + 1;
    if rank == 1 {
        14
    } else {
        rank
    } // Ace is high
}

/// Casino War stages.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum StageV1 {
    Betting = 0,
    War = 1,
    Complete = 2,
}

impl TryFrom<u8> for StageV1 {
    type Error = GameError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(StageV1::Betting),
            1 => Ok(StageV1::War),
            2 => Ok(StageV1::Complete),
            _ => Err(GameError::InvalidPayload),
        }
    }
}

/// Legacy stages (pre-versioned state).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
enum StageV0 {
    Initial = 0,
    War = 1,
}

impl TryFrom<u8> for StageV0 {
    type Error = GameError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(StageV0::Initial),
            1 => Ok(StageV0::War),
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
    SetTieBet = 3, // Set optional tie bet (v1 betting stage only)
}

impl TryFrom<u8> for Move {
    type Error = GameError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Move::Play),
            1 => Ok(Move::War),
            2 => Ok(Move::Surrender),
            3 => Ok(Move::SetTieBet),
            _ => Err(GameError::InvalidPayload),
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct CasinoWarStateV1 {
    player_card: u8,
    dealer_card: u8,
    stage: StageV1,
    tie_bet: u64,
}

fn parse_state(state: &[u8]) -> Option<Result<CasinoWarStateV1, (u8, u8, StageV0)>> {
    // v1
    if state.len() >= 12 && state[0] == STATE_VERSION_V1 {
        let stage = StageV1::try_from(state[1]).ok()?;
        let player_card = state[2];
        let dealer_card = state[3];
        let tie_bet = u64::from_be_bytes(state[4..12].try_into().ok()?);
        return Some(Ok(CasinoWarStateV1 {
            player_card,
            dealer_card,
            stage,
            tie_bet,
        }));
    }

    // legacy
    if state.len() < 3 {
        return None;
    }
    let stage = StageV0::try_from(state[2]).ok()?;
    Some(Err((state[0], state[1], stage)))
}

fn serialize_state_v1(state: &CasinoWarStateV1) -> Vec<u8> {
    let mut out = Vec::with_capacity(12);
    out.push(STATE_VERSION_V1);
    out.push(state.stage as u8);
    out.push(state.player_card);
    out.push(state.dealer_card);
    out.extend_from_slice(&state.tie_bet.to_be_bytes());
    out
}

fn serialize_state_legacy(player_card: u8, dealer_card: u8, stage: StageV0) -> Vec<u8> {
    vec![player_card, dealer_card, stage as u8]
}

pub struct CasinoWar;

impl CasinoGame for CasinoWar {
    fn init(session: &mut GameSession, _rng: &mut GameRng) -> GameResult {
        // Start in a betting stage so optional side bets can be placed before the deal.
        let state = CasinoWarStateV1 {
            player_card: HIDDEN_CARD,
            dealer_card: HIDDEN_CARD,
            stage: StageV1::Betting,
            tie_bet: 0,
        };
        session.state_blob = serialize_state_v1(&state);
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
        let parsed = parse_state(&session.state_blob).ok_or(GameError::InvalidPayload)?;

        session.move_count += 1;

        match parsed {
            // v1 flow with tie bet support
            Ok(mut state) => match state.stage {
                StageV1::Betting => match mv {
                    Move::SetTieBet => {
                        if payload.len() != 9 {
                            return Err(GameError::InvalidPayload);
                        }
                        let next_amount = u64::from_be_bytes(
                            payload[1..9]
                                .try_into()
                                .map_err(|_| GameError::InvalidPayload)?,
                        );

                        let prev_amount = state.tie_bet;

                        // We only support i64 deltas in ContinueWithUpdate.
                        let (payout, new_tie_bet) = if next_amount >= prev_amount {
                            let delta = next_amount - prev_amount;
                            let delta_i64 =
                                i64::try_from(delta).map_err(|_| GameError::InvalidPayload)?;
                            (-(delta_i64), next_amount)
                        } else {
                            let delta = prev_amount - next_amount;
                            let delta_i64 =
                                i64::try_from(delta).map_err(|_| GameError::InvalidPayload)?;
                            (delta_i64, next_amount)
                        };

                        state.tie_bet = new_tie_bet;
                        session.state_blob = serialize_state_v1(&state);
                        Ok(GameResult::ContinueWithUpdate { payout })
                    }
                    Move::Play => {
                        if payload.len() != 1 {
                            return Err(GameError::InvalidPayload);
                        }

                        // Deal one card each.
                        let mut deck = rng.create_shoe(CASINO_WAR_DECKS);
                        let player_card = rng.draw_card(&mut deck).unwrap_or(0);
                        let dealer_card = rng.draw_card(&mut deck).unwrap_or(1);

                        let player_rank = card_rank(player_card);
                        let dealer_rank = card_rank(dealer_card);

                        // Tie bet pays on initial tie only.
                        let tie_bet_return: i64 = if state.tie_bet > 0 && player_rank == dealer_rank
                        {
                            let credited = state
                                .tie_bet
                                .saturating_mul(TIE_BET_PAYOUT_TO_1.saturating_add(1));
                            i64::try_from(credited).map_err(|_| GameError::InvalidPayload)?
                        } else {
                            0
                        };

                        if player_rank > dealer_rank {
                            // Player wins 1:1.
                            state.stage = StageV1::Complete;
                            state.player_card = player_card;
                            state.dealer_card = dealer_card;
                            session.state_blob = serialize_state_v1(&state);
                            session.is_complete = true;

                            let base_winnings = session.bet.saturating_mul(2);
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
                            // Dealer wins.
                            state.stage = StageV1::Complete;
                            state.player_card = player_card;
                            state.dealer_card = dealer_card;
                            session.state_blob = serialize_state_v1(&state);
                            session.is_complete = true;
                            Ok(GameResult::Loss)
                        } else {
                            // Tie: offer war or surrender, and pay tie bet (if any) immediately.
                            state.stage = StageV1::War;
                            state.player_card = player_card;
                            state.dealer_card = dealer_card;
                            session.state_blob = serialize_state_v1(&state);

                            if tie_bet_return != 0 {
                                Ok(GameResult::ContinueWithUpdate {
                                    payout: tie_bet_return,
                                })
                            } else {
                                Ok(GameResult::Continue)
                            }
                        }
                    }
                    _ => Err(GameError::InvalidMove),
                },
                StageV1::War => match mv {
                    Move::Surrender => {
                        state.stage = StageV1::Complete;
                        session.state_blob = serialize_state_v1(&state);
                        session.is_complete = true;
                        // CasinoStartGame already deducted the ante, so refund half to realize a
                        // half-loss outcome.
                        Ok(GameResult::Win(session.bet / 2))
                    }
                    Move::War => {
                        let war_bet = session.bet;

                        // Burn 3 cards, then deal new cards.
                        let mut deck = rng.create_shoe_excluding(
                            &[state.player_card, state.dealer_card],
                            CASINO_WAR_DECKS,
                        );
                        for _ in 0..3 {
                            rng.draw_card(&mut deck);
                        }

                        let new_player_card =
                            rng.draw_card(&mut deck).ok_or(GameError::InvalidMove)?;
                        let new_dealer_card =
                            rng.draw_card(&mut deck).ok_or(GameError::InvalidMove)?;

                        let new_player_rank = card_rank(new_player_card);
                        let new_dealer_rank = card_rank(new_dealer_card);

                        state.stage = StageV1::Complete;
                        state.player_card = new_player_card;
                        state.dealer_card = new_dealer_card;
                        session.state_blob = serialize_state_v1(&state);
                        session.is_complete = true;

                        if new_player_rank >= new_dealer_rank {
                            // WoO "bonus" variant: tie-after-tie awards a bonus equal to the ante.
                            // https://wizardofodds.com/games/casino-war/
                            //
                            // Note: We model the raise as a contingent loss (`LossWithExtraDeduction`)
                            // instead of a pre-deducted bet, so we express the bonus via the credited return.
                            let base_winnings = if new_player_rank == new_dealer_rank {
                                session.bet.saturating_mul(2).saturating_add(
                                    session.bet.saturating_mul(TIE_AFTER_TIE_BONUS_MULTIPLIER),
                                )
                            } else {
                                session.bet.saturating_mul(2)
                            };
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
                            // Lose both bets (ante + war bet).
                            Ok(GameResult::LossWithExtraDeduction(war_bet))
                        }
                    }
                    _ => Err(GameError::InvalidMove),
                },
                StageV1::Complete => Err(GameError::GameAlreadyComplete),
            },

            // legacy flow (pre-versioned state)
            Err((player_card, dealer_card, stage)) => {
                let player_rank = card_rank(player_card);
                let dealer_rank = card_rank(dealer_card);

                match stage {
                    StageV0::Initial => {
                        if mv != Move::Play {
                            return Err(GameError::InvalidMove);
                        }

                        if player_rank > dealer_rank {
                            session.is_complete = true;
                            let base_winnings = session.bet.saturating_mul(2);
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
                            session.is_complete = true;
                            Ok(GameResult::Loss)
                        } else {
                            session.state_blob =
                                serialize_state_legacy(player_card, dealer_card, StageV0::War);
                            Ok(GameResult::Continue)
                        }
                    }
                    StageV0::War => match mv {
                        Move::Surrender => {
                            session.is_complete = true;
                            Ok(GameResult::Win(session.bet / 2))
                        }
                        Move::War => {
                            let war_bet = session.bet;
                            let mut deck = rng.create_shoe_excluding(
                                &[player_card, dealer_card],
                                CASINO_WAR_DECKS,
                            );
                            for _ in 0..3 {
                                rng.draw_card(&mut deck);
                            }
                            let new_player_card =
                                rng.draw_card(&mut deck).ok_or(GameError::InvalidMove)?;
                            let new_dealer_card =
                                rng.draw_card(&mut deck).ok_or(GameError::InvalidMove)?;

                            let new_player_rank = card_rank(new_player_card);
                            let new_dealer_rank = card_rank(new_dealer_card);

                            session.state_blob = serialize_state_legacy(
                                new_player_card,
                                new_dealer_card,
                                StageV0::War,
                            );
                            session.is_complete = true;

                            if new_player_rank >= new_dealer_rank {
                                let base_winnings = session.bet.saturating_mul(2);
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
                                Ok(GameResult::LossWithExtraDeduction(war_bet))
                            }
                        }
                        _ => Err(GameError::InvalidMove),
                    },
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
            is_tournament: false,
            tournament_id: None,
        }
    }

    #[test]
    fn test_card_rank() {
        // Ace is high (14)
        assert_eq!(card_rank(0), 14); // Ace of spades
        assert_eq!(card_rank(13), 14); // Ace of hearts

        // Regular ranks
        assert_eq!(card_rank(1), 2); // 2 of spades
        assert_eq!(card_rank(12), 13); // King of spades
    }

    #[test]
    fn test_player_wins_higher_card() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);

        // Force player to have Ace (14), dealer has King (13)
        session.state_blob = serialize_state_legacy(0, 12, StageV0::Initial);

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
        session.state_blob = serialize_state_legacy(12, 0, StageV0::Initial);

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
        session.state_blob = serialize_state_legacy(12, 25, StageV0::Initial); // Both Kings

        let mut rng = GameRng::new(&seed, session.id, 1);
        let result = CasinoWar::process_move(&mut session, &[0], &mut rng);

        assert!(matches!(result, Ok(GameResult::Continue)));
        assert!(!session.is_complete);

        let parsed = parse_state(&session.state_blob).expect("Failed to parse state");
        let Err((_, _, stage)) = parsed else {
            panic!("expected legacy state after tie");
        };
        assert_eq!(stage, StageV0::War);
    }

    #[test]
    fn test_surrender_after_tie() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);

        // Set up war stage after tie
        session.state_blob = serialize_state_legacy(12, 25, StageV0::War);

        let mut rng = GameRng::new(&seed, session.id, 1);
        let result = CasinoWar::process_move(&mut session, &[2], &mut rng); // Surrender

        // Surrender forfeits half the ante.
        assert!(matches!(result, Ok(GameResult::Win(50))));
        assert!(session.is_complete);
    }

    #[test]
    fn test_go_to_war() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);

        // Set up war stage after tie
        session.state_blob = serialize_state_legacy(12, 25, StageV0::War);

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
        session.state_blob = serialize_state_legacy(1, 2, StageV0::Initial);

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
        session.state_blob = serialize_state_legacy(12, 25, StageV0::War);

        let mut rng = GameRng::new(&seed, session.id, 1);

        // Play move in war stage
        let result = CasinoWar::process_move(&mut session, &[0], &mut rng);
        assert!(matches!(result, Err(GameError::InvalidMove)));
    }

    #[test]
    fn test_init_starts_in_betting_stage() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        CasinoWar::init(&mut session, &mut rng);

        let parsed = parse_state(&session.state_blob).expect("Failed to parse state");
        let Ok(state) = parsed else {
            panic!("expected v1 state from init");
        };
        assert_eq!(state.stage, StageV1::Betting);
        assert_eq!(state.player_card, HIDDEN_CARD);
        assert_eq!(state.dealer_card, HIDDEN_CARD);
        assert_eq!(state.tie_bet, 0);
    }

    #[test]
    fn test_set_tie_bet_updates_state() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        CasinoWar::init(&mut session, &mut rng);

        let mut payload = vec![3];
        payload.extend_from_slice(&10u64.to_be_bytes());
        let mut rng = GameRng::new(&seed, session.id, 1);
        let result = CasinoWar::process_move(&mut session, &payload, &mut rng);
        assert!(matches!(
            result,
            Ok(GameResult::ContinueWithUpdate { payout: -10 })
        ));

        let parsed = parse_state(&session.state_blob).expect("Failed to parse state");
        let Ok(state) = parsed else {
            panic!("expected v1 state");
        };
        assert_eq!(state.tie_bet, 10);
        assert_eq!(state.stage, StageV1::Betting);
    }

    #[test]
    fn test_tie_bet_pays_on_tie() {
        let seed = create_test_seed();

        // Find a session that produces an initial tie.
        for session_id in 1..300 {
            let mut session = create_test_session(100);
            session.id = session_id;
            let mut rng = GameRng::new(&seed, session.id, 0);
            CasinoWar::init(&mut session, &mut rng);

            // Set tie bet to 10.
            let mut payload = vec![3];
            payload.extend_from_slice(&10u64.to_be_bytes());
            let mut rng = GameRng::new(&seed, session.id, 1);
            CasinoWar::process_move(&mut session, &payload, &mut rng).expect("set tie bet");

            // Deal + compare.
            let mut rng = GameRng::new(&seed, session.id, 2);
            let result = CasinoWar::process_move(&mut session, &[0], &mut rng);

            if matches!(result, Ok(GameResult::ContinueWithUpdate { payout: 110 })) {
                let parsed = parse_state(&session.state_blob).expect("Failed to parse state");
                let Ok(state) = parsed else {
                    panic!("expected v1 state");
                };
                assert_eq!(state.stage, StageV1::War);
                assert!(state.player_card < 52);
                assert!(state.dealer_card < 52);
                assert_eq!(card_rank(state.player_card), card_rank(state.dealer_card));
                return;
            }
        }

        panic!("failed to find a tie in 300 trials");
    }

    #[test]
    fn test_tie_after_tie_awards_bonus() {
        let seed = create_test_seed();

        // Find a session that produces a tie and then a tie-after-tie.
        for session_id in 1..10_000 {
            let mut session = create_test_session(100);
            session.id = session_id;
            let mut rng = GameRng::new(&seed, session.id, 0);
            CasinoWar::init(&mut session, &mut rng);

            // Deal + compare.
            let mut rng = GameRng::new(&seed, session.id, 1);
            let _ = CasinoWar::process_move(&mut session, &[0], &mut rng).expect("deal");

            let parsed = parse_state(&session.state_blob).expect("parse state");
            let Ok(state) = parsed else {
                continue;
            };
            if state.stage != StageV1::War {
                continue;
            }

            // Go to war.
            let mut rng = GameRng::new(&seed, session.id, 2);
            let result = CasinoWar::process_move(&mut session, &[1], &mut rng).expect("war");

            let parsed = parse_state(&session.state_blob).expect("parse final state");
            let Ok(final_state) = parsed else {
                panic!("expected v1 state");
            };
            assert_eq!(final_state.stage, StageV1::Complete);

            if card_rank(final_state.player_card) == card_rank(final_state.dealer_card) {
                // Bonus is equal to the ante, so the win credits 3x the ante in our model.
                assert!(matches!(result, GameResult::Win(300)));
                return;
            }
        }

        panic!("failed to find a tie-after-tie in 10,000 trials");
    }
}
