/**
 * Game State Parsers
 * Parse binary state blobs from on-chain casino games into TypeScript objects
 *
 * All binary data uses Big Endian byte order (consistent with CasinoChainService)
 * State formats match the Rust implementations in execution/src/casino/*.rs
 */

import { GameType } from '../types/casino';

// ============================================================================
// Card Representation
// ============================================================================

export interface Card {
  suit: '♠' | '♥' | '♦' | '♣';
  rank: 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K';
  value: number;
}

const SUITS: Array<'♠' | '♥' | '♦' | '♣'> = ['♠', '♥', '♦', '♣'];
const RANKS: Array<'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K'> =
  ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

// Default card for malformed input
const DEFAULT_CARD: Card = { suit: '♠', rank: 'A', value: 11 };

/**
 * Convert card byte (0-51) to Card object
 * Card encoding: suit = card / 13, rank = (card % 13)
 * Suits: 0=♠, 1=♥, 2=♦, 3=♣
 * Ranks: 0=A, 1=2, ..., 12=K
 */
function parseCard(cardByte: number): Card {
  // Bounds check for invalid card bytes
  if (cardByte < 0 || cardByte >= 52) {
    return DEFAULT_CARD;
  }

  const suitIndex = Math.floor(cardByte / 13);
  const rankIndex = cardByte % 13;

  const suit = SUITS[suitIndex];
  const rank = RANKS[rankIndex];

  // Calculate value for display
  let value: number;
  if (rank === 'A') {
    value = 11; // Ace defaults to 11
  } else if (['J', 'Q', 'K'].includes(rank)) {
    value = 10;
  } else {
    value = parseInt(rank);
  }

  return { suit, rank, value };
}

// ============================================================================
// Blackjack State Parser
// ============================================================================

export interface BlackjackState {
  playerHand: Card[];
  dealerHand: Card[];
  stage: 'PLAYER_TURN' | 'DEALER_TURN' | 'COMPLETE';
}

/**
 * Blackjack State Format:
 * [pLen:u8] [pCards:u8×pLen] [dLen:u8] [dCards:u8×dLen] [stage:u8]
 */
export function parseBlackjackState(state: Uint8Array): BlackjackState {
  // Default safe state for malformed input
  if (!state || state.length < 3) {
    return { playerHand: [], dealerHand: [], stage: 'PLAYER_TURN' };
  }

  let offset = 0;

  // Read player hand length
  const playerLen = state[offset++];
  if (offset + playerLen >= state.length) {
    return { playerHand: [], dealerHand: [], stage: 'PLAYER_TURN' };
  }

  const playerHand: Card[] = [];
  for (let i = 0; i < playerLen && offset < state.length; i++) {
    playerHand.push(parseCard(state[offset++]));
  }

  // Read dealer hand length
  if (offset >= state.length) {
    return { playerHand, dealerHand: [], stage: 'PLAYER_TURN' };
  }
  const dealerLen = state[offset++];
  if (offset + dealerLen > state.length) {
    return { playerHand, dealerHand: [], stage: 'PLAYER_TURN' };
  }

  const dealerHand: Card[] = [];
  for (let i = 0; i < dealerLen && offset < state.length; i++) {
    dealerHand.push(parseCard(state[offset++]));
  }

  // Read stage
  if (offset >= state.length) {
    return { playerHand, dealerHand, stage: 'PLAYER_TURN' };
  }
  const stageValue = state[offset];
  const stage = stageValue === 0 ? 'PLAYER_TURN' :
                stageValue === 1 ? 'DEALER_TURN' : 'COMPLETE';

  return { playerHand, dealerHand, stage };
}

// ============================================================================
// Roulette State Parser
// ============================================================================

export interface RouletteState {
  result: number | null;
}

/**
 * Roulette State Format:
 * Empty before spin, [result:u8] after spin
 */
export function parseRouletteState(state: Uint8Array): RouletteState {
  if (!state || state.length === 0) {
    return { result: null };
  }

  return { result: state[0] };
}

// ============================================================================
// Baccarat State Parser
// ============================================================================

export interface BaccaratState {
  playerHand: Card[];
  bankerHand: Card[];
}

/**
 * Baccarat State Format:
 * [playerHandLen:u8] [playerCards:u8×n] [bankerHandLen:u8] [bankerCards:u8×n]
 */
