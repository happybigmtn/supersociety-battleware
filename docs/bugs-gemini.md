**Bug Report: Frontend-Backend Integration Issues**

**1. Balance Updates & Game State Synchronization:**
    - **Issue:** Frontend display of user balances and game state is broken and stale.
    - **Details:**
        - The `useChainGame` hook uses `ChainService.ts`, which attempts to fetch data from non-existent endpoints: `${CHAIN_URL}/player/${publicKeyHex}` and `${CHAIN_URL}/session/${sessionId}`.
        - The backend (`simulator`) only exposes a low-level API: `/state/:query` (where query is a hex-encoded SHA256 hash of the storage key) and `/updates/:filter` (WebSocket).
        - Because of this 404 error on polling, the frontend defaults to initial state or fails to update after actions.
        - `CasinoChainService.ts` and `api/client.js` correctly implement the WASM-based key derivation and WebSocket subscriptions, but they are not being used by the main game hook (`useChainGame`).
    - **Fixes:**
        - Refactor `useChainGame.ts` to use `CasinoChainService` (or `CasinoClient`) instead of the broken `ChainService`.
        - Replace polling with the `onEvent` subscription model provided by `CasinoChainService` to receive real-time updates via WebSocket.
        - Ensure `CasinoChainService` handles the initial state fetch using `getCasinoPlayer` and `getCasinoSession` (which correctly wrap the `/state` query).

**2. Bot Leaderboard:**
    - **Issue:** Leaderboard is empty and never updates.
    - **Details:**
        - `useChainGame` initializes `leaderboard` state to `[]` and contains no logic to fetch or update it.
        - The backend (`types/src/casino.rs`) defines a `CasinoLeaderboard` struct, and `CasinoClient` has a `getCasinoLeaderboard` method.
        - The connection between the UI and the data source is completely missing.
    - **Fixes:**
        - Add a `fetchLeaderboard` function in `useChainGame` that calls `CasinoChainService.getLeaderboard()` (which needs to expose `client.getCasinoLeaderboard()`).
        - Poll the leaderboard periodically (e.g., every 10-30s) or listen for `CasinoLeaderboardUpdated` events if available (though polling is acceptable for a leaderboard).

**3. Game Logic & Execution:**
    - **Issue:** Game moves are flaky, and transaction construction is fragile.
    - **Details:**
        - `ChainService.ts` manually reconstructs the binary transaction format (serialization) in TypeScript. This is error-prone and duplicates the logic in `wasm/src/lib.rs`.
        - If the Rust struct layout changes, the TS code in `ChainService.ts` will break silently or produce invalid transactions.
        - `CasinoClient` correctly uses the WASM module to handle serialization.
    - **Fixes:**
        - Deprecate/Remove `ChainService.ts`.
        - Ensure all transaction submissions go through `CasinoChainService` -> `CasinoClient` -> `WasmWrapper`.
        - This ensures binary compatibility with the backend.

**4. Network & Configuration:**
    - **Issue:** Hardcoded URLs and missing error handling for network failures.
    - **Details:**
        - `ChainService.ts` hardcodes `http://127.0.0.1:8080`.
        - `client.js` has better logic to infer URLs but still defaults to relative paths which might fail in some dev setups (e.g., if frontend is on port 3000 and backend on 8080 without a proxy).
    - **Fixes:**
        - Standardize on a single configuration source for `CHAIN_URL`.
        - Ensure the Vite proxy (if used) is correctly configured to forward `/api` requests to the simulator, or strictly use the full URL from the environment config.

**Review Process:**
    - **Scope:** Frontend `website/src` and Backend `simulator`, `types`, `execution`.
    - **Methodology:** Static code analysis of service layers and API definitions.
    - **Deliverables:** This report and subsequent code fixes.
