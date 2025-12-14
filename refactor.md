# Rust Refactor Review (Nullspace Workspace)

## Project Context Needed (please answer)
- Workspace/crate layout: confirm which crates are production-critical vs dev-only (e.g., `nullspace-simulator`, `nullspace-wasm`, examples).
- Entrypoints and public APIs: list supported binaries and the stability expectations for public APIs (e.g., `nullspace-client::Client`, HTTP/WS endpoints, any CLI contracts).
- Known hotspots or correctness risks: point to code paths that are performance sensitive or have caused issues (state transitions, mempool, indexing, networking, proofs).

## Auto-Detected Workspace Layout (from `Cargo.toml`)
- Crates: `nullspace-node`, `nullspace-client`, `nullspace-execution`, `nullspace-simulator`, `nullspace-types`, `nullspace-wasm` (`website/wasm`).
- Binaries/entrypoints: `node/src/main.rs`, `simulator/src/main.rs`, `client/src/bin/dev_executor.rs`, `client/src/bin/stress_test.rs`.
- Examples: `client/examples/*.rs`, `simulator/examples/get_identity.rs`.

## Implementation Status (2025-12-14)

### Implemented (in this workspace)
- `types/src/execution.rs`: hardened codec reads (no panics), added `TRANSACTION_NAMESPACE`, preallocated `Transaction::payload`, unified casino bounds constants, centralized wire tag constants.
- `types/src/api.rs`: centralized proof bound constants; added `VerifyError` + `Result`-returning `verify` methods; allowed empty `Pending` lists.
- `types/src/token.rs`: removed custom hex helpers; bounded decode and JSON allowance preallocation to prevent OOM.
- `types/src/casino/mod.rs`: split into submodules (preserving encoding/public API) and simplified leaderboard update logic.
- `execution/src/state_transition.rs`: returns `anyhow::Result`, enforces state/events height invariant, removes `unwrap()` on storage operations.
- `execution/src/{lib.rs,state.rs,layer/mod.rs,layer/handlers/*}`: split execution into `state`/`layer`/`handlers` modules (preserving re-exports); `prepare` now returns `Result<_, PrepareError>` (typed nonce mismatch) and call sites handle/ignore errors explicitly.
- `execution/src/fixed.rs`: uses `i128` intermediates for `mul/div` overflow safety; guards division by zero; implements `Mul`/`Div` traits.
- `execution/src/casino/blackjack.rs`: fixed early-completion path to return `LossPreDeducted`/`Win` (no bogus extra deduction), factored shared payout computation, and added regression tests.
- `client/src/client.rs`: validates submission batch size; fixes WS filter shadowing/logging; adds `connect_*_with_capacity` and `join_hex_path` helpers; adds `RetryPolicy` for opt-in retry/backoff on transient HTTP failures.
- `client/src/consensus.rs`: removed URL `unwrap()` by propagating join errors; uses shared URL construction helper.
- `client/src/events.rs`: aborts background WS task on drop; uses bounded channel for backpressure; adds capacity-configurable constructors.
- `node/src/application/mempool.rs`: replaced `assert!` with `debug_assert!`, improved invariant messages, added stale-queue compaction, and plumbed mempool caps from config.
- `node/src/lib.rs`: adds `ValidatedConfig`/`ConfigError` and typed config parsing helpers (including mempool cap defaults/validation).
- `node/src/main.rs`: replaced panic-heavy config/peer parsing with `anyhow` errors and structured context; uses `ValidatedConfig` and shared peer key parsing; adds `--dry-run` validation mode.
- `node/src/seeder/ingress.rs`: adds `MailboxError` + `Result`-returning methods with shutdown-fast behavior; `deliver()` now fails closed on dropped/closed response.
- `node/src/tests.rs`: moved large node tests out of `node/src/lib.rs`.
- `simulator/src/lib.rs`: switched shared state to `tokio::sync::RwLock` (async); made `submit_*`/`query_*` methods async; gated insecure passkey endpoints behind the `passkeys` feature; uses `TRANSACTION_NAMESPACE` for signing.
- `simulator/src/main.rs`: switched to `anyhow::Result` and added decode/bind context.
- `website/wasm/src/lib.rs`: uses `TRANSACTION_NAMESPACE` for signing; removed unreachable match arm; centralized `Instruction` → string mapping; exports `InstructionKind` + `Transaction::{instruction_kind,instruction_name}` for stable JS bindings.
- `execution/src/casino/mod.rs`: implements `rand::RngCore` for `GameRng` (deterministic fuzz/testing integration).
- `execution/src/mocks.rs`: added `*_result` variants returning `anyhow::Result`; centralized test DB config constants; added deterministic codec round-trip tests.

### Validation
- `cargo fmt`
- `cargo clippy --workspace --all-targets` (warnings remain in unrelated modules/examples)
- `cargo test --workspace`

## Feynman Notes (Distributed Systems + Data Structures)

- A replicated node is like a ledger + receipt printer: `state` is the ledger, `events` are the receipts. If you update one without the other, different replicas can “remember” different histories. That’s why `execution/src/state_transition.rs` now refuses to advance state when event height disagrees (the system must move forward as one unit).
- Backpressure is your network’s “traffic law”: unbounded channels are like letting cars merge with no speed limit—eventually you get a pile-up (OOM / latency blowups). Switching the WS update stream to a bounded channel makes overload explicit and forces callers to either keep up or drop/slow down.
- A mempool is a scheduling problem, not a list problem: using per-account queues plus a dedupe set avoids O(n) scans and prevents one account from starving others. Periodic compaction is the garbage collector for “transactions that will never be valid again”.
- Wire formats are a tiny language: the `u8` tags are the grammar. Centralizing tag constants makes audits “read the dictionary once” instead of “re-derive meaning from many match arms”, which is especially important for consensus-critical encodings.
- “Never panic on untrusted bytes” is the distributed-systems equivalent of “never trust the network”: panic is a remote kill switch. Replacing `get_u8()` with `u8::read(reader)?` turns malformed inputs into ordinary errors instead of process aborts.
- Allocation patterns matter at scale: repeated `Vec` builds in sign/verify paths are like re-printing the same ID badge every time you enter the building. Preallocating payload capacity and using a constant namespace reduce churn in hot paths (and matter even more in WASM).

## types/src/execution.rs

### Summary
- Defines execution-layer wire types: `Transaction`, `Instruction`, `Key`, `Value`, `Event`, `Output`, `Progress`, plus hashing/signing helpers.
- Consensus-critical serialization shared across `node`, `client`, `simulator`, and `wasm`.

