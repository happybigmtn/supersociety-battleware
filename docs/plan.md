# Supersociety Nullspace Integration Plan

## Objective
Migrate the `supersociety` frontend-only prototype to a fully decentralized application by forking `nullspace` and replacing its game logic with `supersociety`'s casino games.

## Repository Setup
1.  **Fork:** Create `supersociety-nullspace` from `nullspace`.
2.  **Import:** Copy `supersociety` frontend code into `supersociety-nullspace/website`.

## Phase 1: Backend Adaptation (The Chain)
We need to replace "Creature Battler" with "Decentralized Casino".

### 1. Types (`types` crate)
*   **Rename/Replace:** `nullspace-types` -> `supersociety-types` (conceptually).
*   **Define State:**
    *   Remove `Creature`, `Battle`.
    *   Add `Player` struct:
        ```rust
        pub struct Player {
            pub chips: u64,
            pub shields: u32,
            pub doubles: u32,
            pub rank: u32,
            pub name: String,
        }
        ```
    *   Add `GameSession` struct:
        ```rust
        pub struct GameSession {
            pub id: u64,
            pub player: PublicKey,
            pub game_type: GameType,
            pub bet: u64,
            pub state_blob: Vec<u8>, // Hex blob in TS, Vec<u8> in Rust
        }
        ```
    *   Add `GameType` enum (matching `chainService.ts`):
        ```rust
        #[repr(u8)]
        pub enum GameType {
            Baccarat = 0,
            Blackjack = 1,
            CasinoWar = 2,
            Craps = 3,
            VideoPoker = 4,
            Hilo = 5,
            Roulette = 6,
            SicBo = 7,
            ThreeCard = 8,
            UltimateHoldem = 9,
        }
        ```

### 2. Execution Logic (`execution` crate)
*   **Remove:** `creature.rs`, `battle.rs`, `elo.rs`.
*   **Add:** `casino.rs` module.
    *   **Porting Strategy:**
        *   Each game will have its own sub-module (e.g., `casino/blackjack.rs`, `casino/hilo.rs`).
        *   Each module implements a `process_move` function:
            ```rust
            pub fn process_move(
                session: &mut GameSession, 
                player: &mut Player, 
                payload: &[u8], 
                seed: &Seed
            ) -> bool // returns true if game over
            ```
        *   **Randomness:** Use `commonware_cryptography::Sha256` with the `seed` (derived from consensus) to generate deterministic random numbers. **Do not use `rand::thread_rng()`**.
    *   **Game Specifics (derived from `chainService.ts`):**
        *   **HiLo:** Payload `[0]` (Higher), `[1]` (Lower), `[2]` (Cashout). State: `[current_card, accumulator...]`.
        *   **Blackjack:** Payload `[0]` (Hit), `[1]` (Stand), `[2]` (Double). State: `[pLen, pCards..., dLen, dCards...]`.
        *   **Baccarat:** Payload `[0]` (Player), `[1]` (Banker), `[2]` (Tie). State: `[stage, pCards..., bCards...]`.
        *   **Video Poker:** Payload `[]` (Deal), `[indices...]` (Draw). State: `[stage, cards..., holdMask]`.
        *   **Roulette:** Payload `[0, type, target, amount]` (Bet), `[1]` (Spin). State: `[stage, lastResult, bets...]`.
    *   **Logic:**
        *   Implement the game rules in Rust exactly as implied by the frontend parsing logic.
        *   On "Win", update `player.chips`.
        *   On "Game Over", return `true` so the session can be deleted from state.

*   **Update Layer (`state_transition.rs`):**
    *   Handle `Instruction::StartGame`:
        *   Check `player.chips >= bet`.
        *   Deduct `bet`.
        *   Create `GameSession`.
        *   **Crucial:** Some games (HiLo) deal immediately on start. Call `game::hilo::init(&mut session, seed)` if needed.
    *   Handle `Instruction::GameMove`:
        *   Load session.
        *   Verify ownership (`session.player == tx.sender`).
        *   Call `game::process_move`.
        *   If game over, delete session. Else, update session.

### 4. Binary Compatibility Check (Critical)
The Rust `Instruction` enum serialization **must** match `chainService.ts` exactly.

**Layout Specification:**

1.  **Register (Tag 0)**
    *   `u8`: 0
    *   `u32`: Name Length (Big Endian)
    *   `[u8]`: Name Bytes (UTF-8)

2.  **Deposit (Tag 1)**
    *   `u8`: 1
    *   `u64`: Amount (Big Endian)

3.  **StartGame (Tag 2)**
    *   `u8`: 2
    *   `u8`: GameType (0-9)
    *   `u64`: Bet Amount (Big Endian)
    *   `u64`: Session ID (Big Endian)

4.  **GameMove (Tag 3)**
    *   `u8`: 3
    *   `u64`: Session ID (Big Endian)
    *   `u32`: Payload Length (Big Endian)
    *   `[u8]`: Payload Bytes

**Action:** Create a unit test in `types/src/execution.rs` that takes a hardcoded hex string (generated from `chainService.ts`) and asserts it deserializes correctly into the Rust `Instruction` enum.

## Phase 2: Frontend Adaptation (The Client)
We need to hook the existing `supersociety` React UI to the `nullspace` node.

### 1. API Client (`website/src/api`)
*   **Update `client.js`:**
    *   Update `submitTransaction` to serialize `StartGame` / `GameMove` actions correctly (matching `ChainService.ts` serialization).
    *   Ensure Ed25519 signing matches the backend expectation.

### 2. WASM (`website/wasm`)
*   **Updates:** If game logic verification is needed on client (e.g. "valid move?"), expose Rust game logic via WASM.
*   **Helpers:** Expose `hexToBytes` / `bytesToHex` if needed.

### 3. Service Layer
*   **Refactor `ChainService`:**
    *   Instead of `fetch`, use `NullspaceClient` (which handles connection/auth).
    *   Instead of polling (`setInterval`), subscribe to `client.onEvent('Moved')`.

### 4. UI Components
*   **Copy:** Move `supersociety/components` -> `website/src/components`.
*   **Copy:** Move `supersociety/hooks` -> `website/src/hooks`.
*   **Root:** Replace `App.jsx` with `supersociety`'s `App.tsx` (adapted).
*   **Routing:** Ensure `TitleScreen` leads to `CasinoLobby` instead of `CharacterGeneration`.

## Phase 3: Testing & Verification
1.  **Unit Tests:** Test Rust game logic (Blackjack, HiLo) with deterministic seeds.
2.  **Integration:**
    *   Start local node.
    *   Register player.
    *   Start Game -> Verify Session created on-chain.
    *   Make Move -> Verify State update on-chain.
    *   Finish Game -> Verify Chip balance updated.

## Phase 4: Polish
*   **Events:** Ensure `GameWon` / `GameLost` events are emitted and displayed in UI.
*   **Error Handling:** Handle insufficient funds, invalid moves gracefully.

---

## Appendix A: Complete Game Specifications

### A.1 State Blob Layouts (Binary Format)

All state blobs are serialized as `Vec<u8>` on-chain and hex-encoded for frontend consumption.

#### Blackjack State
```
[pLen:u8] [pCards:u8×pLen] [dLen:u8] [dCards:u8×dLen] [stage:u8] [insuranceBet:u64?]
```
- `pLen`: Number of player cards (2-11)
- `pCards`: Card values 0-51 (suit = value/13, rank = value%13)
- `dLen`: Number of dealer cards (1-6)
- `dCards`: Card values (first card may be hidden until stand)
- `stage`: 0=DEALING, 1=PLAYER_TURN, 2=DEALER_TURN, 3=COMPLETE

#### HiLo State
```
[currentCard:u8] [accumulator:i64 BE]
```
- `currentCard`: Current visible card (0-51)
- `accumulator`: Running total in milliBPS (e.g., 1500 = 1.5x multiplier)

#### Baccarat State
```
[stage:u8] [pCard1:u8] [pCard2:u8] [pCard3:u8?] [bCard1:u8] [bCard2:u8] [bCard3:u8?] [betType:u8]
```
- `stage`: 0=BETTING, 1=DEALT, 2=THIRD_CARD, 3=COMPLETE
- `betType`: 0=PLAYER, 1=BANKER, 2=TIE, 3=P_PAIR, 4=B_PAIR

#### Video Poker State
```
[stage:u8] [c1:u8] [c2:u8] [c3:u8] [c4:u8] [c5:u8] [holdMask:u8]
```
- `stage`: 0=DEAL, 1=DRAW, 2=COMPLETE
- `holdMask`: 5-bit mask (0b00001 = card 1 held, etc.)

#### Three Card Poker State
```
[stage:u8] [p1:u8] [p2:u8] [p3:u8] [d1:u8] [d2:u8] [d3:u8] [pairPlusBet:u64 BE]
```
- `stage`: 0=ANTE, 1=DEALT, 2=PLAYED, 3=COMPLETE

#### Ultimate Texas Hold'em State
```
[stage:u8] [p1:u8] [p2:u8] [d1:u8] [d2:u8] [c1:u8] [c2:u8] [c3:u8] [c4:u8] [c5:u8] [betMultiplier:u8]
```
- `stage`: 0=PREFLOP, 1=FLOP, 2=RIVER, 3=SHOWDOWN, 4=COMPLETE
- `betMultiplier`: 0=check, 1=1x, 2=2x, 3=3x, 4=4x

#### Roulette State
```
[stage:u8] [lastResult:u8] [betCount:u8] [bets:RouletteEntry×betCount]
```
Each `RouletteEntry`:
```
[betType:u8] [target:u8] [amount:u64 BE]
```
- `betType`: 0=STRAIGHT, 1=RED, 2=BLACK, 3=ODD, 4=EVEN, 5=LOW, 6=HIGH, 7=DOZEN1, 8=DOZEN2, 9=DOZEN3, 10=COL1, 11=COL2, 12=COL3, 13=ZERO

#### Sic Bo State
```
[stage:u8] [d1:u8] [d2:u8] [d3:u8] [betCount:u8] [bets:SicBoEntry×betCount]
```
Each `SicBoEntry`:
```
[betType:u8] [target:u8] [target2:u8] [amount:u64 BE]
```
- `betType`: 0=SMALL, 1=BIG, 2=ODD, 3=EVEN, 4=TRIPLE, 5=ANY_TRIPLE, 6=SUM, 7=DOUBLE, 8=COMBO

#### Craps State
```
[stage:u8] [point:u8] [d1:u8] [d2:u8] [betCount:u8] [bets:CrapsEntry×betCount]
```
Each `CrapsEntry`:
```
[betType:u8] [point:u8] [amount:u64 BE] [odds:u64 BE]
```
- `betType`: 0=PASS, 1=DONT_PASS, 2=COME, 3=DONT_COME, 4=FIELD, 5=PLACE, 6=ODDS

#### Casino War State
```
[stage:u8] [pCard:u8] [dCard:u8] [warBet:u64 BE]
```
- `stage`: 0=DEAL, 1=WAR, 2=COMPLETE

---

### A.2 GameMove Payloads (Per Game)

| Game | Payload | Description |
|------|---------|-------------|
| **Blackjack** | `[0]` | Hit |
| | `[1]` | Stand |
| | `[2]` | Double Down |
| | `[3]` | Split |
| | `[4, amount:u64 BE]` | Insurance |
| **HiLo** | `[0]` | Higher |
| | `[1]` | Lower |
| | `[2]` | Cashout |
| **Baccarat** | `[0]` | Bet Player |
| | `[1]` | Bet Banker |
| | `[2]` | Bet Tie |
| | `[3]` | Pair Plus (Player) |
| | `[4]` | Pair Plus (Banker) |
| **Video Poker** | `[]` | Deal (stage 0) |
| | `[indices...]` | Draw - keep cards at indices |
| **Three Card** | `[0]` | Deal |
| | `[1]` | Play (match ante) |
| | `[2]` | Fold |
| | `[3, amount:u64 BE]` | Pair Plus bet |
| **Ultimate Holdem** | `[0]` | Deal |
| | `[1]` | Check |
| | `[2]` | Bet 4x |
| | `[3]` | Bet 3x |
| | `[4]` | Bet 2x |
| | `[5]` | Bet 1x |
| | `[6]` | Fold |
| **Roulette** | `[0, type:u8, target:u8, amount:u64 BE]` | Place bet |
| | `[1]` | Spin |
| | `[2]` | Clear bets |
| **Sic Bo** | `[0, type:u8, t1:u8, t2:u8, amount:u64 BE]` | Place bet |
| | `[1]` | Roll |
| | `[2]` | Clear bets |
| **Craps** | `[0, type:u8, point:u8, amount:u64 BE]` | Place bet |
| | `[1, amount:u64 BE]` | Add odds |
| | `[2]` | Roll |
| | `[3]` | Clear bets |
| **Casino War** | `[0]` | Deal |
| | `[1]` | Go to War |
| | `[2]` | Surrender |

