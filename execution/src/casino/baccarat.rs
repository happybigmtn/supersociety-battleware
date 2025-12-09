//! Baccarat game implementation with multi-bet support.
//!
//! State blob format:
//! [bet_count:u8] [bets:BaccaratBet×count] [playerHandLen:u8] [playerCards:u8×n] [bankerHandLen:u8] [bankerCards:u8×n]
//!
//! Each BaccaratBet (9 bytes):
//! [bet_type:u8] [amount:u64 BE]
//!
//! Payload format:
//! [0, bet_type, amount_bytes...] - Place bet (adds to pending bets)
//! [1] - Deal cards and resolve all bets
//! [2] - Clear all pending bets
//!
//! Bet types:
//! 0 = Player (1:1)
//! 1 = Banker (0.95:1, 5% commission)
//! 2 = Tie (8:1)
//! 3 = Player Pair (11:1)
//! 4 = Banker Pair (11:1)

use super::{CasinoGame, GameError, GameResult, GameRng};
use super::super_mode::apply_super_multiplier_cards;
use nullspace_types::casino::GameSession;

/// Maximum cards in a Baccarat hand (2-3 cards per hand).
const MAX_HAND_SIZE: usize = 3;
/// Maximum number of bets per session (one of each type).
const MAX_BETS: usize = 5;

/// Bet types in Baccarat.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BetType {
    Player = 0,     // 1:1
    Banker = 1,     // 0.95:1 (5% commission)
    Tie = 2,        // 8:1
    PlayerPair = 3, // 11:1
    BankerPair = 4, // 11:1
}

impl TryFrom<u8> for BetType {
    type Error = GameError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(BetType::Player),
            1 => Ok(BetType::Banker),
            2 => Ok(BetType::Tie),
            3 => Ok(BetType::PlayerPair),
            4 => Ok(BetType::BankerPair),
            _ => Err(GameError::InvalidPayload),
        }
    }
}

/// Get card value for Baccarat (0-9).
/// Face cards and 10s = 0, Ace = 1, others = face value.
fn card_value(card: u8) -> u8 {
    let rank = (card % 13) + 1; // 1-13
    match rank {
        1 => 1,         // Ace
        2..=9 => rank,  // 2-9
        _ => 0,         // 10, J, Q, K
    }
}

/// Calculate hand total (mod 10).
fn hand_total(cards: &[u8]) -> u8 {
    cards.iter().map(|&c| card_value(c)).sum::<u8>() % 10
}

/// Get card rank (0-12 for A-K).
fn card_rank(card: u8) -> u8 {
    card % 13
}

/// Check if first two cards are a pair (same rank).
fn is_pair(cards: &[u8]) -> bool {
    cards.len() >= 2 && card_rank(cards[0]) == card_rank(cards[1])
}

/// Individual bet in baccarat.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BaccaratBet {
    pub bet_type: BetType,
    pub amount: u64,
}

impl BaccaratBet {
    /// Serialize to 9 bytes: [bet_type:u8] [amount:u64 BE]
    fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(9);
        bytes.push(self.bet_type as u8);
        bytes.extend_from_slice(&self.amount.to_be_bytes());
        bytes
    }

    /// Deserialize from 9 bytes
    fn from_bytes(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < 9 {
            return None;
        }
        let bet_type = BetType::try_from(bytes[0]).ok()?;
        let amount = u64::from_be_bytes(bytes[1..9].try_into().ok()?);
        Some(BaccaratBet { bet_type, amount })
    }
}

/// Game state for multi-bet baccarat.
struct BaccaratState {
    bets: Vec<BaccaratBet>,
    player_cards: Vec<u8>,
    banker_cards: Vec<u8>,
}

impl BaccaratState {
    fn new() -> Self {
        BaccaratState {
            bets: Vec::new(),
            player_cards: Vec::new(),
            banker_cards: Vec::new(),
        }
    }

    /// Serialize state to blob
    fn to_blob(&self) -> Vec<u8> {
        // Capacity: 1 (bet count) + bets (9 bytes each) + 1 (player len) + player cards + 1 (banker len) + banker cards
        let capacity = 1 + (self.bets.len() * 9) + 1 + self.player_cards.len() + 1 + self.banker_cards.len();
        let mut blob = Vec::with_capacity(capacity);
        blob.push(self.bets.len() as u8);
        for bet in &self.bets {
            blob.extend_from_slice(&bet.to_bytes());
        }
        blob.push(self.player_cards.len() as u8);
        blob.extend_from_slice(&self.player_cards);
        blob.push(self.banker_cards.len() as u8);
        blob.extend_from_slice(&self.banker_cards);
        blob
    }

