//! Casino game execution module.
//!
//! This module contains the game logic for all casino games:
//! - Blackjack
//! - HiLo
//! - Baccarat
//! - Video Poker
//! - Three Card Poker
//! - Ultimate Texas Hold'em
//! - Roulette
//! - Sic Bo
//! - Craps
//! - Casino War

pub mod baccarat;
pub mod blackjack;
pub mod casino_war;
pub mod craps;
pub mod hilo;
#[cfg(test)]
mod integration_tests;
pub mod roulette;
pub mod sic_bo;
pub mod super_mode;
pub mod three_card;
pub mod ultimate_holdem;
pub mod video_poker;

use nullspace_types::casino::{GameSession, GameType, Player};
use nullspace_types::Seed;
use commonware_codec::Encode;
use commonware_cryptography::sha256::Sha256;
use commonware_cryptography::Hasher;

/// Deterministic random number generator seeded from consensus.
///
/// Uses SHA256 hash chains to generate random numbers deterministically
/// from the network's consensus seed.
#[derive(Clone)]
pub struct GameRng {
    state: [u8; 32],
    index: usize,
}

impl GameRng {
    /// Create a new RNG from a seed, session ID, and move number.
    pub fn new(seed: &Seed, session_id: u64, move_number: u32) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(seed.encode().as_ref());
        hasher.update(&session_id.to_be_bytes());
        hasher.update(&move_number.to_be_bytes());
        Self {
            state: hasher.finalize().0,
            index: 0,
        }
    }

    /// Get the next random byte.
    fn next_byte(&mut self) -> u8 {
        if self.index >= 32 {
            // Rehash to get more bytes
            let mut hasher = Sha256::new();
            hasher.update(&self.state);
            self.state = hasher.finalize().0;
            self.index = 0;
        }
        let result = self.state[self.index];
        self.index += 1;
        result
    }

    /// Get a random u8 value.
    pub fn next_u8(&mut self) -> u8 {
        self.next_byte()
    }

    /// Get a random u16 value.
    pub fn next_u16(&mut self) -> u16 {
        let a = self.next_byte() as u16;
        let b = self.next_byte() as u16;
        (a << 8) | b
    }

    /// Get a random f32 value in range [0.0, 1.0).
    pub fn next_f32(&mut self) -> f32 {
        (self.next_u8() as f32) / 256.0
    }

    /// Get a random value in range [0, max).
    pub fn next_bounded(&mut self, max: u8) -> u8 {
        if max == 0 {
            return 0;
        }
        // Simple rejection sampling for unbiased distribution
        let limit = u8::MAX - (u8::MAX % max);
        loop {
            let value = self.next_u8();
            if value < limit {
                return value % max;
            }
        }
    }

    /// Draw a card from the deck without replacement.
    /// Cards are 0-51: suit = card/13, rank = card%13.
    pub fn draw_card(&mut self, deck: &mut Vec<u8>) -> Option<u8> {
        if deck.is_empty() {
            return None;
        }
        let idx = self.next_bounded(deck.len() as u8) as usize;
        Some(deck.swap_remove(idx))
    }

    /// Create a shuffled deck of 52 cards.
    pub fn create_deck(&mut self) -> Vec<u8> {
        let mut deck: Vec<u8> = (0..52).collect();
        self.shuffle(&mut deck);
        deck
    }

    /// Shuffle a slice in place using Fisher-Yates.
    pub fn shuffle<T>(&mut self, slice: &mut [T]) {
        for i in (1..slice.len()).rev() {
            let j = self.next_bounded((i + 1) as u8) as usize;
            slice.swap(i, j);
        }
    }

    /// Roll a single die (1-6).
    pub fn roll_die(&mut self) -> u8 {
        self.next_bounded(6) + 1
    }

    /// Roll multiple dice.
    pub fn roll_dice(&mut self, count: usize) -> Vec<u8> {
        (0..count).map(|_| self.roll_die()).collect()
    }

    /// Spin roulette wheel (0-36).
    pub fn spin_roulette(&mut self) -> u8 {
        self.next_bounded(37)
    }

    /// Create a shuffled deck excluding specific cards.
    /// Uses a bit-set for O(n) performance instead of O(n*m) .contains() calls.
    pub fn create_deck_excluding(&mut self, excluded: &[u8]) -> Vec<u8> {
        // Use u64 as bit-set for 52 cards (cards 0-51)
        let mut used: u64 = 0;
        for &card in excluded {
            if card < 52 {
                used |= 1u64 << card;
            }
        }

        // Collect remaining cards
        let mut deck: Vec<u8> = (0..52)
            .filter(|&c| used & (1u64 << c) == 0)
            .collect();

        self.shuffle(&mut deck);
        deck
    }
}