export function parseBaccaratState(state: Uint8Array): BaccaratState {
  // Default safe state for malformed input
  if (!state || state.length < 2) {
    return { playerHand: [], bankerHand: [] };
  }

  let offset = 0;

  // Read player hand
  const playerLen = state[offset++];
  if (offset + playerLen >= state.length) {
    return { playerHand: [], bankerHand: [] };
  }

  const playerHand: Card[] = [];
  for (let i = 0; i < playerLen && offset < state.length; i++) {
    playerHand.push(parseCard(state[offset++]));
  }

  // Read banker hand
  if (offset >= state.length) {
    return { playerHand, bankerHand: [] };
  }
  const bankerLen = state[offset++];

  const bankerHand: Card[] = [];
  for (let i = 0; i < bankerLen && offset < state.length; i++) {
    bankerHand.push(parseCard(state[offset++]));
  }

  return { playerHand, bankerHand };
}

// ============================================================================
// Sic Bo State Parser
// ============================================================================

export interface SicBoState {
  dice: [number, number, number];
}

/**
 * Sic Bo State Format:
 * [die1:u8] [die2:u8] [die3:u8]
 */
export function parseSicBoState(state: Uint8Array): SicBoState {
  if (!state || state.length < 3) {
    return { dice: [0, 0, 0] };
  }

  return {
    dice: [state[0], state[1], state[2]]
  };
}

// ============================================================================
// Video Poker State Parser
// ============================================================================

export interface VideoPokerState {
  cards: [Card, Card, Card, Card, Card];
  stage: 'DEAL' | 'DRAW';
}

/**
 * Video Poker State Format:
 * [stage:u8] [card1:u8] [card2:u8] [card3:u8] [card4:u8] [card5:u8]
 */
export function parseVideoPokerState(state: Uint8Array): VideoPokerState {
  // Default safe state for malformed input
  if (!state || state.length < 6) {
    return {
      cards: [DEFAULT_CARD, DEFAULT_CARD, DEFAULT_CARD, DEFAULT_CARD, DEFAULT_CARD],
      stage: 'DEAL'
    };
  }

  const stageValue = state[0];
  const stage = stageValue === 0 ? 'DEAL' : 'DRAW';

  const cards: [Card, Card, Card, Card, Card] = [
    parseCard(state[1]),
    parseCard(state[2]),
    parseCard(state[3]),
    parseCard(state[4]),
    parseCard(state[5])
  ];

  return { cards, stage };
}

// ============================================================================
// Three Card Poker State Parser
// ============================================================================

export interface ThreeCardState {
  playerCards: [Card, Card, Card];
  dealerCards: [Card, Card, Card];
  stage: 'ANTE' | 'COMPLETE';
}

/**
 * Three Card Poker State Format:
 * [playerCard1:u8] [playerCard2:u8] [playerCard3:u8]
 * [dealerCard1:u8] [dealerCard2:u8] [dealerCard3:u8]
 * [stage:u8]
 */
export function parseThreeCardState(state: Uint8Array): ThreeCardState {
  // Default safe state for malformed input
  if (!state || state.length < 7) {
    return {
      playerCards: [DEFAULT_CARD, DEFAULT_CARD, DEFAULT_CARD],
      dealerCards: [DEFAULT_CARD, DEFAULT_CARD, DEFAULT_CARD],
      stage: 'ANTE'
    };
  }

  const playerCards: [Card, Card, Card] = [
    parseCard(state[0]),
    parseCard(state[1]),
    parseCard(state[2])
  ];

  const dealerCards: [Card, Card, Card] = [
    parseCard(state[3]),
    parseCard(state[4]),
    parseCard(state[5])
  ];

  const stageValue = state[6];
  const stage = stageValue === 0 ? 'ANTE' : 'COMPLETE';

  return { playerCards, dealerCards, stage };
}

// ============================================================================
// Ultimate Hold'em State Parser
// ============================================================================

export interface UltimateHoldemState {
  stage: 'PREFLOP' | 'FLOP' | 'RIVER' | 'SHOWDOWN';
  playerCards: [Card, Card];
  communityCards: [Card, Card, Card, Card, Card];
  dealerCards: [Card, Card];
  playBetMultiplier: number;
}

/**
 * Ultimate Hold'em State Format:
 * [stage:u8]
 * [playerCard1:u8] [playerCard2:u8]
 * [community1:u8] [community2:u8] [community3:u8] [community4:u8] [community5:u8]
 * [dealerCard1:u8] [dealerCard2:u8]
 * [playBetMultiplier:u8]
 */
