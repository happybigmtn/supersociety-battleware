/**
 * CasinoChainService
 * TypeScript class that wraps casino serialization and integrates with CasinoClient
 */

import { GameType, CasinoGameStartedEvent, CasinoGameMovedEvent, CasinoGameCompletedEvent } from '../types/casino';
import { CasinoClient } from '../api/client.js';

// Extend CasinoClient to include nonceManager property
interface CasinoClientWithNonceManager extends CasinoClient {
  nonceManager: {
    submitCasinoRegister: (name: string) => Promise<{ txHash?: string }>;
    submitCasinoStartGame: (gameType: GameType, bet: bigint, sessionId: bigint) => Promise<{ txHash?: string }>;
    submitCasinoGameMove: (sessionId: bigint, payload: Uint8Array) => Promise<{ txHash?: string }>;
    submitCasinoToggleShield: () => Promise<{ txHash?: string }>;
    submitCasinoToggleDouble: () => Promise<{ txHash?: string }>;
  };
}

// Interface for raw events from the chain client
interface RawCasinoGameStartedEvent {
  session_id: string | number | bigint;
  game_type: string;
  bet: string | number | bigint;
  initial_state: string;
}

interface RawCasinoGameMovedEvent {
  session_id: string | number | bigint;
  move_number: number;
  new_state: string;
}

interface RawCasinoGameCompletedEvent {
  session_id: string | number | bigint;
  game_type: string;
  payout: string | number | bigint;
  final_chips: string | number | bigint;
  was_shielded: boolean;
  was_doubled: boolean;
}

// Session ID counter for generating unique session IDs
let sessionIdCounter = BigInt(Date.now());

/**
 * Read a varint from a buffer (commonware-codec style)
 */
function readVarint(data: Uint8Array, offset: number): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;

  while (bytesRead < 9) {
    if (offset + bytesRead >= data.length) {
      throw new Error('Varint extends beyond buffer');
    }

    const byte = data[offset + bytesRead];
    bytesRead++;

    value |= (byte & 0x7f) << shift;

    if ((byte & 0x80) === 0) {
      return { value, bytesRead };
    }

    shift += 7;
  }

  throw new Error('Varint too long');
}

/**
 * Deserialize CasinoGameStarted event (tag 21)
 */
function deserializeCasinoGameStarted(data: Uint8Array): CasinoGameStartedEvent {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  const tag = data[offset++];
  if (tag !== 21) {
    throw new Error(`Expected CasinoGameStarted tag 21, got ${tag}`);
  }

  const sessionId = view.getBigUint64(offset, false);
  offset += 8;

  const player = data.slice(offset, offset + 32);
  offset += 32;

  const gameType = data[offset++] as GameType;

  const bet = view.getBigUint64(offset, false);
  offset += 8;

  const { value: stateLen, bytesRead } = readVarint(data, offset);
  offset += bytesRead;
  const initialState = data.slice(offset, offset + stateLen);

  return {
    type: 'CasinoGameStarted',
    sessionId,
    player,
    gameType,
    bet,
    initialState,
  };
}

/**
 * Deserialize CasinoGameMoved event (tag 22)
 */
function deserializeCasinoGameMoved(data: Uint8Array): CasinoGameMovedEvent {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  const tag = data[offset++];
  if (tag !== 22) {
    throw new Error(`Expected CasinoGameMoved tag 22, got ${tag}`);
  }

  const sessionId = view.getBigUint64(offset, false);
  offset += 8;

  const moveNumber = view.getUint32(offset, false);
  offset += 4;

  const { value: stateLen, bytesRead } = readVarint(data, offset);
  offset += bytesRead;
  const newState = data.slice(offset, offset + stateLen);

  return {
    type: 'CasinoGameMoved',
    sessionId,
    moveNumber,
    newState,
  };
}

/**
 * Deserialize CasinoGameCompleted event (tag 23)
 */
function deserializeCasinoGameCompleted(data: Uint8Array): CasinoGameCompletedEvent {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  const tag = data[offset++];
  if (tag !== 23) {
    throw new Error(`Expected CasinoGameCompleted tag 23, got ${tag}`);
  }

  const sessionId = view.getBigUint64(offset, false);
  offset += 8;

  const player = data.slice(offset, offset + 32);
  offset += 32;

  const gameType = data[offset++] as GameType;

  const payout = view.getBigInt64(offset, false);
  offset += 8;

  const finalChips = view.getBigUint64(offset, false);
  offset += 8;

  const wasShielded = data[offset++] === 1;
  const wasDoubled = data[offset++] === 1;

  return {
    type: 'CasinoGameCompleted',
    sessionId,
    player,
    gameType,
    payout,
    finalChips,
    wasShielded,
    wasDoubled,
  };
}

