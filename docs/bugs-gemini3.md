# Independent Logic & System Review (Round 3)

**Date:** December 10, 2025
**Reviewer:** Gemini
**Focus:** Game rules compliance, edge cases, system integration, and exploit analysis.

This document outlines findings from a third independent review of the `supersociety-battleware` codebase, focusing on specific game logic and system integrity.

---

## 🚨 Critical Logic Vulnerabilities

### 1. Ultimate Texas Hold'em "Free Blind" Exploit
**Severity:** **CRITICAL**
**Component:** `execution/src/casino/ultimate_holdem.rs`
**Description:**
In Ultimate Texas Hold'em, the rules require the player to place two equal bets to start: the **Ante** and the **Blind**.
- The `CasinoStartGame` instruction in `lib.rs` deducts `bet` from the player's balance.
- The `UltimateHoldem::init` function initializes the game state but does **not** deduct the second unit for the Blind bet.
- **Impact:** Players essentially get the "Blind" bet for free (a "Free Roll").
    - If they Push (tie), they receive `Ante + Blind` back, profiting 1 unit (the Blind they never paid).
    - If they Lose, they lose `Ante + Play` (correctly deducted via `LossWithExtraDeduction` for Play), but the system thinks they also lost the Blind (which they didn't pay).
    - If they Win, they get payouts on both Ante and Blind.
**Remediation:**
Modify `UltimateHoldem::init` to return `GameResult::ContinueWithUpdate { payout: -(session.bet as i64) }`. This will deduct the second unit (Blind) immediately upon game start.

---

## 🔴 High Severity Issues

### 2. Blackjack Split Desynchronization
**Severity:** High (Logic/UX)
**Component:** `website/src/hooks/useTerminalGame.ts` vs `execution/src/casino/blackjack.rs`
**Description:**
- **Frontend:** The `useTerminalGame` hook implements a `bjSplit` function that updates the *local* React state to display split hands.
- **Backend:** The `Blackjack` implementation in Rust does **not** support splitting. The `Move` enum only contains `Hit`, `Stand`, and `Double`.
- **Scenario:**
    1. Player clicks "Split" on the frontend. Local state updates to show two hands.
    2. Player clicks "Hit" on the first split hand.
    3. Frontend sends `CasinoGameMove` with payload `[0]` (Hit).
    4. Backend receives "Hit". Since it has no concept of split, it applies the Hit to the *original* hand (e.g., a pair of 8s becoming 16).
    5. If the hit card causes a bust (e.g., 10 -> 26), the Backend ends the game (`CasinoGameCompleted`).
    6. Frontend receives the completion event and overwrites the UI with a "Loss", causing the split hands to vanish and confusing the player.
**Remediation:**
- **Immediate:** Remove the "Split" button from the frontend UI when `isOnChain` is true.
- **Long-term:** Implement Split logic in the backend (complex, involves dynamic state array resizing).

---

## 🟡 Medium Severity Issues

### 3. Super Mode Dead Code
**Severity:** Medium (Maintenance/Feature Gap)
**Component:** `execution/src/casino/super_mode.rs`, `execution/src/lib.rs`
**Description:**
- The codebase contains extensive logic for "Super Mode" (Lightning/Quantum multipliers) in `super_mode.rs`.
- However, the `generate_super_multipliers` function is **never called** by the execution engine.
- The `SuperModeState` in `GameSession` is always initialized to default (inactive).
- **Impact:** This is a "Ghost Feature". Code exists and is compiled, but is unreachable and non-functional.
**Remediation:**
- If the feature is intended, call `generate_super_multipliers` in `lib.rs` during `handle_casino_start_game` (likely based on a configuration flag or random chance).
- If not intended for this release, remove the dead code to reduce binary size and audit surface.

---

## ✅ Verified Safe

- **Video Poker RNG:** The card replacement logic in `video_poker.rs` correctly uses `create_deck_excluding` to ensure cards drawn are not duplicates of held cards or previously discarded cards.
- **Three Card Poker:** The Ante/Play deduction logic is complex but mathematically correct (Play bet is deducted via `LossWithExtraDeduction` on loss, and subtracted from winnings on win).
- **Baccarat/Roulette/Craps/Sic Bo:** Previous "Infinite Money" fixes appear robust.

---

## Action Plan

1.  **FIX UTH:** Apply the `ContinueWithUpdate` fix to `ultimate_holdem.rs`.
2.  **FIX BLACKJACK:** Disable the Split button in `useTerminalGame.ts`.
3.  **CLEANUP:** Remove or comment out Super Mode code (optional, but recommended).
