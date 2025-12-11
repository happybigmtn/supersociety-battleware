# OpenAI Bug Review

## 1) Account-scoped WebSocket drops `CasinoGameMoved` events
- **Impact:** The frontend subscribes with an account filter (`website/src/hooks/useTerminalGame.ts`:174-176), but the simulator filters out every `CasinoGameMoved` event (`simulator/src/lib.rs`:536-600 sets `is_event_relevant_to_account` to `false`). Players never receive per-move state updates, so hands/dice/card flows hang until completion (or forever if the game requires multi-step moves), balances from mid-game payouts/deductions never reach the UI, and bot activity looks dead.
- **Fix:** Treat move events as relevant when the session belongs to the account (lookup session->player or include the session owner in the event) and include them in `filter_updates_for_account`. At minimum, return `true` for `CasinoGameMoved` in `is_event_relevant_to_account`.

## 2) Chain state JSON shape mismatches break hydration
- **Impact:** WASM encodes casino state with snake_case + hex strings (`website/wasm/src/lib.rs`:262-301), but the React code expects camelCase fields and binary blobs. As a result: active shield/double flags never restore (`useTerminalGame.ts`:198-205), active sessions are never resumed (`useTerminalGame.ts`:210-233), and `parseGameState` is called with `undefined`/hex instead of a `Uint8Array`, throwing and skipping restoration. Users see stale modifiers, lost sessions, and have to re-register after refresh or backend restart.
- **Fix:** Normalize shapes in the client: map `active_shield` → `activeShield`, `active_session` → `activeSession`, `state_blob` (hex) → `Uint8Array`, `is_complete` → `isComplete`, `game_type` → enum value. Optionally include missing fields (`rank`, `nonce`, `last_deposit_block`, `aura_meter`) while you are there.

## 3) Leaderboard ignores chip decreases and new entrants
- **Impact:** `update_casino_leaderboard` is only called on faucet deposits and wins (`execution/src/lib.rs`:365,450,600). Registration (`execution/src/lib.rs`:333-341), start-game bet deduction (`396-402`), losses/pushes (`480-503`, `610-655`), and mid-game deductions never update the board. New players/bots don’t appear until they win, and chip stacks never drop after losses, so the leaderboard and bot board overstate balances and ordering.
- **Fix:** Call `update_casino_leaderboard` after any chip change (registration, bet debit, losses/pushes, `ContinueWithUpdate` payouts). Persisting rank in state would let you avoid recomputing on the frontend.

## 4) Leaderboard update event is defined but never emitted
- **Impact:** `Event::CasinoLeaderboardUpdated` exists (`types/src/execution.rs`:712-742) and is whitelisted for all subscribers, but the execution layer never emits it (`rg` finds no usages in `execution/`). Account- or firehose WebSocket subscribers therefore never get push updates and must poll, worsening the stale leaderboard problem above.
- **Fix:** Emit `CasinoLeaderboardUpdated` after `update_casino_leaderboard` (and after bulk recalcs) so both bots and players see live standings without polling.

### Suggested next steps
- Patch the simulator filter first to unblock gameplay; verify `CasinoGameMoved` flows through account filters.
- Normalize casino state shapes in `CasinoClient` to fix hydration; add a regression test exercising `getCasinoPlayer/getCasinoSession` → hook hydration.
- Wire leaderboard updates into all chip mutations and emit the leaderboard event; add an integration test that plays a losing hand and asserts the leaderboard drops.
