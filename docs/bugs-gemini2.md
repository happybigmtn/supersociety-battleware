# Independent Security & Performance Review

**Date:** December 10, 2025
**Reviewer:** Gemini
**Focus:** Security vulnerabilities, Logic flaws, Performance bottlenecks, Best practices

This document outlines findings from a second independent review of the `supersociety-battleware` codebase.

---

## 🚨 Critical Security Vulnerabilities

### 1. The "Infinite Money" Glitch (Table Games)
**Severity:** **CRITICAL**
**Components:** `execution/src/casino/{roulette.rs, craps.rs, sic_bo.rs, baccarat.rs}`
**Description:**
In multi-bet games (Roulette, Craps, Sic Bo, Baccarat), the `process_move` function allows players to place bets via `Instruction::CasinoGameMove` with a specific payload (Action 0).
- These functions update the game state (adding the bet to `state.bets`) and return `GameResult::Continue`.
- The execution engine (`execution/src/lib.rs`) handles `GameResult::Continue` by saving the session state *without* deducting chips from the player's balance.
- **Impact:** Players can place unlimited bets for free. If they win, they receive payouts based on these "free" bets. In Baccarat, they even receive their "stake" back (which they never paid), resulting in massive inflation.

**Affected Files:**
- `execution/src/casino/roulette.rs`: Lines ~368 (Action 0)
- `execution/src/casino/craps.rs`: Lines ~680 (Action 0), ~715 (Action 1 - Add Odds)
- `execution/src/casino/sic_bo.rs`: Lines ~330 (Action 0)
- `execution/src/casino/baccarat.rs`: Lines ~370 (Action 0)

**Remediation:**
Modify `process_move` in all affected games to return `GameResult::ContinueWithUpdate` instead of `GameResult::Continue` when placing a bet.
```rust
// Example Fix for Roulette
Ok(GameResult::ContinueWithUpdate { payout: -(amount as i64) })
```
This ensures the execution engine deducts the bet amount from the player's balance immediately.

### 2. "Sunk Cost" Initial Bet (Table Games)
**Severity:** High
**Components:** Frontend & Backend Logic mismatch
**Description:**
- The `CasinoStartGame` instruction requires a `bet` amount, which is immediately deducted from the player's balance in `execution/src/lib.rs`.
- However, table games (Roulette, etc.) initialize with an empty state in their `init` function and *ignore* this initial session bet.
- **Impact:** Any amount passed as the initial bet to `StartGame` for these games is permanently lost (burned) and does not count towards any actual game bet.

**Remediation:**
- **Frontend:** Ensure `useTerminalGame.ts` passes `0` as the bet amount for table games when calling `startGameWithSessionId`.
- **Backend:** Alternatively, modify `init` in table games to convert the session bet into a default bet (e.g., "Pass Line" for Craps), but passing 0 is cleaner for multi-bet games.

---

## ⚠️ Performance & Code Quality Issues

### 3. Manual Binary Parsing Fragility
**Severity:** Medium
**Description:**
Both the Rust backend and TypeScript frontend perform manual byte-level serialization/deserialization (e.g., `stateBlob[offset++]`).
- **Risk:** This is highly error-prone. A change in the Rust struct layout without a perfectly matching change in the TS parser will cause runtime errors or incorrect state display.
- **Example:** `parseGameState` in `useTerminalGame.ts` manually advances offsets.

**Remediation:**
- Adopt a shared serialization schema. Since the backend is Rust and frontend is TS/WASM, using a library like `borsh` (via `borsh-js`) or generating TS types from Rust structs (using `ts-rs`) would be significantly safer and more maintainable.

### 4. Monolithic Frontend Hook
**Severity:** Low (Maintainability)
**Component:** `website/src/hooks/useTerminalGame.ts`
**Description:**
This file is over 3,000 lines long and handles logic for all 10 games, plus WebSocket events, tournament timers, and state management.
- **Impact:** extremely difficult to read, test, and maintain. High risk of regression when modifying one game affecting others.

**Remediation:**
Refactor into smaller, game-specific hooks (e.g., `useBlackjack`, `useRoulette`) composed within the main hook or a context provider.

### 5. Potential Integer Overflow in Payout Calculation
**Severity:** Low
**Component:** `execution/src/casino/*.rs`
**Description:**
Games use `saturating_add` / `saturating_mul` for payout calculations.
- **Observation:** While this prevents panics (good), it means that if a payout strictly exceeds `u64::MAX`, it will be capped silently.
- **Context:** `u64::MAX` is ~18 quintillion, so this is unlikely to be hit unless hyper-inflation occurs or a bug allows massive bet multipliers.
- **Recommendation:** No immediate action needed, but be aware that "capping" is the failure mode.

---

## ✅ Best Practices Review

- **Bounds Checking:** The manual parsing logic in `blackjack.rs` and `roulette.rs` correctly checks array bounds (`if idx >= state.len()`), mitigating panic risks from malformed state blobs.
- **Panic Safety:** Search for `unwrap()` in `execution/src` revealed usage mostly in tests or non-critical paths (digest verification where digest is known good).
- **Randomness:** Uses `GameRng` seeded from consensus `Seed`. This provides deterministic execution (required for the node) while being unpredictable to players *before* the block is finalized (assuming consensus assumption holds).

## Action Plan

1.  **IMMEDIATE:** Apply the `ContinueWithUpdate` fix to `roulette.rs`, `craps.rs`, `sic_bo.rs`, and `baccarat.rs`.
2.  **IMMEDIATE:** Update `useTerminalGame.ts` to send `0` bet for table games.
3.  **MEDIUM TERM:** Refactor `useTerminalGame.ts`.