### Top Issues (ranked)
1. **`Read` implementations can panic on short buffers**
   - Impact: malformed/untrusted bytes can trigger a process abort (DoS) instead of returning a decode error.
   - Risk: high where decoded from network/user input.
   - Effort: low.
   - Location: `types/src/execution.rs:354` (`Instruction`), `types/src/execution.rs:816` (`Key`), `types/src/execution.rs:962` (`Value`), `types/src/execution.rs:1383` (`Event`) use `reader.get_u8()`.
2. **Repeated heap allocation in signing/verification path**
   - Impact: extra allocations per `sign()`/`verify()` due to `transaction_namespace()` returning `Vec<u8>` and `payload()` building a fresh `Vec<u8>`.
   - Risk: low (correctness), medium (throughput).
   - Effort: low–medium.
   - Location: `types/src/execution.rs:34` (`transaction_namespace`), `types/src/execution.rs:48` (`Transaction::payload`).
3. **Duplicate casino bounds constants**
   - Impact: diverging limits between instruction parsing and state types is a latent correctness risk.
   - Risk: medium.
   - Effort: low.
   - Location: `types/src/execution.rs:337` duplicates `types/src/casino/constants.rs` limits.

### Idiomatic Rust Improvements
- Replace `reader.get_u8()` with `u8::read(reader)?` so decoding never panics.
- Before:
```rust
let instruction = match reader.get_u8() {
    10 => { /* ... */ }
    i => return Err(Error::InvalidEnum(i)),
};
```
- After:
```rust
let tag = u8::read(reader)?;
let instruction = match tag {
    10 => { /* ... */ }
    i => return Err(Error::InvalidEnum(i)),
};
```
- Avoid allocating the transaction namespace for the default `NAMESPACE` by introducing a constant and using it at call sites.
- Before:
```rust
private.sign(Some(&transaction_namespace(NAMESPACE)), msg)
```
- After:
```rust
pub const TRANSACTION_NAMESPACE: &[u8] = b"_SUPERSOCIETY_TX";
private.sign(Some(TRANSACTION_NAMESPACE), msg)
```

### Data Structure & Algorithm Changes
- Rationale: remove panic-on-decode and cut allocation churn in hot paths.
- Complexity impact (before → after): same asymptotic complexity; fewer allocations and better robustness.

### Safety & Concurrency Notes
- Invariants: decoding `Instruction/Key/Value/Event` must be total (no panics) for any input bytes; only return `commonware_codec::Error`.
- Unsafe requirements (if any): none.
- Concurrency concerns: none directly (pure codec/data logic).

### Performance & Scaling Notes
- Likely hotspots: `Transaction::{sign,verify,verify_batch}` and any decode/encode in networking paths.
- Measurement suggestions: micro-benchmark sign/verify and count allocations (WASM especially).
- Proposed optimizations: precompute `TRANSACTION_NAMESPACE`; preallocate `Transaction::payload` capacity (low-risk).

### Refactor Plan
- Phase 1: low-risk cleanups
  - [x] Replace all `reader.get_u8()` in `Read` impls with `u8::read(reader)?`.
  - [x] Replace `CASINO_MAX_*` with `crate::casino::{MAX_NAME_LENGTH, MAX_PAYLOAD_LENGTH}`.
- Phase 2: structural improvements
  - [x] Add `TRANSACTION_NAMESPACE` const and update call sites across the workspace.
  - [x] Preallocate `Transaction::payload` via `EncodeSize` to reduce reallocations.
- Phase 3: optional larger redesigns
  - [x] Centralize tag values as `const`/`#[repr(u8)]` “tag enums” to improve auditability (consensus-sensitive).

### Open Questions
- Is this encoding already deployed in a live network (requiring backwards-compatible decoding), or can the whole network update in lockstep?

## types/src/api.rs

### Summary
- API-facing message types (`Submission`, `Update`, `Lookup`, `Summary`, proofs) and their verification logic.
- Primary wire protocol for HTTP + WS consumers.

### Top Issues (ranked)
1. **Verification APIs discard error details**
   - Impact: hard to distinguish signature failure vs proof failure vs range mismatch; weak observability.
   - Risk: medium.
   - Effort: medium.
   - Location: `types/src/api.rs:70`, `types/src/api.rs:168`, `types/src/api.rs:237`, `types/src/api.rs:306`.
2. **Magic constant `500` duplicated for proof limits**
   - Impact: changes are error-prone; bounds become inconsistent easily.
   - Risk: low–medium.
   - Effort: low.
   - Location: `types/src/api.rs:133`–`types/src/api.rs:136`, `types/src/api.rs:208`–`types/src/api.rs:209`, `types/src/api.rs:274`, `types/src/api.rs:348`–`types/src/api.rs:349`.
3. **`Pending` decoding rejects empty lists**
   - Impact: cannot represent “no pending txs” in-band; consumers rely on “no message”.
   - Risk: low.
   - Effort: low.
   - Location: `types/src/api.rs:528` uses `1..=MAX_SUBMISSION_TRANSACTIONS`.

### Idiomatic Rust Improvements
- Centralize proof bounds.
- Before:
```rust
let state_proof = Proof::read_cfg(reader, &500)?;
let state_proof_ops = Vec::read_range(reader, 0..=500)?;
```
- After:
```rust
const MAX_PROOF_NODES: usize = 500;
const MAX_PROOF_OPS: usize = 500;
let state_proof = Proof::read_cfg(reader, &MAX_PROOF_NODES)?;
let state_proof_ops = Vec::read_range(reader, 0..=MAX_PROOF_OPS)?;
```

### Data Structure & Algorithm Changes
- Rationale: make bounds auditable and verification debuggable.
- Complexity impact (before → after): no algorithmic change.

### Safety & Concurrency Notes
- Invariants: `verify()` methods must be pure and never panic; proofs must be checked against `Progress` ranges.
- Unsafe requirements (if any): none.
- Concurrency concerns: none.

### Performance & Scaling Notes
- Likely hotspots: `Summary::verify` and `FilteredEvents::verify` when op lists approach configured bounds.
- Measurement suggestions: benchmark worst-case proof sizes close to bounds.
- Proposed optimizations: return `Result<_, VerifyError>` instead of `bool/Option` (keep wrapper if API stability needed).

### Refactor Plan
- Phase 1: low-risk cleanups
  - [x] Replace duplicated `500` literals with constants.
- Phase 2: structural improvements
  - [x] Add `VerifyError` enum and convert `verify` methods to return `Result`.
- Phase 3: optional larger redesigns
  - [x] Revisit whether `Pending` should allow empty lists (behavior-changing).

### Open Questions
- Is the mempool stream expected to ever deliver an empty list, or is “no message” the protocol?

