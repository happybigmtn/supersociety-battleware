/**
 * Casino Types
 * TypeScript types matching the Rust casino implementation
 */

/**
 * GameType enum matching Rust enum (types/src/casino.rs)
 */
export enum GameType {
  Baccarat = 0,
  Blackjack = 1,
  CasinoWar = 2,
  Craps = 3,
  VideoPoker = 4,
  HiLo = 5,
  Roulette = 6,
  SicBo = 7,
  ThreeCard = 8,
  UltimateHoldem = 9,
}

/**
 * Player state on-chain
 */
export interface Player {
  nonce: bigint;
  name: string;
  chips: bigint;
  shields: number;
  doubles: number;
  rank: number;
  activeShield: boolean;
  activeDouble: boolean;
  activeSession: bigint | null;
  lastDepositBlock: bigint;
}

/**
 * Game session state
 */
export interface GameSession {
  id: bigint;
  player: Uint8Array;
  gameType: GameType;
  bet: bigint;
  stateBlob: Uint8Array;
  moveCount: number;
  createdAt: bigint;
  isComplete: boolean;
}

/**
 * Leaderboard entry
 */
export interface LeaderboardEntry {
  player: Uint8Array;
  name: string;
  chips: bigint;
  rank: number;
}

/**
 * Casino leaderboard
 */
export interface CasinoLeaderboard {
  entries: LeaderboardEntry[];
}

/**
 * Event: CasinoGameStarted (tag 21)
 * Emitted when a new game session is started
 */
export interface CasinoGameStartedEvent {
  type: 'CasinoGameStarted';
  sessionId: bigint;
  player: Uint8Array;
  gameType: GameType;
  bet: bigint;
  initialState: Uint8Array;
}

/**
 * Event: CasinoGameMoved (tag 22)
 * Emitted when a move is made in a game session
 */
export interface CasinoGameMovedEvent {
  type: 'CasinoGameMoved';
  sessionId: bigint;
  moveNumber: number;
  newState: Uint8Array;
}

/**
 * Event: CasinoGameCompleted (tag 23)
 * Emitted when a game session is completed
 */
export interface CasinoGameCompletedEvent {
  type: 'CasinoGameCompleted';
  sessionId: bigint;
  player: Uint8Array;
  gameType: GameType;
  payout: bigint;
  finalChips: bigint;
  wasShielded: boolean;
  wasDoubled: boolean;
}