    /// Deserialize state from blob
    fn from_blob(blob: &[u8]) -> Option<Self> {
        if blob.is_empty() {
            return Some(BaccaratState::new());
        }

        let mut offset = 0;

        // Parse bets
        if offset >= blob.len() {
            return None;
        }
        let bet_count = blob[offset] as usize;
        offset += 1;

        let mut bets = Vec::with_capacity(bet_count);
        for _ in 0..bet_count {
            if offset + 9 > blob.len() {
                return None;
            }
            let bet = BaccaratBet::from_bytes(&blob[offset..offset + 9])?;
            bets.push(bet);
            offset += 9;
        }

        // Parse player cards
        if offset >= blob.len() {
            // No cards yet - just bets
            return Some(BaccaratState {
                bets,
                player_cards: Vec::new(),
                banker_cards: Vec::new(),
            });
        }
        let player_len = blob[offset] as usize;
        offset += 1;
        if player_len > MAX_HAND_SIZE || offset + player_len > blob.len() {
            return None;
        }
        let player_cards = blob[offset..offset + player_len].to_vec();
        offset += player_len;

        // Parse banker cards
        if offset >= blob.len() {
            return None;
        }
        let banker_len = blob[offset] as usize;
        offset += 1;
        if banker_len > MAX_HAND_SIZE || offset + banker_len > blob.len() {
            return None;
        }
        let banker_cards = blob[offset..offset + banker_len].to_vec();

        Some(BaccaratState {
            bets,
            player_cards,
            banker_cards,
        })
    }
}

/// Determine if player should draw third card.
/// Player draws on 0-5, stands on 6-7.
fn player_draws(player_total: u8) -> bool {
    player_total <= 5
}

/// Determine if banker should draw third card.
/// Depends on banker's total and player's third card (if any).
fn banker_draws(banker_total: u8, player_third_card: Option<u8>) -> bool {
    match banker_total {
        0..=2 => true, // Always draws
        3 => match player_third_card {
            None => true,
            Some(c) => card_value(c) != 8,
        },
        4 => match player_third_card {
            None => true,
            Some(c) => {
                let v = card_value(c);
                v >= 2 && v <= 7
            }
        },
        5 => match player_third_card {
            None => true,
            Some(c) => {
                let v = card_value(c);
                v >= 4 && v <= 7
            }
        },
        6 => match player_third_card {
            None => false,
            Some(c) => {
                let v = card_value(c);
                v == 6 || v == 7
            }
        },
        _ => false, // 7-9 stands
    }
}

/// Calculate payout for a single bet based on game outcome.
/// Returns total payout (stake + winnings) for wins, 0 for losses, stake for push.
fn calculate_bet_payout(
    bet: &BaccaratBet,
    player_total: u8,
    banker_total: u8,
    player_has_pair: bool,
    banker_has_pair: bool,
) -> (i64, bool) {
    // Returns (payout_delta, is_push)
    // payout_delta: positive for win (winnings only), negative for loss (amount lost), 0 for push
    match bet.bet_type {
        BetType::PlayerPair => {
            if player_has_pair {
                // 11:1 payout = winnings of 11x
                (bet.amount.saturating_mul(11) as i64, false)
            } else {
                (-(bet.amount as i64), false)
            }
        }
        BetType::BankerPair => {
            if banker_has_pair {
                // 11:1 payout = winnings of 11x
                (bet.amount.saturating_mul(11) as i64, false)
            } else {
                (-(bet.amount as i64), false)
            }
        }
        BetType::Tie => {
            if player_total == banker_total {
                // 8:1 payout = winnings of 8x
                (bet.amount.saturating_mul(8) as i64, false)
            } else {
                (-(bet.amount as i64), false)
            }
        }
        BetType::Player => {
            if player_total == banker_total {
                (0, true) // Push on tie
            } else if player_total > banker_total {
                // 1:1 payout = winnings of 1x
                (bet.amount as i64, false)
            } else {
                (-(bet.amount as i64), false)
            }
        }
        BetType::Banker => {
            if player_total == banker_total {
                (0, true) // Push on tie
            } else if banker_total > player_total {
                // 5% commission - win 95% of bet
                let winnings = bet.amount.saturating_mul(95) / 100;
                if winnings > 0 {
                    (winnings as i64, false)
                } else {
                    (0, true) // Effectively a push if winnings round to 0
                }
            } else {
                (-(bet.amount as i64), false)
            }
        }
    }
}