/**
 * CasinoChainService - High-level service for casino on-chain interactions
 */
export class CasinoChainService {
  private client: CasinoClientWithNonceManager;
  private gameStartedHandlers: ((event: CasinoGameStartedEvent) => void)[] = [];
  private gameMovedHandlers: ((event: CasinoGameMovedEvent) => void)[] = [];
  private gameCompletedHandlers: ((event: CasinoGameCompletedEvent) => void)[] = [];

  constructor(client: CasinoClient) {
    this.client = client as CasinoClientWithNonceManager;

    // Subscribe to typed events from the client
    this.client.onEvent('CasinoGameStarted', (event: RawCasinoGameStartedEvent) => {
      // DEBUG: Log raw event from chain
      console.log('[CasinoChainService] Raw CasinoGameStarted event:', {
        rawSessionId: event.session_id,
        rawSessionIdType: typeof event.session_id,
        rawGameType: event.game_type,
        rawBet: event.bet,
        rawInitialState: event.initial_state,
      });
      try {
        // Event is already decoded by the client, just pass it through
        const parsed: CasinoGameStartedEvent = {
          type: 'CasinoGameStarted',
          sessionId: BigInt(event.session_id),
          player: new Uint8Array(0), // Placeholder, we get hex from event
          gameType: this.parseGameType(event.game_type),
          bet: BigInt(event.bet),
          initialState: this.hexToBytes(event.initial_state),
        };
        console.log('[CasinoChainService] Parsed CasinoGameStarted:', {
          sessionId: parsed.sessionId.toString(),
          sessionIdType: typeof parsed.sessionId,
          gameType: parsed.gameType,
          bet: parsed.bet.toString(),
          initialStateLen: parsed.initialState.length,
          numHandlers: this.gameStartedHandlers.length,
        });
        this.gameStartedHandlers.forEach(h => h(parsed));
      } catch (error) {
        console.error('[CasinoChainService] Failed to parse CasinoGameStarted:', error);
      }
    });

    this.client.onEvent('CasinoGameMoved', (event: RawCasinoGameMovedEvent) => {
      try {
        const parsed: CasinoGameMovedEvent = {
          type: 'CasinoGameMoved',
          sessionId: BigInt(event.session_id),
          moveNumber: event.move_number,
          newState: this.hexToBytes(event.new_state),
        };
        this.gameMovedHandlers.forEach(h => h(parsed));
      } catch (error) {
        console.error('[CasinoChainService] Failed to parse CasinoGameMoved:', error);
      }
    });

    this.client.onEvent('CasinoGameCompleted', (event: RawCasinoGameCompletedEvent) => {
      // DEBUG: Log raw event from chain
      console.log('[CasinoChainService] Raw CasinoGameCompleted event:', {
        rawSessionId: event.session_id,
        rawSessionIdType: typeof event.session_id,
        rawPayout: event.payout,
        rawFinalChips: event.final_chips,
      });
      try {
        const parsed: CasinoGameCompletedEvent = {
          type: 'CasinoGameCompleted',
          sessionId: BigInt(event.session_id),
          player: new Uint8Array(0), // Placeholder
          gameType: this.parseGameType(event.game_type),
          payout: BigInt(event.payout),
          finalChips: BigInt(event.final_chips),
          wasShielded: event.was_shielded,
          wasDoubled: event.was_doubled,
        };
        console.log('[CasinoChainService] Parsed sessionId:', parsed.sessionId.toString(), 'type:', typeof parsed.sessionId);
        this.gameCompletedHandlers.forEach(h => h(parsed));
      } catch (error) {
        console.error('[CasinoChainService] Failed to parse CasinoGameCompleted:', error);
      }
    });
  }

  private hexToBytes(hex: string): Uint8Array {
    if (!hex || hex.length === 0) return new Uint8Array(0);
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
  }

