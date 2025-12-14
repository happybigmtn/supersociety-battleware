use super::super::*;

impl<'a, S: State> Layer<'a, S> {
    // === Casino Handler Methods ===

    pub(in crate::layer) async fn handle_casino_register(
        &mut self,
        public: &PublicKey,
        name: &str,
    ) -> Vec<Event> {
        // Check if player already exists
        if self.get(&Key::CasinoPlayer(public.clone())).await.is_some() {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_PLAYER_ALREADY_REGISTERED,
                message: "Player already registered".to_string(),
            }];
        }

        // Create new player with initial chips and current block for rate limiting
        let player =
            nullspace_types::casino::Player::new_with_block(name.to_string(), self.seed.view);

        self.insert(
            Key::CasinoPlayer(public.clone()),
            Value::CasinoPlayer(player.clone()),
        );

        // Update leaderboard with initial chips
        self.update_casino_leaderboard(public, &player).await;

        vec![Event::CasinoPlayerRegistered {
            player: public.clone(),
            name: name.to_string(),
        }]
    }

    pub(in crate::layer) async fn handle_casino_deposit(
        &mut self,
        public: &PublicKey,
        amount: u64,
    ) -> Vec<Event> {
        let mut player = match self.get(&Key::CasinoPlayer(public.clone())).await {
            Some(Value::CasinoPlayer(p)) => p,
            _ => {
                return vec![Event::CasinoError {
                    player: public.clone(),
                    session_id: None,
                    error_code: nullspace_types::casino::ERROR_PLAYER_NOT_FOUND,
                    message: "Player not found".to_string(),
                }]
            }
        };

        // Daily faucet rate limiting (dev/testing).
        let current_block = self.seed.view;
        let current_time_sec = current_block.saturating_mul(3);
        let current_day = current_time_sec / 86_400;
        let last_deposit_day = player.last_deposit_block.saturating_mul(3) / 86_400;
        let is_rate_limited = player.last_deposit_block != 0 && last_deposit_day == current_day;
        if is_rate_limited {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_RATE_LIMITED,
                message: "Daily faucet already claimed, try again tomorrow".to_string(),
            }];
        }

        // Grant faucet chips
        player.chips = player.chips.saturating_add(amount);
        player.last_deposit_block = current_block;

        self.insert(
            Key::CasinoPlayer(public.clone()),
            Value::CasinoPlayer(player.clone()),
        );

        self.update_casino_leaderboard(public, &player).await;

        vec![Event::CasinoPlayerRegistered {
            player: public.clone(),
            name: player.name,
        }]
    }

    fn update_aura_meter_for_completion(
        player: &mut nullspace_types::casino::Player,
        session: &nullspace_types::casino::GameSession,
        won: bool,
    ) {
        if !session.super_mode.is_active {
            return;
        }

        // Consume a Super Aura Round once it has been used.
        if crate::casino::super_mode::is_super_aura_round(player.aura_meter) {
            player.aura_meter = crate::casino::super_mode::reset_aura_meter();
            return;
        }

        // Until we pipe game-specific aura element detection into the session lifecycle,
        // approximate "near-miss" behavior by incrementing on any super-mode loss.
        player.aura_meter =
            crate::casino::super_mode::update_aura_meter(player.aura_meter, true, won);
    }

    fn consume_aura_round_on_push(
        player: &mut nullspace_types::casino::Player,
        session: &nullspace_types::casino::GameSession,
    ) {
        if !session.super_mode.is_active {
            return;
        }
        if crate::casino::super_mode::is_super_aura_round(player.aura_meter) {
            player.aura_meter = crate::casino::super_mode::reset_aura_meter();
        }
    }

    pub(in crate::layer) async fn handle_casino_start_game(
        &mut self,
        public: &PublicKey,
        game_type: nullspace_types::casino::GameType,
        bet: u64,
        session_id: u64,
    ) -> Vec<Event> {
        // Get player
        let mut player = match self.get(&Key::CasinoPlayer(public.clone())).await {
            Some(Value::CasinoPlayer(p)) => p,
            _ => {
                return vec![Event::CasinoError {
                    player: public.clone(),
                    session_id: Some(session_id),
                    error_code: nullspace_types::casino::ERROR_PLAYER_NOT_FOUND,
                    message: "Player not found".to_string(),
                }]
            }
        };

        // Determine play mode (cash vs tournament)
        let mut is_tournament = false;
        let mut tournament_id = None;
        if let Some(active_tid) = player.active_tournament {
            if let Some(Value::Tournament(t)) = self.get(&Key::Tournament(active_tid)).await {
                if matches!(t.phase, nullspace_types::casino::TournamentPhase::Active) {
                    is_tournament = true;
                    tournament_id = Some(active_tid);
                } else {
                    player.active_tournament = None;
                }
            } else {
                player.active_tournament = None;
            }
        }

        // Some table-style games place all wagers via `CasinoGameMove` deductions (ContinueWithUpdate),
        // so they can start with `bet = 0` without charging an extra "entry fee".
        let allows_zero_bet = matches!(
            game_type,
            nullspace_types::casino::GameType::Baccarat
                | nullspace_types::casino::GameType::Craps
                | nullspace_types::casino::GameType::Roulette
                | nullspace_types::casino::GameType::SicBo
        );
        if bet == 0 && !allows_zero_bet {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: Some(session_id),
                error_code: nullspace_types::casino::ERROR_INVALID_BET,
                message: "Bet must be greater than zero".to_string(),
            }];
        }
        let wants_super = player.active_super;
        let super_fee = if wants_super && bet > 0 {
            crate::casino::get_super_mode_fee(bet)
        } else {
            0
        };
        let required_stack = bet.saturating_add(super_fee);
        let available_stack = if is_tournament {
            player.tournament_chips
        } else {
            player.chips
        };
        if available_stack < required_stack {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: Some(session_id),
                error_code: nullspace_types::casino::ERROR_INSUFFICIENT_FUNDS,
                message: format!(
                    "Insufficient chips: have {}, need {}",
                    available_stack, required_stack
                ),
            }];
        }

        // Check for existing session
        if self.get(&Key::CasinoSession(session_id)).await.is_some() {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: Some(session_id),
                error_code: nullspace_types::casino::ERROR_SESSION_EXISTS,
                message: "Session already exists".to_string(),
            }];
        }

        // Deduct bet (and any upfront super fee) from player
        if is_tournament {
            player.tournament_chips = player.tournament_chips.saturating_sub(required_stack);
        } else {
            player.chips = player.chips.saturating_sub(required_stack);
        }
        self.insert(
            Key::CasinoPlayer(public.clone()),
            Value::CasinoPlayer(player.clone()),
        );

        // Update House PnL (Income)
        if !is_tournament && required_stack > 0 {
            self.update_house_pnl(required_stack as i128).await;
        }

        // Create game session and update leaderboard after bet deduction
        let mut session = nullspace_types::casino::GameSession {
            id: session_id,
            player: public.clone(),
            game_type,
            bet,
            state_blob: vec![],
            move_count: 0,
            created_at: self.seed.view,
            is_complete: false,
            super_mode: nullspace_types::casino::SuperModeState::default(),
            is_tournament,
            tournament_id,
        };

        // Initialize Super/Aura mode for this session (independent RNG domain).
        if wants_super {
            session.super_mode.is_active = true;
            let aura_round = crate::casino::super_mode::is_super_aura_round(player.aura_meter);
            let mut super_rng = crate::casino::GameRng::new(&self.seed, session_id, u32::MAX);
            let mut multipliers =
                crate::casino::generate_super_multipliers(session.game_type, &mut super_rng);
            if aura_round {
                crate::casino::super_mode::enhance_multipliers_for_aura_round(&mut multipliers);
            }
            session.super_mode.multipliers = multipliers;
        }
        self.update_leaderboard_for_session(&session, public, &player)
            .await;

        // Initialize game
        let mut rng = crate::casino::GameRng::new(&self.seed, session_id, 0);
        let result = crate::casino::init_game(&mut session, &mut rng);

        let initial_state = session.state_blob.clone();
        self.insert(
            Key::CasinoSession(session_id),
            Value::CasinoSession(session.clone()),
        );

        let mut events = vec![Event::CasinoGameStarted {
            session_id,
            player: public.clone(),
            game_type,
            bet,
            initial_state,
        }];

        // Handle immediate result (e.g. Natural Blackjack)
        if !matches!(result, crate::casino::GameResult::Continue) {
            if let Some(Value::CasinoPlayer(mut player)) =
                self.get(&Key::CasinoPlayer(public.clone())).await
            {
                match result {
                    crate::casino::GameResult::Win(base_payout) => {
                        let mut payout = base_payout as i64;
                        let was_doubled = player.active_double;
                        if was_doubled
                            && ((session.is_tournament && player.tournament_doubles > 0)
                                || (!session.is_tournament && player.doubles > 0))
                        {
                            payout *= 2;
                            if session.is_tournament {
                                player.tournament_doubles -= 1;
                            } else {
                                player.doubles -= 1;
                            }
                        }
                        // Safe cast: payout should always be positive for Win result
                        let addition = u64::try_from(payout).unwrap_or(0);
                        if session.is_tournament {
                            player.tournament_chips =
                                player.tournament_chips.saturating_add(addition);
                        } else {
                            player.chips = player.chips.saturating_add(addition);
                        }
                        player.active_shield = false;
                        player.active_double = false;
                        player.active_super = false;
                        Self::update_aura_meter_for_completion(&mut player, &session, true);

                        // Update House PnL (Payout)
                        if !session.is_tournament {
                            self.update_house_pnl(-(payout as i128)).await;
                        }

                        let final_chips = if session.is_tournament {
                            player.tournament_chips
                        } else {
                            player.chips
                        };
                        self.insert(
                            Key::CasinoPlayer(public.clone()),
                            Value::CasinoPlayer(player.clone()),
                        );
                        self.update_leaderboard_for_session(&session, public, &player)
                            .await;

                        events.push(Event::CasinoGameCompleted {
                            session_id,
                            player: public.clone(),
                            game_type: session.game_type,
                            payout,
                            final_chips,
                            was_shielded: false,
                            was_doubled,
                        });
                    }
                    crate::casino::GameResult::Push => {
                        if session.is_tournament {
                            player.tournament_chips =
                                player.tournament_chips.saturating_add(session.bet);
                        } else {
                            player.chips = player.chips.saturating_add(session.bet);
                        }
                        player.active_shield = false;
                        player.active_double = false;
                        player.active_super = false;
                        Self::consume_aura_round_on_push(&mut player, &session);

                        let final_chips = if session.is_tournament {
                            player.tournament_chips
                        } else {
                            player.chips
                        };
                        self.insert(
                            Key::CasinoPlayer(public.clone()),
                            Value::CasinoPlayer(player.clone()),
                        );

                        // Update leaderboard after push
                        self.update_leaderboard_for_session(&session, public, &player)
                            .await;

                        events.push(Event::CasinoGameCompleted {
                            session_id,
                            player: public.clone(),
                            game_type: session.game_type,
                            payout: session.bet as i64,
                            final_chips,
                            was_shielded: false,
                            was_doubled: false,
                        });
                    }
                    crate::casino::GameResult::Loss => {
                        let shield_pool = if session.is_tournament {
                            player.tournament_shields
                        } else {
                            player.shields
                        };
                        let was_shielded = player.active_shield && shield_pool > 0;
                        let payout = if was_shielded {
                            if session.is_tournament {
                                player.tournament_shields =
                                    player.tournament_shields.saturating_sub(1);
                            } else {
                                player.shields = player.shields.saturating_sub(1);
                            }
                            0
                        } else {
                            -(session.bet as i64)
                        };
                        player.active_shield = false;
                        player.active_double = false;
                        player.active_super = false;
                        Self::update_aura_meter_for_completion(&mut player, &session, false);

                        let final_chips = if session.is_tournament {
                            player.tournament_chips
                        } else {
                            player.chips
                        };
                        self.insert(
                            Key::CasinoPlayer(public.clone()),
                            Value::CasinoPlayer(player.clone()),
                        );

                        // Update leaderboard after immediate loss
                        self.update_leaderboard_for_session(&session, public, &player)
                            .await;

                        events.push(Event::CasinoGameCompleted {
                            session_id,
                            player: public.clone(),
                            game_type: session.game_type,
                            payout,
                            final_chips,
                            was_shielded,
                            was_doubled: false,
                        });
                    }
                    _ => {}
                }
            }
        }

        events
    }

    pub(in crate::layer) async fn handle_casino_game_move(
        &mut self,
        public: &PublicKey,
        session_id: u64,
        payload: &[u8],
    ) -> Vec<Event> {
        // Get session
        let mut session = match self.get(&Key::CasinoSession(session_id)).await {
            Some(Value::CasinoSession(s)) => s,
            _ => {
                return vec![Event::CasinoError {
                    player: public.clone(),
                    session_id: Some(session_id),
                    error_code: nullspace_types::casino::ERROR_SESSION_NOT_FOUND,
                    message: "Session not found".to_string(),
                }]
            }
        };

        // Verify ownership and not complete
        if session.player != *public {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: Some(session_id),
                error_code: nullspace_types::casino::ERROR_SESSION_NOT_OWNED,
                message: "Session does not belong to this player".to_string(),
            }];
        }
        if session.is_complete {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: Some(session_id),
                error_code: nullspace_types::casino::ERROR_SESSION_COMPLETE,
                message: "Session already complete".to_string(),
            }];
        }

        // Process move
        session.move_count += 1;
        let mut rng = crate::casino::GameRng::new(&self.seed, session_id, session.move_count);

        let result = match crate::casino::process_game_move(&mut session, payload, &mut rng) {
            Ok(r) => r,
            Err(_) => {
                return vec![Event::CasinoError {
                    player: public.clone(),
                    session_id: Some(session_id),
                    error_code: nullspace_types::casino::ERROR_INVALID_MOVE,
                    message: "Invalid game move".to_string(),
                }]
            }
        };

        let result = self
            .apply_progressive_meters_for_completion(&session, result)
            .await;

        let move_number = session.move_count;
        let new_state = session.state_blob.clone();

        // Handle game result
        let mut events = vec![Event::CasinoGameMoved {
            session_id,
            move_number,
            new_state,
        }];

        match result {
            crate::casino::GameResult::Continue => {
                self.insert(
                    Key::CasinoSession(session_id),
                    Value::CasinoSession(session),
                );
            }
            crate::casino::GameResult::ContinueWithUpdate { payout } => {
                // Handle mid-game balance updates (additional bets or intermediate payouts)
                if let Some(Value::CasinoPlayer(mut player)) =
                    self.get(&Key::CasinoPlayer(public.clone())).await
                {
                    let stack = if session.is_tournament {
                        &mut player.tournament_chips
                    } else {
                        &mut player.chips
                    };
                    if payout < 0 {
                        // Deducting chips (new bet placed)
                        // Use checked_neg to safely convert negative i64 to positive value
                        let deduction = payout
                            .checked_neg()
                            .and_then(|v| u64::try_from(v).ok())
                            .unwrap_or(0);
                        let super_fee = if session.super_mode.is_active {
                            crate::casino::get_super_mode_fee(deduction)
                        } else {
                            0
                        };
                        let total_deduction = deduction.saturating_add(super_fee);
                        if deduction == 0 || *stack < total_deduction {
                            // Insufficient funds or overflow - reject the move
                            return vec![Event::CasinoError {
                                player: public.clone(),
                                session_id: Some(session_id),
                                error_code: nullspace_types::casino::ERROR_INSUFFICIENT_FUNDS,
                                message: format!(
                                    "Insufficient chips for additional bet: have {}, need {}",
                                    *stack, total_deduction
                                ),
                            }];
                        }
                        *stack = stack.saturating_sub(total_deduction);

                        // Update House PnL for cash games only (income from wager + super fee).
                        if !session.is_tournament && total_deduction > 0 {
                            self.update_house_pnl(total_deduction as i128).await;
                        }
                    } else {
                        // Adding chips (intermediate win)
                        // Safe cast: positive i64 fits in u64
                        let addition = u64::try_from(payout).unwrap_or(0);
                        *stack = stack.saturating_add(addition);

                        // Update House PnL for cash games only (payout outflow).
                        if !session.is_tournament && addition > 0 {
                            self.update_house_pnl(-(addition as i128)).await;
                        }
                    }
                    self.insert(
                        Key::CasinoPlayer(public.clone()),
                        Value::CasinoPlayer(player.clone()),
                    );

                    // Update leaderboard after mid-game balance change
                    self.update_leaderboard_for_session(&session, public, &player)
                        .await;
                }
                self.insert(
                    Key::CasinoSession(session_id),
                    Value::CasinoSession(session),
                );
            }
            crate::casino::GameResult::Win(base_payout) => {
                session.is_complete = true;
                self.insert(
                    Key::CasinoSession(session_id),
                    Value::CasinoSession(session.clone()),
                );

                // Get player for modifier state
                if let Some(Value::CasinoPlayer(mut player)) =
                    self.get(&Key::CasinoPlayer(public.clone())).await
                {
                    let mut payout = base_payout as i64;
                    let was_doubled = player.active_double;
                    let doubles_pool = if session.is_tournament {
                        &mut player.tournament_doubles
                    } else {
                        &mut player.doubles
                    };
                    if was_doubled && *doubles_pool > 0 {
                        payout *= 2;
                        *doubles_pool -= 1;
                    }
                    // Safe cast: payout should always be positive for Win result
                    let addition = u64::try_from(payout).unwrap_or(0);
                    let final_chips = {
                        let stack = if session.is_tournament {
                            &mut player.tournament_chips
                        } else {
                            &mut player.chips
                        };
                        *stack = stack.saturating_add(addition);
                        *stack
                    };
                    player.active_shield = false;
                    player.active_double = false;
                    player.active_super = false;
                    Self::update_aura_meter_for_completion(&mut player, &session, true);

                    if !session.is_tournament {
                        self.update_house_pnl(-(payout as i128)).await;
                    }

                    self.insert(
                        Key::CasinoPlayer(public.clone()),
                        Value::CasinoPlayer(player.clone()),
                    );
                    self.update_leaderboard_for_session(&session, public, &player)
                        .await;

                    events.push(Event::CasinoGameCompleted {
                        session_id,
                        player: public.clone(),
                        game_type: session.game_type,
                        payout,
                        final_chips,
                        was_shielded: false,
                        was_doubled,
                    });
                }
            }
            crate::casino::GameResult::WinWithExtraDeduction {
                payout: base_payout,
                extra_deduction,
            } => {
                // Completed win that still needs an additional deduction (e.g., immediate terminal state
                // after a mid-game bet increase).
                if let Some(Value::CasinoPlayer(mut player)) =
                    self.get(&Key::CasinoPlayer(public.clone())).await
                {
                    if extra_deduction > 0 {
                        let super_fee = if session.super_mode.is_active {
                            crate::casino::get_super_mode_fee(extra_deduction)
                        } else {
                            0
                        };
                        let total_deduction = extra_deduction.saturating_add(super_fee);
                        let stack = if session.is_tournament {
                            &mut player.tournament_chips
                        } else {
                            &mut player.chips
                        };
                        if *stack < total_deduction {
                            return vec![Event::CasinoError {
                                player: public.clone(),
                                session_id: Some(session_id),
                                error_code: nullspace_types::casino::ERROR_INSUFFICIENT_FUNDS,
                                message: format!(
                                    "Insufficient chips for additional bet: have {}, need {}",
                                    *stack, total_deduction
                                ),
                            }];
                        }
                        *stack = stack.saturating_sub(total_deduction);

                        // Update House PnL for cash games only (income from the extra wager).
                        if !session.is_tournament && total_deduction > 0 {
                            self.update_house_pnl(total_deduction as i128).await;
                        }
                    }

                    session.is_complete = true;
                    self.insert(
                        Key::CasinoSession(session_id),
                        Value::CasinoSession(session.clone()),
                    );

                    let mut payout = base_payout as i64;
                    let was_doubled = player.active_double;
                    let doubles_pool = if session.is_tournament {
                        &mut player.tournament_doubles
                    } else {
                        &mut player.doubles
                    };
                    if was_doubled && *doubles_pool > 0 {
                        payout *= 2;
                        *doubles_pool -= 1;
                    }

                    // Safe cast: payout should always be positive for win result.
                    let addition = u64::try_from(payout).unwrap_or(0);
                    let final_chips = {
                        let stack = if session.is_tournament {
                            &mut player.tournament_chips
                        } else {
                            &mut player.chips
                        };
                        *stack = stack.saturating_add(addition);
                        *stack
                    };

                    player.active_shield = false;
                    player.active_double = false;
                    player.active_super = false;
                    Self::update_aura_meter_for_completion(&mut player, &session, true);

                    // Update House PnL for cash games only (payout outflow).
                    if !session.is_tournament {
                        self.update_house_pnl(-(payout as i128)).await;
                    }

                    self.insert(
                        Key::CasinoPlayer(public.clone()),
                        Value::CasinoPlayer(player.clone()),
                    );
                    self.update_leaderboard_for_session(&session, public, &player)
                        .await;

                    events.push(Event::CasinoGameCompleted {
                        session_id,
                        player: public.clone(),
                        game_type: session.game_type,
                        payout,
                        final_chips,
                        was_shielded: false,
                        was_doubled,
                    });
                } else {
                    // Player not found; still persist completion.
                    session.is_complete = true;
                    self.insert(
                        Key::CasinoSession(session_id),
                        Value::CasinoSession(session.clone()),
                    );
                }
            }
            crate::casino::GameResult::Push => {
                session.is_complete = true;
                self.insert(
                    Key::CasinoSession(session_id),
                    Value::CasinoSession(session.clone()),
                );

                if let Some(Value::CasinoPlayer(mut player)) =
                    self.get(&Key::CasinoPlayer(public.clone())).await
                {
                    // Return bet on push
                    let final_chips = {
                        let stack = if session.is_tournament {
                            &mut player.tournament_chips
                        } else {
                            &mut player.chips
                        };
                        *stack = stack.saturating_add(session.bet);
                        *stack
                    };
                    player.active_shield = false;
                    player.active_double = false;
                    player.active_super = false;
                    Self::consume_aura_round_on_push(&mut player, &session);

                    // Update House PnL (Refund)
                    if !session.is_tournament {
                        self.update_house_pnl(-(session.bet as i128)).await;
                    }

                    self.insert(
                        Key::CasinoPlayer(public.clone()),
                        Value::CasinoPlayer(player.clone()),
                    );

                    // Update leaderboard after push
                    self.update_leaderboard_for_session(&session, public, &player)
                        .await;

                    events.push(Event::CasinoGameCompleted {
                        session_id,
                        player: public.clone(),
                        game_type: session.game_type,
                        payout: session.bet as i64,
                        final_chips,
                        was_shielded: false,
                        was_doubled: false,
                    });
                }
            }
            crate::casino::GameResult::Loss => {
                session.is_complete = true;
                self.insert(
                    Key::CasinoSession(session_id),
                    Value::CasinoSession(session.clone()),
                );

                if let Some(Value::CasinoPlayer(mut player)) =
                    self.get(&Key::CasinoPlayer(public.clone())).await
                {
                    let shields_pool = if session.is_tournament {
                        &mut player.tournament_shields
                    } else {
                        &mut player.shields
                    };
                    let was_shielded = player.active_shield && *shields_pool > 0;
                    let payout = if was_shielded {
                        *shields_pool = shields_pool.saturating_sub(1);
                        0 // Shield prevents loss
                    } else {
                        -(session.bet as i64)
                    };
                    player.active_shield = false;
                    player.active_double = false;
                    player.active_super = false;
                    Self::update_aura_meter_for_completion(&mut player, &session, false);

                    let stack = if session.is_tournament {
                        &mut player.tournament_chips
                    } else {
                        &mut player.chips
                    };
                    let final_chips = *stack;
                    self.insert(
                        Key::CasinoPlayer(public.clone()),
                        Value::CasinoPlayer(player.clone()),
                    );

                    // Update leaderboard after loss
                    self.update_leaderboard_for_session(&session, public, &player)
                        .await;

                    events.push(Event::CasinoGameCompleted {
                        session_id,
                        player: public.clone(),
                        game_type: session.game_type,
                        payout,
                        final_chips,
                        was_shielded,
                        was_doubled: false,
                    });
                }
            }
            crate::casino::GameResult::LossWithExtraDeduction(extra) => {
                // Loss with additional deduction for mid-game bet increases
                // (e.g., Blackjack double-down, Casino War go-to-war)
                session.is_complete = true;
                self.insert(
                    Key::CasinoSession(session_id),
                    Value::CasinoSession(session.clone()),
                );

                if let Some(Value::CasinoPlayer(mut player)) =
                    self.get(&Key::CasinoPlayer(public.clone())).await
                {
                    let (was_shielded, payout, final_chips) = {
                        let shields_pool = if session.is_tournament {
                            &mut player.tournament_shields
                        } else {
                            &mut player.shields
                        };
                        let stack = if session.is_tournament {
                            &mut player.tournament_chips
                        } else {
                            &mut player.chips
                        };
                        let was_shielded = player.active_shield && *shields_pool > 0;
                        let payout = if was_shielded {
                            *shields_pool = shields_pool.saturating_sub(1);
                            0 // Shield prevents loss (but extra still deducted)
                        } else {
                            -(session.bet as i64)
                        };

                        // Deduct the extra amount that wasn't charged at StartGame (plus any super fee).
                        if extra > 0 {
                            let super_fee = if session.super_mode.is_active {
                                crate::casino::get_super_mode_fee(extra)
                            } else {
                                0
                            };
                            let total_deduction = extra.saturating_add(super_fee);
                            if *stack < total_deduction {
                                return vec![Event::CasinoError {
                                    player: public.clone(),
                                    session_id: Some(session_id),
                                    error_code: nullspace_types::casino::ERROR_INSUFFICIENT_FUNDS,
                                    message: format!(
                                        "Insufficient chips for additional bet: have {}, need {}",
                                        *stack, total_deduction
                                    ),
                                }];
                            }
                            *stack = stack.saturating_sub(total_deduction);

                            // Update House PnL for cash games only (income from extra wager + super fee).
                            // Note: Shield does NOT prevent this extra deduction in current logic.
                            if !session.is_tournament && total_deduction > 0 {
                                self.update_house_pnl(total_deduction as i128).await;
                            }
                        }

                        (was_shielded, payout, *stack)
                    };

                    player.active_shield = false;
                    player.active_double = false;
                    player.active_super = false;
                    Self::update_aura_meter_for_completion(&mut player, &session, false);

                    self.insert(
                        Key::CasinoPlayer(public.clone()),
                        Value::CasinoPlayer(player.clone()),
                    );

                    // Update leaderboard after loss with extra deduction
                    self.update_leaderboard_for_session(&session, public, &player)
                        .await;

                    events.push(Event::CasinoGameCompleted {
                        session_id,
                        player: public.clone(),
                        game_type: session.game_type,
                        payout: payout - (extra as i64), // Total loss includes extra
                        final_chips,
                        was_shielded,
                        was_doubled: false,
                    });
                }
            }
            crate::casino::GameResult::LossPreDeducted(total_loss) => {
                // Loss where chips were already deducted via ContinueWithUpdate
                // (e.g., Baccarat, Craps, Roulette, Sic Bo table games)
                // No additional chip deduction needed, just report the loss amount
                session.is_complete = true;
                self.insert(
                    Key::CasinoSession(session_id),
                    Value::CasinoSession(session.clone()),
                );

                if let Some(Value::CasinoPlayer(mut player)) =
                    self.get(&Key::CasinoPlayer(public.clone())).await
                {
                    let (was_shielded, payout, final_chips) = {
                        let shields_pool = if session.is_tournament {
                            &mut player.tournament_shields
                        } else {
                            &mut player.shields
                        };
                        let stack = if session.is_tournament {
                            &mut player.tournament_chips
                        } else {
                            &mut player.chips
                        };
                        let was_shielded = player.active_shield && *shields_pool > 0;
                        let payout = if was_shielded {
                            // Shield prevents loss - refund the pre-deducted amount
                            *shields_pool = shields_pool.saturating_sub(1);
                            *stack = stack.saturating_add(total_loss);

                            // Update House PnL (Refund)
                            if !session.is_tournament {
                                self.update_house_pnl(-(total_loss as i128)).await;
                            }

                            0
                        } else {
                            -(total_loss as i64)
                        };

                        (was_shielded, payout, *stack)
                    };

                    player.active_shield = false;
                    player.active_double = false;
                    player.active_super = false;
                    Self::update_aura_meter_for_completion(&mut player, &session, false);

                    self.insert(
                        Key::CasinoPlayer(public.clone()),
                        Value::CasinoPlayer(player.clone()),
                    );

                    // Update leaderboard after pre-deducted loss
                    self.update_leaderboard_for_session(&session, public, &player)
                        .await;

                    events.push(Event::CasinoGameCompleted {
                        session_id,
                        player: public.clone(),
                        game_type: session.game_type,
                        payout,
                        final_chips,
                        was_shielded,
                        was_doubled: false,
                    });
                }
            }
            crate::casino::GameResult::LossPreDeductedWithExtraDeduction {
                total_loss,
                extra_deduction,
            } => {
                // Loss where most chips were already deducted, but an additional deduction is still required.
                if let Some(Value::CasinoPlayer(mut player)) =
                    self.get(&Key::CasinoPlayer(public.clone())).await
                {
                    let (was_shielded, payout, final_chips) = {
                        let shields_pool = if session.is_tournament {
                            &mut player.tournament_shields
                        } else {
                            &mut player.shields
                        };
                        let stack = if session.is_tournament {
                            &mut player.tournament_chips
                        } else {
                            &mut player.chips
                        };

                        if extra_deduction > 0 {
                            let super_fee = if session.super_mode.is_active {
                                crate::casino::get_super_mode_fee(extra_deduction)
                            } else {
                                0
                            };
                            let total_deduction = extra_deduction.saturating_add(super_fee);
                            if *stack < total_deduction {
                                return vec![Event::CasinoError {
                                    player: public.clone(),
                                    session_id: Some(session_id),
                                    error_code: nullspace_types::casino::ERROR_INSUFFICIENT_FUNDS,
                                    message: format!(
                                        "Insufficient chips for additional bet: have {}, need {}",
                                        *stack, total_deduction
                                    ),
                                }];
                            }
                            *stack = stack.saturating_sub(total_deduction);

                            // Update House PnL for cash games only (income from the extra wager).
                            if !session.is_tournament && total_deduction > 0 {
                                self.update_house_pnl(total_deduction as i128).await;
                            }
                        }

                        session.is_complete = true;
                        self.insert(
                            Key::CasinoSession(session_id),
                            Value::CasinoSession(session.clone()),
                        );

                        let was_shielded = player.active_shield && *shields_pool > 0;
                        let payout = if was_shielded {
                            // Shield prevents loss - refund the full loss amount (including the extra deduction).
                            *shields_pool = shields_pool.saturating_sub(1);
                            *stack = stack.saturating_add(total_loss);

                            if !session.is_tournament {
                                self.update_house_pnl(-(total_loss as i128)).await;
                            }
                            0
                        } else {
                            -(total_loss as i64)
                        };

                        (was_shielded, payout, *stack)
                    };

                    player.active_shield = false;
                    player.active_double = false;
                    player.active_super = false;
                    Self::update_aura_meter_for_completion(&mut player, &session, false);

                    self.insert(
                        Key::CasinoPlayer(public.clone()),
                        Value::CasinoPlayer(player.clone()),
                    );
                    self.update_leaderboard_for_session(&session, public, &player)
                        .await;

                    events.push(Event::CasinoGameCompleted {
                        session_id,
                        player: public.clone(),
                        game_type: session.game_type,
                        payout,
                        final_chips,
                        was_shielded,
                        was_doubled: false,
                    });
                } else {
                    session.is_complete = true;
                    self.insert(
                        Key::CasinoSession(session_id),
                        Value::CasinoSession(session.clone()),
                    );
                }
            }
        }

        events
    }

    pub(in crate::layer) async fn handle_casino_toggle_shield(
        &mut self,
        public: &PublicKey,
    ) -> Vec<Event> {
        if let Some(Value::CasinoPlayer(mut player)) =
            self.get(&Key::CasinoPlayer(public.clone())).await
        {
            player.active_shield = !player.active_shield;
            self.insert(
                Key::CasinoPlayer(public.clone()),
                Value::CasinoPlayer(player),
            );
        }
        vec![]
    }

    pub(in crate::layer) async fn handle_casino_toggle_double(
        &mut self,
        public: &PublicKey,
    ) -> Vec<Event> {
        if let Some(Value::CasinoPlayer(mut player)) =
            self.get(&Key::CasinoPlayer(public.clone())).await
        {
            player.active_double = !player.active_double;
            self.insert(
                Key::CasinoPlayer(public.clone()),
                Value::CasinoPlayer(player),
            );
        }
        vec![]
    }

    pub(in crate::layer) async fn handle_casino_toggle_super(
        &mut self,
        public: &PublicKey,
    ) -> Vec<Event> {
        if let Some(Value::CasinoPlayer(mut player)) =
            self.get(&Key::CasinoPlayer(public.clone())).await
        {
            player.active_super = !player.active_super;
            self.insert(
                Key::CasinoPlayer(public.clone()),
                Value::CasinoPlayer(player),
            );
        }
        vec![]
    }

    pub(in crate::layer) async fn handle_casino_join_tournament(
        &mut self,
        public: &PublicKey,
        tournament_id: u64,
    ) -> Vec<Event> {
        // Verify player exists
        let mut player = match self.get(&Key::CasinoPlayer(public.clone())).await {
            Some(Value::CasinoPlayer(p)) => p,
            _ => {
                return vec![Event::CasinoError {
                    player: public.clone(),
                    session_id: None,
                    error_code: nullspace_types::casino::ERROR_PLAYER_NOT_FOUND,
                    message: "Player not found".to_string(),
                }]
            }
        };

        // Check tournament limit (5 per day)
        // Approximate time from view (3s per block)
        let current_time_sec = self.seed.view * 3;
        let current_day = current_time_sec / 86400;
        let last_played_day = player.last_tournament_ts / 86400;

        if current_day > last_played_day {
            player.tournaments_played_today = 0;
        }

        if player.tournaments_played_today >= 5 {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_TOURNAMENT_LIMIT_REACHED,
                message: "Daily tournament limit reached (5/5)".to_string(),
            }];
        }

        // Get or create tournament
        let mut tournament = match self.get(&Key::Tournament(tournament_id)).await {
            Some(Value::Tournament(t)) => t,
            _ => nullspace_types::casino::Tournament {
                id: tournament_id,
                phase: nullspace_types::casino::TournamentPhase::Registration,
                start_block: 0,
                start_time_ms: 0,
                end_time_ms: 0,
                players: Vec::new(),
                prize_pool: 0,
                starting_chips: nullspace_types::casino::STARTING_CHIPS,
                starting_shields: nullspace_types::casino::STARTING_SHIELDS,
                starting_doubles: nullspace_types::casino::STARTING_DOUBLES,
                leaderboard: nullspace_types::casino::CasinoLeaderboard::default(),
            },
        };

        // Check if can join
        if !matches!(
            tournament.phase,
            nullspace_types::casino::TournamentPhase::Registration
        ) {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_TOURNAMENT_NOT_REGISTERING,
                message: "Tournament is not in registration phase".to_string(),
            }];
        }

        // Add player (check not already joined)
        if !tournament.add_player(public.clone()) {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_ALREADY_IN_TOURNAMENT,
                message: "Already joined this tournament".to_string(),
            }];
        }

        // Update player tracking
        player.tournaments_played_today += 1;
        player.last_tournament_ts = current_time_sec;
        player.active_tournament = Some(tournament_id);

        self.insert(
            Key::CasinoPlayer(public.clone()),
            Value::CasinoPlayer(player),
        );
        self.insert(
            Key::Tournament(tournament_id),
            Value::Tournament(tournament),
        );

        vec![Event::PlayerJoined {
            tournament_id,
            player: public.clone(),
        }]
    }

    pub(in crate::layer) async fn handle_casino_start_tournament(
        &mut self,
        public: &PublicKey,
        tournament_id: u64,
        start_time_ms: u64,
        end_time_ms: u64,
    ) -> Vec<Event> {
        let mut tournament = match self.get(&Key::Tournament(tournament_id)).await {
            Some(Value::Tournament(t)) => {
                // Prevent double-starts which would double-mint the prize pool.
                if matches!(t.phase, nullspace_types::casino::TournamentPhase::Active) {
                    return vec![Event::CasinoError {
                        player: public.clone(),
                        session_id: None,
                        error_code: nullspace_types::casino::ERROR_INVALID_MOVE,
                        message: "Tournament already active".to_string(),
                    }];
                }
                if matches!(t.phase, nullspace_types::casino::TournamentPhase::Complete) {
                    return vec![Event::CasinoError {
                        player: public.clone(),
                        session_id: None,
                        error_code: nullspace_types::casino::ERROR_INVALID_MOVE,
                        message: "Tournament already complete".to_string(),
                    }];
                }
                t
            }
            None => {
                // Create new if doesn't exist (single player start)
                let mut t = nullspace_types::casino::Tournament {
                    id: tournament_id,
                    phase: nullspace_types::casino::TournamentPhase::Active,
                    start_block: self.seed.view,
                    start_time_ms,
                    end_time_ms,
                    players: Vec::new(),
                    prize_pool: 0,
                    starting_chips: nullspace_types::casino::STARTING_CHIPS,
                    starting_shields: nullspace_types::casino::STARTING_SHIELDS,
                    starting_doubles: nullspace_types::casino::STARTING_DOUBLES,
                    leaderboard: nullspace_types::casino::CasinoLeaderboard::default(),
                };
                t.add_player(public.clone());
                t
            }
            _ => panic!("Storage corruption: Key::Tournament returned non-Tournament value"),
        };

        // Enforce fixed tournament duration (5 minutes) for freeroll tournaments.
        // Ignore client-provided end time if inconsistent.
        let expected_duration_ms =
            nullspace_types::casino::TOURNAMENT_DURATION_SECS.saturating_mul(1000);
        let end_time_ms = if end_time_ms >= start_time_ms
            && end_time_ms.saturating_sub(start_time_ms) == expected_duration_ms
        {
            end_time_ms
        } else {
            start_time_ms.saturating_add(expected_duration_ms)
        };

        // Calculate Prize Pool (Inflationary)
        let total_supply = nullspace_types::casino::TOTAL_SUPPLY as u128;
        let annual_bps = nullspace_types::casino::ANNUAL_EMISSION_RATE_BPS as u128;
        let tournaments_per_day = nullspace_types::casino::TOURNAMENTS_PER_DAY as u128;
        let reward_pool_cap =
            total_supply * nullspace_types::casino::REWARD_POOL_BPS as u128 / 10000;

        let annual_emission = total_supply * annual_bps / 10000;
        let daily_emission = annual_emission / 365;
        let per_game_emission = daily_emission / tournaments_per_day;

        // Cap emissions to the remaining reward pool (25% of supply over ~5 years)
        let mut house = self.get_or_init_house().await;
        let remaining_pool = reward_pool_cap.saturating_sub(house.total_issuance as u128);
        let capped_emission = per_game_emission.min(remaining_pool);
        let prize_pool = capped_emission as u64;

        // Track Issuance in House
        house.total_issuance = house
            .total_issuance
            .saturating_add(prize_pool)
            .min(reward_pool_cap as u64);
        self.insert(Key::House, Value::House(house));

        // Update state
        tournament.phase = nullspace_types::casino::TournamentPhase::Active;
        tournament.start_block = self.seed.view;
        tournament.start_time_ms = start_time_ms;
        tournament.end_time_ms = end_time_ms;
        tournament.prize_pool = prize_pool;

        // Reset tournament-only stacks for all players and rebuild the tournament leaderboard
        let mut leaderboard = nullspace_types::casino::CasinoLeaderboard::default();
        for player_pk in &tournament.players {
            if let Some(Value::CasinoPlayer(mut player)) =
                self.get(&Key::CasinoPlayer(player_pk.clone())).await
            {
                player.tournament_chips = tournament.starting_chips;
                player.tournament_shields = tournament.starting_shields;
                player.tournament_doubles = tournament.starting_doubles;
                player.active_tournament = Some(tournament_id);
                player.active_shield = false;
                player.active_double = false;
                player.active_super = false;
                player.active_session = None;
                player.aura_meter = 0;

                self.insert(
                    Key::CasinoPlayer(player_pk.clone()),
                    Value::CasinoPlayer(player.clone()),
                );
                leaderboard.update(
                    player_pk.clone(),
                    player.name.clone(),
                    player.tournament_chips,
                );
            }
        }

        tournament.leaderboard = leaderboard;

        self.insert(
            Key::Tournament(tournament_id),
            Value::Tournament(tournament.clone()),
        );

        vec![Event::TournamentStarted {
            id: tournament_id,
            start_block: self.seed.view,
        }]
    }

    pub(in crate::layer) async fn handle_casino_end_tournament(
        &mut self,
        _public: &PublicKey,
        tournament_id: u64,
    ) -> Vec<Event> {
        let mut tournament =
            if let Some(Value::Tournament(t)) = self.get(&Key::Tournament(tournament_id)).await {
                t
            } else {
                return vec![];
            };

        if !matches!(
            tournament.phase,
            nullspace_types::casino::TournamentPhase::Active
        ) {
            return vec![];
        }

        // Gather player tournament chips
        let mut rankings: Vec<(PublicKey, u64)> = Vec::new();
        for player_pk in &tournament.players {
            if let Some(Value::CasinoPlayer(p)) =
                self.get(&Key::CasinoPlayer(player_pk.clone())).await
            {
                rankings.push((player_pk.clone(), p.tournament_chips));
            }
        }

        // Sort descending
        rankings.sort_by(|a, b| b.1.cmp(&a.1));

        // Determine winners (Top 15% for MTT style)
        let num_players = rankings.len();
        let num_winners = (num_players as f64 * 0.15).ceil() as usize;
        let num_winners = num_winners.max(1).min(num_players);

        // Calculate payout weights (1/rank harmonic distribution)
        let mut weights = Vec::with_capacity(num_winners);
        let mut total_weight = 0.0;
        for i in 1..=num_winners {
            let w = 1.0 / (i as f64);
            weights.push(w);
            total_weight += w;
        }

        // Distribute Prize Pool
        if total_weight > 0.0 && tournament.prize_pool > 0 {
            for i in 0..num_winners {
                let (pk, _) = &rankings[i];
                let weight = weights[i];
                let share = weight / total_weight;
                let payout = (share * tournament.prize_pool as f64) as u64;

                if payout > 0 {
                    if let Some(Value::CasinoPlayer(mut p)) =
                        self.get(&Key::CasinoPlayer(pk.clone())).await
                    {
                        // Tournament prizes are credited to the real bankroll
                        p.chips = p.chips.saturating_add(payout);
                        self.insert(Key::CasinoPlayer(pk.clone()), Value::CasinoPlayer(p));
                    }
                }
            }
        }

        // Clear tournament flags and stacks now that the event is over
        for player_pk in &tournament.players {
            if let Some(Value::CasinoPlayer(mut player)) =
                self.get(&Key::CasinoPlayer(player_pk.clone())).await
            {
                if player.active_tournament == Some(tournament_id) {
                    player.active_tournament = None;
                    player.tournament_chips = 0;
                    player.tournament_shields = 0;
                    player.tournament_doubles = 0;
                    player.active_shield = false;
                    player.active_double = false;
                    player.active_super = false;
                    player.active_session = None;
                    self.insert(
                        Key::CasinoPlayer(player_pk.clone()),
                        Value::CasinoPlayer(player.clone()),
                    );
                }
            }
        }

        tournament.phase = nullspace_types::casino::TournamentPhase::Complete;
        self.insert(
            Key::Tournament(tournament_id),
            Value::Tournament(tournament),
        );

        vec![Event::TournamentEnded {
            id: tournament_id,
            rankings,
        }]
    }

    async fn update_casino_leaderboard(
        &mut self,
        public: &PublicKey,
        player: &nullspace_types::casino::Player,
    ) {
        let mut leaderboard = match self.get(&Key::CasinoLeaderboard).await {
            Some(Value::CasinoLeaderboard(lb)) => lb,
            _ => nullspace_types::casino::CasinoLeaderboard::default(),
        };
        leaderboard.update(public.clone(), player.name.clone(), player.chips);
        self.insert(
            Key::CasinoLeaderboard,
            Value::CasinoLeaderboard(leaderboard),
        );
    }

    async fn update_tournament_leaderboard(
        &mut self,
        tournament_id: u64,
        public: &PublicKey,
        player: &nullspace_types::casino::Player,
    ) {
        if let Some(Value::Tournament(mut t)) = self.get(&Key::Tournament(tournament_id)).await {
            t.leaderboard
                .update(public.clone(), player.name.clone(), player.tournament_chips);
            self.insert(Key::Tournament(tournament_id), Value::Tournament(t));
        }
    }

    async fn update_leaderboard_for_session(
        &mut self,
        session: &nullspace_types::casino::GameSession,
        public: &PublicKey,
        player: &nullspace_types::casino::Player,
    ) {
        if session.is_tournament {
            if let Some(tid) = session.tournament_id {
                self.update_tournament_leaderboard(tid, public, player)
                    .await;
            }
        } else {
            self.update_casino_leaderboard(public, player).await;
        }
    }

    async fn apply_progressive_meters_for_completion(
        &mut self,
        session: &nullspace_types::casino::GameSession,
        result: crate::casino::GameResult,
    ) -> crate::casino::GameResult {
        if session.is_tournament || !session.is_complete {
            return result;
        }

        match session.game_type {
            nullspace_types::casino::GameType::ThreeCard => {
                self.apply_three_card_progressive_meter(session, result)
                    .await
            }
            nullspace_types::casino::GameType::UltimateHoldem => {
                self.apply_uth_progressive_meter(session, result).await
            }
            _ => result,
        }
    }

    async fn apply_three_card_progressive_meter(
        &mut self,
        session: &nullspace_types::casino::GameSession,
        result: crate::casino::GameResult,
    ) -> crate::casino::GameResult {
        let Some((progressive_bet, player_cards)) =
            parse_three_card_progressive_state(&session.state_blob)
        else {
            return result;
        };
        if progressive_bet == 0 {
            return result;
        }

        let mut house = self.get_or_init_house().await;
        let base = nullspace_types::casino::THREE_CARD_PROGRESSIVE_BASE_JACKPOT;

        let mut jackpot = house.three_card_progressive_jackpot.max(base);
        jackpot = jackpot.saturating_add(progressive_bet);

        let can_adjust = matches!(result, crate::casino::GameResult::Win(_));
        let is_jackpot = can_adjust && is_three_card_mini_royal_spades(&player_cards);
        let delta = if is_jackpot {
            progressive_bet.saturating_mul(jackpot.saturating_sub(base))
        } else {
            0
        };

        house.three_card_progressive_jackpot = if is_jackpot { base } else { jackpot };
        self.insert(Key::House, Value::House(house));

        match result {
            crate::casino::GameResult::Win(payout) if delta > 0 => {
                crate::casino::GameResult::Win(payout.saturating_add(delta))
            }
            other => other,
        }
    }

    async fn apply_uth_progressive_meter(
        &mut self,
        session: &nullspace_types::casino::GameSession,
        result: crate::casino::GameResult,
    ) -> crate::casino::GameResult {
        let Some((progressive_bet, hole, flop)) = parse_uth_progressive_state(&session.state_blob)
        else {
            return result;
        };
        if progressive_bet == 0 {
            return result;
        }

        let mut house = self.get_or_init_house().await;
        let base = nullspace_types::casino::UTH_PROGRESSIVE_BASE_JACKPOT;

        let mut jackpot = house.uth_progressive_jackpot.max(base);
        jackpot = jackpot.saturating_add(progressive_bet);

        let can_adjust = matches!(result, crate::casino::GameResult::Win(_));
        let tier = if can_adjust {
            uth_progressive_jackpot_tier(&hole, &flop)
        } else {
            UthJackpotTier::None
        };
        let delta = match tier {
            UthJackpotTier::RoyalFlush => {
                progressive_bet.saturating_mul(jackpot.saturating_sub(base))
            }
            UthJackpotTier::StraightFlush => {
                let desired = jackpot / 10;
                let current = base / 10;
                progressive_bet.saturating_mul(desired.saturating_sub(current))
            }
            UthJackpotTier::None => 0,
        };

        house.uth_progressive_jackpot = if matches!(tier, UthJackpotTier::RoyalFlush) {
            base
        } else {
            jackpot
        };
        self.insert(Key::House, Value::House(house));

        match result {
            crate::casino::GameResult::Win(payout) if delta > 0 => {
                crate::casino::GameResult::Win(payout.saturating_add(delta))
            }
            other => other,
        }
    }

    async fn update_house_pnl(&mut self, amount: i128) {
        let mut house = self.get_or_init_house().await;
        house.net_pnl += amount;
        self.insert(Key::House, Value::House(house));
    }
}