pub struct Baccarat;

impl CasinoGame for Baccarat {
    fn init(session: &mut GameSession, _rng: &mut GameRng) -> GameResult {
        // Initialize with empty state
        let state = BaccaratState::new();
        session.state_blob = state.to_blob();
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

        // Parse current state
        let mut state = BaccaratState::from_blob(&session.state_blob)
            .ok_or(GameError::InvalidPayload)?;

        match payload[0] {
            // [0, bet_type, amount_bytes...] - Place bet
            0 => {
                if payload.len() < 10 {
                    return Err(GameError::InvalidPayload);
                }

                // Cards already dealt - can't place more bets
                if !state.player_cards.is_empty() {
                    return Err(GameError::InvalidMove);
                }

                let bet_type = BetType::try_from(payload[1])?;
                let amount = u64::from_be_bytes(
                    payload[2..10].try_into().map_err(|_| GameError::InvalidPayload)?
                );

                if amount == 0 {
                    return Err(GameError::InvalidPayload);
                }

                // Check if bet type already exists - if so, add to it
                if let Some(existing) = state.bets.iter_mut().find(|b| b.bet_type == bet_type) {
                    existing.amount = existing.amount.saturating_add(amount);
                } else {
                    // Check max bets limit
                    if state.bets.len() >= MAX_BETS {
                        return Err(GameError::InvalidMove);
                    }
                    state.bets.push(BaccaratBet { bet_type, amount });
                }

                session.state_blob = state.to_blob();
                Ok(GameResult::Continue)
            }

            // [1] - Deal cards and resolve all bets
            1 => {
                // Must have at least one bet
                if state.bets.is_empty() {
                    return Err(GameError::InvalidMove);
                }

                // Cards already dealt
                if !state.player_cards.is_empty() {
                    return Err(GameError::InvalidMove);
                }

                // Deal initial cards
                let mut deck = rng.create_deck();

                // Deal 2 cards each: Player, Banker, Player, Banker
                state.player_cards = vec![
                    rng.draw_card(&mut deck).unwrap_or(0),
                    rng.draw_card(&mut deck).unwrap_or(1),
                ];
                state.banker_cards = vec![
                    rng.draw_card(&mut deck).unwrap_or(2),
                    rng.draw_card(&mut deck).unwrap_or(3),
                ];

                let mut player_total = hand_total(&state.player_cards);
                let mut banker_total = hand_total(&state.banker_cards);

                // Natural check (8 or 9 on first two cards)
                let natural = player_total >= 8 || banker_total >= 8;

                let mut player_third_card: Option<u8> = None;

                if !natural {
                    // Player draws?
                    if player_draws(player_total) {
                        let card = rng.draw_card(&mut deck).unwrap_or(4);
                        state.player_cards.push(card);
                        player_third_card = Some(card);
                        player_total = hand_total(&state.player_cards);
                    }

                    // Banker draws?
                    if banker_draws(banker_total, player_third_card) {
                        let card = rng.draw_card(&mut deck).unwrap_or(5);
                        state.banker_cards.push(card);
                        banker_total = hand_total(&state.banker_cards);
                    }
                }

                // Check for pairs
                let player_has_pair = is_pair(&state.player_cards);
                let banker_has_pair = is_pair(&state.banker_cards);

                // Calculate total payout across all bets
                let mut total_wagered: u64 = 0;
                let mut net_payout: i64 = 0;
                let mut all_push = true;

                for bet in &state.bets {
                    total_wagered = total_wagered.saturating_add(bet.amount);
                    let (payout_delta, is_push) = calculate_bet_payout(
                        bet,
                        player_total,
                        banker_total,
                        player_has_pair,
                        banker_has_pair,
                    );
                    net_payout = net_payout.saturating_add(payout_delta);
                    if !is_push {
                        all_push = false;
                    }
                }

                session.state_blob = state.to_blob();
                session.move_count += 1;
                session.is_complete = true;

                // Determine final result
                let base_result = if all_push && net_payout == 0 {
                    GameResult::Push
                } else if net_payout > 0 {
                    // Net win: return total wagered + net winnings
                    let total_return = total_wagered.saturating_add(net_payout as u64);
                    GameResult::Win(total_return)
                } else if net_payout < 0 {
                    // Net loss
                    let loss_amount = (-net_payout) as u64;
                    if loss_amount >= total_wagered {
                        GameResult::Loss
                    } else {
                        // Partial loss - return remaining stake
                        let remaining = total_wagered.saturating_sub(loss_amount);
                        GameResult::Win(remaining)
                    }
                } else {
                    // Net zero but not all push - mixed results
                    GameResult::Win(total_wagered)
                };

                // Apply super mode multipliers if active and player won
                if session.super_mode.is_active {
                    if let GameResult::Win(base_payout) = base_result {
                        // Aura Cards: combine player and banker cards for multiplier check
                        let all_cards: Vec<u8> = state.player_cards.iter()
                            .chain(state.banker_cards.iter())
                            .cloned()
                            .collect();
                        let boosted_payout = apply_super_multiplier_cards(
                            &all_cards,
                            &session.super_mode.multipliers,
                            base_payout,
                        );
                        return Ok(GameResult::Win(boosted_payout));
                    }
                }
                Ok(base_result)
            }

            // [2] - Clear all pending bets
            2 => {
                // Can't clear after cards dealt
                if !state.player_cards.is_empty() {
                    return Err(GameError::InvalidMove);
                }

                state.bets.clear();
                session.state_blob = state.to_blob();
                Ok(GameResult::Continue)
            }

            _ => Err(GameError::InvalidPayload),
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
            game_type: GameType::Baccarat,
            bet,
            state_blob: vec![],
            move_count: 0,
            created_at: 0,
            is_complete: false,
            super_mode: nullspace_types::casino::SuperModeState::default(),
        }
    }

