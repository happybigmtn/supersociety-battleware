import * as ed from '@noble/ed25519';

// --- TYPES ---

export const GameType = {
    BACCARAT: 0,
    BLACKJACK: 1,
    CASINO_WAR: 2,
    CRAPS: 3,
    VIDEO_POKER: 4,
    HILO: 5,
    ROULETTE: 6,
    SIC_BO: 7,
    THREE_CARD: 8,
    ULTIMATE_HOLDEM: 9,
} as const;

export type GameTypeValue = typeof GameType[keyof typeof GameType];

export interface Action {
    type: 'Register' | 'Deposit' | 'StartGame' | 'GameMove';
    payload: any;
}

export interface Transaction {
    nonce: bigint;
    action: Action;
    publicKey: Uint8Array;
    signature: Uint8Array;
}

export interface Player {
    chips: number;
    shields: number;
    doubles: number;
    rank: number;
    name: string;
}

export interface Session {
    id: string;
    player: string;
    game_type: number;
    bet: number;
    state_blob: string; // hex
    is_complete?: boolean;
}

// Card representation
export interface Card {
    rank: string;  // '2'-'10', 'J', 'Q', 'K', 'A'
    suit: string;  // '♠', '♥', '♦', '♣'
    value: number; // 0-51
}

function toHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
}

// --- CARD UTILITIES ---

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUITS = ['♠', '♥', '♦', '♣'];

export function decodeCard(cardValue: number): Card {
    const rank = RANKS[cardValue % 13];
    const suit = SUITS[Math.floor(cardValue / 13)];
    return { rank, suit, value: cardValue };
}

export function getCardValue(card: Card): number {
    const rankIdx = RANKS.indexOf(card.rank);
    if (rankIdx <= 8) return rankIdx + 2; // 2-10
    if (rankIdx <= 11) return 10; // J, Q, K
    return 11; // Ace (simplified)
}

// --- STATE PARSERS ---

export interface BlackjackState {
    playerCards: Card[];
    dealerCards: Card[];
    isComplete: boolean;
}

export function parseBlackjackState(hexBlob: string): BlackjackState | null {
    if (!hexBlob || hexBlob.length === 0) return null;
    const bytes = fromHex(hexBlob);
    if (bytes.length < 4) return null;

    const pLen = bytes[0];
    const playerCards: Card[] = [];
    for (let i = 0; i < pLen; i++) {
        playerCards.push(decodeCard(bytes[1 + i]));
    }

    const dLenIdx = 1 + pLen;
    const dLen = bytes[dLenIdx];
    const dealerCards: Card[] = [];
    for (let i = 0; i < dLen; i++) {
        dealerCards.push(decodeCard(bytes[dLenIdx + 1 + i]));
    }

    return { playerCards, dealerCards, isComplete: false };
}

export interface HiLoState {
    currentCard: Card;
    accumulator: number;
    isComplete: boolean;
}

export function parseHiLoState(hexBlob: string): HiLoState | null {
    if (!hexBlob || hexBlob.length < 2) return null;
    const bytes = fromHex(hexBlob);
    // HiLo state: [current_card, accumulator_bytes...]
    const currentCard = decodeCard(bytes[0]);
    // Accumulator is stored as i64 (8 bytes) - simplified parsing
    let accumulator = 0;
    if (bytes.length >= 9) {
        const view = new DataView(bytes.buffer);
        accumulator = Number(view.getBigInt64(1, false));
    }
    return { currentCard, accumulator, isComplete: false };
}

export interface BaccaratState {
    playerCards: Card[];
    bankerCards: Card[];
    stage: 'BETTING' | 'DEALT' | 'COMPLETE';
    result?: 'PLAYER' | 'BANKER' | 'TIE';
}

export function parseBaccaratState(hexBlob: string): BaccaratState | null {
    if (!hexBlob || hexBlob.length === 0) return null;
    const bytes = fromHex(hexBlob);
    // Baccarat: [stage, pCard1, pCard2, pCard3?, bCard1, bCard2, bCard3?]
    const stage = bytes[0];
    const playerCards: Card[] = [];
    const bankerCards: Card[] = [];

    // Simple parsing - stage 0=betting, 1=dealt, 2=complete
    if (bytes.length > 1) {
        // Parse player cards (positions 1-3)
        for (let i = 1; i <= 3 && i < bytes.length; i++) {
            if (bytes[i] !== 255) playerCards.push(decodeCard(bytes[i]));
        }
        // Parse banker cards (positions 4-6)
        for (let i = 4; i <= 6 && i < bytes.length; i++) {
            if (bytes[i] !== 255) bankerCards.push(decodeCard(bytes[i]));
        }
    }

    return {
        playerCards,
        bankerCards,
        stage: stage === 0 ? 'BETTING' : stage === 1 ? 'DEALT' : 'COMPLETE'
    };
}

