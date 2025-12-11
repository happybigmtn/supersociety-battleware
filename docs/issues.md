# Casino Economics Refactor Plan

**Document Owner:** Engineering Management
**Status:** Ready for Implementation
**Priority:** P0 - Critical Financial Integrity

---

## Executive Summary

Independent diagnostic analysis identified a **systemic architecture flaw** affecting 6 of 10 casino games. The `GameResult::ContinueWithUpdate` enum variant exists in the codebase but was **never implemented** in the Layer handler, causing all mid-game balance changes to be silently discarded.

**Impact:**
- Players can double-down, go to war, or place additional bets without being charged
- Intermediate payouts (e.g., Craps field bet wins) are never credited
- Potential for "infinite money" exploits

---

## Root Cause Analysis

### The Missing Handler

**Location:** `execution/src/lib.rs:543-637`

The `GameResult` enum defines 5 variants:
```rust
// execution/src/casino/mod.rs:166-178
pub enum GameResult {
    Continue,
    ContinueWithUpdate { payout: i64 },  // <-- EXISTS BUT NEVER HANDLED
    Win(u64),
    Loss,
    Push,
}
```

The Layer's match statement only handles 4:
```rust
// execution/src/lib.rs:543-637
match result {
    crate::casino::GameResult::Continue => { ... }
    crate::casino::GameResult::Win(base_payout) => { ... }
    crate::casino::GameResult::Push => { ... }
    crate::casino::GameResult::Loss => { ... }
    // ContinueWithUpdate IS MISSING - causes compile warning, runtime silent failure
}
```

---

## Affected Games Matrix

| Game | Issue Type | Location | Financial Impact |
|------|------------|----------|-----------------|
| **Craps** | Intermediate payouts lost | `craps.rs:816-828` | High - Field bets, come bets never pay |
| **Blackjack** | Double-down not charged | `blackjack.rs:249-276` | Critical - Free 2x bets |
| **Casino War** | War bet not charged | `casino_war.rs:142-171` | Critical - Free matching bets |
| **Ultimate Hold'em** | Play bet not charged | `ultimate_holdem.rs:299-347` | Critical - Free 4x/2x/1x bets |
| **Three Card Poker** | Play bet not charged | `three_card.rs:206-275` | Critical - Free ante-match bets |
| **HiLo** | Incorrect payout calculation | `hilo.rs:139` | Medium - Returns profit only |

---

## Detailed Bug Analysis

### 1. Craps (Most Complex)

**File:** `execution/src/casino/craps.rs`

**Issue 1: Come Bet Lifecycle**
- Come bets are correctly tracked through establishment and resolution
- When a come bet wins during Point phase, `total_payout` is calculated (line ~800)
- **Bug:** If other bets remain active, `GameResult::Continue` is returned (line 816-828)
- **Result:** The accumulated `total_payout` is discarded by the Layer

**Issue 2: Incorrect Payout Math**
```rust
// Line 460 - Come bet win pays 1:1
total_payout += come.amount; // WRONG: Returns stake only, not stake + win
// Should be:
total_payout += come.amount * 2; // Stake + 1:1 win
```

```rust
// Line 502 - Come point win pays 1:1
total_payout += come.amount; // WRONG: Same issue
```

**Issue 3: Phase Transition Timing**
- Bets resolve BEFORE phase transitions
- If Seven-Out occurs, come bets on numbers should LOSE before phase resets
- Current logic may not properly sequence these events

### 2. Blackjack

**File:** `execution/src/casino/blackjack.rs:249-276`

```rust
// Double down logic
Move::DoubleDown => {
    if state.player_hands[0].len() != 2 || state.player_split {
        return Err(GameError::InvalidMove);
    }
    session.bet *= 2;  // <-- Doubles the bet value
    // ... deals one card ...
    return Ok(GameResult::Continue); // <-- NO CHARGE COMMUNICATED
}
```

**Expected behavior:** Return `GameResult::ContinueWithUpdate { payout: -(session.bet / 2) }` to charge the additional bet.

### 3. Casino War

**File:** `execution/src/casino/casino_war.rs:142-171`

