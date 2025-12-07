//! Integration tests for casino game execution.
//!
//! These tests verify the full flow from game initialization
//! through multiple moves to game completion.

#[cfg(test)]
mod tests {
    use crate::casino::{init_game, process_game_move, GameResult, GameRng};
    use crate::mocks::{create_account_keypair, create_network_keypair, create_seed};
    use battleware_types::casino::{GameSession, GameType};

    fn create_test_seed() -> battleware_types::Seed {
        let (network_secret, _) = create_network_keypair();
        create_seed(&network_secret, 1)
    }

    fn create_session(game_type: GameType, bet: u64, session_id: u64) -> GameSession {
        let (_, pk) = create_account_keypair(1);
        GameSession {
            id: session_id,
            player: pk,
            game_type,
            bet,
            state_blob: vec![],
            move_count: 0,
            created_at: 0,
            is_complete: false,
        }
    }

    /// Test that all games can be initialized.
    #[test]
    fn test_all_games_initialize() {
        let seed = create_test_seed();

        for (i, game_type) in [
            GameType::Baccarat,
            GameType::Blackjack,
            GameType::CasinoWar,
            GameType::Craps,
            GameType::HiLo,
            GameType::Roulette,
            GameType::SicBo,
            GameType::ThreeCard,
            GameType::UltimateHoldem,
            GameType::VideoPoker,
        ]
        .iter()
        .enumerate()
        {
            let mut session = create_session(*game_type, 100, i as u64 + 1);
            let mut rng = GameRng::new(&seed, session.id, 0);

            init_game(&mut session, &mut rng);

            // Verify state was set
            assert!(
                !session.is_complete,
                "Game {:?} should not be complete after init",
                game_type
            );
        }
    }

    /// Test Blackjack full game flow.
    #[test]
    fn test_blackjack_full_flow() {
        let seed = create_test_seed();
        let mut session = create_session(GameType::Blackjack, 100, 1);

        let mut rng = GameRng::new(&seed, session.id, 0);
        init_game(&mut session, &mut rng);

        // Keep hitting until we bust or stand
        let mut move_num = 1;
        while !session.is_complete {
            let mut rng = GameRng::new(&seed, session.id, move_num);
            // Try to stand (1) to end the game
            let result = process_game_move(&mut session, &[1], &mut rng);
            assert!(result.is_ok());
            move_num += 1;

            if move_num > 20 {
                panic!("Game should complete within 20 moves");
            }
        }

        assert!(session.is_complete);
    }

    /// Test HiLo cashout flow.
    #[test]
    fn test_hilo_cashout_flow() {
        let seed = create_test_seed();
        let mut session = create_session(GameType::HiLo, 100, 1);

        let mut rng = GameRng::new(&seed, session.id, 0);
        init_game(&mut session, &mut rng);

        // Make a few guesses then cashout
        let mut move_num = 1;
        for _ in 0..3 {
            if session.is_complete {
                break;
            }

            let mut rng = GameRng::new(&seed, session.id, move_num);
            // Guess higher (0)
            let result = process_game_move(&mut session, &[0], &mut rng);
            match result {
                Ok(GameResult::Continue) => {}
                Ok(GameResult::Loss) => break,
                _ => {}
            }
            move_num += 1;
        }

        // Cashout if not already complete
        if !session.is_complete {
            let mut rng = GameRng::new(&seed, session.id, move_num);
            let result = process_game_move(&mut session, &[2], &mut rng); // Cashout
            assert!(result.is_ok());
        }

        assert!(session.is_complete);
    }

    /// Test Roulette single spin flow.
    #[test]
    fn test_roulette_single_spin() {
        let seed = create_test_seed();
        let mut session = create_session(GameType::Roulette, 100, 1);

        let mut rng = GameRng::new(&seed, session.id, 0);
        init_game(&mut session, &mut rng);

        let mut rng = GameRng::new(&seed, session.id, 1);
        // Bet on red (1, 0)
        let result = process_game_move(&mut session, &[1, 0], &mut rng);

        assert!(result.is_ok());
        assert!(session.is_complete);

        // State should contain the result
        assert_eq!(session.state_blob.len(), 1);
        assert!(session.state_blob[0] <= 36);
    }