export interface VideoPokerState {
    cards: Card[];
    held: boolean[];
    stage: 'DEAL' | 'DRAW' | 'COMPLETE';
}

export function parseVideoPokerState(hexBlob: string): VideoPokerState | null {
    if (!hexBlob || hexBlob.length === 0) return null;
    const bytes = fromHex(hexBlob);
    // VideoPoker: [stage, card1-5, holdMask]
    const stage = bytes[0];
    const cards: Card[] = [];
    for (let i = 1; i <= 5 && i < bytes.length; i++) {
        cards.push(decodeCard(bytes[i]));
    }
    const holdMask = bytes.length > 6 ? bytes[6] : 0;
    const held = [
        (holdMask & 1) !== 0,
        (holdMask & 2) !== 0,
        (holdMask & 4) !== 0,
        (holdMask & 8) !== 0,
        (holdMask & 16) !== 0,
    ];
    return {
        cards,
        held,
        stage: stage === 0 ? 'DEAL' : stage === 1 ? 'DRAW' : 'COMPLETE'
    };
}

export interface ThreeCardState {
    playerCards: Card[];
    dealerCards: Card[];
    stage: 'BETTING' | 'DEALT' | 'COMPLETE';
}

export function parseThreeCardState(hexBlob: string): ThreeCardState | null {
    if (!hexBlob || hexBlob.length === 0) return null;
    const bytes = fromHex(hexBlob);
    // ThreeCard: [stage, p1, p2, p3, d1, d2, d3, ...]
    const stage = bytes[0];
    const playerCards = [1, 2, 3].map(i => decodeCard(bytes[i] || 0));
    const dealerCards = [4, 5, 6].map(i => decodeCard(bytes[i] || 0));
    return {
        playerCards,
        dealerCards,
        stage: stage === 0 ? 'BETTING' : stage === 1 ? 'DEALT' : 'COMPLETE'
    };
}

export interface UltimateHoldemState {
    playerCards: Card[];
    dealerCards: Card[];
    communityCards: Card[];
    stage: 'BETTING' | 'PREFLOP' | 'FLOP' | 'RIVER' | 'SHOWDOWN' | 'COMPLETE';
}

export function parseUltimateHoldemState(hexBlob: string): UltimateHoldemState | null {
    if (!hexBlob || hexBlob.length === 0) return null;
    const bytes = fromHex(hexBlob);
    // UH: [stage, p1, p2, d1, d2, c1, c2, c3, c4, c5, ...]
    const stageVal = bytes[0];
    const stages = ['BETTING', 'PREFLOP', 'FLOP', 'RIVER', 'SHOWDOWN', 'COMPLETE'] as const;
    const stage = stages[Math.min(stageVal, 5)];

    const playerCards = bytes.length > 2 ? [decodeCard(bytes[1]), decodeCard(bytes[2])] : [];
    const dealerCards = bytes.length > 4 ? [decodeCard(bytes[3]), decodeCard(bytes[4])] : [];
    const communityCards: Card[] = [];
    for (let i = 5; i < 10 && i < bytes.length; i++) {
        if (bytes[i] !== 255) communityCards.push(decodeCard(bytes[i]));
    }

    return { playerCards, dealerCards, communityCards, stage };
}

export interface RouletteState {
    bets: { type: string; amount: number; number?: number }[];
    lastResult?: number;
    stage: 'BETTING' | 'SPINNING' | 'COMPLETE';
}

export function parseRouletteState(hexBlob: string): RouletteState | null {
    if (!hexBlob || hexBlob.length === 0) return null;
    const bytes = fromHex(hexBlob);
    // Simplified: [stage, lastResult, betCount, ...bets]
    const stage = bytes[0] === 0 ? 'BETTING' : bytes[0] === 1 ? 'SPINNING' : 'COMPLETE';
    const lastResult = bytes.length > 1 ? (bytes[1] === 255 ? undefined : bytes[1]) : undefined;
    return { bets: [], lastResult, stage };
}

