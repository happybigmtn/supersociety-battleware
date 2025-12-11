# nullspace-website

Frontend for playing `nullspace`.

## Status

`nullspace-website` is **ALPHA** software and is not yet recommended for production use. Developers should expect breaking changes and occasional instability.

## Development Setup

### Prerequisites

- Rust (with wasm-pack)
- Node.js and npm
- A BLS12-381 identity (96-byte hex string)

### Generate Identity

Generate a new identity using the client tool:

```bash
cargo run --release -p nullspace-client --bin dev-executor -- --help
# Or use an existing identity hex string
```

### Configure Environment

Create a `.env` file in the `website/` directory:

```bash
cd website
cat > .env << 'EOF'
VITE_IDENTITY=<your-96-byte-identity-hex>
VITE_URL=http://localhost:8080
EOF
```

Replace `<your-96-byte-identity-hex>` with your actual identity.

### Start Backend Services

Start the simulator and dev-executor in separate terminals (or background):

```bash
# Terminal 1: Start the simulator
./target/release/nullspace-simulator -i <identity-hex> -p 8080

# Terminal 2: Start the dev-executor (processes transactions)
./target/release/dev-executor -i <identity-hex> -u http://localhost:8080
```

Both the simulator and dev-executor must use the **same identity**.

### Start Frontend

```bash
cd website
npm install
npm run dev
```

The frontend will be available at `http://localhost:3000`.

### Build for Production

```bash
cd website
npm run build
```

The built files will be in `website/dist/`.

## Troubleshooting

### "Waiting for chain" error

Ensure all three components are running:
1. `nullspace-simulator` (provides the API and WebSocket)
2. `dev-executor` (processes transactions from the queue)
3. Frontend dev server (`npm run dev`)

All must use the same identity.

### WebSocket disconnects

- Verify `VITE_URL` in `.env` matches the simulator address
- Ensure `VITE_IDENTITY` is set correctly (must match simulator/executor identity)
