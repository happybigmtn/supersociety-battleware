/**
 * BotService - Spawns simulated bots that play against the chain during tournaments
 *
 * Bots make random bets on all casino games at configurable intervals.
 * This creates realistic tournament competition for testing.
 */

import { WasmWrapper } from '../api/wasm.js';

export interface BotConfig {
  enabled: boolean;
  numBots: number;
  betIntervalMs: number;
  randomizeInterval: boolean;
}

export const DEFAULT_BOT_CONFIG: BotConfig = {
  enabled: false,
  numBots: 100,
  betIntervalMs: 5000,
  randomizeInterval: true,
};

interface BotState {
  id: number;
  name: string;
  wasm: WasmWrapper;
  nonce: number;
  sessionCounter: number;
  isActive: boolean;
}

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

export class BotService {
  private bots: BotState[] = [];
  private config: BotConfig = DEFAULT_BOT_CONFIG;
  private isRunning = false;
  private intervalHandles: number[] = [];
  private baseUrl: string;
  private identityHex: string;
  private onStatusUpdate?: (status: BotServiceStatus) => void;

  constructor(baseUrl: string, identityHex: string) {
    this.baseUrl = baseUrl;
    this.identityHex = identityHex;
  }

  setConfig(config: BotConfig) {
    this.config = config;
  }

  setStatusCallback(callback: (status: BotServiceStatus) => void) {
    this.onStatusUpdate = callback;
  }

  private updateStatus(status: Partial<BotServiceStatus>) {
    if (this.onStatusUpdate) {
      this.onStatusUpdate({
        isRunning: this.isRunning,
        activeBots: this.bots.filter(b => b.isActive).length,
        totalBets: 0,
        ...status,
      });
    }
  }

  async start(): Promise<void> {
    if (this.isRunning || !this.config.enabled) return;

    console.log(`[BotService] Starting ${this.config.numBots} bots...`);
    this.isRunning = true;
    this.updateStatus({ isRunning: true });

    // Create bots
    for (let i = 0; i < this.config.numBots; i++) {
      try {
        const bot = await this.createBot(i);
        this.bots.push(bot);

        // Start bot playing loop
        this.startBotLoop(bot);

        // Stagger bot creation slightly
        await new Promise(r => setTimeout(r, 10));
      } catch (e) {
        console.warn(`[BotService] Failed to create bot ${i}:`, e);
      }
    }

    console.log(`[BotService] Started ${this.bots.length} bots`);
    this.updateStatus({ activeBots: this.bots.length });
  }

  stop(): void {
    if (!this.isRunning) return;

    console.log('[BotService] Stopping all bots...');
    this.isRunning = false;

    // Clear all intervals
    for (const handle of this.intervalHandles) {
      clearTimeout(handle);
    }
    this.intervalHandles = [];

    // Mark all bots as inactive
    for (const bot of this.bots) {
      bot.isActive = false;
    }
    this.bots = [];

    this.updateStatus({ isRunning: false, activeBots: 0 });
  }

  private async createBot(id: number): Promise<BotState> {
    const wasm = new WasmWrapper(this.identityHex);
    await wasm.init();

    // Generate a new keypair for this bot
    wasm.createKeypair();

    const name = `Bot${String(id).padStart(4, '0')}`;
    const publicKeyBytes = wasm.getPublicKeyBytes();

    // Fetch current account state from chain to get the actual nonce
    let currentNonce = 0;
    try {
      const accountState = await this.getAccountState(publicKeyBytes);
      if (accountState) {
        currentNonce = accountState.nonce;
        console.debug(`[BotService] Bot ${name} loaded nonce from chain: ${currentNonce}`);
      }
    } catch (e) {
      console.debug(`[BotService] Bot ${name} failed to fetch account state:`, e);
    }

    // Register the bot if not already registered
    if (currentNonce === 0) {
      try {
        const registerTx = wasm.createCasinoRegisterTransaction(0, name);
        await this.submitTransaction(wasm, registerTx);
        currentNonce = 1; // After registration, nonce is 1
        console.debug(`[BotService] Bot ${name} registered, nonce is now 1`);
      } catch (e) {
        // May already be registered from previous run
        console.debug(`[BotService] Bot ${name} registration:`, e);
        // If registration failed, query the nonce again
        try {
          const accountState = await this.getAccountState(publicKeyBytes);
          if (accountState) {
            currentNonce = accountState.nonce;
          }
        } catch (queryError) {
          console.warn(`[BotService] Bot ${name} failed to query nonce after registration error`);
        }
      }
    }

    return {
      id,
      name,
      wasm,
      nonce: currentNonce,
      sessionCounter: id * 1_000_000,
      isActive: true,
    };
  }

  private async getAccountState(publicKeyBytes: Uint8Array): Promise<{ nonce: number } | null> {
    try {
      // Create a temporary WasmWrapper to use encoding functions
      const tempWasm = new WasmWrapper(this.identityHex);
      await tempWasm.init();

      // Encode the account key
      const keyBytes = tempWasm.encodeAccountKey(publicKeyBytes);
      const hashedKey = tempWasm.hashKey(keyBytes);
      const hexKey = tempWasm.bytesToHex(hashedKey);

      // Query the state
      const response = await fetch(`${this.baseUrl}/state/${hexKey}`);

      if (response.status === 404) {
        return null;
      }

      if (response.status !== 200) {
        throw new Error(`State query returned ${response.status}`);
      }

      // Get binary response
      const buffer = await response.arrayBuffer();
      const valueBytes = new Uint8Array(buffer);

      if (valueBytes.length === 0) {
        return null;
      }

      // Decode value using WASM
      const value = tempWasm.decodeLookup(valueBytes);

      if (value && value.type === 'Account') {
        return { nonce: value.nonce };
      }

      return null;
    } catch (error) {
      console.error('[BotService] Failed to get account state:', error);
      return null;
    }
  }

