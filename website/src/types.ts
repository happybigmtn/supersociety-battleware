
export type Suit = '♠' | '♥' | '♦' | '♣';
export type Rank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K';

export interface Card {
  suit: Suit;
  rank: Rank;
  value: number;
  isHidden?: boolean;
}

export enum GameType {
  NONE = 'NONE',
  BACCARAT = 'BACCARAT',
  BLACKJACK = 'BLACKJACK',
  CASINO_WAR = 'CASINO_WAR',
  CRAPS = 'CRAPS',
  ROULETTE = 'ROULETTE',
  SIC_BO = 'SIC_BO',
  THREE_CARD = 'THREE_CARD',
  ULTIMATE_HOLDEM = 'ULTIMATE_HOLDEM',
  VIDEO_POKER = 'VIDEO_POKER',
  HILO = 'HILO',
}

export type TournamentPhase = 'REGISTRATION' | 'ACTIVE' | 'ELIMINATION';

export interface PlayerStats {
  chips: number;
  shields: number;
  doubles: number;
  rank: number;
  history: string[];
  pnlByGame: Record<string, number>;
  pnlHistory: number[];
}

export interface CompletedHand {
  cards: Card[];
  bet: number;
  result?: number; // Calculated after dealer plays
  message?: string;
  isDoubled?: boolean;
  surrendered?: boolean;
}

export interface CrapsBet {
  type: 'PASS' | 'DONT_PASS' | 'COME' | 'DONT_COME' | 'FIELD' | 'YES' | 'NO' | 'NEXT' | 'HARDWAY';
  amount: number;
  target?: number; // The number (e.g., 4 for a Place 4, or the Point for a Come bet)
  oddsAmount?: number; // Attached odds amount
  status?: 'PENDING' | 'ON'; // PENDING means Come bet waiting to travel
}

export interface BaccaratBet {
    type: 'TIE' | 'P_PAIR' | 'B_PAIR';
    amount: number;
}

export interface RouletteBet {
    type: 'STRAIGHT' | 'RED' | 'BLACK' | 'ODD' | 'EVEN' | 'LOW' | 'HIGH' | 'DOZEN_1' | 'DOZEN_2' | 'DOZEN_3' | 'COL_1' | 'COL_2' | 'COL_3' | 'ZERO';
    target?: number;
    amount: number;
}

export interface SicBoBet {
    type: 'BIG' | 'SMALL' | 'TRIPLE_ANY' | 'TRIPLE_SPECIFIC' | 'DOUBLE_SPECIFIC' | 'SUM' | 'SINGLE_DIE';
    target?: number;
    amount: number;
}

export interface GameState {
  type: GameType;
  message: string;
  bet: number;
  stage: 'BETTING' | 'PLAYING' | 'RESULT';
  playerCards: Card[]; // Represents the ACTIVE hand
  dealerCards: Card[];
  communityCards: Card[];
  dice: number[];
  
  // Craps
  crapsPoint: number | null;
  crapsBets: CrapsBet[];
  crapsUndoStack: CrapsBet[][]; // History of bet arrays for current turn
  crapsInputMode: 'NONE' | 'YES' | 'NO' | 'NEXT' | 'HARDWAY'; // Replaces string buffer
  crapsRollHistory: number[];
  
  // Roulette
  rouletteBets: RouletteBet[];
  rouletteUndoStack: RouletteBet[][]; // History of bets for current spin
  rouletteLastRoundBets: RouletteBet[]; // Bets from the previous spin (for rebet)
  rouletteHistory: number[];
  rouletteInputMode: 'NONE' | 'NUMBER';

  // Sic Bo
  sicBoBets: SicBoBet[];
  sicBoHistory: number[][]; // Array of dice triplets
  sicBoInputMode: 'NONE' | 'SINGLE' | 'DOUBLE' | 'TRIPLE' | 'SUM';
  sicBoUndoStack: SicBoBet[][];
  sicBoLastRoundBets: SicBoBet[];

  lastResult: number;
  activeModifiers: {
    shield: boolean;
    double: boolean;
  };
  
  // Baccarat
  baccaratSelection: 'PLAYER' | 'BANKER';
  baccaratBets: BaccaratBet[];
  baccaratUndoStack: BaccaratBet[][];
  baccaratLastRoundBets: BaccaratBet[];
  
  // Blackjack Specifics
  insuranceBet: number;
  blackjackStack: { cards: Card[], bet: number, isDoubled: boolean }[]; // Hands waiting to be played (Split)
  completedHands: CompletedHand[]; // Hands finished by player, waiting for dealer

  // HiLo
  hiloAccumulator: number;
  hiloGraphData: number[];
}

export interface LeaderboardEntry {
  name: string;
  chips: number;
  status: 'ALIVE' | 'ELIMINATED';
}
