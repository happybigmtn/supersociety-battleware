# Comprehensive Bug Analysis Report

**Agent:** Claude (Opus 4.5)
**Date:** December 10, 2025
**Scope:** Frontend-backend integration, balance updates, leaderboard, game logic, execution

---

## Critical Bugs

### 1. Balance Update Race Condition in CasinoGameCompleted Handler

**Location:** `website/src/hooks/useTerminalGame.ts:786-799`

**Description:** The balance update from `CasinoGameCompleted` events can race with the leaderboard polling, causing visual inconsistencies and potential state divergence.

**Root Cause:** Two separate mechanisms update the player's chip balance:
1. `CasinoGameCompleted` event handler sets `chips: finalChips` directly (line 791)
2. Leaderboard polling updates player rank but may have stale data (lines 300-351)

**Impact:**
- User sees incorrect balance momentarily
- Rank calculation may use outdated chip values
- If the leaderboard poll occurs between game completion and event processing, the balance may briefly show the wrong value

**Suggested Fix:**
```typescript
// In leaderboard polling, skip updating if we have pending game completion
if (currentSessionIdRef.current !== null) {
  // Skip leaderboard balance updates while a game is active
  return;
}
```

---

### 2. Session ID Type Mismatch Between Frontend and Backend

**Location:** `website/src/services/CasinoChainService.ts:208-213` and `useTerminalGame.ts:496`

**Description:** Session IDs are generated and compared inconsistently between BigInt and Number types, potentially causing event filtering to fail silently.

**Root Cause:**
- `CasinoChainService.generateNextSessionId()` returns `bigint`
- Events from chain come with `session_id` as string, then converted to BigInt
- Comparison at line 496: `event.sessionId === currentSessionIdRef.current` compares BigInt values
- JavaScript BigInt comparison requires both operands to be BigInt

**Evidence from Code:**
```typescript
// CasinoChainService.ts:208
sessionId: BigInt(event.session_id),

// useTerminalGame.ts:496
if (currentSessionIdRef.current && event.sessionId === currentSessionIdRef.current) {
```

**Impact:** Events may not match their sessions if type coercion fails, causing games to hang or not complete properly.

**Suggested Fix:** Add explicit BigInt conversion for all comparisons or use string representation consistently:
```typescript
// Always compare as strings to avoid BigInt comparison issues
if (currentSessionIdRef.current &&
    event.sessionId.toString() === currentSessionIdRef.current.toString()) {
```

---

### 3. Bot Nonce Management Bug - Bots Can Exhaust Account State

**Location:** `website/src/services/BotService.ts:159-166`

**Description:** Bots start with `nonce: 1` after registration but don't verify the actual on-chain nonce state. If registration fails (e.g., already registered), subsequent transactions will fail due to nonce mismatch.

**Root Cause:**
```typescript
return {
  // ...
  nonce: 1, // Start at 1 since we used 0 for registration
  // ...
};
```

The bot assumes registration consumed nonce 0, but:
1. If the bot was already registered in a previous session, nonce 0 wasn't used
2. The actual nonce from chain state is never queried
3. No error handling for nonce validation failures

**Impact:**
- All bot transactions fail after a node restart
- Bot leaderboard shows stale data because bots can't play
- Tournament appears inactive despite bots being "active"

**Suggested Fix:**
```typescript
// After registration attempt, query actual nonce from chain
const account = await this.queryAccount(wasm.getPublicKeyBytes());
const actualNonce = account ? account.nonce : 1;

return {
  // ...
  nonce: actualNonce,
  // ...
};
```

---

### 4. Leaderboard Display Not Showing Bot Entries

**Location:** `website/src/hooks/useTerminalGame.ts:305-346`

**Description:** The leaderboard polling fetches `getCasinoLeaderboard()` but bot entries may not appear because:
1. Bots may fail to register (nonce issues)
2. The leaderboard may have a limited entry count
3. Bot names don't populate correctly from the `name` field

**Root Cause:**
```typescript
const newBoard: LeaderboardEntry[] = leaderboardData.entries.map((entry) => ({
  name: entry.name || `Player_${entry.player?.substring(0, 8)}`,
  // ...
}));
```

The fallback to `Player_{hex}` suggests `entry.name` is often undefined, indicating bots may not be registering with names correctly.