## types/src/token.rs

### Summary
- Token-related types (`TokenMetadata`, `TokenAccount`) with custom JSON (serde) and binary serialization.

### Top Issues (ranked)
1. **Potential OOM on decode due to unbounded pre-allocation**
   - Impact: attacker-controlled `allowance_count` can cause huge `Vec::with_capacity(...)` allocation.
   - Risk: high if decoded from untrusted input.
   - Effort: low.
   - Location: `types/src/token.rs:558`–`types/src/token.rs:565`.
2. **Custom hex codec duplicates workspace utilities and uses `unwrap()`**
   - Impact: unnecessary code + panic site; non-idiomatic.
   - Risk: low.
   - Effort: low.
   - Location: `types/src/token.rs:27`–`types/src/token.rs:35`.
3. **Allowances stored as `Vec` with linear scans**
   - Impact: `allowance()`/`set_allowance()` are `O(n)`.
   - Risk: medium if allowances grow.
   - Effort: medium (encoding-impacting if changed).
   - Location: `types/src/token.rs:301`–`types/src/token.rs:327`.

### Idiomatic Rust Improvements
- Replace custom hex helpers with `commonware_utils::{hex, from_hex}` and remove `unwrap()`.
- Before:
```rust
write!(&mut s, "{:02x}", b).unwrap();
```
- After:
```rust
let s = commonware_utils::hex(bytes);
```

### Data Structure & Algorithm Changes
- Rationale: avoid allocation-based DoS; reduce maintenance overhead.
- Complexity impact (before → after): bounded allocation; allowance lookup remains `O(n)` unless redesigned.

### Safety & Concurrency Notes
- Invariants: decoding must not allocate based solely on attacker-controlled lengths; validate against safe maxima and/or remaining buffer.
- Unsafe requirements (if any): none.
- Concurrency concerns: none.

### Performance & Scaling Notes
- Likely hotspots: allowance reads/writes if used frequently.
- Measurement suggestions: track typical allowance cardinalities.
- Proposed optimizations: cap preallocation and/or enforce a maximum allowance count in binary decoding (behavior change).

### Refactor Plan
- Phase 1: low-risk cleanups
  - [x] Remove `unwrap()` by switching to `commonware_utils::hex`.
  - [x] Replace `Vec::with_capacity(allowance_count as usize)` with a bounded strategy.
- Phase 2: structural improvements
  - [x] Align JSON deserialization constraints with binary constraints (avoid invalid states).
- Phase 3: optional larger redesigns
  - [ ] If allowances must scale: canonicalize (sorted) and migrate to a map (behavior-changing).

### Open Questions
- What is the intended maximum size for `TokenAccount::allowances` and is it persisted in consensus state?

## types/src/casino/mod.rs

### Summary
- Casino-domain state types (`Player`, `GameSession`, tournaments, leaderboards, house/vault/AMM state) and serialization helpers.
- Stored in consensus state as `Value::*`.

### Top Issues (ranked)
1. **Single large module mixes many concerns**
   - Impact: auditability and change isolation suffer.
   - Risk: medium.
   - Effort: medium.
   - Location: `types/src/casino/*` (module-wide).
2. **Linear scan tournament membership check**
   - Impact: `Tournament::contains_player` is `O(n)` up to 1000 entries.
   - Risk: medium.
   - Effort: medium (encoding impact if changed).
   - Location: `types/src/casino/tournament.rs`.
3. **Minor non-idiomatic patterns in leaderboard update**
   - Impact: readability.
   - Risk: low.
   - Effort: low.
   - Location: `types/src/casino/leaderboard.rs`.

### Idiomatic Rust Improvements
- Simplify leaderboard removal using `position`.
- Before:
```rust
let mut existing_idx = None;
for (i, e) in self.entries.iter().enumerate() {
    if e.player == player {
        existing_idx = Some(i);
        break;
    }
}
if let Some(idx) = existing_idx {
    self.entries.remove(idx);
}
```
- After:
```rust
if let Some(idx) = self.entries.iter().position(|e| e.player == player) {
    self.entries.remove(idx);
}
```

### Data Structure & Algorithm Changes
- Rationale: scalable membership checks without accidental consensus-breaking changes.
- Complexity impact (before → after): `O(n)` → `O(log n)` (sorted vec) or `O(1)` (set/map), but encoding implications must be handled.

### Safety & Concurrency Notes
- Invariants: on-chain encoding changes require coordinated rollouts/migrations.
- Unsafe requirements (if any): none.
- Concurrency concerns: none.

### Performance & Scaling Notes
- Likely hotspots: tournament join/contains; leaderboard updates under heavy churn.
- Measurement suggestions: instrument tournament join rate and `players.len()`.
- Proposed optimizations: prefer off-chain caches unless changing on-chain representation is acceptable.

### Refactor Plan
- Phase 1: low-risk cleanups
  - [x] Use shared constants for max name/payload lengths (avoid drift with `types/src/execution.rs`).
  - [x] Minor readability refactors in leaderboard update.
- Phase 2: structural improvements
  - [x] Split into submodules while preserving public API + encoding (`types/src/casino/{codec,constants,game,player,leaderboard,tournament,economy}.rs`).
- Phase 3: optional larger redesigns
  - [ ] Canonicalize/replace growing collections if tournaments become a hot path (behavior-changing).

### Open Questions
- Do tournaments routinely approach the 1000-player cap, and is join/contains on the critical path?

## execution/src/state_transition.rs

### Summary
- Executes a block’s state transition: applies transactions to state DB and appends outputs to events DB, producing roots/op counts and processed nonces.

### Top Issues (ranked)
1. **State/events height invariants are not enforced**
   - Impact: can commit state without committing events if DB heights drift; events may become unrecoverable.
   - Risk: high if partial failures are possible.
   - Effort: medium.
   - Location: `execution/src/state_transition.rs:80`–`execution/src/state_transition.rs:110`.
2. **`unwrap()` on storage operations in a production path**
   - Impact: transient storage failures become panics.
   - Risk: medium.
   - Effort: low–medium.
   - Location: `execution/src/state_transition.rs:96`, `execution/src/state_transition.rs:104`, `execution/src/state_transition.rs:115`.
3. **Invalid height is silently ignored**
   - Impact: callers may not realize a block was skipped.
   - Risk: medium.
   - Effort: medium.
   - Location: `execution/src/state_transition.rs:53`–`execution/src/state_transition.rs:72`.

### Idiomatic Rust Improvements
- Propagate errors instead of panicking; return explicit outcomes for invalid heights.
- Before:
```rust
events.append(output).await.unwrap();
```
- After:
```rust
events.append(output).await?;
```