export function parseUltimateHoldemState(state: Uint8Array): UltimateHoldemState {
  // Default safe state for malformed input
  if (!state || state.length < 11) {
    return {
      stage: 'PREFLOP',
      playerCards: [DEFAULT_CARD, DEFAULT_CARD],
      communityCards: [DEFAULT_CARD, DEFAULT_CARD, DEFAULT_CARD, DEFAULT_CARD, DEFAULT_CARD],
      dealerCards: [DEFAULT_CARD, DEFAULT_CARD],
      playBetMultiplier: 0
    };
  }

  const stageValue = state[0];
  const stage = stageValue === 0 ? 'PREFLOP' :
                stageValue === 1 ? 'FLOP' :
                stageValue === 2 ? 'RIVER' : 'SHOWDOWN';

  const playerCards: [Card, Card] = [
    parseCard(state[1]),
    parseCard(state[2])
  ];

  const communityCards: [Card, Card, Card, Card, Card] = [
    parseCard(state[3]),
    parseCard(state[4]),
    parseCard(state[5]),
    parseCard(state[6]),
    parseCard(state[7])
  ];

  const dealerCards: [Card, Card] = [
    parseCard(state[8]),
    parseCard(state[9])
  ];

  const playBetMultiplier = state[10];

  return {
    stage,
    playerCards,
    communityCards,
    dealerCards,
    playBetMultiplier
  };
}

// ============================================================================
// Casino War State Parser
// ============================================================================

export interface CasinoWarState {
  playerCard: Card;
  dealerCard: Card;
  stage: 'INITIAL' | 'WAR';
}

/**
 * Casino War State Format:
 * [playerCard:u8] [dealerCard:u8] [stage:u8]
 */
export function parseCasinoWarState(state: Uint8Array): CasinoWarState {
  // Default safe state for malformed input
  if (!state || state.length < 3) {
    return {
      playerCard: DEFAULT_CARD,
      dealerCard: DEFAULT_CARD,
      stage: 'INITIAL'
    };
  }

  const playerCard = parseCard(state[0]);
  const dealerCard = parseCard(state[1]);

  const stageValue = state[2];
  const stage = stageValue === 0 ? 'INITIAL' : 'WAR';

  return { playerCard, dealerCard, stage };
}

// ============================================================================
// HiLo State Parser
// ============================================================================

export interface HiLoState {
  currentCard: Card;
  accumulator: number; // Multiplier in basis points (10000 = 1.0x)
}

/**
 * HiLo State Format:
 * [currentCard:u8] [accumulator:i64 BE]
 */
export function parseHiLoState(state: Uint8Array): HiLoState {
  // Default safe state for malformed input
  if (!state || state.length < 9) {
    return {
      currentCard: DEFAULT_CARD,
      accumulator: 10000 // 1.0x multiplier
    };
  }

  const currentCard = parseCard(state[0]);

  // Read accumulator as i64 Big Endian
  const view = new DataView(state.buffer, state.byteOffset + 1, 8);
  const accumulator = Number(view.getBigInt64(0, false)); // false = Big Endian

  return { currentCard, accumulator };
}

// ============================================================================
// Craps State Parser
// ============================================================================

export type CrapsPhase = 'COME_OUT' | 'POINT';

export type CrapsBetType =
  | 'PASS' | 'DONT_PASS' | 'COME' | 'DONT_COME' | 'FIELD'
  | 'YES' | 'NO' | 'NEXT'
  | 'HARDWAY_4' | 'HARDWAY_6' | 'HARDWAY_8' | 'HARDWAY_10';

export type CrapsBetStatus = 'ON' | 'PENDING';

export interface CrapsBet {
  betType: CrapsBetType;
  target: number;
  status: CrapsBetStatus;
  amount: number;
  oddsAmount: number;
}

export interface CrapsState {
  phase: CrapsPhase;
  mainPoint: number;
  dice: [number, number];
  bets: CrapsBet[];
}

const CRAPS_BET_TYPES: CrapsBetType[] = [
  'PASS', 'DONT_PASS', 'COME', 'DONT_COME', 'FIELD',
  'YES', 'NO', 'NEXT',
  'HARDWAY_4', 'HARDWAY_6', 'HARDWAY_8', 'HARDWAY_10'
];

/**
 * Read a Big Endian u64 from bytes
 */
function readBigEndianU64(bytes: Uint8Array, offset: number): number {
  if (offset + 8 > bytes.length) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  return Number(view.getBigUint64(0, false)); // false = Big Endian
}

/**
 * Craps State Format:
 * [phase:u8] [main_point:u8] [d1:u8] [d2:u8] [bet_count:u8] [bets:CrapsBetEntry×count]
 *
 * Each CrapsBetEntry (19 bytes):
 * [bet_type:u8] [target:u8] [status:u8] [amount:u64 BE] [odds_amount:u64 BE]
 */