**Additional Issue:** The `getCasinoLeaderboard()` implementation in `execution/src/lib.rs:765-772` only stores a limited number of entries in the leaderboard. If there are more than N players, some are excluded.

**Impact:**
- Users don't see expected bot competition
- Tournament feels empty even when bots are configured

**Suggested Fix:**
1. Verify bot registration succeeds with proper error handling
2. Increase leaderboard capacity or paginate
3. Ensure bot names are properly serialized in registration transaction

---

### 5. Game State Parsing Fails Silently for Some Games

**Location:** `website/src/hooks/useTerminalGame.ts:832-1199`

**Description:** The `parseGameState` function has multiple early returns that swallow errors, leaving the game in an inconsistent state.

**Examples:**
```typescript
// Line 840-843
if (stateBlob.length < 3) {
  console.error('[parseGameState] Blackjack state blob too short:', stateBlob.length);
  return; // Returns without updating state - game appears frozen
}
```

**Root Cause:** When state parsing fails:
1. No error is surfaced to the user
2. Game state isn't reset or marked as errored
3. The isPendingRef flag may remain true indefinitely

**Impact:**
- Games appear frozen
- User can't start new games
- No indication of what went wrong

**Suggested Fix:**
```typescript
if (stateBlob.length < 3) {
  console.error('[parseGameState] Blackjack state blob too short:', stateBlob.length);
  setGameState(prev => ({
    ...prev,
    stage: 'RESULT',
    message: 'ERROR: Invalid game state received',
  }));
  currentSessionIdRef.current = null;
  isPendingRef.current = false;
  return;
}
```

---

## High Priority Bugs

### 6. isPendingRef Flag Can Get Stuck

**Location:** `website/src/hooks/useTerminalGame.ts:149, 523, 534, 820`

**Description:** The `isPendingRef` flag prevents double-submissions but can get stuck in `true` state if:
1. WebSocket connection drops before event arrives
2. Transaction fails on-chain but no error event is emitted
3. Event arrives but session ID doesn't match (see Bug #2)

**Root Cause:** The flag is set to `true` on action initiation but only cleared on:
- Successful event receipt (line 758)
- Explicit error catch blocks (line 534)
- Game completion (line 820)

If none of these conditions occur, the flag stays true.

**Impact:**
- User cannot perform any game actions
- Only workaround is page refresh

**Suggested Fix:** Add timeout-based recovery:
```typescript
// When setting isPending = true, also start a timeout
isPendingRef.current = true;
pendingTimeoutRef.current = setTimeout(() => {
  if (isPendingRef.current) {
    console.warn('[useTerminalGame] Pending timeout - clearing flag');
    isPendingRef.current = false;
    setGameState(prev => ({
      ...prev,
      message: 'TIMEOUT - TRY AGAIN',
    }));
  }
}, 30000); // 30 second timeout
```

---

### 7. NonceManager Has Duplicate cleanupAllTransactions Definition

**Location:** `website/src/api/nonceManager.js:262-277` and `312-330`

**Description:** The `cleanupAllTransactions` method is defined twice in the class, which is a JavaScript error. The second definition silently overwrites the first.

**Code Evidence:**
```javascript
// First definition at line 262
cleanupAllTransactions() {
  if (!this.publicKeyHex) return;
  // ...
}

// Second definition at line 312
cleanupAllTransactions() {
  const prefix = this.TX_STORAGE_PREFIX;
  // ...
}
```

**Impact:** The first implementation (which checks `this.publicKeyHex`) is never called, potentially causing cleanup to run when it shouldn't.

**Suggested Fix:** Remove the duplicate definition and keep only the more complete implementation.

---

### 8. Execution Layer Silently Ignores Invalid Instructions

**Location:** `execution/src/lib.rs:283-316`

**Description:** When `transaction.instruction` matches a casino instruction but fails validation, the function returns an empty `vec![]` with no error event emitted.

**Examples:**
```rust
// Line 322-325
if self.get(&Key::CasinoPlayer(public.clone())).await.is_some() {
    return vec![]; // Player already registered - no error event
}

// Line 387-389
if player.chips < bet || bet == 0 {
    return vec![]; // Insufficient funds - no error event
}
```

