//! Ultimate Texas Hold'em implementation.
//!
//! State blob format:
//! [stage:u8]
//! [playerCard1:u8] [playerCard2:u8]
//! [community1:u8] [community2:u8] [community3:u8] [community4:u8] [community5:u8]
//! [dealerCard1:u8] [dealerCard2:u8]
//! [playBetMultiplier:u8] (0 = not yet bet, 1-4 = multiplier of ante)
//!
//! Stages:
//! 0 = Preflop (player sees hole cards)
//! 1 = Flop (first 3 community cards shown)
//! 2 = River (all 5 community cards shown)
//! 3 = Showdown
//!
//! Payload format:
//! [action:u8]
//! 0 = Check (only valid before play bet)
//! 1 = Bet 4x (preflop only)
//! 2 = Bet 2x (flop only)
//! 3 = Bet 1x (river - required if haven't bet yet)
//! 4 = Fold (river only if no previous bet)

use super::super_mode::apply_super_multiplier_cards;
use super::{CasinoGame, GameError, GameResult, GameRng};
use nullspace_types::casino::GameSession;

/// Game stages.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Stage {
    Preflop = 0,
    Flop = 1,
    River = 2,
    Showdown = 3,
}

impl TryFrom<u8> for Stage {
    type Error = GameError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Stage::Preflop),
            1 => Ok(Stage::Flop),
            2 => Ok(Stage::River),
            3 => Ok(Stage::Showdown),
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
            _ => Err(GameError::InvalidPayload),
        }
    }
}

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
    if r == 1 { 14 } else { r }
}

/// Get card suit.
fn card_suit(card: u8) -> u8 {
    card / 13
}