export function parseCrapsState(state: Uint8Array): CrapsState {
  // Default safe state for malformed input
  if (!state || state.length < 5) {
    return {
      phase: 'COME_OUT',
      mainPoint: 0,
      dice: [0, 0],
      bets: []
    };
  }

  const phase: CrapsPhase = state[0] === 0 ? 'COME_OUT' : 'POINT';
  const mainPoint = state[1];
  const dice: [number, number] = [state[2], state[3]];
  const betCount = state[4];

  // Validate we have enough bytes for all bets (19 bytes each)
  const expectedLength = 5 + (betCount * 19);
  if (state.length < expectedLength) {
    return { phase, mainPoint, dice, bets: [] };
  }

  const bets: CrapsBet[] = [];
  let offset = 5;

  for (let i = 0; i < betCount && offset + 19 <= state.length; i++) {
    const betTypeIndex = state[offset];
    const target = state[offset + 1];
    const statusByte = state[offset + 2];
    const amount = readBigEndianU64(state, offset + 3);
    const oddsAmount = readBigEndianU64(state, offset + 11);

    // Validate bet type index
    const betType: CrapsBetType = betTypeIndex < CRAPS_BET_TYPES.length
      ? CRAPS_BET_TYPES[betTypeIndex]
      : 'PASS';

    const status: CrapsBetStatus = statusByte === 0 ? 'ON' : 'PENDING';

    bets.push({ betType, target, status, amount, oddsAmount });
    offset += 19;
  }

  return { phase, mainPoint, dice, bets };
}

// ============================================================================
// Main Dispatcher Function
// ============================================================================

export type ParsedGameState =
  | { type: GameType.Blackjack; state: BlackjackState }
  | { type: GameType.Roulette; state: RouletteState }
  | { type: GameType.Baccarat; state: BaccaratState }
  | { type: GameType.SicBo; state: SicBoState }
  | { type: GameType.VideoPoker; state: VideoPokerState }
  | { type: GameType.ThreeCard; state: ThreeCardState }
  | { type: GameType.UltimateHoldem; state: UltimateHoldemState }
  | { type: GameType.CasinoWar; state: CasinoWarState }
  | { type: GameType.HiLo; state: HiLoState }
  | { type: GameType.Craps; state: CrapsState };

/**
 * Parse game state based on game type
 * @param gameType The type of casino game
 * @param state Binary state blob from chain
 * @returns Parsed state object specific to the game type
 */
export function parseGameState(gameType: GameType, state: Uint8Array): ParsedGameState {
  switch (gameType) {
    case GameType.Blackjack:
      return { type: gameType, state: parseBlackjackState(state) };

    case GameType.Roulette:
      return { type: gameType, state: parseRouletteState(state) };

    case GameType.Baccarat:
      return { type: gameType, state: parseBaccaratState(state) };

    case GameType.SicBo:
      return { type: gameType, state: parseSicBoState(state) };

    case GameType.VideoPoker:
      return { type: gameType, state: parseVideoPokerState(state) };

    case GameType.ThreeCard:
      return { type: gameType, state: parseThreeCardState(state) };

    case GameType.UltimateHoldem:
      return { type: gameType, state: parseUltimateHoldemState(state) };

    case GameType.CasinoWar:
      return { type: gameType, state: parseCasinoWarState(state) };

    case GameType.HiLo:
      return { type: gameType, state: parseHiLoState(state) };

    case GameType.Craps:
      return { type: gameType, state: parseCrapsState(state) };

    default:
      throw new Error(`Unknown game type: ${gameType}`);
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get the numeric value of a card for Blackjack
 */
export function getBlackjackValue(cards: Card[]): number {
  let value = 0;
  let aces = 0;

  for (const card of cards) {
    if (card.rank === 'A') {
      aces++;
      value += 11;
    } else if (['J', 'Q', 'K'].includes(card.rank)) {
      value += 10;
    } else {
      value += parseInt(card.rank);
    }
  }

  // Adjust for aces
  while (value > 21 && aces > 0) {
    value -= 10;
    aces--;
  }

  return value;
}

/**
 * Get the Baccarat value of cards (mod 10)
 */
export function getBaccaratValue(cards: Card[]): number {
  let value = 0;

  for (const card of cards) {
    if (card.rank === 'A') {
      value += 1;
    } else if (['10', 'J', 'Q', 'K'].includes(card.rank)) {
      value += 0;
    } else {
      value += parseInt(card.rank);
    }
  }

  return value % 10;
}

/**
 * Get HiLo card rank (1-13, Ace=1, King=13)
 */
export function getHiLoRank(card: Card): number {
  if (card.rank === 'A') return 1;
  if (card.rank === 'K') return 13;
  if (card.rank === 'Q') return 12;
  if (card.rank === 'J') return 11;
  return parseInt(card.rank);
}

/**
 * Convert HiLo accumulator from basis points to multiplier
 * @param accumulator Value in basis points (10000 = 1.0x)
 * @returns Multiplier as decimal (e.g., 1.5 for 1.5x)
 */
export function hiloAccumulatorToMultiplier(accumulator: number): number {
  return accumulator / 10000;
}