**Impact:**
- Frontend never knows why a transaction failed
- User sees no feedback on invalid actions
- Debug logs are the only way to diagnose issues

**Suggested Fix:** Add error events:
```rust
if player.chips < bet || bet == 0 {
    return vec![Event::CasinoError {
        player: public.clone(),
        error: "Insufficient chips or zero bet".to_string(),
    }];
}
```

---

### 9. Leaderboard Stale Closure Bug

**Location:** `website/src/hooks/useTerminalGame.ts:326`

**Description:** The leaderboard update logic uses `stats.chips` from a stale closure when adding the current player who isn't in the leaderboard:

```typescript
if (!isPlayerInBoard && myPublicKeyHex) {
  newBoard.push({ name: "YOU", chips: stats.chips, status: 'ALIVE' });
}
```

The `stats.chips` value comes from the outer scope of the `useEffect` callback, which was captured when the interval was created. If chips change during the session, this closure has outdated values.

**Impact:**
- Player's chips display incorrectly in leaderboard if they're not in top N
- Rank calculation may be wrong

**Suggested Fix:** Use a ref to access current stats:
```typescript
const statsRef = useRef(stats);
useEffect(() => { statsRef.current = stats; }, [stats]);

// In leaderboard update:
newBoard.push({ name: "YOU", chips: statsRef.current.chips, status: 'ALIVE' });
```

---

### 10. Casino War Auto-Confirm Race Condition

**Location:** `website/src/hooks/useTerminalGame.ts:512-538`

**Description:** For Casino War, an auto-confirm is sent immediately after `CasinoGameStarted` is received if `stage === 0`. However, this creates a race:
1. `CasinoGameStarted` event arrives
2. Auto-confirm transaction is submitted
3. Before chain processes confirm, another `CasinoGameStarted` might arrive (from previous session cleanup)

**Code:**
```typescript
if (frontendGameType === GameType.CASINO_WAR && chainService && currentSessionIdRef.current) {
  const stage = event.initialState[2];
  if (stage === 0) {
    // Guard exists but may not catch all cases
    if (isPendingRef.current) {
      console.log('[useTerminalGame] Casino War auto-confirm blocked - transaction pending');
      return;
    }
    // Auto-confirm logic...
  }
}
```

**Impact:** Duplicate confirm transactions or confirms for wrong session.

---

## Medium Priority Bugs

### 11. WebSocket Reconnection Doesn't Re-sync State

**Location:** `website/src/api/client.js:393-397`

**Description:** When WebSocket reconnects after disconnection, it simply reconnects but doesn't re-fetch current game state:

```javascript
this.updatesWs.onclose = (event) => {
  console.log('Updates WebSocket disconnected, code:', event.code, 'reason:', event.reason);
  this.handleReconnect('updatesWs', () => this.connectUpdates(this.currentUpdateFilter));
};
```

**Impact:** If events were missed during disconnection, game state may be out of sync. User might think they're in a different game state than the chain.

**Suggested Fix:** After successful reconnect, query current session and player state.

---

### 12. Tournament Phase Never Changes to ELIMINATION

**Location:** `website/src/hooks/useTerminalGame.ts:276-297`

**Description:** The `TournamentPhase` type includes `'ELIMINATION'` but it's never set anywhere in the code. The phase only transitions between `'REGISTRATION'` and `'ACTIVE'`.

```typescript
if (remaining <= 0) {
  console.log('[useTerminalGame] Manual tournament ended');
  setManualTournamentEndTime(null);
  setPhase('REGISTRATION'); // Never goes to 'ELIMINATION'
  // ...
}
```

**Impact:** Tournament end mechanics may not work as designed. Players expecting elimination phase features won't see them.

---

### 13. Baccarat Auto-Deal Sends Bets Without Balance Check

**Location:** `website/src/hooks/useTerminalGame.ts:548-586`

**Description:** When Baccarat auto-deals, it sends all bets without first checking if the player has sufficient chips:

```typescript
// Send all bets (action 0 for each)
for (const bet of betsToPlace) {
  const betPayload = serializeBaccaratBet(bet.betType, bet.amount);
  const result = await chainService.sendMove(currentSessionIdRef.current!, betPayload);
  // No balance check before sending
}
```

