# Independent Logic & System Review (Round 4)

**Date:** December 10, 2025
**Reviewer:** Gemini
**Focus:** Betting Synchronization & "Ghost Features"

This document outlines findings from a fourth independent review, specifically targeting synchronization between frontend betting features and backend execution logic.

---

## 🟡 Medium Severity (Synchronization / Ghost Features)

### 1. Blackjack Insurance Desynchronization
**Severity:** Medium (UX/Logic Mismatch)
**Component:** `website/src/hooks/useTerminalGame.ts` vs `execution/src/casino/blackjack.rs`
**Description:**
- **Frontend:** Supports an "Insurance" bet if the dealer shows an Ace. Updates local `insuranceBet` state.
- **Backend:** The `Blackjack` implementation does **not** support an Insurance move.
- **Impact:**
    - If a player takes insurance on-chain, the frontend updates the message to "INSURANCE TAKEN", but **no transaction is sent**.
    - If the dealer has Blackjack, the backend returns a loss (or push).
    - The frontend displays the backend result, ignoring the local insurance bet.
    - Result: Player thinks they are insured, but they are not. (Though they also don't pay for it on-chain, so it's a "Ghost Feature" rather than theft).

**Remediation:**
- **Immediate:** Disable the Insurance prompt when `isOnChain` is true to prevent user confusion.
- **Status:** ✅ Fixed (Disabled in `useTerminalGame.ts`).

---

## ✅ Verified Sync (Other Games)

- **Casino War:** "Go to War" bet is correctly deducted via `LossWithExtraDeduction` on loss, and implicit net calculation on win. Synced.
- **Three Card Poker:** "Play" bet deduction logic is mathematically equivalent to correct payouts (deducted on loss via `LossWithExtraDeduction`, ignored on win but payout calculation assumes it wasn't deducted). Synced.
- **Baccarat/Roulette/Craps/Sic Bo:** Side bets are supported and synced.
- **Video Poker:** No side bets. Synced.
- **HiLo:** No side bets. Synced.
- **Ultimate Texas Hold'em:** "Trips" side bet is missing from both frontend and backend. Consistent (feature gap, not desync).

---

## Conclusion

Blackjack Insurance was the only remaining synchronization issue where the frontend offered a feature the backend completely ignored. This has been remediated by disabling the option in on-chain mode.