    #[test]
    fn test_card_value() {
        // Ace = 1
        assert_eq!(card_value(0), 1);
        assert_eq!(card_value(13), 1);

        // 2-9 = face value
        assert_eq!(card_value(1), 2);
        assert_eq!(card_value(8), 9);

        // 10, J, Q, K = 0
        assert_eq!(card_value(9), 0);  // 10
        assert_eq!(card_value(10), 0); // J
        assert_eq!(card_value(11), 0); // Q
        assert_eq!(card_value(12), 0); // K
    }

    #[test]
    fn test_hand_total() {
        // 7 + 8 = 15 mod 10 = 5
        assert_eq!(hand_total(&[6, 7]), 5);

        // Ace + 3 = 4
        assert_eq!(hand_total(&[0, 2]), 4);

        // King + Queen = 0
        assert_eq!(hand_total(&[12, 11]), 0);

        // 9 + 9 = 18 mod 10 = 8 (natural)
        assert_eq!(hand_total(&[8, 21]), 8);
    }

    #[test]
    fn test_player_draws() {
        assert!(player_draws(0));
        assert!(player_draws(5));
        assert!(!player_draws(6));
        assert!(!player_draws(7));
    }

    #[test]
    fn test_banker_draws_no_player_third() {
        // Banker draws on 0-5 when player stands
        assert!(banker_draws(0, None));
        assert!(banker_draws(5, None));
        assert!(!banker_draws(6, None));
        assert!(!banker_draws(7, None));
    }

    #[test]
    fn test_banker_draws_with_player_third() {
        // Banker on 3, player drew 8 -> banker stands
        assert!(!banker_draws(3, Some(7))); // 7's value is 8

        // Banker on 4, player drew 2 -> banker draws
        assert!(banker_draws(4, Some(1))); // 1's value is 2

        // Banker on 6, player drew 6 -> banker draws
        assert!(banker_draws(6, Some(5))); // 5's value is 6
    }

