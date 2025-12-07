# Supersociety Battleware Integration Plan

## Objective
Migrate the `supersociety` frontend-only prototype to a fully decentralized application by forking `battleware` and replacing its game logic with `supersociety`'s casino games.

## Repository Setup
1.  **Fork:** Create `supersociety-battleware` from `battleware`.
2.  **Import:** Copy `supersociety` frontend code into `supersociety-battleware/website`.

## Phase 1: Backend Adaptation (The Chain)
We need to replace "Creature Battler" with "Decentralized Casino".

### 1. Types (`types` crate)
*   **Rename/Replace:** `battleware-types` -> `supersociety-types` (conceptually).
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
We need to hook the existing `supersociety` React UI to the `battleware` node.

### 1. API Client (`website/src/api`)
*   **Update `client.js`:**
    *   Update `submitTransaction` to serialize `StartGame` / `GameMove` actions correctly (matching `ChainService.ts` serialization).
    *   Ensure Ed25519 signing matches the backend expectation.

### 2. WASM (`website/wasm`)
*   **Updates:** If game logic verification is needed on client (e.g. "valid move?"), expose Rust game logic via WASM.
*   **Helpers:** Expose `hexToBytes` / `bytesToHex` if needed.

### 3. Service Layer
*   **Refactor `ChainService`:**
    *   Instead of `fetch`, use `BattlewareClient` (which handles connection/auth).
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
| Royal Flush | 250:1 |
| Straight Flush | 50:1 |
| Four of a Kind | 25:1 |
| Full House | 9:1 |
| Flush | 6:1 |
| Straight | 4:1 |
| Three of a Kind | 3:1 |
| Two Pair | 2:1 |
| Jacks or Better | 1:1 |

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
| Bet Type | Payout |
|----------|--------|
| Small (4-10) | 1:1 |
| Big (11-17) | 1:1 |
| Specific Triple | 150:1 |
| Any Triple | 24:1 |
| Sum of 4 or 17 | 50:1 |
| Sum of 5 or 16 | 18:1 |
| Sum of 6 or 15 | 14:1 |
| Sum of 7 or 14 | 12:1 |
| Sum of 8 or 13 | 8:1 |
| Sum of 9/10/11/12 | 6:1 |
| Double | 8:1 |
| Combo (two specific) | 5:1 |

#### Craps
| Bet Type | Payout |
|----------|--------|
| Pass/Come (win) | 1:1 |
| Don't Pass/Don't Come (win) | 1:1 |
| Field (3,4,9,10,11) | 1:1 |
| Field (2) | 2:1 |
| Field (12) | 3:1 |
| Pass Odds (4/10) | 2:1 |
| Pass Odds (5/9) | 3:2 |
| Pass Odds (6/8) | 6:5 |

#### HiLo Multipliers
Multiplier scales inversely with probability:
- A → 2: ~13x multiplier
- 2 → A: ~13x multiplier
- Middle cards: ~2x multiplier
- Formula: `multiplier = 13 / abs(currentRank - targetRank)`
- Accumulator tracks running total for cashout

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

### A.6 Deterministic RNG Implementation

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

## Appendix B: Migration Checklist

### Backend (Rust)
- [ ] Create `supersociety-types` crate with Player, GameSession, GameType
- [ ] Implement binary serialization matching frontend exactly
- [ ] Create `execution/src/casino/mod.rs` dispatcher
- [ ] Implement GameRng from Seed
- [ ] Implement hand_eval utilities
- [ ] Implement Blackjack game logic + tests
- [ ] Implement HiLo game logic + tests
- [ ] Implement Baccarat game logic + tests
- [ ] Implement Video Poker game logic + tests
- [ ] Implement Three Card Poker game logic + tests
- [ ] Implement Ultimate Texas Hold'em game logic + tests
- [ ] Implement Roulette game logic + tests
- [ ] Implement Sic Bo game logic + tests
- [ ] Implement Craps game logic + tests
- [ ] Implement Casino War game logic + tests
- [ ] Add modifier system (shields/doubles)
- [ ] Add tournament state management
- [ ] Add serialization compatibility tests
- [ ] Full integration tests

### Frontend (TypeScript)
- [ ] Create `utils/gameUtils.ts`
- [ ] Update ChainService to use battleware client
- [ ] Add toggle modifier instructions
- [ ] Add tournament join flow
- [ ] Connect polling to battleware events
- [ ] Test all 10 games end-to-end

### Deployment
- [ ] Local node testing with all games
- [ ] Testnet deployment
- [ ] Performance benchmarking (latency per game move)
- [ ] Security audit of RNG implementation