  private parseGameType(gameTypeStr: string): GameType {
    const mapping: Record<string, GameType> = {
      'Baccarat': GameType.Baccarat,
      'Blackjack': GameType.Blackjack,
      'CasinoWar': GameType.CasinoWar,
      'Craps': GameType.Craps,
      'VideoPoker': GameType.VideoPoker,
      'HiLo': GameType.HiLo,
      'Roulette': GameType.Roulette,
      'SicBo': GameType.SicBo,
      'ThreeCard': GameType.ThreeCard,
      'UltimateHoldem': GameType.UltimateHoldem,
    };
    return mapping[gameTypeStr] ?? GameType.Blackjack;
  }

  /**
   * Register the player on-chain
   * @param name - The player name
   */
  async register(name: string): Promise<void> {
    await this.client.nonceManager.submitCasinoRegister(name);
  }

  /**
   * Generate the next session ID without submitting anything.
   * Call this to get the session ID before submitting, so you can store it
   * in a ref before the WebSocket event arrives.
   */
  generateNextSessionId(): bigint {
    const sessionId = sessionIdCounter++;
    console.log('[CasinoChainService] generateNextSessionId:', sessionId.toString());
    return sessionId;
  }

  /**
   * Start a new game session with a pre-generated session ID.
   * Use generateNextSessionId() first, store it, then call this.
   * @param sessionId - The pre-generated session ID
   * @returns Object with session ID and transaction hash
   */
  async startGameWithSessionId(gameType: GameType, bet: bigint, sessionId: bigint): Promise<{ sessionId: bigint; txHash?: string }> {
    console.log('[CasinoChainService] startGameWithSessionId:', sessionId.toString(), 'type:', typeof sessionId);

    // Use the NonceManager to submit the transaction
    const result = await this.client.nonceManager.submitCasinoStartGame(gameType, bet, sessionId);

    return { sessionId, txHash: result.txHash };
  }

  /**
   * Start a new game session (legacy - session ID generated internally)
   * WARNING: This may cause race conditions where the WebSocket event arrives
   * before the session ID is stored. Prefer generateNextSessionId() + startGameWithSessionId().
   * @returns Object with session ID and transaction hash
   */
  async startGame(gameType: GameType, bet: bigint): Promise<{ sessionId: bigint; txHash?: string }> {
    const sessionId = this.generateNextSessionId();

    // Use the NonceManager to submit the transaction
    const result = await this.client.nonceManager.submitCasinoStartGame(gameType, bet, sessionId);

    return { sessionId, txHash: result.txHash };
  }

  /**
   * Send a move in the current game
   */
  async sendMove(sessionId: bigint, payload: Uint8Array): Promise<{ txHash?: string }> {
    const result = await this.client.nonceManager.submitCasinoGameMove(sessionId, payload);
    return { txHash: result.txHash };
  }

  /**
   * Toggle shield modifier
   */
  async toggleShield(): Promise<{ txHash?: string }> {
    const result = await this.client.nonceManager.submitCasinoToggleShield();
    return { txHash: result.txHash };
  }

  /**
   * Toggle double modifier
   */
  async toggleDouble(): Promise<{ txHash?: string }> {
    const result = await this.client.nonceManager.submitCasinoToggleDouble();
    return { txHash: result.txHash };
  }

  /**
   * Subscribe to game started events
   * @returns Unsubscribe function
   */
  onGameStarted(handler: (event: CasinoGameStartedEvent) => void): () => void {
    this.gameStartedHandlers.push(handler);
    return () => {
      const index = this.gameStartedHandlers.indexOf(handler);
      if (index !== -1) {
        this.gameStartedHandlers.splice(index, 1);
      }
    };
  }

  /**
   * Subscribe to game moved events
   * @returns Unsubscribe function
   */
  onGameMoved(handler: (event: CasinoGameMovedEvent) => void): () => void {
    this.gameMovedHandlers.push(handler);
    return () => {
      const index = this.gameMovedHandlers.indexOf(handler);
      if (index !== -1) {
        this.gameMovedHandlers.splice(index, 1);
      }
    };
  }

  /**
   * Subscribe to game completed events
   * @returns Unsubscribe function
   */
  onGameCompleted(handler: (event: CasinoGameCompletedEvent) => void): () => void {
    this.gameCompletedHandlers.push(handler);
    return () => {
      const index = this.gameCompletedHandlers.indexOf(handler);
      if (index !== -1) {
        this.gameCompletedHandlers.splice(index, 1);
      }
    };
  }
}