---

### A.3 Payout Tables

#### Blackjack
| Outcome | Payout |
|---------|--------|
| Blackjack (21 with 2 cards) | 3:2 (1.5x bet) |
| Win | 1:1 |
| Insurance (dealer BJ) | 2:1 on insurance amount |
| Push | 0 (bet returned) |

#### Video Poker (Jacks or Better)
| Hand | Payout |
|------|--------|
| Royal Flush | 800:1 |
| Straight Flush | 50:1 |
| Four of a Kind | 25:1 |
| Full House | 9:1 |
| Flush | 6:1 |
| Straight | 4:1 |
| Three of a Kind | 3:1 |
| Two Pair | 2:1 |
| Jacks or Better | 1:1 |
| High Card | 0 (lose) |

#### Three Card Poker
| Hand | Ante Bonus | Pair Plus |
|------|------------|-----------|
| Straight Flush | 5:1 | 40:1 |
| Three of a Kind | 4:1 | 30:1 |
| Straight | 1:1 | 6:1 |
| Flush | - | 3:1 |
| Pair | - | 1:1 |

#### Ultimate Texas Hold'em
| Hand | Blind Payout |
|------|--------------|
| Royal Flush | 500:1 |
| Straight Flush | 50:1 |
| Four of a Kind | 10:1 |
| Full House | 3:1 |
| Flush | 3:2 |
| Straight | 1:1 |
| Lower | Push |

#### Baccarat
| Bet | Payout | House Edge |
|-----|--------|------------|
| Player | 1:1 | 1.24% |
| Banker | 0.95:1 (5% commission) | 1.06% |
| Tie | 8:1 | 14.36% |
| Player Pair | 11:1 | 11.25% |
| Banker Pair | 11:1 | 11.25% |

#### Roulette (Single Zero)
| Bet Type | Payout |
|----------|--------|
| Straight (single number) | 35:1 |
| Red/Black | 1:1 |
| Odd/Even | 1:1 |
| High/Low (1-18/19-36) | 1:1 |
| Dozen (1-12/13-24/25-36) | 2:1 |
| Column | 2:1 |
| Zero | 35:1 |

#### Sic Bo
| Bet Type | Payout | Notes |
|----------|--------|-------|
| Small (4-10) | 1:1 | Loses on any triple |
| Big (11-17) | 1:1 | Loses on any triple |
| Specific Triple | 180:1 | Exact triple (e.g., 3-3-3) |
| Any Triple | 30:1 | Any matching triple |
| Double Specific | 10:1 | At least 2 of target die |
| Single Die | 1:1/2:1/3:1 | 1 match/2 match/3 match |
| Sum of 4 or 17 | 60:1 | |
| Sum of 5 or 16 | 30:1 | |
| Sum of 6 or 15 | 17:1 | |
| Sum of 7 or 14 | 12:1 | |
| Sum of 8 or 13 | 8:1 | |
| Sum of 9 or 12 | 6:1 | |
| Sum of 10 or 11 | 6:1 | |

#### Craps (Enhanced Implementation)

**Bet Types (from frontend gameUtils.ts):**

| Bet Type | Tag | Description | Resolution |
|----------|-----|-------------|------------|
| PASS | 0 | Standard pass line | Come out: 7/11=win, 2/3/12=lose, else=point. Point phase: point=win, 7=lose |
| DONT_PASS | 1 | Against shooter | Come out: 2/3=win, 7/11=lose, 12=push. Point phase: 7=win, point=lose |
| COME | 2 | Pass line during point phase | Works like PASS but with own point. Status: PENDING→ON |
| DONT_COME | 3 | Don't pass during point phase | Works like DONT_PASS but with own point. Status: PENDING→ON |
| FIELD | 4 | Single roll bet | 2,12=2x, 3,4,9,10,11=1x, else=lose |
| YES | 5 | Number hits before 7 (Place) | Target hits=win (true odds - 1% commission), 7=lose |
| NO | 6 | 7 hits before number (Lay) | 7=win (true odds - 1% commission), target=lose |
| NEXT | 7 | Hop bet - exact roll | Target on next roll=win (probability-based), else=lose |
| HARDWAY | 8 | Specific double (4,6,8,10) | Hard way rolled=win, easy way or 7=lose |

**Craps Payouts:**

| Bet | Condition | Payout |
|-----|-----------|--------|
| PASS/COME | Win | 1:1 |
| DONT_PASS/DONT_COME | Win | 1:1 |
| FIELD | 2 or 12 | 2:1 |
| FIELD | 3,4,9,10,11 | 1:1 |
| YES 4/10 | Hit | 2:1 (true odds: 6/3) |
| YES 5/9 | Hit | 1.5:1 (true odds: 6/4) |
| YES 6/8 | Hit | 1.2:1 (true odds: 6/5) |
| NO 4/10 | 7 hits | 0.5:1 (true odds: 3/6) |
| NO 5/9 | 7 hits | 0.67:1 (true odds: 4/6) |
| NO 6/8 | 7 hits | 0.83:1 (true odds: 5/6) |
| NEXT 7 | Hit | 5:1 (6/36 prob) |
| NEXT 6/8 | Hit | 6.2:1 (5/36 prob) |
| NEXT 5/9 | Hit | 8:1 (4/36 prob) |
| NEXT 4/10 | Hit | 11:1 (3/36 prob) |
| NEXT 3/11 | Hit | 17:1 (2/36 prob) |
| NEXT 2/12 | Hit | 35:1 (1/36 prob) |
| HARDWAY 4/10 | Hit | 7:1 |
| HARDWAY 6/8 | Hit | 9:1 |
| Pass Odds 4/10 | Win | 2:1 |
| Pass Odds 5/9 | Win | 3:2 |
| Pass Odds 6/8 | Win | 6:5 |

**Ways to Roll Each Total (WAYS constant):**
```
2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1
```

**Enhanced Craps State Blob:**
```
[phase:u8] [mainPoint:u8] [d1:u8] [d2:u8] [betCount:u8] [bets:CrapsEntry×betCount]
```

**CrapsEntry (Enhanced):**
```
[betType:u8] [target:u8] [status:u8] [amount:u64 BE] [oddsAmount:u64 BE]
```
- `betType`: 0-8 per table above
- `target`: Number for YES/NO/NEXT/HARDWAY, or come point for COME/DONT_COME
- `status`: 0=ON, 1=PENDING (for COME/DONT_COME waiting to travel)
- `oddsAmount`: Free odds behind PASS/COME/DONT_PASS/DONT_COME

**Roll Processing Logic:**
1. Process single-roll bets first (FIELD, NEXT)
2. Process HARDWAY bets (check for 7 or easy way)
3. Process YES/NO bets (working bets only)
4. Process COME/DONT_COME:
   - PENDING bets: Act like come-out roll
   - ON bets: Check against their target point
5. Process PASS/DONT_PASS based on phase and main point
6. Update phase and main point if needed

#### HiLo (Accumulator-Based)

**Core Mechanics:**
- Player starts with initial bet as accumulator value
- Each correct guess multiplies the accumulator
- Player can cashout at any time to collect accumulator
- **Ties win** (inclusive comparison: HIGHER wins on ≥, LOWER wins on ≤)

**Card Ranks (for comparison):**
- A=1, 2=2, 3=3, ... J=11, Q=12, K=13

**Payout Calculation:**
```typescript
const calculatePayout = (wins: number, total: number) => {
    const prob = wins / total;
    const rawTotal = accumulator / prob;
    const profit = rawTotal - accumulator;
    const commission = profit * 0.02; // 2% house edge
    return Math.floor(accumulator + profit - commission);
};
```

**Super Mode HiLo (Streak Multipliers):**
| Streak Level | Base Multiplier |
|--------------|-----------------|
| 0-1 correct | 1.5x |
| 2-3 correct | 2.5x |
| 4+ correct | 4x |
| Ace Bonus | Additional 3x multiplier when current card is Ace |

#### Casino War
| Outcome | Payout |
|---------|--------|
| Player wins | 1:1 |
| War (tie) then win | 1:1 on original |
| War then tie | 2:1 bonus |
| Surrender on tie | Lose half bet |

---

### A.4 Modifier System (On-Chain)

The shield and double modifiers must be tracked and applied on-chain.

#### Player Struct Extension
```rust
pub struct Player {
    pub chips: u64,
    pub shields: u32,       // Max 3 per tournament
    pub doubles: u32,       // Max 3 per tournament
    pub rank: u32,
    pub name: String,
    pub active_shield: bool,  // Currently toggled on
    pub active_double: bool,  // Currently toggled on
}
```

#### New Instructions
```rust
// Tag 4 - Toggle Shield
// [4]
ToggleShield,

// Tag 5 - Toggle Double
// [5]
ToggleDouble,
```

#### Modifier Application Logic
In `process_move` for each game, after calculating outcome:
```rust
fn apply_modifiers(player: &mut Player, outcome: i64) -> i64 {
    let mut final_outcome = outcome;

    if outcome < 0 && player.active_shield && player.shields > 0 {
        player.shields -= 1;
        player.active_shield = false;
        final_outcome = 0; // Loss converted to break-even
    }

    if outcome > 0 && player.active_double && player.doubles > 0 {
        player.doubles -= 1;
        player.active_double = false;
        final_outcome = outcome * 2; // Win doubled
    }

    final_outcome
}
```

---

### A.5 Tournament System (On-Chain)

#### Tournament State
```rust
pub struct Tournament {
    pub id: u64,
    pub phase: TournamentPhase,
    pub start_block: u64,
    pub players: Vec<PublicKey>,
    pub starting_chips: u64,        // e.g., 10000
    pub starting_shields: u32,      // 3
    pub starting_doubles: u32,      // 3
}

#[repr(u8)]
pub enum TournamentPhase {
    Registration = 0,  // 1 minute (~20 blocks at 3s/block)
    Active = 1,        // 5 minutes (~100 blocks)
    Complete = 2,
}
```

#### Tournament Instructions
```rust
// Tag 6 - Join Tournament
// [6] [tournamentId:u64 BE]
JoinTournament(u64),

// Automatic via block height progression:
// - Registration ends at start_block + 20
// - Active ends at start_block + 120
// - Leaderboard calculated from chip counts
```

#### Tournament Events
```rust
pub enum Event {
    // ... existing events ...
    TournamentStarted { id: u64, start_block: u64 },
    PlayerJoined { tournament_id: u64, player: PublicKey },
    TournamentPhaseChanged { id: u64, phase: TournamentPhase },
    TournamentEnded { id: u64, rankings: Vec<(PublicKey, u64)> },
}
```

---

### A.6 Super Mode System (NEW)

Super Mode is a premium game mode that adds random multipliers to winning outcomes in exchange for a 20% fee on the bet amount.

#### Super Mode Types
```rust
#[derive(Clone, Debug)]
pub struct SuperMultiplier {
    pub id: String,           // Identifier (e.g., "K♠", "17", "♥")
    pub multiplier: u8,       // 2-500x depending on game
    pub mult_type: SuperType, // CARD, NUMBER, TOTAL, RANK, SUIT
}

#[repr(u8)]
pub enum SuperType {
    Card = 0,    // Specific card (rank+suit)
    Number = 1,  // Roulette/Craps number
    Total = 2,   // Sic Bo sum
    Rank = 3,    // Card rank only
    Suit = 4,    // Card suit only
}
```