```rust
// Go to War
Move::War => {
    // Comment says "Player matches ante to go to war"
    // But NO code deducts the matching ante

    // Later, payout calculation:
    let payout = session.bet * 2; // Only pays original ante
    // Should be session.bet * 4 (ante + war + winnings on both)
}
```

### 4. Ultimate Texas Hold'em

**File:** `execution/src/casino/ultimate_holdem.rs:299-347`

```rust
// Play bet stored but never charged
let play_bet = match action {
    Action::Check => 0,
    Action::Bet4x => session.bet * 4,
    Action::Bet2x => session.bet * 2,
    Action::Bet1x => session.bet,
};
// play_bet is used in payout calculations
// BUT player is never charged for it
```

### 5. Three Card Poker

**File:** `execution/src/casino/three_card.rs:206-275`

The Play bet (matching the ante) is never charged. Player pays 1x ante but plays with 2x value.

### 6. HiLo (Different Bug)

**File:** `execution/src/casino/hilo.rs:139`

```rust
// Current code
let profit = payout - session.bet;
Ok(GameResult::Win(profit)) // Returns profit only

// All other games return TOTAL payout (stake + winnings)
// This is inconsistent and underpays the player
```

**Fix:** `Ok(GameResult::Win(payout))`

---

## Implementation Plan

### Phase 0: Emergency Validation (Optional)

Add balance check before processing moves to prevent exploits during development:

```rust
// execution/src/lib.rs - in handle_casino_game_move, before process_move()
// Estimate max additional bet based on game type
let max_additional = match session.game_type {
    GameType::Blackjack => session.bet,      // Double down
    GameType::CasinoWar => session.bet,      // War bet
    GameType::UltimateHoldem => session.bet * 4, // 4x play bet
    GameType::ThreeCard => session.bet,      // Play bet
    _ => 0,
};
if player.chips < max_additional {
    return vec![]; // Reject moves if player can't afford max bet
}
```

### Phase 1: Implement ContinueWithUpdate Handler

**File:** `execution/src/lib.rs` - Add after line 546

```rust
crate::casino::GameResult::ContinueWithUpdate { payout } => {
    // Update player balance
    if let Some(Value::CasinoPlayer(mut player)) =
        self.get(&Key::CasinoPlayer(public.clone())).await
    {
        if payout < 0 {
            // Deducting chips (new bet)
            let deduction = (-payout) as u64;
            if player.chips < deduction {
                // Insufficient funds - should not happen if Phase 0 implemented
                // Log error and skip
                return vec![];
            }
            player.chips = player.chips.saturating_sub(deduction);
        } else {
            // Adding chips (intermediate win)
            player.chips = player.chips.saturating_add(payout as u64);
        }
        self.insert(Key::CasinoPlayer(public.clone()), Value::CasinoPlayer(player));
    }
    // Save updated session state
    self.insert(Key::CasinoSession(session_id), Value::CasinoSession(session));

    // Optionally emit event for mid-game balance change
    events.push(Event::CasinoBalanceUpdate {
        session_id,
        player: public.clone(),
        delta: payout,
    });
}
```

**Note:** May need to add `CasinoBalanceUpdate` event variant to `types/src/execution.rs`.

### Phase 2: Update Games to Use ContinueWithUpdate

#### 2.1 Blackjack Double-Down

```rust
// blackjack.rs - in process_move, DoubleDown branch
let additional_bet = session.bet; // Current bet before doubling
session.bet *= 2;
// ... deal card logic ...

if /* game continues */ {
    return Ok(GameResult::ContinueWithUpdate {
        payout: -(additional_bet as i64)
    });
}
```

#### 2.2 Casino War - Go to War

```rust
// casino_war.rs - in Move::War handler
let war_bet = session.bet; // Match the ante
// ... deal war cards ...

// Track total bet for payout calculation
// Return ContinueWithUpdate to charge war bet
Ok(GameResult::ContinueWithUpdate {
    payout: -(war_bet as i64)
})
```

#### 2.3 Ultimate Hold'em - Play Bet

```rust
// ultimate_holdem.rs - when player makes play bet
let play_amount = match action {
    Action::Bet4x => session.bet * 4,
    Action::Bet2x => session.bet * 2,
    Action::Bet1x => session.bet,
    Action::Check => 0,
};

if play_amount > 0 {
    return Ok(GameResult::ContinueWithUpdate {
        payout: -(play_amount as i64)
    });
}
```

