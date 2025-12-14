use super::super::*;

impl<'a, S: State> Layer<'a, S> {
    // === Staking Handlers ===

    pub(in crate::layer) async fn handle_stake(
        &mut self,
        public: &PublicKey,
        amount: u64,
        duration: u64,
    ) -> Vec<Event> {
        let mut player = match self.get(&Key::CasinoPlayer(public.clone())).await {
            Some(Value::CasinoPlayer(p)) => p,
            _ => return vec![], // Error handled by checking balance
        };

        if player.chips < amount {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INSUFFICIENT_FUNDS,
                message: "Insufficient chips to stake".to_string(),
            }];
        }

        // Min duration 1 week (approx 201600 blocks @ 3s), Max 4 years
        const MIN_DURATION: u64 = 1; // Simplified for dev
        if duration < MIN_DURATION {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INVALID_BET, // Reuse code
                message: "Duration too short".to_string(),
            }];
        }

        // Deduct chips
        player.chips -= amount;
        self.insert(
            Key::CasinoPlayer(public.clone()),
            Value::CasinoPlayer(player),
        );

        // Create/Update Staker
        let mut staker = match self.get(&Key::Staker(public.clone())).await {
            Some(Value::Staker(s)) => s,
            _ => nullspace_types::casino::Staker::default(),
        };

        // Calculate Voting Power: Amount * Duration
        // If adding to existing stake, we weight-average or just add?
        // Simple model: New stake resets lockup to max(old_unlock, new_unlock)
        let current_block = self.seed.view;
        let new_unlock = current_block + duration;

        // If extending, new VP is total amount * new duration remaining
        staker.balance += amount;
        staker.unlock_ts = new_unlock;
        staker.voting_power = (staker.balance as u128) * (duration as u128);

        self.insert(Key::Staker(public.clone()), Value::Staker(staker.clone()));

        // Update House Total VP
        let mut house = self.get_or_init_house().await;
        house.total_staked_amount += amount;
        house.total_voting_power += (amount as u128) * (duration as u128); // Approximation for new stake
        self.insert(Key::House, Value::House(house));

        vec![Event::Staked {
            player: public.clone(),
            amount,
            duration,
            new_balance: staker.balance,
            unlock_ts: staker.unlock_ts,
            voting_power: staker.voting_power,
        }]
    }

    pub(in crate::layer) async fn handle_unstake(&mut self, public: &PublicKey) -> Vec<Event> {
        let mut staker = match self.get(&Key::Staker(public.clone())).await {
            Some(Value::Staker(s)) => s,
            _ => return vec![],
        };

        if self.seed.view < staker.unlock_ts {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INVALID_MOVE,
                message: "Stake still locked".to_string(),
            }];
        }

        if staker.balance == 0 {
            return vec![];
        }

        let unstake_amount = staker.balance;

        // Return chips
        if let Some(Value::CasinoPlayer(mut player)) =
            self.get(&Key::CasinoPlayer(public.clone())).await
        {
            player.chips += staker.balance;
            self.insert(
                Key::CasinoPlayer(public.clone()),
                Value::CasinoPlayer(player),
            );
        }

        // Update House
        let mut house = self.get_or_init_house().await;
        house.total_staked_amount = house.total_staked_amount.saturating_sub(staker.balance);
        house.total_voting_power = house.total_voting_power.saturating_sub(staker.voting_power);
        self.insert(Key::House, Value::House(house));

        // Clear Staker
        staker.balance = 0;
        staker.voting_power = 0;
        self.insert(Key::Staker(public.clone()), Value::Staker(staker));

        vec![Event::Unstaked {
            player: public.clone(),
            amount: unstake_amount,
        }]
    }

    pub(in crate::layer) async fn handle_claim_rewards(
        &mut self,
        public: &PublicKey,
    ) -> Vec<Event> {
        // Placeholder for distribution logic
        // In this MVP, rewards are auto-compounded or we just skip this for now
        let staker = match self.get(&Key::Staker(public.clone())).await {
            Some(Value::Staker(s)) => s,
            _ => return vec![],
        };

        if staker.balance == 0 {
            return vec![];
        }

        vec![Event::RewardsClaimed {
            player: public.clone(),
            amount: 0,
        }]
    }

    pub(in crate::layer) async fn handle_process_epoch(
        &mut self,
        _public: &PublicKey,
    ) -> Vec<Event> {
        let mut house = self.get_or_init_house().await;

        // 1 Week Epoch (approx)
        const EPOCH_LENGTH: u64 = 100; // Short for testing

        if self.seed.view >= house.epoch_start_ts + EPOCH_LENGTH {
            // End Epoch

            // If Net PnL > 0, Surplus!
            if house.net_pnl > 0 {
                // In a real system, we'd snapshot this into a "RewardPool"
                // For now, we just reset PnL and log it (via debug/warn or event)
                // warn!("Epoch Surplus: {}", house.net_pnl);
            } else {
                // Deficit. Minting happened. Inflation.
                // warn!("Epoch Deficit: {}", house.net_pnl);
            }

            house.current_epoch += 1;
            house.epoch_start_ts = self.seed.view;
            house.net_pnl = 0; // Reset for next week

            let epoch = house.current_epoch;
            self.insert(Key::House, Value::House(house));

            return vec![Event::EpochProcessed { epoch }];
        }

        vec![]
    }
}
