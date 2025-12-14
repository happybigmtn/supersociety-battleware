use super::*;
use commonware_codec::Encode;
use commonware_codec::ReadExt;
use commonware_cryptography::{ed25519::PrivateKey, PrivateKeyExt, Signer};
use rand::{rngs::StdRng, SeedableRng};

#[test]
fn test_game_type_roundtrip() {
    for game_type in [
        GameType::Baccarat,
        GameType::Blackjack,
        GameType::CasinoWar,
        GameType::Craps,
        GameType::VideoPoker,
        GameType::HiLo,
        GameType::Roulette,
        GameType::SicBo,
        GameType::ThreeCard,
        GameType::UltimateHoldem,
    ] {
        let encoded = game_type.encode();
        let decoded = GameType::read(&mut &encoded[..]).unwrap();
        assert_eq!(game_type, decoded);
    }
}

#[test]
fn test_player_roundtrip() {
    let player = Player::new("TestPlayer".to_string());
    let encoded = player.encode();
    let decoded = Player::read(&mut &encoded[..]).unwrap();
    assert_eq!(player, decoded);
}

#[test]
fn test_leaderboard_update() {
    let mut rng = StdRng::seed_from_u64(42);
    let mut leaderboard = CasinoLeaderboard::default();

    // Add some players
    for i in 0..15 {
        let pk = PrivateKey::from_rng(&mut rng).public_key();
        leaderboard.update(pk, format!("Player{}", i), (i as u64 + 1) * 1000);
    }

    // Should only keep top 10
    assert_eq!(leaderboard.entries.len(), 10);

    // Should be sorted by chips descending
    for i in 0..9 {
        assert!(leaderboard.entries[i].chips >= leaderboard.entries[i + 1].chips);
    }

    // Ranks should be 1-10
    for (i, entry) in leaderboard.entries.iter().enumerate() {
        assert_eq!(entry.rank, (i + 1) as u32);
    }
}