#### 2.4 Three Card Poker - Play Bet

```rust
// three_card.rs - in Move::Play handler
let play_bet = session.bet; // Match ante
// Game immediately resolves, so this becomes part of final calculation
// Store play_bet in state and account for it in Win payout
```

#### 2.5 Craps - Intermediate Payouts

```rust
// craps.rs - when resolving bets mid-game
if total_payout > 0 && /* game continues */ {
    return Ok(GameResult::ContinueWithUpdate {
        payout: total_payout as i64
    });
}
```

### Phase 3: Fix HiLo Payout

```rust
// hilo.rs:139 - Change:
Ok(GameResult::Win(profit))
// To:
Ok(GameResult::Win(payout)) // Full return including stake
```

### Phase 4: Testing & Validation

1. **Unit Tests:** Each game must have tests verifying:
   - Balance decreases on mid-game bets
   - Balance increases on intermediate wins
   - Final payout calculations are correct

2. **Integration Tests:** `integration_tests.rs` comprehensive bot should:
   - Track chip balance through entire game lifecycle
   - Verify no "infinite money" exploits
   - Test all edge cases (double after split, war ties, etc.)

3. **Regression Tests:** Ensure existing passing games still work

---

## Future Considerations

### GameTransition Struct (v2)

If the system grows more complex, consider the original proposed refactor:

```rust
pub struct GameTransition {
    pub state_blob: Vec<u8>,
    pub payout: i64,      // Net change to player balance
    pub complete: bool,
    pub events: Vec<GameEvent>, // Optional: in-game events for UI
}
```

This would replace all `GameResult` returns and provide a uniform interface.

**Pros:**
- Single return type for all outcomes
- Explicit about every financial change
- Easier to add new features (side bets, bonuses)

**Cons:**
- Breaking change to all 10 games
- More complex than current fix
- Current fix with `ContinueWithUpdate` is sufficient

**Recommendation:** Implement Phases 1-4 first. Evaluate `GameTransition` migration only if additional complexity is needed.

---

## Appendix A: Game Economics Reference

### Expected Payout Behaviors

| Game | Bet Type | Payout | Notes |
|------|----------|--------|-------|
| Blackjack | Double Down | 2:1 on doubled bet | Charges 2x, pays 4x on win |
| Casino War | Go to War | 1:1 on ante only | Ante wins, war bet pushes |
| Ultimate | Play Bet | 1:1 on ante+play | Trips bonus separate |
| Three Card | Play Bet | 1:1 on both | Ante bonus separate |
| Craps | Field Bet | 1:1 / 2:1 | Immediate resolution |
| Craps | Come Bet | 1:1 | Resolves when point hit |
| HiLo | Cashout | Accumulator * stake | Progressive multiplier |

### Win Return Formula

For all games, `GameResult::Win(amount)` should return:
```
amount = total_stake + total_winnings
```

Where:
- `total_stake` = all bets placed during the game
- `total_winnings` = profit from winning bets

This is because the Layer treats `Win(amount)` as "add this to player chips" - the initial bet was already deducted at `StartGame`.

---

## Appendix B: File Change Summary

| File | Changes Required |
|------|-----------------|
| `execution/src/lib.rs` | Add `ContinueWithUpdate` handler (~30 lines) |
| `execution/src/casino/blackjack.rs` | Return `ContinueWithUpdate` on double-down |
| `execution/src/casino/casino_war.rs` | Return `ContinueWithUpdate` on war, fix payout |
| `execution/src/casino/ultimate_holdem.rs` | Return `ContinueWithUpdate` on play bet |
| `execution/src/casino/three_card.rs` | Return `ContinueWithUpdate` on play bet |
| `execution/src/casino/craps.rs` | Return `ContinueWithUpdate` for intermediate wins, fix payout math |
| `execution/src/casino/hilo.rs` | Change `Win(profit)` to `Win(payout)` |
| `types/src/execution.rs` | (Optional) Add `CasinoBalanceUpdate` event |

---

## Sign-off

- [ ] Engineering Review Complete
- [ ] Security Review (exploit scenarios validated)
- [ ] QA Test Plan Approved
- [ ] Deployment Plan Documented