#### Super Mode Fee
```rust
pub fn get_super_mode_fee(bet: u64) -> u64 {
    bet / 5  // 20% of bet
}
```

#### Game-Specific Super Modes

| Game | Super Name | Multiplier Count | Multiplier Range | Trigger |
|------|------------|------------------|------------------|---------|
| **Baccarat** | Lightning Baccarat | 1-5 cards | 2x-8x | Winning hand contains lightning card |
| **Roulette** | Quantum Roulette | 5-7 numbers | 50x-500x | Ball lands on quantum number |
| **Blackjack** | Strike Blackjack | 3 cards | 2x-10x | Winning hand contains strike card |
| **Craps** | Thunder Craps | 3 numbers (4-10) | 3x-25x | Pass line point hit matches thunder number |
| **Sic Bo** | Fortune Sic Bo | 3 totals (4-17) | 3x-50x | Sum matches fortune total |
| **Video Poker** | Mega Video Poker | 4 cards | 2x-5x | Winning hand contains mega card |
| **Three Card** | Flash Three Card | 2 suits | 2x | Player hand has 2+ of flash suit |
| **Ultimate Holdem** | Blitz UTH | 2 ranks | 2x | Best 5 contains blitz rank |
| **Casino War** | Strike War | 3 ranks | 3x | Player wins with strike rank |
| **HiLo** | Super HiLo | Streak-based | 1.5x-4x + Ace 3x | See HiLo section |

#### Multiplier Generation Logic (from gameUtils.ts)

**Lightning Baccarat:**
```typescript
const numCards = random() < 0.6 ? 1 : random() < 0.8 ? 2 : random() < 0.9 ? 3 : random() < 0.98 ? 4 : 5;
const mVal = random() < 0.35 ? 2 : random() < 0.65 ? 3 : random() < 0.85 ? 4 : random() < 0.95 ? 5 : 8;
```

**Quantum Roulette:**
```typescript
const count = randomInt(5, 7);
const mVal = roll < 0.35 ? 50 : roll < 0.65 ? 100 : roll < 0.83 ? 200 : roll < 0.93 ? 300 : roll < 0.98 ? 400 : 500;
// Note: Base straight payout reduced to 29:1 in Super Mode (from 35:1)
```

**Thunder Craps:**
```typescript
const opts = [4,5,6,8,9,10];  // 3 numbers selected
// 6/8 = 3x, 5/9 = 5x, 4/10 = 10x, rare (5%) = 25x
```

**Fortune Sic Bo:**
```typescript
// 3 totals from 4-17
// 10/11 = 3-5x, 7/8/13/14 = 5-10x, edges = 10-50x
```

#### Super Mode State Blob Extension
Add to GameSession state:
```
[...existing state...] [isSuperMode:u8] [multCount:u8] [mults:SuperEntry×multCount]
```

Each `SuperEntry`:
```
[id_len:u8] [id:utf8] [multiplier:u8] [type:u8]
```

#### Super Mode Instructions
```rust
// Tag 7 - Toggle Super Mode (before deal)
// [7]
ToggleSuperMode,
```

---

### A.7 Enhanced State Types (from reference types.ts)

#### Updated GameState Fields
```typescript
interface GameState {
  // ... existing fields ...

  // Super Mode
  isSuperMode: boolean;
  superState: {
    activeMultipliers: SuperMultiplier[];
    streakLevel?: number;  // For HiLo
  };

  // Three Card Poker
  threeCardBets: { ante: number, pairPlus: number, play: number };

  // Ultimate Texas Hold'em
  uthBets: { ante: number, blind: number, trips: number, play: number };
  uthPhase: 'PREFLOP' | 'FLOP' | 'RIVER' | 'RESULT';

  // Craps
  crapsInputMode: 'NONE' | 'YES' | 'NO' | 'NEXT' | 'HARDWAY';
  crapsUndoStack: CrapsBet[][];

  // Roulette/SicBo
  rouletteLastRoundBets: RouletteBet[];  // For rebet
  sicBoLastRoundBets: SicBoBet[];
  baccaratLastRoundBets: BaccaratBet[];
}
```

#### Updated CrapsBet Type
```typescript
interface CrapsBet {
  type: 'PASS' | 'DONT_PASS' | 'COME' | 'DONT_COME' | 'FIELD' | 'YES' | 'NO' | 'NEXT' | 'HARDWAY';
  amount: number;
  target?: number;      // Number for YES/NO/NEXT/HARDWAY, or come point
  oddsAmount?: number;  // Free odds amount
  status?: 'PENDING' | 'ON';  // COME/DONT_COME travel status
}
```

---

### A.8 Deterministic RNG Implementation

All randomness MUST derive from the consensus `Seed` to ensure verifiable fairness.

```rust
use commonware_cryptography::{Sha256, Hasher};

pub struct GameRng {
    state: [u8; 32],
}

impl GameRng {
    pub fn new(seed: &Seed, session_id: u64, move_number: u32) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(seed.as_bytes());
        hasher.update(&session_id.to_be_bytes());
        hasher.update(&move_number.to_be_bytes());
        Self { state: hasher.finalize() }
    }

    pub fn next_u8(&mut self) -> u8 {
        let result = self.state[0];
        let mut hasher = Sha256::new();
        hasher.update(&self.state);
        self.state = hasher.finalize();
        result
    }

    /// Returns card 0-51 without replacement from deck
    pub fn draw_card(&mut self, deck: &mut Vec<u8>) -> u8 {
        let idx = (self.next_u8() as usize) % deck.len();
        deck.swap_remove(idx)
    }

    /// Returns die roll 1-6
    pub fn roll_die(&mut self) -> u8 {
        (self.next_u8() % 6) + 1
    }

    /// Returns roulette number 0-36
    pub fn spin_roulette(&mut self) -> u8 {
        self.next_u8() % 37
    }
}
```

---

### A.7 Game Logic Modules

Each game should implement this trait:

```rust
pub trait CasinoGame {
    /// Initialize game state after StartGame
    fn init(session: &mut GameSession, rng: &mut GameRng);

    /// Process a player move, returns true if game over
    fn process_move(
        session: &mut GameSession,
        player: &mut Player,
        payload: &[u8],
        rng: &mut GameRng,
    ) -> Result<bool, GameError>;

    /// Calculate payout (positive = win, negative = loss)
    fn calculate_payout(session: &GameSession) -> i64;
}

pub enum GameError {
    InvalidPayload,
    InsufficientChips,
    InvalidMove,
    GameAlreadyComplete,
}
```

#### File Structure
```
execution/src/
├── lib.rs
├── layer.rs
├── casino/
│   ├── mod.rs           # Dispatcher + GameRng
│   ├── blackjack.rs     # ~200 lines
│   ├── hilo.rs          # ~100 lines
│   ├── baccarat.rs      # ~150 lines
│   ├── video_poker.rs   # ~250 lines
│   ├── three_card.rs    # ~180 lines
│   ├── ultimate.rs      # ~300 lines
│   ├── roulette.rs      # ~200 lines
│   ├── sic_bo.rs        # ~180 lines
│   ├── craps.rs         # ~300 lines
│   └── casino_war.rs    # ~80 lines
└── hand_eval.rs         # Poker hand evaluation utilities
```

---

### A.8 Hand Evaluation Utilities

Required for poker-based games:

```rust
pub mod hand_eval {
    #[derive(PartialEq, Eq, PartialOrd, Ord)]
    pub enum HandRank {
        HighCard(u8),
        OnePair(u8),
        TwoPair(u8, u8),
        ThreeOfAKind(u8),
        Straight(u8),
        Flush(u8),
        FullHouse(u8, u8),
        FourOfAKind(u8),
        StraightFlush(u8),
        RoyalFlush,
    }

    /// Evaluate best 5-card hand from any number of cards
    pub fn evaluate_hand(cards: &[u8]) -> HandRank;

    /// Blackjack hand value (handles aces)
    pub fn blackjack_value(cards: &[u8]) -> (u8, bool); // (value, is_soft)

    /// Baccarat hand value (sum mod 10)
    pub fn baccarat_value(cards: &[u8]) -> u8;

    /// Three-card poker ranking
    pub fn three_card_rank(cards: &[u8; 3]) -> HandRank;

    /// Card rank for HiLo (A=1, 2=2, ..., K=13)
    pub fn hilo_rank(card: u8) -> u8;
}
```

---

### A.9 Testing Strategy

#### Unit Tests (per game)
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_blackjack_natural_21() {
        let seed = create_test_seed(42);
        let mut session = create_session(GameType::Blackjack, 100);
        let mut player = create_player(1000);
        let mut rng = GameRng::new(&seed, session.id, 0);

        // Force deal: Ace + King
        session.state_blob = vec![2, 0, 12, 1, 25]; // pLen=2, A♠, K♠, dLen=1, hidden

        let payout = Blackjack::calculate_payout(&session);
        assert_eq!(payout, 150); // 1.5x bet
    }

    #[test]
    fn test_hilo_higher_correct() {
        // Test higher guess with lower current card
    }

    #[test]
    fn test_baccarat_banker_commission() {
        // Verify 5% commission on banker wins
    }

    #[test]
    fn test_serialization_compatibility() {
        // Hex from TypeScript: "02010000000000006400000000000001"
        let bytes = hex::decode("02010000000000006400000000000001").unwrap();
        let instruction = Instruction::deserialize(&bytes).unwrap();
        assert!(matches!(instruction, Instruction::StartGame {
            game_type: GameType::Blackjack,
            bet: 100,
            session_id: 1
        }));
    }
}
```

#### Integration Tests
```rust
#[tokio::test]
async fn test_full_blackjack_game() {
    let mut node = TestNode::new().await;

    // 1. Register player
    let player = node.register("Alice").await;
    assert_eq!(player.chips, 10000);

    // 2. Start blackjack
    let session = node.start_game(GameType::Blackjack, 100).await;
    assert!(session.state_blob.len() >= 4);

    // 3. Hit
    node.game_move(session.id, &[0]).await;

    // 4. Stand
    let result = node.game_move(session.id, &[1]).await;
    assert!(result.is_complete);

    // 5. Verify chips updated
    let player = node.get_player().await;
    assert!(player.chips != 10000); // Won or lost
}
```

---

### A.10 Frontend Utilities (gameUtils.ts)

Create `/website/src/utils/gameUtils.ts`:

```typescript
// Card utilities
export const createDeck = (): number[] =>
  Array.from({ length: 52 }, (_, i) => i);

export const cardToValue = (card: number): { suit: string; rank: string; value: number } => {
  const suits = ['♠', '♥', '♦', '♣'];
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  return {
    suit: suits[Math.floor(card / 13)],
    rank: ranks[card % 13],
    value: Math.min((card % 13) + 1, 10), // Face cards = 10
  };
};

// Blackjack
export const getHandValue = (cards: number[]): number => {
  let value = 0, aces = 0;
  for (const card of cards) {
    const rank = (card % 13) + 1;
    if (rank === 1) { aces++; value += 11; }
    else if (rank > 10) value += 10;
    else value += rank;
  }
  while (value > 21 && aces > 0) { value -= 10; aces--; }
  return value;
};

// Baccarat
export const getBaccaratValue = (cards: number[]): number =>
  cards.reduce((sum, c) => (sum + Math.min((c % 13) + 1, 10)) % 10, 0);

// Roulette
export const getRouletteColor = (num: number): 'RED' | 'BLACK' | 'GREEN' => {
  if (num === 0) return 'GREEN';
  const reds = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
  return reds.includes(num) ? 'RED' : 'BLACK';
};

// HiLo
export const getHiLoRank = (card: number): number => (card % 13) + 1; // 1-13