### Data Structure & Algorithm Changes
- Rationale: correctness depends on state and events advancing atomically.
- Complexity impact (before → after): none.

### Safety & Concurrency Notes
- Invariants:
  - `state_height == events_height` at entry (or a defined catch-up strategy exists).
  - Either both DBs commit height `h`, or neither does.
- Unsafe requirements (if any): none.
- Concurrency/cancellation concerns: cancellation mid-flight can leave DBs inconsistent unless guarded.

### Performance & Scaling Notes
- Likely hotspots: DB commit/sync and transaction execution.
- Measurement suggestions: record execution time and op counts per block.
- Proposed optimizations: batching where supported; avoid redundant `root()` computation when skipping.

### Refactor Plan
- Phase 1: low-risk cleanups
  - [x] Replace `unwrap()` with error propagation or structured warnings + early return.
- Phase 2: structural improvements
  - [x] Enforce `state_height == events_height` invariant; refuse to advance state alone.
  - [x] Change return type to `anyhow::Result<StateTransitionResult>` (API change; now returns `Err` on invariant violations).
- Phase 3: optional larger redesigns
  - [ ] Add an atomic “block execution transaction” abstraction to make partial commits impossible.

### Open Questions
- Can `state` and `events` heights diverge in production (e.g., after a crash), and what is the intended recovery behavior?

## execution/src/fixed.rs

### Summary
- Small fixed-point `Decimal` type (scale = 10,000) with unit tests.

### Top Issues (ranked)
1. **Overflow and division-by-zero are unchecked**
   - Impact: `mul/div/from_frac/div_int` can panic or overflow depending on inputs.
   - Risk: medium.
   - Effort: low–medium.
   - Location: `execution/src/fixed.rs:22`, `execution/src/fixed.rs:49`, `execution/src/fixed.rs:54`, `execution/src/fixed.rs:59`.
2. **Currently unused within `nullspace-execution`**
   - Impact: dead code adds maintenance burden; semantics can drift.
   - Risk: low.
   - Effort: low.
   - Location: `execution/src/fixed.rs` (crate warnings show `Decimal` and constants unused).

### Idiomatic Rust Improvements
- Use `i128` intermediates to avoid i64 overflow.
- Before:
```rust
pub fn mul(self, other: Self) -> Self {
    Decimal((self.0 * other.0) / SCALE as i64)
}
```
- After:
```rust
pub fn mul(self, other: Self) -> Self {
    let scaled = (self.0 as i128) * (other.0 as i128);
    Decimal((scaled / SCALE as i128) as i64)
}
```

### Data Structure & Algorithm Changes
- Rationale: arithmetic used in financial logic must be overflow-safe and non-panicking.
- Complexity impact (before → after): none.

### Safety & Concurrency Notes
- Invariants: denominators must be non-zero; if that cannot be guaranteed, return `Result/Option` instead of panicking (behavior-changing).
- Unsafe requirements (if any): none.
- Concurrency concerns: none.

### Performance & Scaling Notes
- Likely hotspots: AMM/vault computations if `Decimal` is used there.
- Measurement suggestions: micro-bench mul/div loops; WASM performance if used in frontend.
- Proposed optimizations: prefer checked math; inline small helpers if profiling shows benefit.

### Refactor Plan
- Phase 1: low-risk cleanups
  - [x] Switch to i128 intermediates.
  - [x] Guard against zero denominators.
- Phase 2: structural improvements
  - [x] Implement `Mul`/`Div` traits for more idiomatic use.
- Phase 3: optional larger redesigns
  - [ ] Consider a well-tested fixed-point crate if requirements grow (tradeoff: dependency footprint vs correctness).

### Open Questions
- Is `Decimal` used in consensus-critical execution paths with attacker-controlled inputs, or only in internal tooling?

## execution/src/lib.rs

### Summary
- Core execution engine: defines `State`, in-memory state, `Layer` executor, and a large set of handlers for casino + staking + vault + AMM instructions.
- Central to block execution and therefore consensus correctness and performance.

### Top Issues (ranked)
1. **Overgrown module combines many domains**
   - Impact: difficult to audit; regressions are easier.
   - Risk: high.
   - Effort: medium–high.
   - Location: `execution/src/lib.rs` (2,425 LOC).
2. **Unused / placeholder precomputation pipeline**
   - Impact: complexity + warnings; implies verification caching isn’t exercised.
   - Risk: low today, medium long-term.
   - Effort: low.
   - Location: `execution/src/lib.rs:211`–`execution/src/lib.rs:216`, `execution/src/lib.rs:2252`, `execution/src/lib.rs:251`–`execution/src/lib.rs:252`.
3. **Nonce/account lookup logic is duplicated**
   - Impact: drift risk across `nonce()`, `Noncer::prepare`, `Layer::prepare`.
   - Risk: medium.
   - Effort: medium.
   - Location: `execution/src/lib.rs:129`, `execution/src/lib.rs:165`, `execution/src/lib.rs:294`.

### Idiomatic Rust Improvements
- Remove unused scaffolding and simplify obvious irrefutable patterns.
- Before:
```rust
if let Task::Seed(_) = op {
    seed_ops.insert(op);
}
```
- After:
```rust
seed_ops.insert(op);
```

### Data Structure & Algorithm Changes
- Rationale: reduce surface area for consensus-critical logic.
- Complexity impact (before → after): none (structural simplification).

### Safety & Concurrency Notes
- Invariants:
  - Pending writes must be deterministic (`BTreeMap` helps).
  - Arithmetic must be overflow-safe and consistent across platforms.
- Unsafe requirements (if any): none visible.
- Concurrency concerns: `parallel` precomputations must remain pure.

### Performance & Scaling Notes
- Likely hotspots: `Layer::execute` filtering/dispatch; cloning large `Value` variants.
- Measurement suggestions: `tracing` spans around `prepare/apply` and per-instruction handlers; track allocations per block.
- Proposed optimizations: load player/session once per tx and write back once to reduce clones.

### Refactor Plan
- Phase 1: low-risk cleanups
  - [x] Remove unused `verified_seeds` and unused `Task` scaffolding until required.
  - [x] Factor shared nonce update helper.
- Phase 2: structural improvements
  - [x] Split into modules (`state`, `layer`, `handlers/*`) and re-export from `lib.rs` to preserve API.
- Phase 3: optional larger redesigns
  - [x] Replace bool-returning “prepare” with typed errors surfaced to callers (behavior-visible).

### Open Questions
- Which instructions are production vs dev-only (e.g., faucet-like deposit), and should any be gated behind features?

## simulator/src/lib.rs