/// Evaluate best 5-card hand from 7 cards.
/// Returns (HandRank, high cards for tiebreaker).
/// Optimized to avoid heap allocations.
pub fn evaluate_best_hand(cards: &[u8]) -> (HandRank, [u8; 5]) {
    let mut best_rank = HandRank::HighCard;
    let mut best_kickers = [0u8; 5];

    // Generate all 21 5-card combinations from 7 cards (C(7,5) = 21)
    // We iterate over which 2 cards to skip
    let n = cards.len();
    for i in 0..n {
        for j in (i + 1)..n {
            // Build 5-card hand by skipping indices i and j
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

/// Evaluate a 5-card hand without heap allocations.
fn evaluate_5_card_fast(cards: &[u8; 5]) -> (HandRank, [u8; 5]) {
    // Extract ranks and suits
    let mut ranks = [0u8; 5];
    let mut suits = [0u8; 5];
    for i in 0..5 {
        ranks[i] = card_rank(cards[i]);
        suits[i] = card_suit(cards[i]);
    }

    // Sort ranks descending for kickers
    ranks.sort_unstable_by(|a, b| b.cmp(a));

    // Check flush
    let is_flush = suits[0] == suits[1] && suits[1] == suits[2]
                && suits[2] == suits[3] && suits[3] == suits[4];

    // Check straight - need sorted ascending with no duplicates
    let mut sorted = ranks;
    sorted.sort_unstable();

    // Check for duplicates
    let has_duplicates = sorted[0] == sorted[1] || sorted[1] == sorted[2]
                      || sorted[2] == sorted[3] || sorted[3] == sorted[4];

    let is_straight = if has_duplicates {
        false
    } else if sorted[4] - sorted[0] == 4 {
        true
    } else {
        // Check A-2-3-4-5 (wheel)
        sorted == [2, 3, 4, 5, 14]
    };

    let is_royal = sorted == [10, 11, 12, 13, 14];

    // Count ranks
    let mut counts = [0u8; 15];
    for &r in &ranks {
        counts[r as usize] += 1;
    }

    // Find pairs, trips, quads
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

    // Determine hand rank
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

fn parse_state(state: &[u8]) -> Option<(Stage, [u8; 2], [u8; 5], [u8; 2], u8)> {
    if state.len() < 11 {
        return None;
    }
    let stage = Stage::try_from(state[0]).ok()?;
    let player = [state[1], state[2]];
    let community = [state[3], state[4], state[5], state[6], state[7]];
    let dealer = [state[8], state[9]];
    let play_bet = state[10];
    Some((stage, player, community, dealer, play_bet))
}

fn serialize_state(
    stage: Stage,
    player: &[u8; 2],
    community: &[u8; 5],
    dealer: &[u8; 2],
    play_bet: u8,
) -> Vec<u8> {
    vec![
        stage as u8,
        player[0], player[1],
        community[0], community[1], community[2], community[3], community[4],
        dealer[0], dealer[1],
        play_bet,
    ]
}

pub struct UltimateHoldem;

impl CasinoGame for UltimateHoldem {
    fn init(session: &mut GameSession, rng: &mut GameRng) -> GameResult {
        let mut deck = rng.create_deck();

        // Deal player cards
        let player = [
            rng.draw_card(&mut deck).unwrap_or(0),
            rng.draw_card(&mut deck).unwrap_or(1),
        ];

        // Deal community cards
        let community = [
            rng.draw_card(&mut deck).unwrap_or(2),
            rng.draw_card(&mut deck).unwrap_or(3),
            rng.draw_card(&mut deck).unwrap_or(4),
            rng.draw_card(&mut deck).unwrap_or(5),
            rng.draw_card(&mut deck).unwrap_or(6),
        ];

        // Deal dealer cards
        let dealer = [
            rng.draw_card(&mut deck).unwrap_or(7),
            rng.draw_card(&mut deck).unwrap_or(8),
        ];

        session.state_blob = serialize_state(Stage::Preflop, &player, &community, &dealer, 0);
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

        let action = Action::try_from(payload[0])?;
        let (stage, player, community, dealer, play_bet) =
            parse_state(&session.state_blob).ok_or(GameError::InvalidPayload)?;

        session.move_count += 1;

        match stage {
            Stage::Preflop => match action {
                Action::Bet4x => {
                    // Bet 4x, go to showdown
                    session.state_blob =
                        serialize_state(Stage::Showdown, &player, &community, &dealer, 4);
                    resolve_showdown(session, &player, &community, &dealer, 4)
                }
                Action::Check => {
                    // Move to flop
                    session.state_blob =
                        serialize_state(Stage::Flop, &player, &community, &dealer, 0);
                    Ok(GameResult::Continue)
                }
                _ => Err(GameError::InvalidMove),
            },
            Stage::Flop => match action {
                Action::Bet2x => {
                    // Bet 2x, go to showdown
                    session.state_blob =
                        serialize_state(Stage::Showdown, &player, &community, &dealer, 2);
                    resolve_showdown(session, &player, &community, &dealer, 2)
                }
                Action::Check => {
                    // Move to river
                    session.state_blob =
                        serialize_state(Stage::River, &player, &community, &dealer, 0);
                    Ok(GameResult::Continue)
                }
                _ => Err(GameError::InvalidMove),
            },
            Stage::River => {
                if play_bet > 0 {
                    return Err(GameError::InvalidMove);
                }
                match action {
                    Action::Bet1x => {
                        // Must bet or fold
                        session.state_blob =
                            serialize_state(Stage::Showdown, &player, &community, &dealer, 1);
                        resolve_showdown(session, &player, &community, &dealer, 1)
                    }
                    Action::Fold => {
                        session.is_complete = true;
                        session.state_blob =
                            serialize_state(Stage::Showdown, &player, &community, &dealer, 0);
                        Ok(GameResult::Loss)
                    }
                    _ => Err(GameError::InvalidMove),
                }
            }
            Stage::Showdown => Err(GameError::GameAlreadyComplete),
        }
    }
}

/// Resolve the showdown and calculate winnings.
fn resolve_showdown(
    session: &mut GameSession,
    player_hole: &[u8; 2],
    community: &[u8; 5],
    dealer_hole: &[u8; 2],
    play_multiplier: u8,
) -> Result<GameResult, GameError> {
    session.is_complete = true;

    // Build 7-card hands (stack allocated)
    let player_cards: [u8; 7] = [
        player_hole[0], player_hole[1],
        community[0], community[1], community[2], community[3], community[4],
    ];

    let dealer_cards: [u8; 7] = [
        dealer_hole[0], dealer_hole[1],
        community[0], community[1], community[2], community[3], community[4],
    ];

    let player_hand = evaluate_best_hand(&player_cards);
    let dealer_hand = evaluate_best_hand(&dealer_cards);

    // Dealer qualifies with pair or better
    let dealer_qualifies = dealer_hand.0 >= HandRank::Pair;

    // Calculate total bet: ante + blind + play (play_multiplier * ante)
    // For simplicity, session.bet is the ante
    let ante = session.bet;
    let play_bet = ante.saturating_mul(play_multiplier as u64);

    // Compare hands
    let player_wins = player_hand.0 > dealer_hand.0
        || (player_hand.0 == dealer_hand.0 && player_hand.1 > dealer_hand.1);
    let tie = player_hand.0 == dealer_hand.0 && player_hand.1 == dealer_hand.1;

    // Calculate blind bonus (paid regardless) with overflow protection
    let blind_bonus: u64 = match player_hand.0 {
        HandRank::RoyalFlush => 500,
        HandRank::StraightFlush => 50,
        HandRank::FourOfAKind => 10,
        HandRank::FullHouse => 3,
        HandRank::Flush => 3,
        HandRank::Straight => 1,
        _ => 0,
    };
    let blind_pay = ante.saturating_mul(blind_bonus);

    // NOTE: play_bet was NOT charged at StartGame, so we must adjust payouts accordingly.
    // On wins/ties: subtract play_bet from the calculated return.
    // On losses: use LossWithExtraDeduction to deduct the uncharged play_bet.

    // Helper to apply super mode multiplier
    let apply_multiplier = |base: u64| -> u64 {
        if session.super_mode.is_active {
            apply_super_multiplier_cards(
                &player_cards,
                &session.super_mode.multipliers,
                base,
            )
        } else {
            base
        }
    };

    if tie {
        // Push - return all stakes (Ante + Play + Blind)
        // Rules: "If the hand is a tie, the Ante, Play, and Blind bets push."
        // Calculated return: Ante + Play + Blind (Blind = Ante)
        // Actual return: subtract play_bet since it wasn't charged
        let total_return = ante.saturating_add(ante); // Just Ante + Blind (play_bet wasn't charged)
        Ok(GameResult::Win(total_return))
    } else if player_wins {
        if dealer_qualifies {
            // Win Ante (1:1), Play (1:1), Blind (Pay table or Push)
            // Calculated return: 2*Ante + 2*Play + (Blind + BlindBonus)
            // Actual return: subtract play_bet since it wasn't charged
            let blind_return = ante.saturating_add(blind_pay);
            let base_return = ante.saturating_mul(2)
                .saturating_add(play_bet) // Only 1x play_bet since 1x was "returned" but never charged
                .saturating_add(blind_return);
            Ok(GameResult::Win(apply_multiplier(base_return)))
        } else {
            // Dealer doesn't qualify: Ante Pushes, Play Wins (1:1), Blind Wins (Pay table or Push)
            // Calculated return: 1*Ante + 2*Play + (Blind + BlindBonus)
            // Actual return: subtract play_bet since it wasn't charged
            let blind_return = ante.saturating_add(blind_pay);
            let base_return = ante
                .saturating_add(play_bet) // Only 1x play_bet since 1x was "returned" but never charged
                .saturating_add(blind_return);
            Ok(GameResult::Win(apply_multiplier(base_return)))
        }
    } else {
        // Lose Ante, Play, Blind
        // Play bet was NOT charged, so need LossWithExtraDeduction
        Ok(GameResult::LossWithExtraDeduction(play_bet))
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
        }
    }

    #[test]
    fn test_evaluate_pair() {
        let cards = vec![0, 13, 2, 3, 4, 5, 6]; // A-A and others
        let (rank, _) = evaluate_best_hand(&cards);
        assert!(rank >= HandRank::Pair);
    }

    #[test]
    fn test_game_flow_bet_preflop() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        UltimateHoldem::init(&mut session, &mut rng);
        assert!(!session.is_complete);

        let mut rng = GameRng::new(&seed, session.id, 1);
        let result = UltimateHoldem::process_move(&mut session, &[1], &mut rng); // Bet 4x

        assert!(result.is_ok());
        assert!(session.is_complete);
    }

    #[test]
    fn test_game_flow_check_to_river() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        UltimateHoldem::init(&mut session, &mut rng);

        // Check preflop
        let mut rng = GameRng::new(&seed, session.id, 1);
        let result = UltimateHoldem::process_move(&mut session, &[0], &mut rng);
        assert!(matches!(result, Ok(GameResult::Continue)));
        assert!(!session.is_complete);

        // Check flop
        let mut rng = GameRng::new(&seed, session.id, 2);
        let result = UltimateHoldem::process_move(&mut session, &[0], &mut rng);
        assert!(matches!(result, Ok(GameResult::Continue)));
        assert!(!session.is_complete);

        // Bet 1x at river
        let mut rng = GameRng::new(&seed, session.id, 3);
        let result = UltimateHoldem::process_move(&mut session, &[3], &mut rng);
        assert!(result.is_ok());
        assert!(session.is_complete);
    }

    #[test]
    fn test_fold_at_river() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        UltimateHoldem::init(&mut session, &mut rng);

        // Check to river
        for i in 1..=2 {
            let mut rng = GameRng::new(&seed, session.id, i);
            UltimateHoldem::process_move(&mut session, &[0], &mut rng).expect("Failed to process move");
        }

        // Fold at river
        let mut rng = GameRng::new(&seed, session.id, 3);
        let result = UltimateHoldem::process_move(&mut session, &[4], &mut rng);

        assert!(matches!(result, Ok(GameResult::Loss)));
        assert!(session.is_complete);
    }

    #[test]
    fn test_invalid_moves() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        UltimateHoldem::init(&mut session, &mut rng);

        // Try to bet 2x at preflop (invalid)
        let mut rng = GameRng::new(&seed, session.id, 1);
        let result = UltimateHoldem::process_move(&mut session, &[2], &mut rng);
        assert!(matches!(result, Err(GameError::InvalidMove)));

        // Check preflop first
        let mut rng = GameRng::new(&seed, session.id, 1);
        UltimateHoldem::process_move(&mut session, &[0], &mut rng).expect("Failed to process move");

        // Try to bet 4x at flop (invalid)
        let mut rng = GameRng::new(&seed, session.id, 2);
        let result = UltimateHoldem::process_move(&mut session, &[1], &mut rng);
        assert!(matches!(result, Err(GameError::InvalidMove)));
    }

    #[test]
    fn test_init_deals_all_cards() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        UltimateHoldem::init(&mut session, &mut rng);

        let (stage, player, community, dealer, play_bet) =
            parse_state(&session.state_blob).expect("Failed to parse state");

        assert_eq!(stage, Stage::Preflop);
        assert_eq!(play_bet, 0);

        // All 9 cards should be unique
        let mut all_cards = Vec::with_capacity(player.len() + community.len() + dealer.len());
        all_cards.extend_from_slice(&player);
        all_cards.extend_from_slice(&community);
        all_cards.extend_from_slice(&dealer);

        all_cards.sort_unstable();
        all_cards.dedup();
        assert_eq!(all_cards.len(), 9);
    }
}