// Poker hand evaluation
export const evaluatePokerHand = (cards: number[]): { rank: string; multiplier: number } => {
  // Full poker hand evaluation implementation
  // Returns { rank: 'ROYAL_FLUSH', multiplier: 250 } etc.
};

// Formatting
export const formatTime = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

export const formatChips = (chips: number): string =>
  chips >= 1000 ? `${(chips / 1000).toFixed(1)}k` : chips.toString();
```

---

## Appendix B: Comprehensive Implementation Specifications

This appendix provides detailed, implementation-ready specifications synthesized from analysis of the current codebase and reference materials.

---

### B.1 Backend Phase 1 - COMPLETE ✅

#### Types Crate
- [x] Create casino types in `types/src/casino.rs` (Player, GameSession, GameType)
- [x] Implement binary serialization (Encode/Decode traits)

#### Execution Crate - Casino Module
- [x] Create `execution/src/casino/mod.rs` dispatcher
- [x] Implement GameRng from Seed (SHA256 hash chains, deterministic)
- [x] Implement `create_deck_excluding()` with bit-set optimization

#### Game Implementations (All 10 Games Complete)
- [x] Blackjack - 3:2 blackjack payout, hit/stand/double, dealer hits soft 17
- [x] HiLo - Higher/lower/cashout with running accumulator multiplier
- [x] Baccarat - Player/banker/tie bets, 5% banker commission, natural check
- [x] Video Poker (Jacks or Better) - Deal/draw with hold mask, 800x royal flush
- [x] Three Card Poker - Ante bonus, dealer qualification (Q-high), play/fold
- [x] Ultimate Texas Hold'em - Preflop/flop/river betting, blind bonus, dealer qualification
- [x] Roulette - 9 bet types, straight/red/black/odd/even/high/low/dozen/column
- [x] Sic Bo - 9 bet types, small/big/triple/double/total/single
- [x] Craps - Pass/don't pass, come out roll, point phase
- [x] Casino War - Deal, war on tie, surrender option

#### Security & Optimization Hardening
- [x] Add modifier system (shields/doubles) in `apply_modifiers()`
- [x] Fix integer overflow in HiLo accumulator (checked_mul/checked_div)
- [x] Fix integer overflow in Blackjack double down (checked_mul)
- [x] Add saturating arithmetic to all payout multiplications
- [x] Add bounds checking to state parsing (MAX_HAND_SIZE constants)
- [x] Change From<u8> to TryFrom<u8> for proper error handling
- [x] Optimize 7-card hand evaluation (stack-allocated, no heap allocs)
- [x] Optimize deck reconstruction with bit-set (O(n) vs O(n*m))
- [x] Optimize Video Poker hand evaluation (fixed arrays)
- [x] Clean up unused GameError variants

#### Testing
- [x] Unit tests for all games (122 casino tests passing)
- [x] Integration tests (14 tests covering full game flows)
- [x] Deterministic outcome verification
- [x] Total: 167 tests passing

---

### B.2 Layer Integration Specification (Priority 1)

#### B.2.1 Current Architecture Analysis

**Location:** `execution/src/lib.rs` (lines 335-1006)

**Current Layer::apply() Flow:**
```
Layer::apply(&mut self, transaction: &Transaction) -> Vec<Event>
  ├─ Gets account from state
  ├─ Matches on instruction type:
  │  ├─ Generate: Creates creature, emits Generated event
  │  ├─ Match: Adds to lobby or creates battles, emits Matched events
  │  ├─ Move: Stores encrypted move in battle, emits Locked event
  │  └─ Settle: Decrypts moves, resolves battle, emits Moved & Settled events
  └─ Returns Vec<Event> for output
```

**Key Characteristics:**
- Operates on pending state (BTreeMap<Key, Status>)
- Uses `self.get()` and `self.insert()` for state management
- Async/await pattern for I/O
- RNG seeded from `self.seed` (already available)

#### B.2.2 Types Extension (`types/src/execution.rs`)

**Instruction Enum (Tags 10-16 ALREADY DEFINED):**
```rust
pub enum Instruction {
    // Nullspace (0-3) - EXISTING
    Generate,
    Match,
    Move(Ciphertext<MinSig>),
    Settle(Signature),

    // Casino (10-16) - ALREADY DEFINED in execution.rs
    CasinoRegister { name: String },           // Tag 10
    CasinoDeposit { amount: u64 },             // Tag 11
    CasinoStartGame {
        game_type: crate::casino::GameType,
        bet: u64,
        session_id: u64
    },                                          // Tag 12
    CasinoGameMove { session_id: u64, payload: Vec<u8> }, // Tag 13
    CasinoToggleShield,                        // Tag 14
    CasinoToggleDouble,                        // Tag 15
    CasinoJoinTournament { tournament_id: u64 }, // Tag 16
}
```

**Key Enum (Tags 10-13 ALREADY DEFINED):**
```rust
pub enum Key {
    // Nullspace (0-3)
    Account(PublicKey),
    Lobby,
    Battle(Digest),
    Leaderboard,

    // Casino (10-13) - ALREADY DEFINED
    CasinoPlayer(PublicKey),      // Tag 10
    CasinoSession(u64),           // Tag 11
    CasinoLeaderboard,            // Tag 12
    Tournament(u64),              // Tag 13
}
```

**Value Enum (Tags 10-13 ALREADY DEFINED):**
```rust
pub enum Value {
    // Nullspace (0-4)
    Account(Account),
    Lobby { expiry: u64, players: BTreeSet<PublicKey> },
    Battle { ... },
    Commit { height: u64, start: u64 },
    Leaderboard(Leaderboard),

    // Casino (10-13) - ALREADY DEFINED
    CasinoPlayer(crate::casino::Player),           // Tag 10
    CasinoSession(crate::casino::GameSession),     // Tag 11
    CasinoLeaderboard(crate::casino::CasinoLeaderboard), // Tag 12
    Tournament(crate::casino::Tournament),         // Tag 13
}
```

**Event Enum - NEEDS EXTENSION (Add Tags 20-24):**
```rust
pub enum Event {
    // Nullspace (0-4) - EXISTING
    Generated { account: PublicKey, creature: Creature },
    Matched { battle: Digest, ... },
    Locked { battle: Digest, ... },
    Moved { battle: Digest, ... },
    Settled { battle: Digest, ... },

    // Casino events (tags 20-24) - ADD THESE
    CasinoPlayerRegistered {
        player: PublicKey,
        name: String
    },                                    // Tag 20

    CasinoGameStarted {
        session_id: u64,
        player: PublicKey,
        game_type: crate::casino::GameType,
        bet: u64,
        initial_state: Vec<u8>,
    },                                    // Tag 21

    CasinoGameMoved {
        session_id: u64,
        move_number: u32,
        new_state: Vec<u8>,
    },                                    // Tag 22

    CasinoGameCompleted {
        session_id: u64,
        player: PublicKey,
        game_type: crate::casino::GameType,
        payout: i64,
        final_chips: u64,
        was_shielded: bool,
        was_doubled: bool,
    },                                    // Tag 23

    CasinoLeaderboardUpdated {
        leaderboard: crate::casino::CasinoLeaderboard,
    },                                    // Tag 24
}
```

#### B.2.3 Layer Handler Methods

**Add to `impl<'a, S: State> Layer<'a, S>` in `execution/src/lib.rs`:**

```rust
// === Casino Register Handler ===
async fn handle_casino_register(
    &mut self,
    public: &PublicKey,
    name: &str
) -> Vec<Event> {
    // Check if player already exists
    if self.get(&Key::CasinoPlayer(public.clone())).await.is_some() {
        return vec![]; // Player already registered, no-op
    }

    // Create new player
    let player = crate::casino::Player::new(name.to_string());

    // Store in state
    self.insert(
        Key::CasinoPlayer(public.clone()),
        Value::CasinoPlayer(player.clone())
    );

    // Emit event
    vec![Event::CasinoPlayerRegistered {
        player: public.clone(),
        name: name.to_string(),
    }]
}

// === Casino Start Game Handler ===
async fn handle_casino_start_game(
    &mut self,
    public: &PublicKey,
    game_type: crate::casino::GameType,
    bet: u64,
    session_id: u64,
) -> Vec<Event> {
    // Get player
    let mut player = match self.get(&Key::CasinoPlayer(public.clone())).await {
        Some(Value::CasinoPlayer(p)) => p,
        _ => return vec![], // Player doesn't exist
    };

    // Check if already in a game
    if player.active_session.is_some() {
        return vec![]; // Already in game, no-op
    }

    // Check sufficient chips
    if player.chips < bet {
        return vec![]; // Insufficient chips, no-op
    }

    // Deduct bet
    player.chips = player.chips.saturating_sub(bet);

    // Create game session
    let mut session = crate::casino::GameSession {
        id: session_id,
        player: public.clone(),
        game_type,
        bet,
        state_blob: vec![],
        move_count: 0,
        created_at: self.seed.view,
        is_complete: false,
    };

    // Initialize game (some games deal immediately)
    let mut rng = crate::casino::GameRng::new(&self.seed, session_id, 0);
    crate::casino::init_game(&mut session, &mut rng);

    let initial_state = session.state_blob.clone();

    // Mark player as in game
    player.active_session = Some(session_id);

    // Store updates
    self.insert(
        Key::CasinoPlayer(public.clone()),
        Value::CasinoPlayer(player)
    );
    self.insert(
        Key::CasinoSession(session_id),
        Value::CasinoSession(session)
    );

    // Emit event
    vec![Event::CasinoGameStarted {
        session_id,
        player: public.clone(),
        game_type,
        bet,
        initial_state,
    }]
}

// === Casino Game Move Handler ===
async fn handle_casino_game_move(
    &mut self,
    public: &PublicKey,
    session_id: u64,
    payload: &[u8],
) -> Vec<Event> {
    // Get session
    let mut session = match self.get(&Key::CasinoSession(session_id)).await {
        Some(Value::CasinoSession(s)) => s,
        _ => return vec![], // Session doesn't exist
    };

    // Verify ownership
    if session.player != *public {
        return vec![]; // Not owner, no-op
    }

    // Check not already complete
    if session.is_complete {
        return vec![]; // Game already complete, no-op
    }

    // Get player
    let mut player = match self.get(&Key::CasinoPlayer(public.clone())).await {
        Some(Value::CasinoPlayer(p)) => p,
        _ => return vec![],
    };

    // Create RNG for this move
    let mut rng = crate::casino::GameRng::new(
        &self.seed,
        session_id,
        session.move_count
    );

    // Process the move
    let move_result = match crate::casino::process_game_move(
        &mut session,
        payload,
        &mut rng
    ) {
        Ok(result) => result,
        Err(_) => return vec![], // Invalid move, no-op
    };

    // Update move count
    session.move_count += 1;

    // Handle result
    let mut events = vec![Event::CasinoGameMoved {
        session_id,
        move_number: session.move_count,
        new_state: session.state_blob.clone(),
    }];

    match move_result {
        crate::casino::GameResult::Continue => {
            // Game continues, just update session
            self.insert(Key::CasinoSession(session_id), Value::CasinoSession(session));
            self.insert(Key::CasinoPlayer(public.clone()), Value::CasinoPlayer(player));
        }
        crate::casino::GameResult::Win(winnings) => {
            // Apply modifiers
            let (final_payout, was_shielded, was_doubled) =
                crate::casino::apply_modifiers(&mut player, winnings as i64);

            // Update chips
            player.chips = player.chips.saturating_add(final_payout as u64);

            // Mark game complete
            session.is_complete = true;
            player.active_session = None;

            // Emit completion event
            events.push(Event::CasinoGameCompleted {
                session_id,
                player: public.clone(),
                game_type: session.game_type,
                payout: final_payout,
                final_chips: player.chips,
                was_shielded,
                was_doubled,
            });

            // Update leaderboard
            self.update_casino_leaderboard(public, &player).await;

            // Store updates
            self.insert(Key::CasinoSession(session_id), Value::CasinoSession(session));
            self.insert(Key::CasinoPlayer(public.clone()), Value::CasinoPlayer(player));
        }
        crate::casino::GameResult::Loss => {
            // Apply shield modifier
            let (final_payout, was_shielded, _) =
                crate::casino::apply_modifiers(&mut player, -(session.bet as i64));

            // If shield applied, restore bet
            if was_shielded {
                player.chips = player.chips.saturating_add(session.bet);
            }

            // Mark game complete
            session.is_complete = true;
            player.active_session = None;

            // Emit completion event
            events.push(Event::CasinoGameCompleted {
                session_id,
                player: public.clone(),
                game_type: session.game_type,
                payout: final_payout,
                final_chips: player.chips,
                was_shielded,
                was_doubled: false,
            });

            // Update leaderboard
            self.update_casino_leaderboard(public, &player).await;

            // Store updates
            self.insert(Key::CasinoSession(session_id), Value::CasinoSession(session));
            self.insert(Key::CasinoPlayer(public.clone()), Value::CasinoPlayer(player));
        }
        crate::casino::GameResult::Push => {
            // Bet returned, return chips
            player.chips = player.chips.saturating_add(session.bet);
            session.is_complete = true;
            player.active_session = None;

            // Emit completion event
            events.push(Event::CasinoGameCompleted {
                session_id,
                player: public.clone(),
                game_type: session.game_type,
                payout: 0,
                final_chips: player.chips,
                was_shielded: false,
                was_doubled: false,
            });

            // Store updates
            self.insert(Key::CasinoSession(session_id), Value::CasinoSession(session));
            self.insert(Key::CasinoPlayer(public.clone()), Value::CasinoPlayer(player));
        }
    }

    events
}