### Summary
- Local simulator with Axum HTTP/WS API, in-memory state, proof construction, explorer views, and a passkey-like signing flow.

### Top Issues (ranked)
1. **Blocking `std::sync::RwLock` used inside async handlers**
   - Impact: can block Tokio worker threads and increase tail latency.
   - Risk: medium–high beyond strictly-local use.
   - Effort: medium.
   - Location: `simulator/src/lib.rs:142` and widespread `.read()`/`.write()`.
2. **Passkey endpoints are insecure and store raw private key bytes**
   - Impact: auth is essentially bearer-token only; private key material stored as `Vec<u8>`.
   - Risk: high if exposed beyond local dev.
   - Effort: medium–high.
   - Location: `simulator/src/lib.rs:103`, `simulator/src/lib.rs:990`–`simulator/src/lib.rs:1170`.
3. **Unbounded in-memory growth**
   - Impact: long-running simulator can OOM.
   - Risk: medium.
   - Effort: medium.
   - Location: `simulator/src/lib.rs` state maps (`State`, `ExplorerState`, `PasskeyStore`).

### Idiomatic Rust Improvements
- Prefer `tokio::sync::RwLock` for async contexts.
- Before:
```rust
state: Arc<RwLock<State>>,
```
- After:
```rust
state: Arc<tokio::sync::RwLock<State>>,
```

### Data Structure & Algorithm Changes
- Rationale: keep simulator responsive; reduce risk if accidentally exposed.
- Complexity impact (before → after): none.

### Safety & Concurrency Notes
- Invariants: never hold locks across `.await`; audit carefully if switching to `tokio::sync::RwLock`.
- Unsafe requirements (if any): none.
- Concurrency concerns: WS fanout can drop messages; clients must tolerate missed updates.

### Performance & Scaling Notes
- Likely hotspots: proof filtering that scans ops; explorer indexing.
- Measurement suggestions: `tracing` spans per endpoint; lock hold times; WS message rates.
- Proposed optimizations: retention limits; offload heavy work to `spawn_blocking`.

### Refactor Plan
- Phase 1: low-risk cleanups
  - [x] Treat poisoned lock errors as `500` (internal error) not `None`/`404`.
  - [x] Avoid repeated allocations of `transaction_namespace(NAMESPACE)` when signing (use constant namespace).
- Phase 2: structural improvements
  - [x] Switch to `tokio::sync::RwLock` and audit lock usage (API change: `submit_*`/`query_*` are now `async fn`).
  - [x] Gate passkey endpoints behind a feature flag or mark dev-only clearly (`nullspace-simulator` feature `passkeys`, default off).
- Phase 3: optional larger redesigns
  - [ ] Implement real WebAuthn verification and avoid storing private key material in plaintext if multi-user.

### Open Questions
- Is `nullspace-simulator` strictly local/dev tooling, or is it ever deployed in a security-sensitive context?

## simulator/src/main.rs

### Summary
- CLI entrypoint starting the simulator server with a provided network identity.

### Top Issues (ranked)
1. **Errors are erased (`Box<dyn Error>`)**
   - Impact: loss of context vs workspace’s `anyhow/thiserror` pattern.
   - Risk: low.
   - Effort: low.
   - Location: `simulator/src/main.rs:13`–`simulator/src/main.rs:55`.

### Idiomatic Rust Improvements
- Use `anyhow::Result<()>` for context-rich errors.
- Before:
```rust
async fn main() -> Result<(), Box<dyn std::error::Error>> { /* ... */ }
```
- After:
```rust
async fn main() -> anyhow::Result<()> { /* ... */ }
```

### Data Structure & Algorithm Changes
- Rationale: better debuggability; no algorithmic change.
- Complexity impact (before → after): none.

### Safety & Concurrency Notes
- Invariants: none.
- Unsafe requirements (if any): none.
- Concurrency concerns: none.

### Performance & Scaling Notes
- Likely hotspots: none.
- Measurement suggestions: none.
- Proposed optimizations: none.

### Refactor Plan
- Phase 1: low-risk cleanups
  - [x] Switch to `anyhow::Result` and add `Context` to hex decoding failures.
- Phase 2: structural improvements
  - None.
- Phase 3: optional larger redesigns
  - None.

### Open Questions
- None.

## client/src/client.rs

### Summary
- HTTP + WebSocket client for submitting data and subscribing to updates/mempool streams.

### Top Issues (ranked)
1. **Variable shadowing in `connect_updates` harms logs**
   - Impact: logs show encoded filter but label it as `filter`, obscuring the semantic filter.
   - Risk: low.
   - Effort: low.
   - Location: `client/src/client.rs:96`–`client/src/client.rs:112`.
2. **Missing client-side submission size checks**
   - Impact: can send oversized transaction batches that will be rejected; wasted bandwidth.
   - Risk: low.
   - Effort: low.
   - Location: `client/src/client.rs:58`–`client/src/client.rs:84`.

### Idiomatic Rust Improvements
- Avoid shadowing and log both forms.
- Before:
```rust
let filter = hex(&filter.encode());
```
- After:
```rust
let encoded_filter = hex(&filter.encode());
```

### Data Structure & Algorithm Changes
- Rationale: better debuggability and earlier validation feedback.
- Complexity impact (before → after): none.

### Safety & Concurrency Notes
- Invariants: `Client::new` should only accept `http/https` base URLs.
- Unsafe requirements (if any): none.
- Concurrency concerns: shared `reqwest::Client` is clone-safe.

### Performance & Scaling Notes
- Likely hotspots: WS message decode throughput.
- Measurement suggestions: load test submit + updates concurrently.
- Proposed optimizations: avoid repeated string formatting in hot paths if profiling shows it matters.

### Refactor Plan
- Phase 1: low-risk cleanups
  - [x] Fix filter shadowing.
  - [x] Validate `txs.len() <= MAX_SUBMISSION_TRANSACTIONS` before sending.
- Phase 2: structural improvements
  - [x] Return `Url` directly (avoid `String` allocations for paths).
- Phase 3: optional larger redesigns
  - [x] Add retry/backoff policies for transient HTTP errors if used in production bots.

### Open Questions
- Is `nullspace-client` API stability required (semver), or can signatures evolve freely?

## client/src/events.rs

### Summary
- Wraps a WebSocket connection into a `Stream<T>` that decodes binary messages and optionally verifies consensus signatures.

### Top Issues (ranked)
1. **Background task may keep socket alive after receiver drop**
   - Impact: potential resource leak; task waits on `ws.next()` even if downstream is gone.
   - Risk: medium.
   - Effort: low.
   - Location: `client/src/events.rs:13`–`client/src/events.rs:84`.
