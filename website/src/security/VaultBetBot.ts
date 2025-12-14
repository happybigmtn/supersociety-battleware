import { WasmWrapper } from '../api/wasm.js';

export type VaultBetBotConfig = {
  betIntervalMs: number;
  randomizeInterval: boolean;
  betAmount: number;
};

const DEFAULT_CONFIG: VaultBetBotConfig = {
  betIntervalMs: 2500,
  randomizeInterval: true,
  betAmount: 10,
};

// Game type enum matching the chain
const GameType = {
  Baccarat: 0,
  Blackjack: 1,
  CasinoWar: 2,
  Craps: 3,
  VideoPoker: 4,
  HiLo: 5,
  Roulette: 6,
  SicBo: 7,
  ThreeCard: 8,
  UltimateHoldem: 9,
};

const ALL_GAMES = [
  GameType.Baccarat,
  GameType.Blackjack,
  GameType.CasinoWar,
  GameType.Craps,
  GameType.VideoPoker,
  GameType.HiLo,
  GameType.Roulette,
  GameType.SicBo,
  GameType.ThreeCard,
  GameType.UltimateHoldem,
];

export class VaultBetBot {
  private baseUrl: string;
  private identityHex: string;
  private privateKeyBytes: Uint8Array;
  private wasm: WasmWrapper | null = null;
  private nonce = 0;
  private sessionCounter = Date.now();
  private isRunning = false;
  private timer: number | null = null;
  private config: VaultBetBotConfig = DEFAULT_CONFIG;
  private onLog?: (msg: string) => void;

  constructor(opts: {
    baseUrl: string;
    identityHex: string;
    privateKeyBytes: Uint8Array;
    onLog?: (msg: string) => void;
    config?: Partial<VaultBetBotConfig>;
  }) {
    this.baseUrl = opts.baseUrl;
    this.identityHex = opts.identityHex;
    this.privateKeyBytes = opts.privateKeyBytes;
    this.onLog = opts.onLog;
    this.config = { ...DEFAULT_CONFIG, ...(opts.config ?? {}) };
  }

  private log(msg: string) {
    try {
      this.onLog?.(msg);
    } catch {
      // ignore
    }
  }