**Impact:** Transactions fail on-chain silently, leaving the game in a confusing state.

---

### 14. decodeCard Function Not Shown But Referenced

**Location:** `website/src/hooks/useTerminalGame.ts:855, 856, 864, etc.`

**Description:** The `decodeCard` function is called throughout `parseGameState` but its implementation isn't visible in the reviewed code. If it has bugs, all card-based games would be affected.

**Impact:** Potential for incorrect card display if decoding is buggy.

---

### 15. HiLo Graph Data Grows Unbounded

**Location:** `website/src/hooks/useTerminalGame.ts:914`

**Description:** The HiLo game state accumulates graph data indefinitely:

```typescript
hiloGraphData: [...(prev.hiloGraphData || []), actualPot],
```

**Impact:** Memory usage grows over long sessions, potentially causing browser slowdown.

**Suggested Fix:** Limit to last N entries:
```typescript
hiloGraphData: [...(prev.hiloGraphData || []).slice(-100), actualPot],
```

---

## Low Priority Bugs / Code Quality Issues

### 16. Multiple `setGameState` Calls in Event Handlers

**Location:** `website/src/hooks/useTerminalGame.ts:803-815`

**Description:** After game completion, multiple `setGameState` calls occur:
```typescript
// Reset active modifiers (lines 803-808)
setGameState(prev => ({ ...prev, activeModifiers: { shield: false, double: false } }));

// Set result state (lines 810-815)
setGameState(prev => ({ ...prev, stage: 'RESULT', message: resultMessage, lastResult: payout }));
```

**Impact:** Potential for React batching issues or unnecessary re-renders.

**Suggested Fix:** Combine into single update.

---

### 17. localStorage Keys Are Not Namespaced Per User

**Location:** `website/src/api/nonceManager.js:164-166`

**Description:** The nonce is stored with a generic key:
```javascript
const key = 'casino_nonce';
```

If multiple tabs or users share localStorage, they could interfere.

---

### 18. Error Handling in Leaderboard Polling is Debug-level

**Location:** `website/src/hooks/useTerminalGame.ts:348`

**Description:**
```typescript
} catch (e) {
  console.debug('[useTerminalGame] Failed to fetch leaderboard:', e);
}
```

Using `console.debug` means errors are hidden by default in most browser consoles.

---

## Architecture Observations

### Session Management Complexity
The current session management uses:
1. `currentSessionIdRef` (ref for async access)
2. `currentSessionId` (state for re-renders)
3. `gameTypeRef` (ref for game type)
4. `isPendingRef` (ref for in-flight tracking)

This complexity increases the surface area for bugs. Consider consolidating into a single session state object.

### Event-Driven vs Polling Hybrid
The system uses both WebSocket events and polling:
- Game events via WebSocket
- Leaderboard via polling every 3 seconds

This can cause inconsistencies. Consider moving to fully event-driven or fully polling.

### Type Safety Gaps
The codebase mixes TypeScript (`.ts`, `.tsx`) with JavaScript (`.js`). The JavaScript files (`client.js`, `nonceManager.js`) lack type safety, making it easier to introduce bugs.

---

## Recommended Priority Order for Fixes

1. **Bug #1** - Balance race condition (user-facing confusion)
2. **Bug #2** - Session ID type mismatch (causes games to fail)
3. **Bug #3** - Bot nonce management (breaks tournament simulation)
4. **Bug #6** - isPendingRef stuck (complete game freeze)
5. **Bug #8** - Silent execution errors (debugging nightmare)
6. **Bug #5** - Silent parsing failures (frozen UI)
7. **Bug #7** - Duplicate function definition (code correctness)
8. **Bug #4** - Leaderboard display (feature broken)
9. **Bug #9** - Stale closure (incorrect display)
10. **Bug #10** - Casino War race (duplicate transactions)

---

## Testing Recommendations

1. **Add integration tests** for the frontend-backend event flow
2. **Add nonce validation tests** for bot service
3. **Test WebSocket disconnection/reconnection** scenarios
4. **Add boundary tests** for state blob parsing
5. **Test tournament lifecycle** end-to-end

---

*This report was generated by analyzing the codebase files without runtime testing. Some issues may be masked by other code not reviewed or may manifest differently in production.*