// === Toggle Handlers ===
async fn handle_casino_toggle_shield(&mut self, public: &PublicKey) -> Vec<Event> {
    let mut player = match self.get(&Key::CasinoPlayer(public.clone())).await {
        Some(Value::CasinoPlayer(p)) => p,
        _ => return vec![],
    };

    // Can't toggle if already in game
    if player.active_session.is_some() { return vec![]; }

    // Toggle shield (only if shields available)
    if player.shields > 0 {
        player.active_shield = !player.active_shield;
        self.insert(Key::CasinoPlayer(public.clone()), Value::CasinoPlayer(player));
    }

    vec![] // No event for toggle (UI-driven state)
}

async fn handle_casino_toggle_double(&mut self, public: &PublicKey) -> Vec<Event> {
    let mut player = match self.get(&Key::CasinoPlayer(public.clone())).await {
        Some(Value::CasinoPlayer(p)) => p,
        _ => return vec![],
    };

    // Can't toggle if already in game
    if player.active_session.is_some() { return vec![]; }

    // Toggle double (only if doubles available)
    if player.doubles > 0 {
        player.active_double = !player.active_double;
        self.insert(Key::CasinoPlayer(public.clone()), Value::CasinoPlayer(player));
    }

    vec![] // No event for toggle (UI-driven state)
}

// === Helper: Update Leaderboard ===
async fn update_casino_leaderboard(&mut self, public: &PublicKey, player: &crate::casino::Player) {
    let mut leaderboard = match self.get(&Key::CasinoLeaderboard).await {
        Some(Value::CasinoLeaderboard(lb)) => lb,
        _ => crate::casino::CasinoLeaderboard::default(),
    };
    leaderboard.update(public.clone(), player.name.clone(), player.chips);
    self.insert(Key::CasinoLeaderboard, Value::CasinoLeaderboard(leaderboard));
}
```

#### B.2.4 Apply() Method Integration

**Add to match statement in `Layer::apply()` (after existing Settle case):**

```rust
async fn apply(&mut self, transaction: &Transaction) -> Vec<Event> {
    // ... existing account retrieval ...

    match &transaction.instruction {
        // ... existing Nullspace cases (Generate, Match, Move, Settle) ...

        // Casino instructions
        Instruction::CasinoRegister { name } => {
            return self.handle_casino_register(&transaction.public, name).await;
        }
        Instruction::CasinoDeposit { amount: _ } => {
            // Faucet logic - TBD
            return vec![];
        }
        Instruction::CasinoStartGame { game_type, bet, session_id } => {
            return self.handle_casino_start_game(
                &transaction.public,
                *game_type,
                *bet,
                *session_id
            ).await;
        }
        Instruction::CasinoGameMove { session_id, payload } => {
            return self.handle_casino_game_move(
                &transaction.public,
                *session_id,
                payload
            ).await;
        }
        Instruction::CasinoToggleShield => {
            return self.handle_casino_toggle_shield(&transaction.public).await;
        }
        Instruction::CasinoToggleDouble => {
            return self.handle_casino_toggle_double(&transaction.public).await;
        }
        Instruction::CasinoJoinTournament { tournament_id: _ } => {
            // Tournament logic - Priority 2
            return vec![];
        }
    }
}
```

#### B.2.5 Event Flow Diagram

```
CasinoRegister
    ↓
CasinoPlayerRegistered { player, name }

CasinoStartGame
    ├─→ CasinoGameStarted { session_id, player, game_type, bet, initial_state }
    └─→ (state stored)

CasinoGameMove (game continues)
    ├─→ CasinoGameMoved { session_id, move_number, new_state }
    └─→ (session updated)

CasinoGameMove (game ends - Win)
    ├─→ CasinoGameMoved { ... }
    ├─→ CasinoGameCompleted { payout > 0, was_shielded, was_doubled }
    └─→ CasinoLeaderboardUpdated { leaderboard }

CasinoGameMove (game ends - Loss)
    ├─→ CasinoGameMoved { ... }
    ├─→ CasinoGameCompleted { payout < 0, was_shielded }
    └─→ CasinoLeaderboardUpdated { leaderboard }

CasinoGameMove (game ends - Push)
    ├─→ CasinoGameMoved { ... }
    └─→ CasinoGameCompleted { payout = 0 }

ToggleShield / ToggleDouble
    └─→ (no events, state-only)
```

#### B.2.6 Error Handling Strategy

All handlers validate inputs and **silently no-op on errors**:

| Instruction | Validation | On Failure |
|-------------|------------|------------|
| CasinoRegister | Player exists? | No-op (already registered) |
| CasinoStartGame | Player exists? In game? chips >= bet? | No-op |
| CasinoGameMove | Session exists? Owner matches? Game complete? Payload valid? | No-op |
| ToggleShield/Double | Player exists? In game? Shields/Doubles > 0? | No-op |

**Frontend Implication:** No events = action failed. Frontend must implement optimistic updates with timeout/retry.

#### B.2.7 Implementation Checklist

- [ ] Add Event variants (tags 20-24) to `types/src/execution.rs`
- [ ] Implement Write/Read/EncodeSize for new Event variants
- [ ] Add `active_session: Option<u64>` to `types/src/casino.rs` Player struct
- [ ] Create handler methods in Layer impl block
- [ ] Add casino instruction match arms to `Layer::apply()`
- [ ] Wire imports (GameRng, process_game_move, apply_modifiers)
- [ ] Unit tests for each handler
- [ ] Integration test: register → start → moves → complete

---

### B.3 Super Mode Specification (Priority 3)

#### B.3.1 Type Definitions

**Add to `types/src/casino.rs`:**

```rust
/// Super mode multiplier type
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum SuperType {
    Card = 0,    // Specific card (rank+suit) - e.g., "K♠"
    Number = 1,  // Roulette/Craps number - e.g., "17"
    Total = 2,   // Sic Bo sum - e.g., "10"
    Rank = 3,    // Card rank only - e.g., "K"
    Suit = 4,    // Card suit only - e.g., "♥"
}

/// Super mode multiplier entry
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SuperMultiplier {
    pub id: u8,            // Card (0-51), number (0-36), or total (4-17)
    pub multiplier: u16,   // 2-500x
    pub super_type: SuperType,
}