  async init(): Promise<void> {
    if (this.wasm) return;
    const wasm = new WasmWrapper(this.identityHex);
    await wasm.init();
    wasm.createKeypair(this.privateKeyBytes);
    this.wasm = wasm;
    await this.resyncNonce();
    await this.ensureRegistered();
    this.log(`Vault bot ready (pubkey=${wasm.getPublicKeyHex().slice(0, 8)}…) nonce=${this.nonce}`);
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    void this.loop();
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  setConfig(config: Partial<VaultBetBotConfig>) {
    this.config = { ...this.config, ...config };
  }

  getRunning(): boolean {
    return this.isRunning;
  }

  private scheduleNext(): void {
    if (!this.isRunning) return;
    const delay = this.config.randomizeInterval
      ? Math.floor(this.config.betIntervalMs * (0.5 + Math.random()))
      : this.config.betIntervalMs;
    this.timer = window.setTimeout(() => void this.loop(), delay);
  }

  private async loop(): Promise<void> {
    if (!this.isRunning) return;
    try {
      await this.init();
      await this.playRandomGame();
    } catch (e: any) {
      this.log(`Vault bot error: ${e?.message ?? String(e)}`);
      // Attempt to recover nonce on errors.
      try {
        await this.resyncNonce();
      } catch {
        // ignore
      }
    } finally {
      this.scheduleNext();
    }
  }

  private async submitTransaction(txBytes: Uint8Array): Promise<void> {
    if (!this.wasm) throw new Error('bot-not-initialized');
    const submission = this.wasm.wrapTransactionSubmission(txBytes);
    const response = await fetch(`${this.baseUrl}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: submission,
    });
    if (!response.ok) throw new Error(`submit-failed:${response.status}`);
  }

  private async getAccountState(publicKeyBytes: Uint8Array): Promise<{ nonce: number } | null> {
    if (!this.wasm) throw new Error('bot-not-initialized');

    const keyBytes = this.wasm.encodeAccountKey(publicKeyBytes);
    const hashedKey = this.wasm.hashKey(keyBytes);
    const hexKey = this.wasm.bytesToHex(hashedKey);

    const response = await fetch(`${this.baseUrl}/state/${hexKey}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`state-query-failed:${response.status}`);

    const buffer = await response.arrayBuffer();
    const valueBytes = new Uint8Array(buffer);
    if (valueBytes.length === 0) return null;

    const value: any = this.wasm.decodeLookup(valueBytes);
    if (value && value.type === 'Account') return { nonce: value.nonce };
    return null;
  }

  private async resyncNonce(): Promise<void> {
    if (!this.wasm) throw new Error('bot-not-initialized');
    const pk = this.wasm.getPublicKeyBytes();
    const state = await this.getAccountState(pk);
    this.nonce = state?.nonce ?? 0;
  }

  private async ensureRegistered(): Promise<void> {
    if (!this.wasm) throw new Error('bot-not-initialized');

    // Heuristic: nonce 0 likely means not registered.
    if (this.nonce !== 0) return;

    const name = `Vault_${Date.now().toString(36)}`;
    const tx = this.wasm.createCasinoRegisterTransaction(this.nonce, name);
    try {
      await this.submitTransaction(tx);
      this.nonce += 1;
      this.log(`Registered as ${name}`);
    } catch {
      // If registration fails, re-sync nonce and proceed.
      await this.resyncNonce();
    }
  }

  private async playRandomGame(): Promise<void> {
    if (!this.wasm) throw new Error('bot-not-initialized');

    const gameType = ALL_GAMES[Math.floor(Math.random() * ALL_GAMES.length)];
    const sessionId = BigInt(++this.sessionCounter);
    const bet = this.config.betAmount;

    const startNonce = this.nonce;
    const startTx = this.wasm.createCasinoStartGameTransaction(startNonce, gameType, bet, sessionId);
    try {
      await this.submitTransaction(startTx);
      this.nonce++;
    } catch {
      await this.resyncNonce();
      return;
    }

    // Small delay to allow block production.
    await new Promise(r => setTimeout(r, 25));

    for (const move of this.getGameMoves(gameType)) {
      const moveTx = this.wasm.createCasinoGameMoveTransaction(this.nonce, sessionId, move);
      try {
        await this.submitTransaction(moveTx);
        this.nonce++;
        await new Promise(r => setTimeout(r, 10));
      } catch {
        await this.resyncNonce();
        break;
      }
    }
  }

  private getGameMoves(gameType: number): Uint8Array[] {
    switch (gameType) {
      case GameType.Baccarat:
        return [this.serializeBaccaratBet(Math.floor(Math.random() * 3), this.config.betAmount), new Uint8Array([1])];
      case GameType.Blackjack:
        return [new Uint8Array([1])]; // Stand
      case GameType.CasinoWar:
        return [];
      case GameType.Craps:
        return [this.serializeCrapsBet(0, 0, this.config.betAmount), new Uint8Array([2])]; // Pass + roll
      case GameType.VideoPoker:
        return [new Uint8Array([31])]; // Hold all
      case GameType.HiLo:
        return [new Uint8Array([Math.floor(Math.random() * 2)])];
      case GameType.Roulette:
        return [new Uint8Array([1, 0])]; // Red
      case GameType.SicBo:
        return [new Uint8Array([0, 0])]; // Small
      case GameType.ThreeCard:
        return [new Uint8Array([0])]; // Play
      case GameType.UltimateHoldem:
        return [new Uint8Array([0]), new Uint8Array([4])]; // Check, fold
      default:
        return [];
    }
  }

  private serializeBaccaratBet(betType: number, amount: number): Uint8Array {
    // [action:u8] [betType:u8] [amount:u64 BE]
    const payload = new Uint8Array(10);
    payload[0] = 0; // Place bet
    payload[1] = betType;
    new DataView(payload.buffer).setBigUint64(2, BigInt(amount), false);
    return payload;
  }

  private serializeCrapsBet(betType: number, point: number, amount: number): Uint8Array {
    // Match existing frontend encoding: [action:u8=0] [betType:u8] [point:u8] [amount:u64 BE]
    const payload = new Uint8Array(11);
    payload[0] = 0;
    payload[1] = betType;
    payload[2] = point;
    new DataView(payload.buffer).setBigUint64(3, BigInt(amount), false);
    return payload;
  }
}