    /// Test Craps point phase flow.
    #[test]
    fn test_craps_point_flow() {
        let seed = create_test_seed();

        // Try multiple sessions to find one that establishes a point
        for session_id in 1..100 {
            let mut session = create_session(GameType::Craps, 100, session_id);

            let mut rng = GameRng::new(&seed, session_id, 0);
            init_game(&mut session, &mut rng);

            let mut rng = GameRng::new(&seed, session_id, 1);
            let result = process_game_move(&mut session, &[0], &mut rng); // Pass line

            if matches!(result, Ok(GameResult::Continue)) {
                // Point established, keep rolling
                let mut move_num = 2;
                while !session.is_complete && move_num < 50 {
                    let mut rng = GameRng::new(&seed, session_id, move_num);
                    let result = process_game_move(&mut session, &[], &mut rng);
                    assert!(result.is_ok());
                    move_num += 1;
                }
                assert!(session.is_complete);
                return; // Found and tested a point game
            }
        }
    }

    /// Test Video Poker hold all flow.
    #[test]
    fn test_video_poker_hold_all() {
        let seed = create_test_seed();
        let mut session = create_session(GameType::VideoPoker, 100, 1);

        let mut rng = GameRng::new(&seed, session.id, 0);
        init_game(&mut session, &mut rng);

        // Verify 5 cards dealt
        assert_eq!(session.state_blob.len(), 6); // stage + 5 cards

        let mut rng = GameRng::new(&seed, session.id, 1);
        // Hold all cards (0b11111)
        let result = process_game_move(&mut session, &[0b11111], &mut rng);

        assert!(result.is_ok());
        assert!(session.is_complete);
    }

    /// Test Ultimate Holdem check to river flow.
    #[test]
    fn test_ultimate_holdem_check_to_river() {
        let seed = create_test_seed();
        let mut session = create_session(GameType::UltimateHoldem, 100, 1);

        let mut rng = GameRng::new(&seed, session.id, 0);
        init_game(&mut session, &mut rng);

        // Check preflop
        let mut rng = GameRng::new(&seed, session.id, 1);
        let result = process_game_move(&mut session, &[0], &mut rng);
        assert!(matches!(result, Ok(GameResult::Continue)));

        // Check flop
        let mut rng = GameRng::new(&seed, session.id, 2);
        let result = process_game_move(&mut session, &[0], &mut rng);
        assert!(matches!(result, Ok(GameResult::Continue)));

        // Bet 1x at river
        let mut rng = GameRng::new(&seed, session.id, 3);
        let result = process_game_move(&mut session, &[3], &mut rng);
        assert!(result.is_ok());
        assert!(session.is_complete);
    }

    /// Test Three Card Poker play decision.
    #[test]
    fn test_three_card_poker_play() {
        let seed = create_test_seed();
        let mut session = create_session(GameType::ThreeCard, 100, 1);

        let mut rng = GameRng::new(&seed, session.id, 0);
        init_game(&mut session, &mut rng);

        // Verify 6 cards dealt + stage
        assert_eq!(session.state_blob.len(), 7);

        let mut rng = GameRng::new(&seed, session.id, 1);
        // Play (0)
        let result = process_game_move(&mut session, &[0], &mut rng);

        assert!(result.is_ok());
        assert!(session.is_complete);
    }

    /// Test Baccarat complete flow.
    #[test]
    fn test_baccarat_complete() {
        let seed = create_test_seed();
        let mut session = create_session(GameType::Baccarat, 100, 1);

        let mut rng = GameRng::new(&seed, session.id, 0);
        init_game(&mut session, &mut rng);

        let mut rng = GameRng::new(&seed, session.id, 1);
        // Bet on banker (1)
        let result = process_game_move(&mut session, &[1], &mut rng);

        assert!(result.is_ok());
        assert!(session.is_complete);

        // State should have player and banker cards
        assert!(session.state_blob.len() >= 6);
    }