/// Super mode state
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SuperModeState {
    pub is_active: bool,
    pub multipliers: Vec<SuperMultiplier>,
    pub streak_level: u8,  // For HiLo only
}
```

#### B.3.2 Fee Calculation

```rust
/// Calculate super mode fee (20% of bet)
pub fn get_super_mode_fee(bet: u64) -> u64 {
    bet / 5  // 20%
}
```

**Applied at game start:** When super mode enabled, deduct fee before dealing:
```rust
let effective_bet = if session.super_mode.is_active {
    let fee = get_super_mode_fee(bet);
    player.chips = player.chips.saturating_sub(fee);
    bet - fee
} else {
    bet
};
```

#### B.3.3 Multiplier Generation by Game

**Lightning Baccarat:**
```rust
fn generate_baccarat_multipliers(rng: &mut GameRng) -> Vec<SuperMultiplier> {
    // 1-5 cards based on probability
    let roll = rng.next_f32();
    let count = if roll < 0.6 { 1 }
        else if roll < 0.8 { 2 }
        else if roll < 0.9 { 3 }
        else if roll < 0.98 { 4 }
        else { 5 };

    let mut mults = Vec::with_capacity(count);
    let mut used_cards = 0u64;  // Bit set

    for _ in 0..count {
        // Pick unused card (0-51)
        let mut card;
        loop {
            card = rng.next_u8() % 52;
            if (used_cards & (1 << card)) == 0 {
                used_cards |= 1 << card;
                break;
            }
        }

        // Assign multiplier (2,3,4,5,8x with decreasing probability)
        let m_roll = rng.next_f32();
        let multiplier = if m_roll < 0.35 { 2 }
            else if m_roll < 0.65 { 3 }
            else if m_roll < 0.85 { 4 }
            else if m_roll < 0.95 { 5 }
            else { 8 };

        mults.push(SuperMultiplier {
            id: card,
            multiplier,
            super_type: SuperType::Card,
        });
    }
    mults
}
```

**Quantum Roulette:**
```rust
fn generate_roulette_multipliers(rng: &mut GameRng) -> Vec<SuperMultiplier> {
    // 5-7 numbers
    let count = 5 + (rng.next_u8() % 3) as usize;
    let mut mults = Vec::with_capacity(count);
    let mut used = 0u64;

    for _ in 0..count {
        // Pick unused number (0-36)
        let mut num;
        loop {
            num = rng.next_u8() % 37;
            if (used & (1 << num)) == 0 {
                used |= 1 << num;
                break;
            }
        }

        // Assign multiplier (50, 100, 200, 300, 400, 500x)
        let roll = rng.next_f32();
        let multiplier = if roll < 0.35 { 50 }
            else if roll < 0.65 { 100 }
            else if roll < 0.83 { 200 }
            else if roll < 0.93 { 300 }
            else if roll < 0.98 { 400 }
            else { 500 };

        mults.push(SuperMultiplier {
            id: num,
            multiplier,
            super_type: SuperType::Number,
        });
    }
    mults
}
// NOTE: Base straight payout reduced to 29:1 in Super Mode (from 35:1)
```

**Strike Blackjack:**
```rust
fn generate_blackjack_multipliers(rng: &mut GameRng) -> Vec<SuperMultiplier> {
    // 3 cards with 2-10x multipliers
    let mut mults = Vec::with_capacity(3);
    let mut used = 0u64;

    for _ in 0..3 {
        let mut card;
        loop {
            card = rng.next_u8() % 52;
            if (used & (1 << card)) == 0 {
                used |= 1 << card;
                break;
            }
        }

        let roll = rng.next_f32();
        let multiplier = if roll < 0.4 { 2 }
            else if roll < 0.7 { 3 }
            else if roll < 0.85 { 5 }
            else if roll < 0.95 { 7 }
            else { 10 };

        mults.push(SuperMultiplier {
            id: card,
            multiplier,
            super_type: SuperType::Card,
        });
    }
    mults
}
```

**Thunder Craps:**
```rust
fn generate_craps_multipliers(rng: &mut GameRng) -> Vec<SuperMultiplier> {
    // 3 numbers from [4,5,6,8,9,10]
    let opts = [4u8, 5, 6, 8, 9, 10];
    let mut indices = [0, 1, 2, 3, 4, 5];
    // Fisher-Yates shuffle first 3
    for i in 0..3 {
        let j = i + (rng.next_u8() as usize % (6 - i));
        indices.swap(i, j);
    }

    let mut mults = Vec::with_capacity(3);
    for i in 0..3 {
        let num = opts[indices[i]];
        let roll = rng.next_f32();

        // Multiplier based on point difficulty
        let multiplier = if roll < 0.05 {
            25  // Rare 5%
        } else {
            match num {
                6 | 8 => 3,   // Easy points
                5 | 9 => 5,   // Medium points
                4 | 10 => 10, // Hard points
                _ => 3,
            }
        };

        mults.push(SuperMultiplier {
            id: num,
            multiplier,
            super_type: SuperType::Number,
        });
    }
    mults
}
```

**Fortune Sic Bo:**
```rust
fn generate_sic_bo_multipliers(rng: &mut GameRng) -> Vec<SuperMultiplier> {
    // 3 totals from 4-17
    let mut mults = Vec::with_capacity(3);
    let mut used = 0u32;

    for _ in 0..3 {
        let mut total;
        loop {
            total = 4 + (rng.next_u8() % 14);  // 4-17
            if (used & (1 << total)) == 0 {
                used |= 1 << total;
                break;
            }
        }

        // Multiplier based on probability (center totals easier)
        let multiplier = match total {
            10 | 11 => 3 + (rng.next_u8() % 3) as u16,  // 3-5x
            7 | 8 | 13 | 14 => 5 + (rng.next_u8() % 6) as u16,  // 5-10x
            _ => 10 + (rng.next_u8() % 41) as u16,  // 10-50x (edges)
        };

        mults.push(SuperMultiplier {
            id: total,
            multiplier,
            super_type: SuperType::Total,
        });
    }
    mults
}
```

**Mega Video Poker:**
```rust
fn generate_video_poker_multipliers(rng: &mut GameRng) -> Vec<SuperMultiplier> {
    // 4 cards with 2-5x
    let mut mults = Vec::with_capacity(4);
    let mut used = 0u64;

    for _ in 0..4 {
        let mut card;
        loop {
            card = rng.next_u8() % 52;
            if (used & (1 << card)) == 0 {
                used |= 1 << card;
                break;
            }
        }

        let multiplier = 2 + (rng.next_u8() % 4) as u16;  // 2-5x
        mults.push(SuperMultiplier {
            id: card,
            multiplier,
            super_type: SuperType::Card,
        });
    }
    mults
}
```

**Flash Three Card Poker:**
```rust
fn generate_three_card_multipliers(rng: &mut GameRng) -> Vec<SuperMultiplier> {
    // 2 suits with 2x
    let suit1 = rng.next_u8() % 4;
    let mut suit2;
    loop {
        suit2 = rng.next_u8() % 4;
        if suit2 != suit1 { break; }
    }

    vec![
        SuperMultiplier { id: suit1, multiplier: 2, super_type: SuperType::Suit },
        SuperMultiplier { id: suit2, multiplier: 2, super_type: SuperType::Suit },
    ]
}
// Trigger: Player hand has 2+ cards of flash suit
```

**Blitz Ultimate Texas Hold'em:**
```rust
fn generate_uth_multipliers(rng: &mut GameRng) -> Vec<SuperMultiplier> {
    // 2 ranks with 2x
    let rank1 = rng.next_u8() % 13;
    let mut rank2;
    loop {
        rank2 = rng.next_u8() % 13;
        if rank2 != rank1 { break; }
    }

    vec![
        SuperMultiplier { id: rank1, multiplier: 2, super_type: SuperType::Rank },
        SuperMultiplier { id: rank2, multiplier: 2, super_type: SuperType::Rank },
    ]
}
// Trigger: Best 5-card hand contains blitz rank
```

**Strike Casino War:**
```rust
fn generate_casino_war_multipliers(rng: &mut GameRng) -> Vec<SuperMultiplier> {
    // 3 ranks with 3x
    let mut mults = Vec::with_capacity(3);
    let mut used = 0u16;

    for _ in 0..3 {
        let mut rank;
        loop {
            rank = rng.next_u8() % 13;
            if (used & (1 << rank)) == 0 {
                used |= 1 << rank;
                break;
            }
        }
        mults.push(SuperMultiplier {
            id: rank,
            multiplier: 3,
            super_type: SuperType::Rank,
        });
    }
    mults
}
// Trigger: Player wins with strike rank
```

**Super HiLo:**
```rust
fn generate_hilo_multipliers(streak: u8) -> SuperModeState {
    // Streak-based multipliers, no random generation
    let base_mult = match streak {
        0..=1 => 15,  // 1.5x (stored as 15 = 1.5 * 10)
        2..=3 => 25,  // 2.5x
        _ => 40,      // 4.0x
    };

    SuperModeState {
        is_active: true,
        multipliers: vec![],  // No random cards for HiLo
        streak_level: streak,
    }
}
// Additional 3x multiplier when current card is Ace
```

#### B.3.4 Multiplier Application

**For Card-based games:**
```rust
fn apply_super_multiplier_cards(
    winning_cards: &[u8],
    multipliers: &[SuperMultiplier],
    base_payout: u64
) -> u64 {
    let mut total_mult: u64 = 1;

    for card in winning_cards {
        for m in multipliers {
            let matches = match m.super_type {
                SuperType::Card => *card == m.id,
                SuperType::Rank => (*card % 13) == m.id,
                SuperType::Suit => (*card / 13) == m.id,
                _ => false,
            };
            if matches {
                total_mult = total_mult.saturating_mul(m.multiplier as u64);
            }
        }
    }

    base_payout.saturating_mul(total_mult)
}
```

**For Number-based games (Roulette):**
```rust
fn apply_super_multiplier_number(
    result: u8,
    multipliers: &[SuperMultiplier],
    base_payout: u64
) -> u64 {
    for m in multipliers {
        if m.super_type == SuperType::Number && m.id == result {
            return base_payout.saturating_mul(m.multiplier as u64);
        }
    }
    base_payout
}
```

**For Total-based games (Sic Bo):**
```rust
fn apply_super_multiplier_total(
    total: u8,
    multipliers: &[SuperMultiplier],
    base_payout: u64
) -> u64 {
    for m in multipliers {
        if m.super_type == SuperType::Total && m.id == total {
            return base_payout.saturating_mul(m.multiplier as u64);
        }
    }
    base_payout
}
```

#### B.3.5 State Blob Extension

Append to existing game state:
```
[...existing state...] [is_super:u8] [mult_count:u8] [mults:SuperEntry×count]
```

Each `SuperEntry`:
```
[id:u8] [multiplier:u16 BE] [type:u8]
```

#### B.3.6 Implementation Checklist

- [ ] Add SuperType, SuperMultiplier, SuperModeState to `types/src/casino.rs`
- [ ] Add `super_mode: SuperModeState` to GameSession
- [ ] Implement `generate_super_multipliers()` dispatcher
- [ ] Implement per-game multiplier generators (10 functions)
- [ ] Implement `apply_super_multiplier_*()` functions
- [ ] Add fee deduction in start_game handler
- [ ] Add ToggleSuperMode instruction handler
- [ ] Update state blob serialization
- [ ] Unit tests for multiplier generation and application

---

### B.4 Enhanced Craps Specification (Priority 4)

#### B.4.1 Complete BetType Enum

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum BetType {
    Pass = 0,       // Come-out: 7/11 win, 2/3/12 lose, else point
    DontPass = 1,   // Come-out: 2/3 win, 7/11 lose, 12 push
    Come = 2,       // Like PASS but during point phase
    DontCome = 3,   // Like DONT_PASS but during point phase
    Field = 4,      // Single roll: 2,12=2x, 3,4,9,10,11=1x
    Yes = 5,        // Place bet: target hits before 7
    No = 6,         // Lay bet: 7 hits before target
    Next = 7,       // Hop bet: exact total on next roll
    Hardway4 = 8,   // 2+2 before 7 or easy 4
    Hardway6 = 9,   // 3+3 before 7 or easy 6
    Hardway8 = 10,  // 4+4 before 7 or easy 8
    Hardway10 = 11, // 5+5 before 7 or easy 10
}

impl TryFrom<u8> for BetType {
    type Error = ();
    fn try_from(v: u8) -> Result<Self, ()> {
        match v {
            0 => Ok(BetType::Pass),
            1 => Ok(BetType::DontPass),
            2 => Ok(BetType::Come),
            3 => Ok(BetType::DontCome),
            4 => Ok(BetType::Field),
            5 => Ok(BetType::Yes),
            6 => Ok(BetType::No),
            7 => Ok(BetType::Next),
            8 => Ok(BetType::Hardway4),
            9 => Ok(BetType::Hardway6),
            10 => Ok(BetType::Hardway8),
            11 => Ok(BetType::Hardway10),
            _ => Err(()),
        }
    }
}
```