2. **Unbounded channel can grow without backpressure**
   - Impact: slow consumers can cause unbounded memory growth.
   - Risk: medium.
   - Effort: low–medium.
   - Location: `client/src/events.rs:50`, `client/src/events.rs:99`.

### Idiomatic Rust Improvements
- Abort the task on drop.
- Before:
```rust
pub struct Stream<T> { /* ... */ }
```
- After:
```rust
impl<T: ReadExt + Send + 'static> Drop for Stream<T> {
    fn drop(&mut self) {
        self._handle.abort();
    }
}
```

### Data Structure & Algorithm Changes
- Rationale: bound memory and ensure clean shutdown.
- Complexity impact (before → after): none unless a bounded channel is introduced.

### Safety & Concurrency Notes
- Invariants: decoding errors must not crash; verification failure should surface as `Error::InvalidSignature`.
- Unsafe requirements (if any): none.
- Concurrency concerns: decide between backpressure vs dropping when switching to bounded channels.

### Performance & Scaling Notes
- Likely hotspots: `T::read` decode under high-frequency streams.
- Measurement suggestions: simulate fast producer + slow consumer and measure memory.
- Proposed optimizations: bounded channel with defined dropping/backpressure semantics.

### Refactor Plan
- Phase 1: low-risk cleanups
  - [x] Implement `Drop` to abort background task.
- Phase 2: structural improvements
  - [x] Replace unbounded channel with bounded channel and document behavior.
- Phase 3: optional larger redesigns
  - [x] Add stream configuration knobs (capacity, verification mode) if widely used.

### Open Questions
- Is it acceptable for clients to drop WS messages under load, or must reads apply backpressure?

## client/src/consensus.rs

### Summary
- Adds consensus-related helper methods to `Client` (seed queries) and verifies returned seeds.

### Top Issues (ranked)
1. **`unwrap()` in URL construction**
   - Impact: avoidable panic; better to propagate.
   - Risk: low.
   - Effort: low.
   - Location: `client/src/consensus.rs:10`.

### Idiomatic Rust Improvements
- Propagate URL join errors.
- Before:
```rust
base.join(...).unwrap()
```
- After:
```rust
base.join(...)?
```

### Data Structure & Algorithm Changes
- Rationale: remove panic paths.
- Complexity impact (before → after): none.

### Safety & Concurrency Notes
- Invariants: verify uses correct `NAMESPACE` and identity.
- Unsafe requirements (if any): none.
- Concurrency concerns: none.

### Performance & Scaling Notes
- Likely hotspots: none.
- Measurement suggestions: none.
- Proposed optimizations: none.

### Refactor Plan
- Phase 1: low-risk cleanups
  - [x] Remove `unwrap()` and return `Url` directly.
- Phase 2: structural improvements
  - [x] Consolidate path helpers with `client/src/client.rs`.
- Phase 3: optional larger redesigns
  - None.

### Open Questions
- None.

## node/src/main.rs

### Summary
- CLI entrypoint for running a validator node: loads config, initializes telemetry/runtime, configures P2P, and starts the engine.

### Top Issues (ranked)
1. **Panics for routine error conditions**
   - Impact: misconfiguration/IO errors crash without structured reporting.
   - Risk: medium–high.
   - Effort: medium.
   - Location: `node/src/main.rs` (many `assert!/expect`).
2. **Duplicated peer parsing between hosts vs peers modes**
   - Impact: must keep two parsing paths consistent.
   - Risk: medium.
   - Effort: medium.
   - Location: `node/src/main.rs:101`–`node/src/main.rs:174`.

### Idiomatic Rust Improvements
- Use a single `anyhow::Result<()>` main and extract helpers.
- Before:
```rust
let config_file = std::fs::read_to_string(config_file).expect("Could not read config file");
```
- After:
```rust
let config_file = std::fs::read_to_string(config_file)?;
```

### Data Structure & Algorithm Changes
- Rationale: turn panics into actionable errors; reduce duplicated logic.
- Complexity impact (before → after): none.

### Safety & Concurrency Notes
- Invariants: config/key material must be validated before starting the network.
- Unsafe requirements (if any): none.
- Concurrency concerns: none in bootstrap.

### Performance & Scaling Notes
- Likely hotspots: none in bootstrap.
- Measurement suggestions: none.
- Proposed optimizations: none; prioritize operability.

### Refactor Plan
- Phase 1: low-risk cleanups
  - [x] Replace `assert!/expect` with `anyhow::bail!` and `Context`.
- Phase 2: structural improvements
  - [x] Extract peer loading into a shared helper.
  - [x] Introduce a validated config type.
- Phase 3: optional larger redesigns
  - [x] Add `--dry-run` config validation (behavior addition; optional).

### Open Questions
- Are there requirements around exit codes/log formats that must be preserved (e.g., JSON logs under deployer)?

## node/src/seeder/ingress.rs

### Summary
- Defines seeder mailbox and integrates with resolver `Producer/Consumer` and consensus `Reporter`.

### Top Issues (ranked)
1. **Panics if actor channel is closed**
   - Impact: seeder shutdown/crash can panic callers.
   - Risk: medium.
   - Effort: medium (API ripples if returning `Result`).
   - Location: `node/src/seeder/ingress.rs:48`, `node/src/seeder/ingress.rs:59`, `node/src/seeder/ingress.rs:67`, `node/src/seeder/ingress.rs:85`, `node/src/seeder/ingress.rs:105`.
2. **`deliver()` defaults to success when response is dropped**
   - Impact: may acknowledge delivery even when the actor cannot process.
   - Risk: medium–high.
   - Effort: low.
   - Location: `node/src/seeder/ingress.rs:88`.

### Idiomatic Rust Improvements
- Treat dropped responses as failure (or at least log).
- Before:
```rust
receiver.await.unwrap_or(true)
```
- After:
```rust
receiver.await.unwrap_or(false)
```

### Data Structure & Algorithm Changes
- Rationale: align delivery acknowledgment with actual processing.
- Complexity impact (before → after): none.

### Safety & Concurrency Notes
- Invariants: `Consumer::deliver` should only return `true` when the message was processed or safely enqueued.
- Unsafe requirements (if any): none.
- Concurrency concerns: apply backpressure via bounded channels if needed.

### Performance & Scaling Notes
- Likely hotspots: none.
- Measurement suggestions: add tracing around deliver/produce latency.
- Proposed optimizations: bounded channels if upstream can overrun mailboxes.

### Refactor Plan
- Phase 1: low-risk cleanups
  - [x] Change `unwrap_or(true)` to `unwrap_or(false)` (behavior change; verify resolver expectations first).
  - [x] Add warnings on send failures instead of panicking where feasible.