    #[test]
    fn test_state_serialize_parse_roundtrip() {
        let state = BaccaratState {
            bets: vec![
                BaccaratBet { bet_type: BetType::Player, amount: 100 },
                BaccaratBet { bet_type: BetType::Tie, amount: 50 },
            ],
            player_cards: vec![1, 2, 3],
            banker_cards: vec![4, 5],
        };

        let blob = state.to_blob();
        let parsed = BaccaratState::from_blob(&blob).expect("Failed to parse state");

        assert_eq!(parsed.bets.len(), 2);
        assert_eq!(parsed.bets[0].bet_type, BetType::Player);
        assert_eq!(parsed.bets[0].amount, 100);
        assert_eq!(parsed.bets[1].bet_type, BetType::Tie);
        assert_eq!(parsed.bets[1].amount, 50);
        assert_eq!(parsed.player_cards, vec![1, 2, 3]);
        assert_eq!(parsed.banker_cards, vec![4, 5]);
    }

    /// Helper to create place bet payload
    fn place_bet_payload(bet_type: BetType, amount: u64) -> Vec<u8> {
        let mut payload = vec![0, bet_type as u8];
        payload.extend_from_slice(&amount.to_be_bytes());
        payload
    }

    #[test]
    fn test_place_bet() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        Baccarat::init(&mut session, &mut rng);
        assert!(!session.is_complete);

        // Place a player bet
        let mut rng = GameRng::new(&seed, session.id, 1);
        let payload = place_bet_payload(BetType::Player, 100);
        let result = Baccarat::process_move(&mut session, &payload, &mut rng);

        assert!(result.is_ok());
        assert!(!session.is_complete); // Game continues - need to deal