    /// Test Casino War tie handling.
    #[test]
    fn test_casino_war_tie() {
        let seed = create_test_seed();

        // Find a session that results in a tie
        for session_id in 1..200 {
            let mut session = create_session(GameType::CasinoWar, 100, session_id);

            let mut rng = GameRng::new(&seed, session_id, 0);
            init_game(&mut session, &mut rng);

            let mut rng = GameRng::new(&seed, session_id, 1);
            let result = process_game_move(&mut session, &[0], &mut rng); // Play

            if matches!(result, Ok(GameResult::Continue)) {
                // Tie! Go to war
                let mut rng = GameRng::new(&seed, session_id, 2);
                let result = process_game_move(&mut session, &[1], &mut rng); // War

                assert!(result.is_ok());
                assert!(session.is_complete);
                return;
            }
        }
    }

    /// Test Sic Bo various bets.
    #[test]
    fn test_sic_bo_various_bets() {
        let seed = create_test_seed();

        // Test different bet types
        let bet_types = [
            (0, 0, "Small"),
            (1, 0, "Big"),
            (2, 0, "Odd"),
            (3, 0, "Even"),
            (8, 1, "Single 1"),
        ];

        for (session_id, (bet_type, bet_num, name)) in bet_types.iter().enumerate() {
            let mut session = create_session(GameType::SicBo, 100, session_id as u64 + 1);

            let mut rng = GameRng::new(&seed, session.id, 0);
            init_game(&mut session, &mut rng);

            let mut rng = GameRng::new(&seed, session.id, 1);
            let result = process_game_move(&mut session, &[*bet_type, *bet_num], &mut rng);

            assert!(result.is_ok(), "Bet type {} failed", name);
            assert!(session.is_complete, "Game should complete for {}", name);
        }
    }

    /// Test deterministic outcomes across identical sessions.
    #[test]
    fn test_deterministic_outcomes() {
        let seed = create_test_seed();

        // Run two identical sessions
        for _ in 0..2 {
            let mut session1 = create_session(GameType::Blackjack, 100, 42);
            let mut session2 = create_session(GameType::Blackjack, 100, 42);

            let mut rng1 = GameRng::new(&seed, 42, 0);
            let mut rng2 = GameRng::new(&seed, 42, 0);

            init_game(&mut session1, &mut rng1);
            init_game(&mut session2, &mut rng2);

            // States should be identical
            assert_eq!(session1.state_blob, session2.state_blob);

            // Process same move
            let mut rng1 = GameRng::new(&seed, 42, 1);
            let mut rng2 = GameRng::new(&seed, 42, 1);

            let _result1 = process_game_move(&mut session1, &[1], &mut rng1);
            let _result2 = process_game_move(&mut session2, &[1], &mut rng2);

            // Results and states should match
            assert_eq!(session1.state_blob, session2.state_blob);
            assert_eq!(session1.is_complete, session2.is_complete);
        }
    }

    /// Test different sessions produce different outcomes.
    #[test]
    fn test_different_sessions_different_outcomes() {
        let seed = create_test_seed();

        let mut session1 = create_session(GameType::Roulette, 100, 1);
        let mut session2 = create_session(GameType::Roulette, 100, 2);

        let mut rng1 = GameRng::new(&seed, 1, 0);
        let mut rng2 = GameRng::new(&seed, 2, 0);

        init_game(&mut session1, &mut rng1);
        init_game(&mut session2, &mut rng2);

        let mut rng1 = GameRng::new(&seed, 1, 1);
        let mut rng2 = GameRng::new(&seed, 2, 1);

        process_game_move(&mut session1, &[0, 17], &mut rng1).unwrap();
        process_game_move(&mut session2, &[0, 17], &mut rng2).unwrap();

        // Results should be different (with very high probability)
        assert_ne!(session1.state_blob, session2.state_blob);
    }

    /// Test that completed games reject moves.
    #[test]
    fn test_completed_games_reject_moves() {
        let seed = create_test_seed();
        let mut session = create_session(GameType::Roulette, 100, 1);

        let mut rng = GameRng::new(&seed, session.id, 0);
        init_game(&mut session, &mut rng);

        // Complete the game
        let mut rng = GameRng::new(&seed, session.id, 1);
        process_game_move(&mut session, &[1, 0], &mut rng).unwrap();

        assert!(session.is_complete);

        // Try another move
        let mut rng = GameRng::new(&seed, session.id, 2);
        let result = process_game_move(&mut session, &[1, 0], &mut rng);

        assert!(result.is_err());
    }
}