- Phase 2: structural improvements
  - [x] Convert mailbox APIs to return `Result` and propagate errors to supervisors (`seeder::MailboxError`; `get/put/uploaded` now return `Result`).
- Phase 3: optional larger redesigns
  - [x] Add shutdown signaling so mailbox operations fail fast during shutdown (use runtime `stopped()` signal).

### Open Questions
- Does the resolver treat `deliver=false` as “retry later”, and is that preferable to silently accepting delivery when the actor is unavailable?

## node/src/application/mempool.rs

### Summary
- In-memory mempool that deduplicates transactions, tracks per-account nonce ordering, and yields transactions in a round-robin across accounts.

### Top Issues (ranked)
1. **Queue can accumulate stale addresses**
   - Impact: `queue` can grow with dead keys, increasing skip work under churn.
   - Risk: medium.
   - Effort: low–medium.
   - Location: `node/src/application/mempool.rs:135` (comment + logic in `next()`).
2. **`assert!` / `unwrap()` in hot path**
   - Impact: invariant violations become panics instead of controlled failures.
   - Risk: low but non-zero.
   - Effort: low.
   - Location: `node/src/application/mempool.rs:81`, `node/src/application/mempool.rs:153`.
3. **Hard-coded caps**
   - Impact: tuning requires rebuild; operational friction.
   - Risk: medium.
   - Effort: medium.
   - Location: `node/src/application/mempool.rs:7`–`node/src/application/mempool.rs:13`.

### Idiomatic Rust Improvements
- Use `debug_assert!` and `expect` with invariant messages.
- Before:
```rust
assert!(entry.insert(tx.nonce, digest).is_none());
```
- After:
```rust
debug_assert!(entry.insert(tx.nonce, digest).is_none(), "nonce dedupe invariant");
```

### Data Structure & Algorithm Changes
- Rationale: keep `next()` amortized O(1) and avoid churn-induced overhead.
- Complexity impact (before → after): improves worst-case churn behavior.

### Safety & Concurrency Notes
- Invariants:
  - Every digest in `tracked` must exist in `transactions`.
  - Each `(PublicKey, nonce)` appears at most once.
- Unsafe requirements (if any): none.
- Concurrency concerns: not thread-safe; must be actor-owned.

### Performance & Scaling Notes
- Likely hotspots: `add()` and `next()` at high TPS.
- Measurement suggestions: track stale-pop ratio and mempool size over time.
- Proposed optimizations: maintain a “queued” set/flag to avoid duplicates; make caps configurable.

### Refactor Plan
- Phase 1: low-risk cleanups
  - [x] Convert panics to debug asserts/expect messages.
- Phase 2: structural improvements
  - [x] Add queue uniqueness tracking and prune stale buildup.
  - [x] Plumb caps from config (`mempool_max_backlog`/`mempool_max_transactions`).
- Phase 3: optional larger redesigns
  - [ ] Separate dedupe/order structures if profiling shows hash overhead dominates.

### Open Questions
- Expected steady-state active accounts and txs/account, and whether caps must be runtime-tunable?

## node/src/lib.rs

### Summary
- Node-level config boundary types (`Config`, `Peers`) and module exports.

### Top Issues (ranked)
1. **Config is stringly-typed past the serde boundary**
   - Impact: key/path parsing is duplicated in `main`; validation isn’t centralized.
   - Risk: medium.
   - Effort: medium.
   - Location: `node/src/lib.rs:11`–`node/src/lib.rs:33`.
2. **Peer identity representation inconsistent**
   - Impact: extra conversion logic and duplication.
   - Risk: low–medium.
   - Effort: medium.
   - Location: `node/src/lib.rs:39`–`node/src/lib.rs:44`.

### Idiomatic Rust Improvements
- Add a validated config type and conversion method.
- Before:
```rust
pub struct Config { pub private_key: String, pub directory: String, /* ... */ }
```
- After:
```rust
pub struct ValidatedConfig { pub signer: ed25519::PrivateKey, pub directory: PathBuf, /* ... */ }
```

### Data Structure & Algorithm Changes
- Rationale: reduce duplication and make invalid configs unrepresentable.
- Complexity impact (before → after): none.

### Safety & Concurrency Notes
- Invariants: reject invalid keys/paths early with actionable errors.
- Unsafe requirements (if any): none.
- Concurrency concerns: none.

### Performance & Scaling Notes
- Likely hotspots: none.
- Measurement suggestions: none.
- Proposed optimizations: none.

### Refactor Plan
- Phase 1: low-risk cleanups
  - [x] Add `Config::validate(self, peer_count: u32) -> Result<ValidatedConfig, ConfigError>`.
- Phase 2: structural improvements
  - [x] Unify peer parsing helpers shared by hosts/peers.
- Phase 3: optional larger redesigns
  - [x] Move large integration tests out of `node/src/lib.rs` if compile times become an issue (moved to `node/src/tests.rs`).

### Open Questions
- Is `node::Config` considered a stable public API?

## execution/src/casino/mod.rs

### Summary
- Deterministic RNG (`GameRng`), `CasinoGame` trait, and game dispatch.

### Top Issues (ranked)
1. **`GameResult` payout semantics are spread across many variants**
   - Impact: easy to mishandle in the caller; subtle double-deduct/double-pay risks.
   - Risk: medium.
   - Effort: medium.
   - Location: `execution/src/casino/mod.rs:262`–`execution/src/casino/mod.rs:311`.
2. **`GameRng` does not implement standard RNG traits**
   - Impact: harder to reuse ecosystem fuzzing/testing tools.
   - Risk: low.
   - Effort: medium.
   - Location: `execution/src/casino/mod.rs:26`–`execution/src/casino/mod.rs:225`.

### Idiomatic Rust Improvements
- Small readability tweak.
- Before:
```rust
(self.next_u8() as f32) / 256.0
```
- After:
```rust
f32::from(self.next_u8()) / 256.0
```

### Data Structure & Algorithm Changes
- Rationale: reduce payout-handling complexity and improve testability.
- Complexity impact (before → after): none.

### Safety & Concurrency Notes
- Invariants:
  - RNG must be deterministic for `(Seed, session_id, move_number)`.
  - Caller handling of `GameResult` must be exhaustive and consistent.
- Unsafe requirements (if any): none.
- Concurrency concerns: none.

### Performance & Scaling Notes
- Likely hotspots: per-move game logic; repeated state blob parsing.
- Measurement suggestions: per-game benchmarks of `process_move`.
- Proposed optimizations: none until profiling demands it.

### Refactor Plan
- Phase 1: low-risk cleanups
  - [x] Add targeted tests around payout edge cases per `GameResult` variant handling.
