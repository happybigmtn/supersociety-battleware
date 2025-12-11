# Leaderboard Implementation - Bug Fix #6

## Issue Description
The frontend initialized the leaderboard to an empty array and contained no logic to fetch or subscribe to leaderboard updates. Users saw an empty or static leaderboard during gameplay and in the registration/lobby phase.

## Solution Overview
Implemented a three-pronged approach to ensure leaderboard data is always available and up-to-date:

1. **Initial Load**: Fetch leaderboard immediately on app startup
2. **Polling**: Poll leaderboard every 3 seconds during both REGISTRATION and ACTIVE phases
3. **Event Subscription**: Subscribe to `CasinoLeaderboardUpdated` events for real-time updates

## Files Modified

### 1. `/website/src/hooks/useTerminalGame.ts`

#### A. Initial Leaderboard Fetch (Lines 274-309)
Added immediate leaderboard fetch after chain service initialization:
- Prevents empty leaderboard state on app load
- Fetches via `client.getCasinoLeaderboard()`
- Maps on-chain entries to frontend format
- Identifies and marks current player with "(YOU)" suffix

#### B. Extended Polling to REGISTRATION Phase (Line 361)
Changed polling condition from:
```typescript
if (phase === 'ACTIVE' && clientRef.current && tickCounterRef.current % 3 === 0)
```

To:
```typescript
if ((phase === 'ACTIVE' || phase === 'REGISTRATION') && clientRef.current && tickCounterRef.current % 3 === 0)
```

Also added `isRegistered` check when adding "YOU" entry (Line 384):
```typescript
if (!isPlayerInBoard && myPublicKeyHex && isRegistered)
```

#### C. Real-time Event Subscription (Lines 898-942)
Added subscription to `CasinoLeaderboardUpdated` events:
- Subscribes via `chainService.onLeaderboardUpdated()`
- Updates leaderboard state immediately when on-chain changes occur
- Uses same processing logic as polling for consistency
- Properly unsubscribes on cleanup

### 2. `/website/src/services/CasinoChainService.ts`

#### A. Handler Storage (Line 191)
Added handler array for leaderboard subscribers:
```typescript
private leaderboardUpdatedHandlers: ((leaderboard: any) => void)[] = [];
```

#### B. Event Listener in Constructor (Lines 295-305)
Subscribed to `CasinoLeaderboardUpdated` events from client:
```typescript
this.client.onEvent('CasinoLeaderboardUpdated', (event: any) => {
  const normalized = snakeToCamel(event) as any;
  try {
    if (normalized.leaderboard) {
      this.leaderboardUpdatedHandlers.forEach(h => h(normalized.leaderboard));
    }
  } catch (error) {
    console.error('[CasinoChainService] Failed to parse CasinoLeaderboardUpdated:', error);
  }
});
```

#### C. Public Subscription Method (Lines 448-460)
Added public method for components to subscribe to leaderboard updates:
```typescript
onLeaderboardUpdated(handler: (leaderboard: any) => void): () => void {
  this.leaderboardUpdatedHandlers.push(handler);
  return () => {
    const index = this.leaderboardUpdatedHandlers.indexOf(handler);
    if (index !== -1) {
      this.leaderboardUpdatedHandlers.splice(index, 1);
    }
  };
}
```

## How It Works

### Leaderboard Data Flow

1. **App Initialization**
   - WebSocket connects to backend
   - Initial leaderboard fetch via REST API
   - Populates leaderboard state immediately
   - No empty/loading state visible to user

2. **During Gameplay**
   - Polling checks leaderboard every 3 seconds (both phases)
   - Event subscription provides instant updates
   - Current player always marked with "(YOU)"
   - "YOU" entry only shown if player is registered

3. **Data Processing**
   - On-chain entries mapped to `LeaderboardEntry` format
   - Player identification via public key hex comparison
   - Entries sorted by chips descending
   - Player rank calculated and updated in stats

### Update Strategy

**Polling (Every 3 seconds)**
- Provides fallback if events are missed
- Ensures eventual consistency
- Active during REGISTRATION and ACTIVE phases

**Event-Driven (Instant)**
- Responds to `CasinoLeaderboardUpdated` WebSocket events
- Zero latency for leaderboard changes
- More responsive user experience

**Initial Load (On startup)**
- REST API call to `getCasinoLeaderboard()`
- Prevents flash of empty content
- Synchronizes UI with chain state

## Testing

### Verification Steps

1. **Empty State Fix**
   - ✓ Open app → leaderboard should populate immediately
   - ✓ No empty array visible at any time

2. **Registration Phase**
   - ✓ Leaderboard visible in registration/lobby view
   - ✓ Shows existing players from previous tournaments
   - ✓ Updates when new players register

3. **Active Phase**
   - ✓ Leaderboard updates after each game completes
   - ✓ "YOU" entry shows current chip count
   - ✓ Player rank updates correctly

4. **Real-time Updates**
   - ✓ Play a game and observe immediate leaderboard update
   - ✓ Check console for "Leaderboard updated event" logs
   - ✓ Compare with 3-second polling logs

5. **Multiple Players**
   - ✓ Enable bots in registration screen
   - ✓ Start tournament
   - ✓ Leaderboard should show all active players
   - ✓ Current player marked with "(YOU)" suffix

## API Reference

### CasinoClient Methods
- `getCasinoLeaderboard()`: Returns current leaderboard state from chain

### CasinoChainService Methods
- `onLeaderboardUpdated(handler)`: Subscribe to leaderboard update events
  - Returns unsubscribe function
  - Handler receives normalized leaderboard data

### Event Types
- `CasinoLeaderboardUpdated`: Emitted when on-chain leaderboard changes
  - Contains `leaderboard` object with `entries` array
  - Each entry has `player` (hex), `name`, and `chips`

## Performance Considerations

- **Polling Interval**: 3 seconds (prevents excessive API calls)
- **Event Priority**: Events update immediately, polling provides backup
- **Memory**: Leaderboard limited to top N entries + current player
- **Network**: Combined strategy ensures reliability with acceptable traffic

## Future Improvements

1. **Configurable Polling**: Allow adjustment of poll interval
2. **Leaderboard Pagination**: Support for viewing full leaderboard
3. **Historical Data**: Track leaderboard changes over time
4. **Animations**: Smooth transitions when entries change
5. **Filtering**: View by game type, time period, etc.