export interface CasinoWarState {
    playerCard: Card | null;
    dealerCard: Card | null;
    stage: 'BETTING' | 'DEALT' | 'WAR' | 'COMPLETE';
}

export function parseCasinoWarState(hexBlob: string): CasinoWarState | null {
    if (!hexBlob || hexBlob.length === 0) return null;
    const bytes = fromHex(hexBlob);
    // CasinoWar: [pCard, dCard, stage]
    const playerCard = bytes.length > 0 && bytes[0] !== 255 ? decodeCard(bytes[0]) : null;
    const dealerCard = bytes.length > 1 && bytes[1] !== 255 ? decodeCard(bytes[1]) : null;
    const stageVal = bytes.length > 2 ? bytes[2] : 0;
    const stages = ['BETTING', 'DEALT', 'WAR', 'COMPLETE'] as const;
    return { playerCard, dealerCard, stage: stages[Math.min(stageVal, 3)] };
}

// --- SERIALIZATION (MATCHING RUST) ---

const writeU64 = (view: DataView, offset: number, value: bigint) => {
    view.setBigUint64(offset, value, false); // Big Endian (Network)
    return 8;
};

const writeU32 = (view: DataView, offset: number, value: number) => {
    view.setUint32(offset, value, false); // Big Endian
    return 4;
};

const serializeAction = (action: Action): Uint8Array => {
    let size = 1; // Type tag
    if (action.type === 'Register') {
        const nameBytes = new TextEncoder().encode(action.payload.name);
        size += 4 + nameBytes.length;
        const buf = new Uint8Array(size);
        const view = new DataView(buf.buffer);
        buf[0] = 0;
        writeU32(view, 1, nameBytes.length);
        buf.set(nameBytes, 5);
        return buf;
    } else if (action.type === 'Deposit') {
        size += 8;
        const buf = new Uint8Array(size);
        const view = new DataView(buf.buffer);
        buf[0] = 1;
        writeU64(view, 1, BigInt(action.payload.amount));
        return buf;
    } else if (action.type === 'StartGame') {
        size += 1 + 8 + 8;
        const buf = new Uint8Array(size);
        const view = new DataView(buf.buffer);
        buf[0] = 2;
        buf[1] = action.payload.game;
        writeU64(view, 2, BigInt(action.payload.bet));
        writeU64(view, 10, BigInt(action.payload.sessionId));
        return buf;
    } else if (action.type === 'GameMove') {
        const p = action.payload.payload; // Uint8Array
        size += 8 + 4 + p.length;
        const buf = new Uint8Array(size);
        const view = new DataView(buf.buffer);
        buf[0] = 3;
        writeU64(view, 1, BigInt(action.payload.sessionId));
        writeU32(view, 9, p.length);
        buf.set(p, 13);
        return buf;
    }
    throw new Error("Unknown Action");
};

const serializeTransactionPayload = (nonce: bigint, actionBytes: Uint8Array, pubKey: Uint8Array): Uint8Array => {
    const size = 8 + actionBytes.length + 32;
    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer);
    
    // Nonce
    writeU64(view, 0, nonce);
    
    // Action
    buf.set(actionBytes, 8);
    
    // PublicKey
    buf.set(pubKey, 8 + actionBytes.length);
    
    return buf;
};

const serializeTransaction = (nonce: bigint, actionBytes: Uint8Array, pubKey: Uint8Array, sig: Uint8Array): Uint8Array => {
    const size = 8 + actionBytes.length + 32 + 64;
    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer);
    
    writeU64(view, 0, nonce);
    buf.set(actionBytes, 8);
    buf.set(pubKey, 8 + actionBytes.length);
    buf.set(sig, 8 + actionBytes.length + 32);
    
    return buf;
};

// --- SERVICE ---

const CHAIN_URL = "http://127.0.0.1:3005"; // Local validator

// In-memory key storage
let privateKey: Uint8Array | null = null;
let publicKey: Uint8Array | null = null;
let nonce = 0n;