        // Verify bet was stored
        let state = BaccaratState::from_blob(&session.state_blob).expect("Failed to parse state");
        assert_eq!(state.bets.len(), 1);
        assert_eq!(state.bets[0].bet_type, BetType::Player);
        assert_eq!(state.bets[0].amount, 100);
    }

    #[test]
    fn test_game_completes() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        Baccarat::init(&mut session, &mut rng);
        assert!(!session.is_complete);

        // Place bet
        let mut rng = GameRng::new(&seed, session.id, 1);
        let payload = place_bet_payload(BetType::Player, 100);
        Baccarat::process_move(&mut session, &payload, &mut rng).expect("Failed to process move");

        // Deal cards
        let mut rng = GameRng::new(&seed, session.id, 2);
        let result = Baccarat::process_move(&mut session, &[1], &mut rng);

        assert!(result.is_ok());
        assert!(session.is_complete);

        // State should have cards
        let state = BaccaratState::from_blob(&session.state_blob).expect("Failed to parse state");
        assert!(state.player_cards.len() >= 2);
        assert!(state.banker_cards.len() >= 2);
    }

    #[test]
    fn test_multi_bet() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        Baccarat::init(&mut session, &mut rng);

        // Place multiple bets
        let mut rng = GameRng::new(&seed, session.id, 1);
        let payload = place_bet_payload(BetType::Player, 100);
        Baccarat::process_move(&mut session, &payload, &mut rng).expect("Failed to process move");

        let mut rng = GameRng::new(&seed, session.id, 2);
        let payload = place_bet_payload(BetType::Tie, 50);
        Baccarat::process_move(&mut session, &payload, &mut rng).expect("Failed to process move");

        let mut rng = GameRng::new(&seed, session.id, 3);
        let payload = place_bet_payload(BetType::PlayerPair, 25);
        Baccarat::process_move(&mut session, &payload, &mut rng).expect("Failed to process move");

        // Verify all bets stored
        let state = BaccaratState::from_blob(&session.state_blob).expect("Failed to parse state");
        assert_eq!(state.bets.len(), 3);

        // Deal
        let mut rng = GameRng::new(&seed, session.id, 4);
        let result = Baccarat::process_move(&mut session, &[1], &mut rng);

        assert!(result.is_ok());
        assert!(session.is_complete);
    }

    #[test]
    fn test_add_to_existing_bet() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        Baccarat::init(&mut session, &mut rng);

        // Place player bet twice
        let mut rng = GameRng::new(&seed, session.id, 1);
        let payload = place_bet_payload(BetType::Player, 100);
        Baccarat::process_move(&mut session, &payload, &mut rng).expect("Failed to process move");

        let mut rng = GameRng::new(&seed, session.id, 2);
        let payload = place_bet_payload(BetType::Player, 50);
        Baccarat::process_move(&mut session, &payload, &mut rng).expect("Failed to process move");

        // Verify amounts combined
        let state = BaccaratState::from_blob(&session.state_blob).expect("Failed to parse state");
        assert_eq!(state.bets.len(), 1);
        assert_eq!(state.bets[0].amount, 150);
    }

    #[test]
    fn test_invalid_bet_type() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        Baccarat::init(&mut session, &mut rng);

        let mut rng = GameRng::new(&seed, session.id, 1);
        // Invalid bet type (5 is valid now - BankerPair, use 6 for invalid)
        let mut payload = vec![0, 6]; // Invalid bet type
        payload.extend_from_slice(&100u64.to_be_bytes());
        let result = Baccarat::process_move(&mut session, &payload, &mut rng);

        assert!(matches!(result, Err(GameError::InvalidPayload)));
    }

    #[test]
    fn test_deal_without_bets() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        Baccarat::init(&mut session, &mut rng);

        // Try to deal without placing bets
        let mut rng = GameRng::new(&seed, session.id, 1);
        let result = Baccarat::process_move(&mut session, &[1], &mut rng);

        assert!(matches!(result, Err(GameError::InvalidMove)));
    }

    #[test]
    fn test_clear_bets() {
        let seed = create_test_seed();
        let mut session = create_test_session(100);
        let mut rng = GameRng::new(&seed, session.id, 0);

        Baccarat::init(&mut session, &mut rng);

        // Place a bet
        let mut rng = GameRng::new(&seed, session.id, 1);
        let payload = place_bet_payload(BetType::Player, 100);
        Baccarat::process_move(&mut session, &payload, &mut rng).expect("Failed to process move");

        // Clear bets
        let mut rng = GameRng::new(&seed, session.id, 2);
        let result = Baccarat::process_move(&mut session, &[2], &mut rng);
        assert!(result.is_ok());

        // Verify bets cleared
        let state = BaccaratState::from_blob(&session.state_blob).expect("Failed to parse state");
        assert!(state.bets.is_empty());
    }

    #[test]
    fn test_banker_commission() {
        // If banker wins, payout should be 95% of bet
        let bet = BaccaratBet { bet_type: BetType::Banker, amount: 100 };
        // Banker wins with 9 vs 4
        let (payout, is_push) = calculate_bet_payout(&bet, 4, 9, false, false);
        assert!(!is_push);
        assert_eq!(payout, 95); // 95% of 100
    }

    #[test]
    fn test_tie_payout() {
        // Tie bet should pay 8:1
        let bet = BaccaratBet { bet_type: BetType::Tie, amount: 100 };
        let (payout, is_push) = calculate_bet_payout(&bet, 5, 5, false, false);
        assert!(!is_push);
        assert_eq!(payout, 800); // 8x winnings
    }

    #[test]
    fn test_player_pair_payout() {
        // Player pair pays 11:1
        let bet = BaccaratBet { bet_type: BetType::PlayerPair, amount: 100 };
        let (payout, _) = calculate_bet_payout(&bet, 5, 7, true, false);
        assert_eq!(payout, 1100); // 11x winnings
    }

    #[test]
    fn test_various_outcomes() {
        let seed = create_test_seed();

        // Run multiple sessions to test different outcomes
        for session_id in 1..20 {
            let mut session = create_test_session(100);
            session.id = session_id;

            let mut rng = GameRng::new(&seed, session_id, 0);
            Baccarat::init(&mut session, &mut rng);

            // Place bet
            let mut rng = GameRng::new(&seed, session_id, 1);
            let payload = place_bet_payload(BetType::Player, 100);
            Baccarat::process_move(&mut session, &payload, &mut rng).expect("Failed to process move");

            // Deal
            let mut rng = GameRng::new(&seed, session_id, 2);
            let result = Baccarat::process_move(&mut session, &[1], &mut rng);

            assert!(result.is_ok());
            assert!(session.is_complete);

            // Verify result is one of the valid outcomes
            match result.expect("Failed to process move") {
                GameResult::Win(_) | GameResult::Loss | GameResult::Push => {}
                GameResult::Continue | GameResult::ContinueWithUpdate { .. } => {
                    panic!("Baccarat should complete after deal")
                }
                GameResult::LossWithExtraDeduction(_) => {}
            }
        }
    }
}