#### B.4.2 CrapsBet Struct

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum BetStatus {
    On = 0,       // Bet is working
    Pending = 1,  // Come/Don't Come waiting to travel
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrapsBet {
    pub bet_type: BetType,
    pub target: u8,         // Point for COME/YES/NO, number for NEXT/HARDWAY
    pub status: BetStatus,  // ON or PENDING
    pub amount: u64,
    pub odds_amount: u64,   // Free odds behind contract bets
}
```

#### B.4.3 State Blob Format

```
[phase:u8] [main_point:u8] [d1:u8] [d2:u8] [bet_count:u8] [bets:CrapsBetEntry×count]
```

Each `CrapsBetEntry`:
```
[bet_type:u8] [target:u8] [status:u8] [amount:u64 BE] [odds_amount:u64 BE]
```
= 1 + 1 + 1 + 8 + 8 = 19 bytes per bet

#### B.4.4 WAYS Constant

```rust
/// Number of ways to roll each total with 2d6
const WAYS: [u8; 13] = [0, 0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1];
//                      0  1  2  3  4  5  6  7  8  9 10 11 12

// Usage: probability of rolling N = WAYS[N] / 36
```

#### B.4.5 Payout Calculations

**Pass/Don't Pass/Come/Don't Come:**
```rust
fn calculate_pass_payout(bet: &CrapsBet, won: bool) -> i64 {
    if won {
        bet.amount as i64 + bet.odds_amount as i64  // 1:1 + odds
    } else {
        -(bet.amount as i64 + bet.odds_amount as i64)
    }
}
```

**True Odds Payouts:**
```rust
fn calculate_odds_payout(point: u8, odds_amount: u64, is_pass: bool) -> u64 {
    match point {
        4 | 10 => {
            if is_pass { odds_amount * 2 }  // 2:1
            else { odds_amount / 2 }         // 1:2
        }
        5 | 9 => {
            if is_pass { odds_amount * 3 / 2 }  // 3:2
            else { odds_amount * 2 / 3 }         // 2:3
        }
        6 | 8 => {
            if is_pass { odds_amount * 6 / 5 }  // 6:5
            else { odds_amount * 5 / 6 }         // 5:6
        }
        _ => 0,
    }
}
```

**Field Bet:**
```rust
fn calculate_field_payout(total: u8, amount: u64) -> i64 {
    match total {
        2 | 12 => (amount * 2) as i64,       // 2:1
        3 | 4 | 9 | 10 | 11 => amount as i64, // 1:1
        _ => -(amount as i64),                // 5,6,7,8 lose
    }
}
```

**YES (Place) Bet - with 1% commission:**
```rust
fn calculate_yes_payout(target: u8, amount: u64, hit: bool) -> i64 {
    if !hit { return -(amount as i64); }

    let true_odds = match target {
        4 | 10 => amount * 2,          // 6:3 = 2:1
        5 | 9 => amount * 3 / 2,       // 6:4 = 3:2
        6 | 8 => amount * 6 / 5,       // 6:5
        _ => amount,
    };

    // 1% commission on winnings
    let commission = true_odds / 100;
    (true_odds - commission) as i64
}
```

**NO (Lay) Bet - with 1% commission:**
```rust
fn calculate_no_payout(target: u8, amount: u64, seven_hit: bool) -> i64 {
    if !seven_hit { return -(amount as i64); }

    let true_odds = match target {
        4 | 10 => amount / 2,          // 3:6 = 1:2
        5 | 9 => amount * 2 / 3,       // 4:6 = 2:3
        6 | 8 => amount * 5 / 6,       // 5:6
        _ => amount,
    };

    // 1% commission
    let commission = true_odds / 100;
    (true_odds - commission) as i64
}
```

**NEXT (Hop) Bet:**
```rust
fn calculate_next_payout(target: u8, total: u8, amount: u64) -> i64 {
    if total != target { return -(amount as i64); }

    // Payout based on probability, 1% commission
    let ways = WAYS[target as usize];
    let multiplier = match ways {
        1 => 35,   // 2 or 12
        2 => 17,   // 3 or 11
        3 => 11,   // 4 or 10
        4 => 8,    // 5 or 9
        5 => 6,    // 6 or 8 (rounded from 6.2)
        6 => 5,    // 7
        _ => 1,
    };

    let winnings = amount * multiplier;
    let commission = winnings / 100;
    (winnings - commission) as i64
}
```

**Hardway Bets:**
```rust
fn calculate_hardway_payout(
    target: u8,
    d1: u8,
    d2: u8,
    total: u8,
    amount: u64
) -> Option<i64> {
    let is_hard = d1 == d2 && d1 * 2 == target;
    let is_easy = !is_hard && total == target;
    let is_seven = total == 7;

    if is_hard {
        // Win!
        let payout = match target {
            4 | 10 => amount * 7,  // 7:1
            6 | 8 => amount * 9,   // 9:1
            _ => amount,
        };
        Some(payout as i64)
    } else if is_easy || is_seven {
        // Lose
        Some(-(amount as i64))
    } else {
        // Still working
        None
    }
}
```

#### B.4.6 Roll Processing Order

```rust
fn process_roll(state: &mut CrapsState, d1: u8, d2: u8) -> Vec<BetResult> {
    let total = d1 + d2;
    let mut results = Vec::new();

    // 1. Single-roll bets (FIELD, NEXT) - always resolve
    for bet in &state.bets {
        if bet.bet_type == BetType::Field {
            results.push(BetResult {
                bet_idx: bet.idx,
                payout: calculate_field_payout(total, bet.amount),
                resolved: true,
            });
        }
        if bet.bet_type == BetType::Next {
            results.push(BetResult {
                bet_idx: bet.idx,
                payout: calculate_next_payout(bet.target, total, bet.amount),
                resolved: true,
            });
        }
    }

    // 2. HARDWAY bets (check for 7 or easy way)
    for bet in &state.bets {
        if matches!(bet.bet_type, BetType::Hardway4 | BetType::Hardway6 |
                                   BetType::Hardway8 | BetType::Hardway10) {
            let target = match bet.bet_type {
                BetType::Hardway4 => 4,
                BetType::Hardway6 => 6,
                BetType::Hardway8 => 8,
                BetType::Hardway10 => 10,
                _ => continue,
            };
            if let Some(payout) = calculate_hardway_payout(target, d1, d2, total, bet.amount) {
                results.push(BetResult {
                    bet_idx: bet.idx,
                    payout,
                    resolved: true,
                });
            }
        }
    }

    // 3. YES/NO bets (working bets only)
    for bet in &state.bets {
        if bet.status != BetStatus::On { continue; }

        match bet.bet_type {
            BetType::Yes => {
                if total == bet.target {
                    results.push(BetResult {
                        bet_idx: bet.idx,
                        payout: calculate_yes_payout(bet.target, bet.amount, true),
                        resolved: true,
                    });
                } else if total == 7 {
                    results.push(BetResult {
                        bet_idx: bet.idx,
                        payout: calculate_yes_payout(bet.target, bet.amount, false),
                        resolved: true,
                    });
                }
            }
            BetType::No => {
                if total == 7 {
                    results.push(BetResult {
                        bet_idx: bet.idx,
                        payout: calculate_no_payout(bet.target, bet.amount, true),
                        resolved: true,
                    });
                } else if total == bet.target {
                    results.push(BetResult {
                        bet_idx: bet.idx,
                        payout: calculate_no_payout(bet.target, bet.amount, false),
                        resolved: true,
                    });
                }
            }
            _ => {}
        }
    }

    // 4. COME/DONT_COME bets
    for bet in &mut state.bets {
        match (bet.bet_type, bet.status) {
            (BetType::Come, BetStatus::Pending) => {
                // Act like come-out roll
                match total {
                    7 | 11 => {
                        results.push(BetResult {
                            bet_idx: bet.idx,
                            payout: bet.amount as i64,
                            resolved: true,
                        });
                    }
                    2 | 3 | 12 => {
                        results.push(BetResult {
                            bet_idx: bet.idx,
                            payout: -(bet.amount as i64),
                            resolved: true,
                        });
                    }
                    _ => {
                        // Travel to point
                        bet.target = total;
                        bet.status = BetStatus::On;
                    }
                }
            }
            (BetType::Come, BetStatus::On) => {
                if total == bet.target {
                    // Win!
                    let odds_payout = calculate_odds_payout(bet.target, bet.odds_amount, true);
                    results.push(BetResult {
                        bet_idx: bet.idx,
                        payout: (bet.amount + bet.odds_amount + odds_payout) as i64,
                        resolved: true,
                    });
                } else if total == 7 {
                    // Lose
                    results.push(BetResult {
                        bet_idx: bet.idx,
                        payout: -((bet.amount + bet.odds_amount) as i64),
                        resolved: true,
                    });
                }
            }
            (BetType::DontCome, BetStatus::Pending) => {
                match total {
                    2 | 3 => {
                        results.push(BetResult {
                            bet_idx: bet.idx,
                            payout: bet.amount as i64,
                            resolved: true,
                        });
                    }
                    12 => {
                        // Push
                        results.push(BetResult {
                            bet_idx: bet.idx,
                            payout: 0,
                            resolved: true,
                        });
                    }
                    7 | 11 => {
                        results.push(BetResult {
                            bet_idx: bet.idx,
                            payout: -(bet.amount as i64),
                            resolved: true,
                        });
                    }
                    _ => {
                        bet.target = total;
                        bet.status = BetStatus::On;
                    }
                }
            }
            (BetType::DontCome, BetStatus::On) => {
                if total == 7 {
                    // Win!
                    let odds_payout = calculate_odds_payout(bet.target, bet.odds_amount, false);
                    results.push(BetResult {
                        bet_idx: bet.idx,
                        payout: (bet.amount + bet.odds_amount + odds_payout) as i64,
                        resolved: true,
                    });
                } else if total == bet.target {
                    results.push(BetResult {
                        bet_idx: bet.idx,
                        payout: -((bet.amount + bet.odds_amount) as i64),
                        resolved: true,
                    });
                }
            }
            _ => {}
        }
    }

    // 5. PASS/DONT_PASS
    process_pass_bets(state, total, &mut results);

    // 6. Update phase and main point
    update_phase(state, total);

    results
}
```

#### B.4.7 Implementation Checklist

- [ ] Extend BetType enum with all 12 variants
- [ ] Add BetStatus enum and CrapsBet struct
- [ ] Update state blob serialization (19 bytes per bet)
- [ ] Add WAYS constant
- [ ] Implement payout functions for all bet types
- [ ] Implement roll processing in correct order
- [ ] Handle COME/DONT_COME state transitions (PENDING→ON)
- [ ] Implement odds bet attachment
- [ ] Comprehensive unit tests for each bet type
- [ ] Integration test for complex multi-bet scenarios

---

### B.5 Frontend Integration Specification (Priority 5)

#### B.5.1 Instruction Serialization

**Binary format (all values Big Endian):**

```typescript
// Tag 10: CasinoRegister
function serializeCasinoRegister(name: string): Uint8Array {
    const encoder = new TextEncoder();
    const nameBytes = encoder.encode(name);
    const buf = new Uint8Array(1 + 4 + nameBytes.length);
    buf[0] = 10;  // Tag
    new DataView(buf.buffer).setUint32(1, nameBytes.length, false);
    buf.set(nameBytes, 5);
    return buf;
}

// Tag 11: CasinoDeposit
function serializeCasinoDeposit(amount: bigint): Uint8Array {
    const buf = new Uint8Array(1 + 8);
    buf[0] = 11;
    new DataView(buf.buffer).setBigUint64(1, amount, false);
    return buf;
}

// Tag 12: CasinoStartGame
function serializeCasinoStartGame(
    gameType: number,
    bet: bigint,
    sessionId: bigint
): Uint8Array {
    const buf = new Uint8Array(1 + 1 + 8 + 8);
    buf[0] = 12;
    buf[1] = gameType;
    const view = new DataView(buf.buffer);
    view.setBigUint64(2, bet, false);
    view.setBigUint64(10, sessionId, false);
    return buf;
}

// Tag 13: CasinoGameMove
function serializeCasinoGameMove(
    sessionId: bigint,
    payload: Uint8Array
): Uint8Array {
    const buf = new Uint8Array(1 + 8 + 4 + payload.length);
    buf[0] = 13;
    const view = new DataView(buf.buffer);
    view.setBigUint64(1, sessionId, false);
    view.setUint32(9, payload.length, false);
    buf.set(payload, 13);
    return buf;
}

// Tag 14: CasinoToggleShield
function serializeCasinoToggleShield(): Uint8Array {
    return new Uint8Array([14]);
}

// Tag 15: CasinoToggleDouble
function serializeCasinoToggleDouble(): Uint8Array {
    return new Uint8Array([15]);
}

// Tag 16: CasinoJoinTournament
function serializeCasinoJoinTournament(tournamentId: bigint): Uint8Array {
    const buf = new Uint8Array(1 + 8);
    buf[0] = 16;
    new DataView(buf.buffer).setBigUint64(1, tournamentId, false);
    return buf;
}
```

#### B.5.2 CasinoChainService Adapter

```typescript
// website/src/services/CasinoChainService.ts

import { NullspaceClient } from '../api/client';

export interface Player {
    chips: bigint;
    shields: number;
    doubles: number;
    activeShield: boolean;
    activeDouble: boolean;
    activeSession: bigint | null;
}

export interface GameSession {
    id: bigint;
    gameType: GameType;
    bet: bigint;
    stateBlob: Uint8Array;
    moveCount: number;
    isComplete: boolean;
}

export class CasinoChainService {
    private client: NullspaceClient;
    private sessionId: bigint = 0n;

    constructor(client: NullspaceClient) {
        this.client = client;
    }

    // Generate unique session ID
    private nextSessionId(): bigint {
        return ++this.sessionId;
    }

    // === Transaction Methods ===

    async register(name: string): Promise<void> {
        const instruction = serializeCasinoRegister(name);
        await this.client.submitTransaction(instruction);
    }

    async startGame(gameType: GameType, bet: bigint): Promise<bigint> {
        const sessionId = this.nextSessionId();
        const instruction = serializeCasinoStartGame(gameType, bet, sessionId);
        await this.client.submitTransaction(instruction);
        return sessionId;
    }

    async sendMove(sessionId: bigint, payload: Uint8Array): Promise<void> {
        const instruction = serializeCasinoGameMove(sessionId, payload);
        await this.client.submitTransaction(instruction);
    }

    async toggleShield(): Promise<void> {
        await this.client.submitTransaction(serializeCasinoToggleShield());
    }

    async toggleDouble(): Promise<void> {
        await this.client.submitTransaction(serializeCasinoToggleDouble());
    }

    // === Event Subscription ===

    onGameStarted(callback: (event: CasinoGameStartedEvent) => void): () => void {
        return this.client.subscribe('CasinoGameStarted', (data) => {
            callback(deserializeCasinoGameStarted(data));
        });
    }

    onGameMoved(callback: (event: CasinoGameMovedEvent) => void): () => void {
        return this.client.subscribe('CasinoGameMoved', (data) => {
            callback(deserializeCasinoGameMoved(data));
        });
    }

    onGameCompleted(callback: (event: CasinoGameCompletedEvent) => void): () => void {
        return this.client.subscribe('CasinoGameCompleted', (data) => {
            callback(deserializeCasinoGameCompleted(data));
        });
    }
}
```

#### B.5.3 useTerminalGame Hook Modifications

```typescript
// Key modifications to reference/supersociety/hooks/useTerminalGame.ts

// Replace local state management with chain service
const [chainService] = useState(() => new CasinoChainService(client));

// Replace immediate state updates with transaction + event flow
const startGame = async (gameType: GameType, bet: number) => {
    // Optimistic update
    setGameState(prev => ({ ...prev, stage: 'LOADING' }));

    try {
        const sessionId = await chainService.startGame(gameType, BigInt(bet));
        // State will update when CasinoGameStarted event arrives
    } catch (error) {
        // Revert optimistic update
        setGameState(prev => ({ ...prev, stage: 'BETTING' }));
        setMessage('Transaction failed');
    }
};

// Subscribe to chain events
useEffect(() => {
    const unsubGameStarted = chainService.onGameStarted((event) => {
        setGameState(prev => ({
            ...prev,
            type: event.gameType,
            stage: 'PLAYING',
            // Parse initial_state into game-specific fields
            ...parseGameState(event.gameType, event.initialState),
        }));
    });

    const unsubGameMoved = chainService.onGameMoved((event) => {
        setGameState(prev => ({
            ...prev,
            ...parseGameState(prev.type, event.newState),
        }));
    });

    const unsubGameCompleted = chainService.onGameCompleted((event) => {
        setGameState(prev => ({
            ...prev,
            stage: 'RESULT',
            lastResult: event.payout,
        }));
        setPlayerStats(prev => ({
            ...prev,
            chips: Number(event.finalChips),
        }));
    });

    return () => {
        unsubGameStarted();
        unsubGameMoved();
        unsubGameCompleted();
    };
}, [chainService]);
```

#### B.5.4 Error Handling & Retry Logic

```typescript
// Optimistic update pattern with timeout
async function sendMoveWithRetry(
    chainService: CasinoChainService,
    sessionId: bigint,
    payload: Uint8Array,
    maxRetries: number = 3,
    timeoutMs: number = 5000
): Promise<boolean> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            await chainService.sendMove(sessionId, payload);

            // Wait for confirmation event
            const confirmed = await waitForEvent(
                chainService,
                'CasinoGameMoved',
                (e) => e.sessionId === sessionId,
                timeoutMs
            );

            if (confirmed) return true;
        } catch (error) {
            console.error(`Move attempt ${attempt + 1} failed:`, error);
        }
    }
    return false;
}