/// Result of processing a game move.
pub enum GameResult {
    /// Game is still in progress, state updated.
    Continue,
    /// Game continues, but with a balance update (e.g. intermediate win or new bet).
    /// `payout` is the net change to player balance (positive = add, negative = deduct).
    ContinueWithUpdate { payout: i64 },
    /// Game completed with a win. Value is chips won (TOTAL RETURN: stake + profit).
    Win(u64),
    /// Game completed with a loss.
    Loss,
    /// Game completed with a loss AND an additional deduction (for mid-game bet increases).
    /// The value is the extra amount to deduct beyond the initial bet.
    /// Used when games like Blackjack double-down or Casino War go-to-war increase
    /// the bet mid-game and then the player loses.
    LossWithExtraDeduction(u64),
    /// Game completed with a push (tie, bet returned).
    Push,
}

/// Error during game execution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GameError {
    /// Invalid payload format or content.
    InvalidPayload,
    /// Invalid move for current game state.
    InvalidMove,
    /// Game session has already completed.
    GameAlreadyComplete,
    /// Invalid game state or corrupted state blob.
    InvalidState,
    /// Deck is exhausted (no more cards to draw).
    DeckExhausted,
}

/// Trait for casino game implementations.
pub trait CasinoGame {
    /// Initialize game state after StartGame.
    /// Returns the initial state blob and immediate result (if any).
    fn init(session: &mut GameSession, rng: &mut GameRng) -> GameResult;

    /// Process a player move.
    /// Updates the session state and returns the result.
    fn process_move(
        session: &mut GameSession,
        payload: &[u8],
        rng: &mut GameRng,
    ) -> Result<GameResult, GameError>;
}

/// Dispatch game initialization to the appropriate game module.
pub fn init_game(session: &mut GameSession, rng: &mut GameRng) -> GameResult {
    match session.game_type {
        GameType::Baccarat => baccarat::Baccarat::init(session, rng),
        GameType::Blackjack => blackjack::Blackjack::init(session, rng),
        GameType::CasinoWar => casino_war::CasinoWar::init(session, rng),
        GameType::Craps => craps::Craps::init(session, rng),
        GameType::HiLo => hilo::HiLo::init(session, rng),
        GameType::Roulette => roulette::Roulette::init(session, rng),
        GameType::SicBo => sic_bo::SicBo::init(session, rng),
        GameType::ThreeCard => three_card::ThreeCardPoker::init(session, rng),
        GameType::UltimateHoldem => ultimate_holdem::UltimateHoldem::init(session, rng),
        GameType::VideoPoker => video_poker::VideoPoker::init(session, rng),
    }
}

/// Dispatch game move processing to the appropriate game module.
pub fn process_game_move(
    session: &mut GameSession,
    payload: &[u8],
    rng: &mut GameRng,
) -> Result<GameResult, GameError> {
    match session.game_type {
        GameType::Baccarat => baccarat::Baccarat::process_move(session, payload, rng),
        GameType::Blackjack => blackjack::Blackjack::process_move(session, payload, rng),
        GameType::CasinoWar => casino_war::CasinoWar::process_move(session, payload, rng),
        GameType::Craps => craps::Craps::process_move(session, payload, rng),
        GameType::HiLo => hilo::HiLo::process_move(session, payload, rng),
        GameType::Roulette => roulette::Roulette::process_move(session, payload, rng),
        GameType::SicBo => sic_bo::SicBo::process_move(session, payload, rng),
        GameType::ThreeCard => three_card::ThreeCardPoker::process_move(session, payload, rng),
        GameType::UltimateHoldem => ultimate_holdem::UltimateHoldem::process_move(session, payload, rng),
        GameType::VideoPoker => video_poker::VideoPoker::process_move(session, payload, rng),
    }
}

/// Apply modifiers (shield/double) to a game outcome.
pub fn apply_modifiers(player: &mut Player, payout: i64) -> (i64, bool, bool) {
    let mut final_payout = payout;
    let mut was_shielded = false;
    let mut was_doubled = false;

    // Shield: converts loss to break-even
    if payout < 0 && player.active_shield && player.shields > 0 {
        player.shields -= 1;
        player.active_shield = false;
        final_payout = 0;
        was_shielded = true;
    }

    // Double: doubles wins (with overflow protection)
    if payout > 0 && player.active_double && player.doubles > 0 {
        player.doubles -= 1;
        player.active_double = false;
        final_payout = payout.saturating_mul(2);
        was_doubled = true;
    }

    // Reset modifiers after use
    player.active_shield = false;
    player.active_double = false;

    (final_payout, was_shielded, was_doubled)
}

/// Calculate super mode fee (20% of bet)
pub fn get_super_mode_fee(bet: u64) -> u64 {
    bet / 5  // 20%
}