export const ChainService = {
    async init() {
        if (!privateKey) {
            // Polyfill for Node or Browser
            if (globalThis.crypto && globalThis.crypto.getRandomValues) {
                privateKey = new Uint8Array(32);
                globalThis.crypto.getRandomValues(privateKey);
            } else {
                // Fallback
                const { randomBytes } = await import('node:crypto');
                privateKey = new Uint8Array(randomBytes(32));
            }
            publicKey = await ed.getPublicKeyAsync(privateKey);
            nonce = BigInt(Date.now()); // Simple nonce
        }
        return { publicKey };
    },

    async register(name: string) {
        await this.submit({ type: 'Register', payload: { name } });
    },

    async deposit(amount: number) {
        await this.submit({ type: 'Deposit', payload: { amount } });
    },

    async startGame(game: GameTypeValue, bet: number, sessionId: bigint) {
        if (typeof game !== 'number') {
            console.error("Invalid GameType:", game);
            throw new Error("Invalid GameType (must be number)");
        }
        await this.submit({ type: 'StartGame', payload: { game, bet, sessionId } });
    },

    async gameMove(sessionId: bigint, payload: Uint8Array) {
        await this.submit({ type: 'GameMove', payload: { sessionId, payload } });
    },

    async blackjackMove(sessionId: bigint, action: 'HIT' | 'STAND' | 'DOUBLE') {
        const payload = new Uint8Array(1);
        if (action === 'HIT') payload[0] = 0;
        else if (action === 'STAND') payload[0] = 1;
        else if (action === 'DOUBLE') payload[0] = 2;
        await this.gameMove(sessionId, payload);
    },

    // HiLo: 0=Higher, 1=Lower, 2=Cashout
    async hiloMove(sessionId: bigint, action: 'HIGHER' | 'LOWER' | 'CASHOUT') {
        const payload = new Uint8Array(1);
        if (action === 'HIGHER') payload[0] = 0;
        else if (action === 'LOWER') payload[0] = 1;
        else if (action === 'CASHOUT') payload[0] = 2;
        await this.gameMove(sessionId, payload);
    },

    // Baccarat: 0=Player, 1=Banker, 2=Tie
    async baccaratMove(sessionId: bigint, bet: 'PLAYER' | 'BANKER' | 'TIE') {
        const payload = new Uint8Array(1);
        if (bet === 'PLAYER') payload[0] = 0;
        else if (bet === 'BANKER') payload[0] = 1;
        else if (bet === 'TIE') payload[0] = 2;
        await this.gameMove(sessionId, payload);
    },

    // VideoPoker: Initial deal = empty, Draw = indices to HOLD
    async videoPokerDeal(sessionId: bigint) {
        // Empty payload triggers initial deal
        await this.gameMove(sessionId, new Uint8Array(0));
    },

    async videoPokerDraw(sessionId: bigint, heldIndices: number[]) {
        const payload = new Uint8Array(heldIndices.length);
        heldIndices.forEach((idx, i) => payload[i] = idx);
        await this.gameMove(sessionId, payload);
    },

    // ThreeCardPoker: 0=Deal, 1=Play, 2=Fold, 3=PairPlus(+8 byte amount)
    async threeCardDeal(sessionId: bigint) {
        await this.gameMove(sessionId, new Uint8Array([0]));
    },

    async threeCardPlay(sessionId: bigint) {
        await this.gameMove(sessionId, new Uint8Array([1]));
    },

    async threeCardFold(sessionId: bigint) {
        await this.gameMove(sessionId, new Uint8Array([2]));
    },

    async threeCardPairPlus(sessionId: bigint, amount: bigint) {
        const payload = new Uint8Array(9);
        const view = new DataView(payload.buffer);
        payload[0] = 3;
        view.setBigUint64(1, amount, false);
        await this.gameMove(sessionId, payload);
    },

    // UltimateHoldem: 0=Deal, 1=Check, 2=Bet4x, 3=Bet3x, 4=Bet2x, 5=Bet1x, 6=Fold
    async uhDeal(sessionId: bigint) {
        await this.gameMove(sessionId, new Uint8Array([0]));
    },

    async uhCheck(sessionId: bigint) {
        await this.gameMove(sessionId, new Uint8Array([1]));
    },

    async uhBet(sessionId: bigint, multiplier: 1 | 2 | 3 | 4) {
        const actionMap: Record<number, number> = { 4: 2, 3: 3, 2: 4, 1: 5 };
        await this.gameMove(sessionId, new Uint8Array([actionMap[multiplier]]));
    },

    async uhFold(sessionId: bigint) {
        await this.gameMove(sessionId, new Uint8Array([6]));
    },

    // Roulette: 0=PlaceBet(+bet_type+target+amount), 1=Spin, 2=ClearBets
    async roulettePlaceBet(sessionId: bigint, betType: number, target: number, amount: bigint) {
        const payload = new Uint8Array(11);
        const view = new DataView(payload.buffer);
        payload[0] = 0; // PlaceBet
        payload[1] = betType;
        payload[2] = target === -1 ? 255 : target;
        view.setBigUint64(3, amount, false);
        await this.gameMove(sessionId, payload);
    },

    async rouletteSpin(sessionId: bigint) {
        await this.gameMove(sessionId, new Uint8Array([1]));
    },

    async rouletteClearBets(sessionId: bigint) {
        await this.gameMove(sessionId, new Uint8Array([2]));
    },

    // Craps: 0=Roll, 1=Bet(+type+amount)
    async crapsRoll(sessionId: bigint) {
        await this.gameMove(sessionId, new Uint8Array([0]));
    },

    async crapsPlaceBet(sessionId: bigint, betType: number, amount: bigint) {
        const payload = new Uint8Array(10);
        const view = new DataView(payload.buffer);
        payload[0] = 1; // Bet action
        payload[1] = betType;
        view.setBigUint64(2, amount, false);
        await this.gameMove(sessionId, payload);
    },

    // SicBo: 0=PlaceBet(+type+target+target2+amount), 1=Roll, 2=ClearBets
    async sicBoPlaceBet(sessionId: bigint, betType: number, target: number, target2: number, amount: bigint) {
        const payload = new Uint8Array(12);
        const view = new DataView(payload.buffer);
        payload[0] = 0; // PlaceBet
        payload[1] = betType;
        payload[2] = target;
        payload[3] = target2;
        view.setBigUint64(4, amount, false);
        await this.gameMove(sessionId, payload);
    },

    async sicBoRoll(sessionId: bigint) {
        await this.gameMove(sessionId, new Uint8Array([1]));
    },

    async sicBoClearBets(sessionId: bigint) {
        await this.gameMove(sessionId, new Uint8Array([2]));
    },

    // CasinoWar: empty=initial deal, 0=Surrender, 1=GoToWar
    async casinoWarDeal(sessionId: bigint) {
        await this.gameMove(sessionId, new Uint8Array(0));
    },

    async casinoWarSurrender(sessionId: bigint) {
        await this.gameMove(sessionId, new Uint8Array([0]));
    },

    async casinoWarGoToWar(sessionId: bigint) {
        await this.gameMove(sessionId, new Uint8Array([1]));
    },

    async submit(action: Action) {
        if (!privateKey || !publicKey) await this.init();
        
        nonce++;
        const actionBytes = serializeAction(action);
        const payloadToSign = serializeTransactionPayload(nonce, actionBytes, publicKey!);
        const signature = await ed.signAsync(payloadToSign, privateKey!);
        
        const txBytes = serializeTransaction(nonce, actionBytes, publicKey!, signature);
        
        // Log hex for debugging
        const hex = Array.from(txBytes).map(b => b.toString(16).padStart(2, '0')).join('');
        console.log(`[ChainService] Submitting Tx (Nonce: ${nonce}):`, hex);

        const res = await fetch(`${CHAIN_URL}/submit`, {
            method: 'POST',
            body: txBytes,
            headers: { 'Content-Type': 'application/octet-stream' }
        });
        
        if (!res.ok) {
            console.error(`[ChainService] Tx Failed: ${res.status} ${res.statusText}`);
            throw new Error("Transaction Failed");
        }
    },

    async getPublicKeyHex() {
        if (!publicKey) await this.init();
        return toHex(publicKey!);
    },

    async getPlayer(publicKeyHex: string): Promise<Player | null> {
        try {
            const res = await fetch(`${CHAIN_URL}/player/${publicKeyHex}`);
            if (!res.ok) return null;
            return await res.json();
        } catch (e) {
            console.error("Failed to fetch player:", e);
            return null;
        }
    },

    async getSession(sessionId: string): Promise<Session | null> {
        try {
            const res = await fetch(`${CHAIN_URL}/session/${sessionId}`);
            if (!res.ok) return null;
            return await res.json();
        } catch (e) {
            console.error("Failed to fetch session:", e);
            return null;
        }
    },
};