  private async submitTransaction(wasm: WasmWrapper, txBytes: Uint8Array): Promise<void> {
    // Wrap transaction in Submission enum
    const submission = wasm.wrapTransactionSubmission(txBytes);

    const response = await fetch(`${this.baseUrl}/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream'
      },
      body: submission
    });

    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }
  }

  private startBotLoop(bot: BotState): void {
    const runGame = async () => {
      if (!this.isRunning || !bot.isActive) return;

      try {
        await this.playRandomGame(bot);
      } catch (e) {
        console.debug(`[BotService] Bot ${bot.name} game error:`, e);
      }

      // Schedule next game
      if (this.isRunning && bot.isActive) {
        const delay = this.config.randomizeInterval
          ? Math.floor(this.config.betIntervalMs * (0.5 + Math.random()))
          : this.config.betIntervalMs;

        const handle = window.setTimeout(runGame, delay);
        this.intervalHandles.push(handle);
      }
    };

    // Start with a random initial delay to spread out bot activity
    const initialDelay = Math.floor(Math.random() * this.config.betIntervalMs);
    const handle = window.setTimeout(runGame, initialDelay);
    this.intervalHandles.push(handle);
  }

  private async playRandomGame(bot: BotState): Promise<void> {
    const gameType = ALL_GAMES[Math.floor(Math.random() * ALL_GAMES.length)];
    const sessionId = BigInt(++bot.sessionCounter);
    const bet = 10; // Small consistent bet

    // Start game - use current nonce, only increment on success
    const startNonce = bot.nonce;
    const startTx = bot.wasm.createCasinoStartGameTransaction(
      startNonce,
      gameType,
      bet,
      sessionId
    );

    try {
      await this.submitTransaction(bot.wasm, startTx);
      bot.nonce++; // Only increment after successful submission
    } catch (e) {
      console.debug(`[BotService] Bot ${bot.name} start game failed, re-syncing nonce`);
      // Try to re-sync nonce from chain on failure
      await this.resyncNonce(bot);
      return; // Exit early, next iteration will try again
    }

    // Small delay
    await new Promise(r => setTimeout(r, 20));

    // Make moves based on game type
    const moves = this.getGameMoves(gameType);
    for (const move of moves) {
      const moveNonce = bot.nonce;
      const moveTx = bot.wasm.createCasinoGameMoveTransaction(
        moveNonce,
        sessionId,
        move
      );
      try {
        await this.submitTransaction(bot.wasm, moveTx);
        bot.nonce++; // Only increment after successful submission
        await new Promise(r => setTimeout(r, 10));
      } catch {
        // Game may have ended or nonce issue - re-sync and exit
        await this.resyncNonce(bot);
        break;
      }
    }
  }

  private async resyncNonce(bot: BotState): Promise<void> {
    try {
      const accountState = await this.getAccountState(bot.wasm.getPublicKeyBytes());
      if (accountState) {
        bot.nonce = accountState.nonce;
        console.debug(`[BotService] Bot ${bot.name} nonce re-synced to ${bot.nonce}`);
      }
    } catch (e) {
      console.debug(`[BotService] Bot ${bot.name} failed to re-sync nonce:`, e);
    }
  }

  private getGameMoves(gameType: number): Uint8Array[] {
    switch (gameType) {
      case GameType.Baccarat:
        // Place bet then deal
        return [
          this.serializeBaccaratBet(Math.floor(Math.random() * 3), 10),
          new Uint8Array([1]), // Deal
        ];

      case GameType.Blackjack:
        // Stand immediately
        return [new Uint8Array([1])];

      case GameType.CasinoWar:
        return [];

      case GameType.Craps:
        // Pass bet then roll
        return [
          this.serializeCrapsBet(0, 0, 10),
          new Uint8Array([2]), // Roll
        ];

      case GameType.VideoPoker:
        // Hold all
        return [new Uint8Array([31])];

      case GameType.HiLo:
        // Random higher/lower
        return [new Uint8Array([Math.floor(Math.random() * 2)])];

      case GameType.Roulette:
        // Bet on red
        return [new Uint8Array([1, 0])];

      case GameType.SicBo:
        // Bet on small
        return [new Uint8Array([0, 0])];

      case GameType.ThreeCard:
        // Play
        return [new Uint8Array([0])];

      case GameType.UltimateHoldem:
        // Check then fold
        return [new Uint8Array([0]), new Uint8Array([4])];

      default:
        return [];
    }
  }

  private serializeBaccaratBet(betType: number, amount: number): Uint8Array {
    const payload = new Uint8Array(10);
    payload[0] = 0; // Place bet action
    payload[1] = betType;
    const view = new DataView(payload.buffer);
    view.setBigUint64(2, BigInt(amount), false);
    return payload;
  }

  private serializeCrapsBet(betType: number, target: number, amount: number): Uint8Array {
    const payload = new Uint8Array(11);
    payload[0] = 0; // Place bet action
    payload[1] = betType;
    payload[2] = target;
    const view = new DataView(payload.buffer);
    view.setBigUint64(3, BigInt(amount), false);
    return payload;
  }
}

export interface BotServiceStatus {
  isRunning: boolean;
  activeBots: number;
  totalBets: number;
}