/// Generate super mode multipliers for a game type
pub fn generate_super_multipliers(game_type: GameType, rng: &mut GameRng) -> Vec<nullspace_types::casino::SuperMultiplier> {
    match game_type {
        GameType::Baccarat => super_mode::generate_baccarat_multipliers(rng),
        GameType::Roulette => super_mode::generate_roulette_multipliers(rng),
        GameType::Blackjack => super_mode::generate_blackjack_multipliers(rng),
        GameType::Craps => super_mode::generate_craps_multipliers(rng),
        GameType::SicBo => super_mode::generate_sic_bo_multipliers(rng),
        GameType::VideoPoker => super_mode::generate_video_poker_multipliers(rng),
        GameType::ThreeCard => super_mode::generate_three_card_multipliers(rng),
        GameType::UltimateHoldem => super_mode::generate_uth_multipliers(rng),
        GameType::CasinoWar => super_mode::generate_casino_war_multipliers(rng),
        GameType::HiLo => Vec::new(),  // HiLo uses streak-based system
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mocks::{create_network_keypair, create_seed};

    fn create_test_seed() -> Seed {
        let (network_secret, _) = create_network_keypair();
        create_seed(&network_secret, 1)
    }

    #[test]
    fn test_game_rng_deterministic() {
        let seed = create_test_seed();

        let mut rng1 = GameRng::new(&seed, 1, 0);
        let mut rng2 = GameRng::new(&seed, 1, 0);

        // Same seed should produce same sequence
        for _ in 0..100 {
            assert_eq!(rng1.next_u8(), rng2.next_u8());
        }
    }

    #[test]
    fn test_game_rng_different_sessions() {
        let seed = create_test_seed();

        let mut rng1 = GameRng::new(&seed, 1, 0);
        let mut rng2 = GameRng::new(&seed, 2, 0);

        // Different sessions should produce different sequences
        let seq1: Vec<u8> = (0..10).map(|_| rng1.next_u8()).collect();
        let seq2: Vec<u8> = (0..10).map(|_| rng2.next_u8()).collect();
        assert_ne!(seq1, seq2);
    }

    #[test]
    fn test_game_rng_bounded() {
        let seed = create_test_seed();
        let mut rng = GameRng::new(&seed, 1, 0);

        // Test bounded values are in range
        for _ in 0..1000 {
            let value = rng.next_bounded(52);
            assert!(value < 52);
        }
    }

    #[test]
    fn test_game_rng_deck() {
        let seed = create_test_seed();
        let mut rng = GameRng::new(&seed, 1, 0);

        let deck = rng.create_deck();

        // Deck should have 52 cards
        assert_eq!(deck.len(), 52);

        // All cards should be unique
        let mut seen = [false; 52];
        for card in &deck {
            assert!(!seen[*card as usize], "Duplicate card: {}", card);
            seen[*card as usize] = true;
        }
    }

    #[test]
    fn test_game_rng_draw_card() {
        let seed = create_test_seed();
        let mut rng = GameRng::new(&seed, 1, 0);

        let mut deck = rng.create_deck();
        let initial_len = deck.len();

        let card = rng.draw_card(&mut deck).expect("Failed to draw card from deck");
        assert!(card < 52);
        assert_eq!(deck.len(), initial_len - 1);
        assert!(!deck.contains(&card));
    }

    #[test]
    fn test_game_rng_dice() {
        let seed = create_test_seed();
        let mut rng = GameRng::new(&seed, 1, 0);

        // Test die rolls are in range
        for _ in 0..1000 {
            let roll = rng.roll_die();
            assert!(roll >= 1 && roll <= 6);
        }
    }

    #[test]
    fn test_game_rng_roulette() {
        let seed = create_test_seed();
        let mut rng = GameRng::new(&seed, 1, 0);

        // Test roulette spins are in range
        for _ in 0..1000 {
            let spin = rng.spin_roulette();
            assert!(spin <= 36);
        }
    }

    #[test]
    fn test_apply_modifiers_shield() {
        let mut player = Player::new("Test".to_string());
        player.shields = 2;
        player.active_shield = true;

        let (payout, was_shielded, was_doubled) = apply_modifiers(&mut player, -100);

        assert_eq!(payout, 0); // Loss converted to 0
        assert!(was_shielded);
        assert!(!was_doubled);
        assert_eq!(player.shields, 1); // Shield consumed
        assert!(!player.active_shield); // Reset
    }

    #[test]
    fn test_apply_modifiers_double() {
        let mut player = Player::new("Test".to_string());
        player.doubles = 2;
        player.active_double = true;

        let (payout, was_shielded, was_doubled) = apply_modifiers(&mut player, 100);

        assert_eq!(payout, 200); // Win doubled
        assert!(!was_shielded);
        assert!(was_doubled);
        assert_eq!(player.doubles, 1); // Double consumed
        assert!(!player.active_double); // Reset
    }

    #[test]
    fn test_apply_modifiers_no_effect_on_opposite() {
        // Shield doesn't affect wins
        let mut player = Player::new("Test".to_string());
        player.shields = 2;
        player.active_shield = true;

        let (payout, was_shielded, _) = apply_modifiers(&mut player, 100);
        assert_eq!(payout, 100);
        assert!(!was_shielded);
        assert_eq!(player.shields, 2); // Not consumed

        // Double doesn't affect losses
        let mut player = Player::new("Test".to_string());
        player.doubles = 2;
        player.active_double = true;

        let (payout, _, was_doubled) = apply_modifiers(&mut player, -100);
        assert_eq!(payout, -100);
        assert!(!was_doubled);
        assert_eq!(player.doubles, 2); // Not consumed
    }
}