// Event waiter utility
function waitForEvent<T>(
    service: CasinoChainService,
    eventType: string,
    predicate: (event: T) => boolean,
    timeoutMs: number
): Promise<T | null> {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(null), timeoutMs);

        const unsub = service.subscribe(eventType, (event: T) => {
            if (predicate(event)) {
                clearTimeout(timeout);
                unsub();
                resolve(event);
            }
        });
    });
}
```

#### B.5.5 Implementation Checklist

- [ ] Create `website/src/services/CasinoChainService.ts`
- [ ] Implement instruction serialization functions
- [ ] Implement event deserialization functions
- [ ] Modify `useTerminalGame.ts` for chain integration
- [ ] Add optimistic update pattern
- [ ] Add error handling and retry logic
- [ ] Create state parsing functions for each game type
- [ ] Add serialization unit tests
- [ ] Integration test with local node

### B.6 Frontend Rebuild Tasks (Phase 2)

#### Repository Structure

**Reference Source (Golden Record):** `reference/supersociety/`
- Cloned from https://github.com/happybigmtn/supersociety
- Contains complete frontend implementation with all game logic
- Use as source of truth when rebuilding frontend

**Current Website Structure:** `website/`
```
website/
├── src/
│   ├── api/
│   │   ├── client.js        # NullspaceClient (WebSocket, transactions)
│   │   ├── nonceManager.js  # Transaction nonce management
│   │   └── wasm.js          # WASM wrapper
│   ├── utils/
│   │   └── bip39.txt        # Wallet mnemonic wordlist
│   └── index.css            # Tailwind styles
├── wasm/
│   ├── Cargo.toml           # WASM crate config
│   └── src/lib.rs           # Rust→WASM bridge
├── test/
│   ├── client.test.js
│   └── nonceManager.test.js
├── vite.config.js
├── tailwind.config.js
├── tsconfig.json
├── package.json
└── index.html
```

#### Implementation Steps

**Step 1: Copy from Reference**
- [ ] Copy `reference/supersociety/types.ts` → `website/src/types.ts`
- [ ] Copy `reference/supersociety/utils/gameUtils.ts` → `website/src/utils/gameUtils.ts`
- [ ] Copy `reference/supersociety/hooks/` → `website/src/hooks/`
- [ ] Copy `reference/supersociety/components/` → `website/src/components/`
- [ ] Copy `reference/supersociety/services/` → `website/src/services/`
- [ ] Copy `reference/supersociety/App.tsx` → `website/src/App.tsx`

**Step 2: Implement CasinoChainService** (see B.5.2)
- [ ] Create `website/src/services/CasinoChainService.ts`
- [ ] Implement instruction serialization functions (see B.5.1)
- [ ] Implement event deserialization functions
- [ ] Add WebSocket event subscription

**Step 3: Modify useTerminalGame Hook** (see B.5.3)
- [ ] Replace local state with chain service calls
- [ ] Add event listeners for state updates
- [ ] Implement optimistic updates with rollback

**Step 4: WASM Integration** (optional)
- [ ] Expose casino game logic via WASM for client-side validation
- [ ] Add `hexToBytes`/`bytesToHex` utilities if needed

**Step 5: UI Polish**
- [ ] Add tournament join flow
- [ ] Add modifier toggle UI (shield/double buttons)
- [ ] Add leaderboard display
- [ ] Test all 10 games end-to-end

---

### B.7 Deployment Checklist (Phase 3)

- [ ] Local node testing with all games
- [ ] Testnet deployment
- [ ] Performance benchmarking (latency per game move)
- [ ] Security audit of RNG implementation
- [ ] Load testing with multiple concurrent players

---

## Progress Summary

| Phase | Status | Details |
|-------|--------|---------|
| Phase 1: Game Logic | ✅ Complete | All 10 games implemented with 186 tests |
| Phase 1: Security Hardening | ✅ Complete | Overflow protection, bounds checking, TryFrom |
| Phase 1: Performance | ✅ Complete | Heap allocation elimination, bit-set optimization |
| Phase 1: Layer Integration | ✅ Complete | 7 instructions, 5 events, 4 keys, handler methods, apply() integration |
| Phase 1: Tournament System | ✅ Complete | 4 events, phase transitions, join handlers |
| Phase 1: Super Mode | ✅ Complete | 10 multiplier generators, 3 apply functions, 13 tests |
| Phase 1: Enhanced Craps | ✅ Complete | 12 bet types, BetStatus, WAYS constant, 14 tests |
| Phase 2: Frontend Setup | ✅ Complete | Reference cloned, website cleaned, structure ready |
| Phase 2: Frontend Integration | ✅ Complete | CasinoChainService, serialization, event handlers |
| Phase 3: Deployment | ⏳ Not Started | Testing and benchmarking |

### Implementation Details (Completed)

**Layer Integration (Priority 1):**
- Instructions: CasinoRegister, CasinoDeposit, CasinoStartGame, CasinoGameMove, CasinoToggleShield, CasinoToggleDouble, CasinoJoinTournament (tags 10-16)
- Events: CasinoPlayerRegistered, CasinoGameStarted, CasinoGameMoved, CasinoGameCompleted, CasinoLeaderboardUpdated (tags 20-24)
- Keys: CasinoPlayer, CasinoSession, CasinoLeaderboard, Tournament (tags 10-13)
- Handler methods: handle_casino_register, handle_casino_start_game, handle_casino_game_move, handle_casino_toggle_shield, handle_casino_toggle_double, update_casino_leaderboard
- Files modified: `types/src/execution.rs`, `execution/src/lib.rs`, `simulator/src/lib.rs`, `website/wasm/src/lib.rs`

**Super Mode (Priority 3):**
- Types: SuperType enum (Card, Number, Total, Rank, Suit), SuperMultiplier struct, SuperModeState struct
- Generators: generate_baccarat_multipliers, generate_roulette_multipliers, generate_blackjack_multipliers, generate_craps_multipliers, generate_sic_bo_multipliers, generate_video_poker_multipliers, generate_three_card_multipliers, generate_uth_multipliers, generate_casino_war_multipliers, generate_hilo_state
- Application: apply_super_multiplier_cards, apply_super_multiplier_number, apply_super_multiplier_total
- File: `execution/src/casino/super_mode.rs` (NEW)

**Enhanced Craps (Priority 4):**
- BetType enum: Pass, DontPass, Come, DontCome, Field, Yes, No, Next, Hardway4, Hardway6, Hardway8, Hardway10
- BetStatus enum: On, Pending
- CrapsBet struct: 19-byte serialization (bet_type, target, status, amount, odds_amount)
- WAYS constant: [0, 0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1]
- Payout functions with 1% commission on Yes/No/Next
- File: `execution/src/casino/craps.rs` (REWRITTEN)

**Tournament System (Priority 2):**
- TournamentPhase enum: Registration, Active, Complete
- Tournament struct: id, phase, start_block, players, starting_chips/shields/doubles
- Events: TournamentStarted (tag 25), PlayerJoined (tag 26), TournamentPhaseChanged (tag 27), TournamentEnded (tag 28)
- Handlers: handle_casino_join_tournament, handle_casino_tick_tournament
- Block-based phase transitions: Registration→Active at +20 blocks, Active→Complete at +120 blocks
- Rankings calculated from player chip counts at tournament end
- Files: `types/src/execution.rs`, `execution/src/lib.rs`, `simulator/src/lib.rs`, `website/wasm/src/lib.rs`

**Frontend Integration (Priority 5):**
- CasinoChainService class with full instruction serialization (tags 10-16)
- Event deserialization for CasinoGameStarted, CasinoGameMoved, CasinoGameCompleted
- GameType enum matching Rust (10 games)
- Error handling with sendMoveWithRetry and waitForEvent utilities
- Player and GameSession interfaces
- Files: `website/src/services/CasinoChainService.ts`, `website/src/types/casino.ts`

---

## Next Steps (Execution Order)

### Priority 6: Deposit/Faucet System (NEXT)
**Files:** `execution/src/lib.rs`
**Status:** Stubbed (CasinoDeposit handler returns empty vec)

1. Implement faucet logic (dev mode only)
2. Add rate limiting to prevent abuse
3. Add initial chip grant on registration

---

## Key Logic from Reference (gameUtils.ts & useTerminalGame.ts)

### Hand Evaluation Functions (must match in Rust)

**Blackjack Hand Value:**
- Aces count as 11 unless it would bust (then 1)
- Face cards = 10

**Baccarat Hand Value:**
- 10/J/Q/K = 0, A = 1, others = face value
- Sum % 10

**Video Poker Evaluation:**
- Royal Flush = 10,J,Q,K,A of same suit → 800:1
- Wheel straight (A,2,3,4,5) is valid

**Three Card Poker Evaluation:**
- Rankings: SF > 3Kind > Straight > Flush > Pair > High
- Straight Flush: Ante Bonus 5:1, Pair Plus 40:1
- Three of a Kind: Ante Bonus 4:1, Pair Plus 30:1
- Straight: Ante Bonus 1:1, Pair Plus 6:1
- Flush: Pair Plus 3:1
- Pair: Pair Plus 1:1
- Dealer qualifies with Q-high or better

**Ultimate Texas Hold'em Evaluation:**
- Best 5 from 7 cards (2 player + 5 community)
- Dealer qualifies with pair or better
- Blind only pays on Straight or better

**HiLo Card Ranks:**
- A=1, 2-10=face, J=11, Q=12, K=13
- Ties win (inclusive comparison)