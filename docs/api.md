# Nullspace API & Bot Connectivity Plan

This document outlines the plan to make API connectivity a first-class citizen in the Nullspace ecosystem, enabling easy bot deployment and comprehensive testing.

## 1. Architecture Overview

The Nullspace architecture consists of three main layers relevant to API interaction:

1.  **Node (HTTP/WS):** Exposes public endpoints for submitting transactions and querying state.
2.  **Client (Rust SDK):** A wrapper around the Node's API that handles signing, serialization, and connection management.
3.  **Execution (Game Logic):** Processes moves and updates game state.

To support bots effectively, we will formalize the API surface and provide documentation for the binary payloads required by each game.

## 2. API Reference

### 2.1 HTTP Endpoints

*   **`POST /submit`**
    *   **Body:** Binary encoded `Submission` (Transactions, Seed, or Summary).
    *   **Purpose:** Submit signed transactions (e.g., game moves, registration).
    *   **Response:** 200 OK on success.

*   **`GET /state/{key}`**
    *   **Path:** `key` is the hex-encoded SHA256 hash of the requested `Key` (e.g., Account, CasinoSession).
    *   **Purpose:** Query the current state of a specific key.
    *   **Response:** Binary encoded `Lookup` struct containing the value and proof.

### 2.2 WebSocket Streams

*   **`GET /updates/{filter}`**
    *   **Path:** `filter` is the hex-encoded binary of `UpdatesFilter` (All or Account-specific).
    *   **Purpose:** Receive real-time updates on game events (e.g., GameStarted, GameMoved).
    *   **Message:** Binary encoded `Update` (Events or FilteredEvents).

*   **`GET /mempool`**
    *   **Purpose:** Monitor pending transactions (useful for arbitrage or MEV bots, though less relevant for standard gameplay).

## 3. Transaction Structure

Bots must sign and submit transactions using the `Instruction` enum.

```rust
pub struct Transaction {
    pub nonce: u64,
    pub instruction: Instruction,
    pub public: PublicKey,
    pub signature: Signature,
}
```

**Key Instructions for Bots:**

1.  **`CasinoRegister { name: String }`** - Register a new player.
2.  **`CasinoStartGame { game_type: u8, bet: u64, session_id: u64 }`** - Start a game.
3.  **`CasinoGameMove { session_id: u64, payload: Vec<u8> }`** - Submit a move.

### 4. Game Payload Schemas

This is the critical section for bot developers. Each game type requires a specific binary payload for its moves.

### 4.1 Baccarat (GameType = 0)
*   **Player Bet:** `[0x00]`
*   **Banker Bet:** `[0x01]`
*   **Tie Bet:** `[0x02]`

### 4.2 Blackjack (GameType = 1)
*   **Hit:** `[0x00]`
*   **Stand:** `[0x01]`
*   **Double:** `[0x02]`

### 4.3 Casino War (GameType = 2)
*   **Play (Initial):** `[0x00]`
*   **War (On Tie):** `[0x01]`
*   **Surrender (On Tie):** `[0x02]`

### 4.4 Craps (GameType = 3)
*   **Place Bet:** `[0x00, bet_type:u8, target:u8, amount:u64_BE]`
    *   *Bet Types:* 0=Pass, 1=DontPass, 2=Come, 3=DontCome, 4=Field, 5=Yes, 6=No, 7=Next, 8=Hard4, 9=Hard6, 10=Hard8, 11=Hard10.
*   **Add Odds:** `[0x01, amount:u64_BE]`
*   **Roll Dice:** `[0x02]`
*   **Clear Bets:** `[0x03]`

### 4.5 Video Poker (GameType = 4)
*   **Draw Cards:** `[hold_mask:u8]`
    *   *Hold Mask:* Bitmask of cards to keep (bit 0 = card 1, etc.). e.g., `0b00001` (1) holds 1st card.

### 4.6 HiLo (GameType = 5)
*   **Higher:** `[0x00]`
*   **Lower:** `[0x01]`
*   **Cashout:** `[0x02]`

### 4.7 Roulette (GameType = 6)
*   **Bet:** `[bet_type:u8, number:u8]`
    *   *Bet Types:* 0=Straight, 1=Red, 2=Black, 3=Even, 4=Odd, 5=Low, 6=High, 7=Dozen, 8=Column.
    *   *Number:* Used for Straight (0-36), Dozen (0-2), Column (0-2). Ignored for others.

### 4.8 Sic Bo (GameType = 7)
*   **Bet:** `[bet_type:u8, number:u8]`
    *   *Bet Types:* 0=Small, 1=Big, 2=Odd, 3=Even, 4=SpecificTriple, 5=AnyTriple, 6=SpecificDouble, 7=Total, 8=Single.

### 4.9 Three Card Poker (GameType = 8)
*   **Play:** `[0x00]`
*   **Fold:** `[0x01]`

### 4.10 Ultimate Hold'em (GameType = 9)
*   **Check:** `[0x00]`
*   **Bet 4x:** `[0x01]`
*   **Bet 2x:** `[0x02]`
*   **Bet 1x:** `[0x03]`
*   **Fold:** `[0x04]`

## 5. Bot Development Guide

### 5.1 Using the Rust Client (Recommended)

The easiest way to build a bot is using the provided `client` crate.

**Example: Simple HiLo Bot**

```rust
use nullspace_client::Client;
use nullspace_types::casino::GameType;
use nullspace_types::execution::Instruction;

async fn main() -> Result<()> {
    // 1. Initialize Client
    let (secret, identity) = load_identity(); // Implement key loading
    let client = Client::new("http://localhost:3000", identity);

    // 2. Start Game
    let session_id = 1; // Manage session IDs locally
    let start_tx = create_tx(&secret, nonce, Instruction::CasinoStartGame {
        game_type: GameType::HiLo,
        bet: 100,
        session_id,
    });
    client.submit_transactions(vec![start_tx]).await?;

    // 3. Listen for Updates
    let mut stream = client.connect_updates(UpdatesFilter::Account(identity)).await?;
    while let Some(update) = stream.next().await {
        if let Update::FilteredEvents(events) = update {
            // Parse events to see if it's our turn
            // logic here...
            
            // 4. Submit Move
            let move_tx = create_tx(&secret, nonce + 1, Instruction::CasinoGameMove {
                session_id,
                payload: vec![0], // Guess Higher
            });
            client.submit_transactions(vec![move_tx]).await?;
        }
    }
    Ok(())
}
```

### 5.2 Direct API (Advanced)

For non-Rust languages (Python, JS), developers must:
1.  Implement Ed25519 signing.
2.  Implement the binary serialization for `Transaction` and `Instruction` (using a library like `bincode` or manual struct packing matching the Rust `commonware_codec`).
3.  Use standard HTTP/WS libraries to communicate with the Node.

## 6. Action Items

1.  **Document All Game Payloads:** Audit all files in `execution/src/casino/` and complete the "Game Payload Schemas" section.
2.  **Create Bot Examples:** Add a `examples/bot` directory with a reference implementation of a bot that plays multiple games.
3.  **Generate OpenAPI/Swagger Spec:** (Optional) If we want to strictly support REST clients, we could generate an OpenAPI spec for the `submit` and `state` endpoints, though the binary bodies make this less standard.
4.  **SDK Generation:** Consider generating a TypeScript/Python SDK from the Rust types if demand exists.

## 7. Testing Strategy

*   **Integration Tests:** Use the bot API to run end-to-end tests for every game type in CI.
*   **Fuzzing:** Run random-move bots against the testnet to catch edge cases in game logic.
