use super::super::*;

impl<'a, S: State> Layer<'a, S> {
    // === Liquidity / Vault Handlers ===

    pub(in crate::layer) async fn handle_create_vault(&mut self, public: &PublicKey) -> Vec<Event> {
        if self.get(&Key::Vault(public.clone())).await.is_some() {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INVALID_MOVE, // Reuse
                message: "Vault already exists".to_string(),
            }];
        }

        let vault = nullspace_types::casino::Vault::default();
        self.insert(Key::Vault(public.clone()), Value::Vault(vault));
        vec![Event::VaultCreated {
            player: public.clone(),
        }]
    }

    pub(in crate::layer) async fn handle_deposit_collateral(
        &mut self,
        public: &PublicKey,
        amount: u64,
    ) -> Vec<Event> {
        let mut player = match self.get(&Key::CasinoPlayer(public.clone())).await {
            Some(Value::CasinoPlayer(p)) => p,
            _ => return vec![],
        };

        if player.chips < amount {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INSUFFICIENT_FUNDS,
                message: "Insufficient chips".to_string(),
            }];
        }

        let mut vault = match self.get(&Key::Vault(public.clone())).await {
            Some(Value::Vault(v)) => v,
            _ => {
                return vec![Event::CasinoError {
                    player: public.clone(),
                    session_id: None,
                    error_code: nullspace_types::casino::ERROR_INVALID_MOVE,
                    message: "Vault not found".to_string(),
                }]
            }
        };

        player.chips -= amount;
        vault.collateral_rng += amount;
        let new_collateral = vault.collateral_rng;

        self.insert(
            Key::CasinoPlayer(public.clone()),
            Value::CasinoPlayer(player),
        );
        self.insert(Key::Vault(public.clone()), Value::Vault(vault));

        vec![Event::CollateralDeposited {
            player: public.clone(),
            amount,
            new_collateral,
        }]
    }

    pub(in crate::layer) async fn handle_borrow_usdt(
        &mut self,
        public: &PublicKey,
        amount: u64,
    ) -> Vec<Event> {
        let mut vault = match self.get(&Key::Vault(public.clone())).await {
            Some(Value::Vault(v)) => v,
            _ => return vec![],
        };

        // Determine Price (RNG price in vUSDT)
        let amm = self.get_or_init_amm().await;
        let price_numerator = if amm.reserve_rng > 0 {
            amm.reserve_vusdt as u128
        } else {
            1 // Bootstrap price: 1 RNG = 1 vUSDT
        };
        let price_denominator = if amm.reserve_rng > 0 {
            amm.reserve_rng as u128
        } else {
            1
        };

        // LTV Calculation: Max Debt = (Collateral * Price) * 50%
        // Debt <= (Collateral * P_num / P_den) / 2
        // 2 * Debt * P_den <= Collateral * P_num
        let new_debt = vault.debt_vusdt + amount;

        let lhs = 2 * (new_debt as u128) * price_denominator;
        let rhs = (vault.collateral_rng as u128) * price_numerator;

        if lhs > rhs {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INVALID_MOVE,
                message: "Insufficient collateral (Max 50% LTV)".to_string(),
            }];
        }

        // Update Vault
        vault.debt_vusdt = new_debt;
        self.insert(Key::Vault(public.clone()), Value::Vault(vault));

        // Mint vUSDT to Player
        if let Some(Value::CasinoPlayer(mut player)) =
            self.get(&Key::CasinoPlayer(public.clone())).await
        {
            player.vusdt_balance += amount;
            self.insert(
                Key::CasinoPlayer(public.clone()),
                Value::CasinoPlayer(player),
            );
        }

        vec![Event::VusdtBorrowed {
            player: public.clone(),
            amount,
            new_debt,
        }]
    }

    pub(in crate::layer) async fn handle_repay_usdt(
        &mut self,
        public: &PublicKey,
        amount: u64,
    ) -> Vec<Event> {
        let mut player = match self.get(&Key::CasinoPlayer(public.clone())).await {
            Some(Value::CasinoPlayer(p)) => p,
            _ => return vec![],
        };

        let mut vault = match self.get(&Key::Vault(public.clone())).await {
            Some(Value::Vault(v)) => v,
            _ => return vec![],
        };

        if player.vusdt_balance < amount {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INSUFFICIENT_FUNDS,
                message: "Insufficient vUSDT".to_string(),
            }];
        }

        let actual_repay = amount.min(vault.debt_vusdt);

        player.vusdt_balance -= actual_repay;
        vault.debt_vusdt -= actual_repay;
        let new_debt = vault.debt_vusdt;

        self.insert(
            Key::CasinoPlayer(public.clone()),
            Value::CasinoPlayer(player),
        );
        self.insert(Key::Vault(public.clone()), Value::Vault(vault));

        vec![Event::VusdtRepaid {
            player: public.clone(),
            amount: actual_repay,
            new_debt,
        }]
    }

    pub(in crate::layer) async fn handle_swap(
        &mut self,
        public: &PublicKey,
        mut amount_in: u64,
        min_amount_out: u64,
        is_buying_rng: bool,
    ) -> Vec<Event> {
        let original_amount_in = amount_in;
        let mut amm = self.get_or_init_amm().await;
        let mut player = match self.get(&Key::CasinoPlayer(public.clone())).await {
            Some(Value::CasinoPlayer(p)) => p,
            _ => return vec![],
        };

        if amount_in == 0 {
            return vec![];
        }

        if amm.reserve_rng == 0 || amm.reserve_vusdt == 0 {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INVALID_MOVE,
                message: "AMM has zero liquidity".to_string(),
            }];
        }

        // Apply Sell Tax (if Selling RNG)
        let mut burned_amount = 0;
        if !is_buying_rng {
            // Sell Tax: 5% (default)
            burned_amount = (amount_in as u128 * amm.sell_tax_basis_points as u128 / 10000) as u64;
            if burned_amount > 0 {
                // Deduct tax from input amount
                amount_in = amount_in.saturating_sub(burned_amount);

                // Track burned amount in House
                let mut house = self.get_or_init_house().await;
                house.total_burned += burned_amount;
                self.insert(Key::House, Value::House(house));
            }
        }

        // Reserves (u128 for safety)
        let (reserve_in, reserve_out) = if is_buying_rng {
            (amm.reserve_vusdt as u128, amm.reserve_rng as u128)
        } else {
            (amm.reserve_rng as u128, amm.reserve_vusdt as u128)
        };

        // Fee (30 bps = 0.3%)
        let fee_bps = amm.fee_basis_points as u128;
        let fee_amount = ((amount_in as u128) * fee_bps) / 10_000;
        let net_in = (amount_in as u128).saturating_sub(fee_amount);
        let amount_in_with_fee = net_in * 10_000;
        let numerator = amount_in_with_fee.saturating_mul(reserve_out);
        let denominator = reserve_in
            .saturating_mul(10_000)
            .saturating_add(amount_in_with_fee);
        if denominator == 0 {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INVALID_MOVE,
                message: "Invalid AMM state".to_string(),
            }];
        }
        let amount_out = (numerator / denominator) as u64;

        if amount_out < min_amount_out {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INVALID_MOVE, // Slippage
                message: "Slippage limit exceeded".to_string(),
            }];
        }

        // Execute Swap
        if is_buying_rng {
            // Player gives vUSDT, gets RNG
            if player.vusdt_balance < amount_in {
                return vec![Event::CasinoError {
                    player: public.clone(),
                    session_id: None,
                    error_code: nullspace_types::casino::ERROR_INSUFFICIENT_FUNDS,
                    message: "Insufficient vUSDT".to_string(),
                }];
            }
            player.vusdt_balance -= amount_in;
            player.chips = player.chips.saturating_add(amount_out);

            amm.reserve_vusdt = amm.reserve_vusdt.saturating_add(amount_in);
            amm.reserve_rng = amm.reserve_rng.saturating_sub(amount_out);
        } else {
            // Player gives RNG, gets vUSDT
            // Note: We deduct the FULL amount (incl tax) from player
            let total_deduction = amount_in + burned_amount;
            if player.chips < total_deduction {
                return vec![Event::CasinoError {
                    player: public.clone(),
                    session_id: None,
                    error_code: nullspace_types::casino::ERROR_INSUFFICIENT_FUNDS,
                    message: "Insufficient RNG".to_string(),
                }];
            }

            player.chips = player.chips.saturating_sub(total_deduction);
            player.vusdt_balance = player.vusdt_balance.saturating_add(amount_out);

            amm.reserve_rng = amm.reserve_rng.saturating_add(amount_in); // Add net amount (after tax) to reserves
            amm.reserve_vusdt = amm.reserve_vusdt.saturating_sub(amount_out);
        }

        // Book fee to House
        if fee_amount > 0 {
            let mut house = self.get_or_init_house().await;
            house.accumulated_fees = house.accumulated_fees.saturating_add(fee_amount as u64);
            self.insert(Key::House, Value::House(house));
        }

        let event = Event::AmmSwapped {
            player: public.clone(),
            is_buying_rng,
            amount_in: original_amount_in,
            amount_out,
            fee_amount: fee_amount as u64,
            burned_amount,
            reserve_rng: amm.reserve_rng,
            reserve_vusdt: amm.reserve_vusdt,
        };

        self.insert(
            Key::CasinoPlayer(public.clone()),
            Value::CasinoPlayer(player),
        );
        self.insert(Key::AmmPool, Value::AmmPool(amm));

        vec![event]
    }

    pub(in crate::layer) async fn handle_add_liquidity(
        &mut self,
        public: &PublicKey,
        rng_amount: u64,
        usdt_amount: u64,
    ) -> Vec<Event> {
        let mut amm = self.get_or_init_amm().await;
        let mut player = match self.get(&Key::CasinoPlayer(public.clone())).await {
            Some(Value::CasinoPlayer(p)) => p,
            _ => return vec![],
        };

        if rng_amount == 0 || usdt_amount == 0 {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INVALID_MOVE,
                message: "Zero liquidity not allowed".to_string(),
            }];
        }

        if player.chips < rng_amount || player.vusdt_balance < usdt_amount {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INSUFFICIENT_FUNDS,
                message: "Insufficient funds".to_string(),
            }];
        }

        let lp_balance = self.get_lp_balance(public).await;

        // Initial liquidity?
        let mut shares_minted = if amm.total_shares == 0 {
            // Sqrt(x*y)
            let val = (rng_amount as u128) * (usdt_amount as u128);
            Self::integer_sqrt(val)
        } else {
            // Proportional to current reserves
            if amm.reserve_rng == 0 || amm.reserve_vusdt == 0 {
                return vec![Event::CasinoError {
                    player: public.clone(),
                    session_id: None,
                    error_code: nullspace_types::casino::ERROR_INVALID_MOVE,
                    message: "AMM has zero liquidity".to_string(),
                }];
            }
            let share_a = (rng_amount as u128 * amm.total_shares as u128) / amm.reserve_rng as u128;
            let share_b =
                (usdt_amount as u128 * amm.total_shares as u128) / amm.reserve_vusdt as u128;
            share_a.min(share_b) as u64
        };

        // Lock a minimum amount of LP shares on first deposit so reserves can never be fully drained.
        if amm.total_shares == 0 {
            if shares_minted <= MINIMUM_LIQUIDITY {
                return vec![Event::CasinoError {
                    player: public.clone(),
                    session_id: None,
                    error_code: nullspace_types::casino::ERROR_INVALID_MOVE,
                    message: "Initial liquidity too small".to_string(),
                }];
            }
            amm.total_shares = amm.total_shares.saturating_add(MINIMUM_LIQUIDITY);
            shares_minted = shares_minted.saturating_sub(MINIMUM_LIQUIDITY);
        }

        if shares_minted == 0 {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INVALID_MOVE,
                message: "Deposit too small".to_string(),
            }];
        }

        player.chips = player.chips.saturating_sub(rng_amount);
        player.vusdt_balance = player.vusdt_balance.saturating_sub(usdt_amount);

        amm.reserve_rng = amm.reserve_rng.saturating_add(rng_amount);
        amm.reserve_vusdt = amm.reserve_vusdt.saturating_add(usdt_amount);
        amm.total_shares = amm.total_shares.saturating_add(shares_minted);

        let new_lp_balance = lp_balance.saturating_add(shares_minted);

        let event = Event::LiquidityAdded {
            player: public.clone(),
            rng_amount,
            vusdt_amount: usdt_amount,
            shares_minted,
            total_shares: amm.total_shares,
            reserve_rng: amm.reserve_rng,
            reserve_vusdt: amm.reserve_vusdt,
            lp_balance: new_lp_balance,
        };

        self.insert(
            Key::CasinoPlayer(public.clone()),
            Value::CasinoPlayer(player),
        );
        self.insert(Key::AmmPool, Value::AmmPool(amm));
        self.insert(
            Key::LpBalance(public.clone()),
            Value::LpBalance(new_lp_balance),
        );

        vec![event]
    }

    pub(in crate::layer) async fn handle_remove_liquidity(
        &mut self,
        public: &PublicKey,
        shares: u64,
    ) -> Vec<Event> {
        if shares == 0 {
            return vec![];
        }

        let mut amm = self.get_or_init_amm().await;
        if amm.total_shares == 0 || shares > amm.total_shares {
            return vec![];
        }

        let lp_balance = self.get_lp_balance(public).await;
        if shares > lp_balance {
            return vec![Event::CasinoError {
                player: public.clone(),
                session_id: None,
                error_code: nullspace_types::casino::ERROR_INSUFFICIENT_FUNDS,
                message: "Not enough LP shares".to_string(),
            }];
        }

        let mut player = match self.get(&Key::CasinoPlayer(public.clone())).await {
            Some(Value::CasinoPlayer(p)) => p,
            _ => return vec![],
        };

        // Calculate amounts out proportionally
        let amount_rng =
            ((shares as u128 * amm.reserve_rng as u128) / amm.total_shares as u128) as u64;
        let amount_vusd =
            ((shares as u128 * amm.reserve_vusdt as u128) / amm.total_shares as u128) as u64;

        amm.reserve_rng = amm.reserve_rng.saturating_sub(amount_rng);
        amm.reserve_vusdt = amm.reserve_vusdt.saturating_sub(amount_vusd);
        amm.total_shares = amm.total_shares.saturating_sub(shares);

        player.chips = player.chips.saturating_add(amount_rng);
        player.vusdt_balance = player.vusdt_balance.saturating_add(amount_vusd);

        let new_lp_balance = lp_balance.saturating_sub(shares);

        let event = Event::LiquidityRemoved {
            player: public.clone(),
            rng_amount: amount_rng,
            vusdt_amount: amount_vusd,
            shares_burned: shares,
            total_shares: amm.total_shares,
            reserve_rng: amm.reserve_rng,
            reserve_vusdt: amm.reserve_vusdt,
            lp_balance: new_lp_balance,
        };

        self.insert(
            Key::CasinoPlayer(public.clone()),
            Value::CasinoPlayer(player),
        );
        self.insert(Key::AmmPool, Value::AmmPool(amm));
        self.insert(
            Key::LpBalance(public.clone()),
            Value::LpBalance(new_lp_balance),
        );

        vec![event]
    }
}