- Phase 2: structural improvements
  - [ ] Consider a unified resolution struct if payout handling remains complex (behavior-sensitive).
- Phase 3: optional larger redesigns
  - [x] Implement `rand_core::RngCore` for `GameRng` if ecosystem tooling is desired.

### Open Questions
- Is the `GameResult` API stable, or can it change if it reduces payout-handling risk?

## execution/src/mocks.rs

### Summary
- Test helpers for generating keys/seeds and executing blocks against storage backends.

### Top Issues (ranked)
1. **Panicking helpers reduce reuse**
   - Impact: failures are less composable and less contextual.
   - Risk: low.
   - Effort: low–medium.
   - Location: `execution/src/mocks.rs:82`–`execution/src/mocks.rs:105`.

### Idiomatic Rust Improvements
- Prefer `Result`-returning helpers.
- Before:
```rust
.await.expect("Failed to initialize state ADB");
```
- After:
```rust
.await?;
```

### Data Structure & Algorithm Changes
- Rationale: improve test ergonomics.
- Complexity impact (before → after): none.

### Safety & Concurrency Notes
- Invariants: none (test-only).
- Unsafe requirements (if any): none.
- Concurrency concerns: deterministic runtime stores everything in memory; keep test allocations bounded.

### Performance & Scaling Notes
- Likely hotspots: DB init/proof generation in tests.
- Measurement suggestions: reduce proof sizes if deterministic tests become slow.
- Proposed optimizations: none unless tests become a bottleneck.

### Refactor Plan
- Phase 1: low-risk cleanups
  - [x] Add `*_result` variants returning `Result` and keep panicking wrappers for existing tests.
- Phase 2: structural improvements
  - [x] Centralize mock config constants (buffers/partitions).
- Phase 3: optional larger redesigns
  - [x] Add codec round-trip property tests using these helpers.

### Open Questions
- None.

## website/wasm/src/lib.rs

### Summary
- WASM bindings exposing key management, transaction construction, and decoding helpers to JavaScript.

### Top Issues (ranked)
1. **Unreachable match arm in instruction-to-string mapping**
   - Impact: warning today; more importantly, hides missing handling when `Instruction` evolves (you want compile errors).
   - Risk: low today, medium long-term.
   - Effort: low.
   - Location: `website/wasm/src/lib.rs:1082`–`website/wasm/src/lib.rs:1106` (`_ => "Unknown"`).
2. **Repeated allocation of transaction namespace when signing**
   - Impact: avoidable alloc per sign, expensive in WASM.
   - Risk: low.
   - Effort: low.
   - Location: `website/wasm/src/lib.rs:103`.

### Idiomatic Rust Improvements
- Remove unreachable `_ => "Unknown"` to keep the match exhaustive.
- Before:
```rust
Instruction::RemoveLiquidity { .. } => "RemoveLiquidity",
_ => "Unknown",
```
- After:
```rust
Instruction::RemoveLiquidity { .. } => "RemoveLiquidity",
```

### Data Structure & Algorithm Changes
- Rationale: keep bindings self-auditing; reduce allocations.
- Complexity impact (before → after): none.

### Safety & Concurrency Notes
- Invariants: WASM `Signer` exposes private key material to JS; treat as sensitive and avoid logging/persisting.
- Unsafe requirements (if any): none.
- Concurrency concerns: none.

### Performance & Scaling Notes
- Likely hotspots: signing and JSON conversion for large outputs.
- Measurement suggestions: benchmark signing throughput in browser/node.
- Proposed optimizations: use the constant namespace (see `types/src/execution.rs` plan).

### Refactor Plan
- Phase 1: low-risk cleanups
  - [x] Remove unreachable match arm.
  - [x] Switch signing to constant namespace.
- Phase 2: structural improvements
  - [x] Centralize `Instruction` → string mapping if needed across frontends (keep exhaustive).
- Phase 3: optional larger redesigns
  - [x] Define a canonical “instruction kind” enum exposed to JS if string stability matters.

### Open Questions
- Are the WASM exports intended for production browser usage or developer-only tooling?

## execution/src/casino/blackjack.rs

### Summary
- Implements the Blackjack state machine (`Betting` → `Deal` → `PlayerTurn` → `Reveal` → `Complete`) including the `21+3` side bet.
- Produces `GameResult` values consumed by `execution/src/lib.rs` settlement logic.

### Top Issues (ranked)
1. **Early completion path returned the wrong `GameResult` variant**
   - Impact: could apply an extra deduction on a fully pre-deducted wager path; also broke compilation (`extra_bet` was undefined).
   - Risk: high (payout correctness).
   - Effort: low.
   - Location: `execution/src/casino/blackjack.rs` (`Stage::PlayerTurn`, `Move::Hit`, all-hands-busted branch).

### Idiomatic Rust Improvements
- Align early-return outcome with the main reveal settlement logic (`LossPreDeducted` / `Win`).
- Before:
```rust
return Ok(if total_return == 0 {
    GameResult::LossPreDeductedWithExtraDeduction { /* ... */ }
} else {
    GameResult::WinWithExtraDeduction { /* ... */ }
});
```
- After:
```rust
return Ok(if total_return == 0 {
    GameResult::LossPreDeducted(total_wagered)
} else {
    GameResult::Win(total_return)
});
```

### Data Structure & Algorithm Changes
- Rationale: keep `GameResult` payout variants consistent across early-complete and reveal paths; avoid double-deduction hazards.
- Complexity impact (before → after): none.

### Safety & Concurrency Notes
- Invariants: when wagers are fully deducted before completion, do not request extra deductions at completion.
- Unsafe requirements (if any): none.
- Concurrency concerns: none.

### Performance & Scaling Notes
- Likely hotspots: repeated deck reconstruction (`create_shoe_excluding`) each move.
- Measurement suggestions: profile allocations/copies per move (`--release` + `cargo bench` if added later).
- Proposed optimizations: only if profiling warrants (e.g., buffer reuse, compact deck representation).

### Refactor Plan
- Phase 1: low-risk cleanups
  - [x] Fix all-hands-busted `Hit` completion to return `LossPreDeducted`/`Win`.
  - [x] Add regression tests for all-hands-busted `Hit` outcomes (loss + side-bet-only win).
- Phase 2: structural improvements
  - [x] Factor duplicated “compute total_return/total_wagered + super multiplier” across early-complete and reveal paths.
- Phase 3: optional larger redesigns
  - [ ] Consider encoding incremental deck state to avoid full reconstruction (needs determinism audit).

### Open Questions
- Should casino-wide modifiers (shield/double) apply to side-bet-only wins when the main hand loses?
