
import { Card, Suit, Rank, CrapsBet, RouletteBet, SicBoBet, GameType, SuperMultiplier } from '../types';

// --- CONSTANTS ---
export const SUITS: Suit[] = ['♠', '♥', '♦', '♣'];
export const RANKS: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const WAYS: { [key: number]: number } = { 2:1, 3:2, 4:3, 5:4, 6:5, 7:6, 8:5, 9:4, 10:3, 11:2, 12:1 };

// Roulette Constants
export const ROULETTE_NUMBERS = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26
];
export const RED_NUMBERS = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];

interface HelpContent {
  title: string;
  win: string;
  loss: string;
  example: string;
}

export const HELP_CONTENT: Record<string, HelpContent> = {
    [GameType.BLACKJACK]: {
        title: "BLACKJACK",
        win: "Beat dealer's hand without going over 21. Blackjack (A+10/J/Q/K) pays 3:2.",
        loss: "Bust (over 21) or dealer has higher hand.",
        example: "Your Hand: K, 7 (17). Dealer: 6. Stand."
    },
    [GameType.CRAPS]: {
        title: "CRAPS",
        win: "Pass Line: Win on 7/11 (Come Out). Win if Point repeats before 7.",
        loss: "Pass Line: Lose on 2/3/12 (Come Out). Lose if 7 rolls before Point.",
        example: "Roll 4 (Point). Roll 4 again to win."
    },
    [GameType.ROULETTE]: {
        title: "ROULETTE",
        win: "Predict number/color where ball lands. Straight up pays 35:1.",
        loss: "Ball lands on unpicked number/color.",
        example: "Bet Red. Ball lands 32 (Red). Win 1:1."
    },
    [GameType.SIC_BO]: {
        title: "SIC BO",
        win: "Predict dice combinations. Small (4-10) / Big (11-17) pays 1:1.",
        loss: "Dice result doesn't match bet. Triples lose Small/Big bets.",
        example: "Bet Big. Roll 4-5-6 (15). Win."
    },
    [GameType.BACCARAT]: {
        title: "BACCARAT",
        win: "Bet on hand closest to 9. Player 1:1, Banker 0.95:1.",
        loss: "Selected hand lower than opponent.",
        example: "Player 7, Banker 6. Player wins."
    },
    [GameType.HILO]: {
        title: "HILO",
        win: "Guess if next card is Higher or Lower. Win accumulates in pot.",
        loss: "Incorrect guess loses accumulated pot.",
        example: "Card 5. Guess Higher. Next is J. Win."
    },
    [GameType.VIDEO_POKER]: {
        title: "VIDEO POKER",
        win: "Make poker hand (Jacks or Better+). Royal Flush pays 800x.",
        loss: "Hand lower than Pair of Jacks.",
        example: "Hold Pair of Kings. Draw 3 of a Kind. Win."
    },
    [GameType.THREE_CARD]: {
        title: "THREE CARD POKER",
        win: "Beat dealer with higher poker hand. Dealer needs Q-high to qualify.",
        loss: "Dealer has higher hand.",
        example: "You: Pair 8s. Dealer: A-K-2. You win."
    },
    [GameType.ULTIMATE_HOLDEM]: {
        title: "ULTIMATE TEXAS HOLDEM",
        win: "Beat dealer's best 5-card hand. Play bet multiplies based on street.",
        loss: "Dealer has higher hand.",
        example: "You: A-K. Flop: A-5-2. Bet 4x Pre-flop wins."
    },
    [GameType.CASINO_WAR]: {
        title: "CASINO WAR",
        win: "Higher card than dealer. Tie goes to War.",
        loss: "Lower card than dealer.",
        example: "You: King. Dealer: 10. Win."
    }
};

// --- DECK & RANDOM ---
export const createDeck = (): Card[] => {
  const deck: Card[] = [];
  SUITS.forEach(suit => {
    RANKS.forEach(rank => {
      let value = parseInt(rank);
      if (isNaN(value)) value = rank === 'A' ? 11 : 10;
      deck.push({ suit, rank, value });
    });
  });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
};

export const rollDie = () => Math.floor(Math.random() * 6) + 1;
export const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
export const randomItem = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

// --- SUPER MODE LOGIC ---
export const getSuperModeFee = (gameType: GameType, bet: number): number => {
    return Math.floor(bet * 0.20);
};

export const generateSuperMultipliers = (gameType: GameType): SuperMultiplier[] => {
    const mults: SuperMultiplier[] = [];
    
    if (gameType === GameType.ROULETTE) {
        // 1-5 numbers, 50x-500x
        const count = randomInt(1, 5);
        const used = new Set<number>();
        for (let i = 0; i < count; i++) {
            let num;
            do { num = randomInt(0, 36); } while (used.has(num));
            used.add(num);
            const m = randomItem([50, 100, 150, 200, 250, 300, 400, 500]);
            mults.push({ id: num.toString(), multiplier: m, type: 'NUMBER', label: `${num} x${m}` });
        }
    } else if (gameType === GameType.BACCARAT) {
        // 1-3 Lightning Cards, 2x-8x
        const count = randomInt(1, 3);
        const deck = createDeck(); 
        for (let i = 0; i < count; i++) {
            const c = deck[i];
            const m = randomItem([2, 3, 4, 5, 8]);
            mults.push({ id: `${c.rank}${c.suit}`, multiplier: m, type: 'CARD', label: `${c.rank}${c.suit} x${m}` });
        }
    } else if (gameType === GameType.CRAPS) {
        // 1-2 Lucky Totals (4,5,6,8,9,10), 2x-5x
        const points = [4, 5, 6, 8, 9, 10];
        const count = randomInt(1, 2);
        const used = new Set<number>();
        for (let i = 0; i < count; i++) {
            let p;
            do { p = randomItem(points); } while (used.has(p));
            used.add(p);
            const m = randomInt(2, 5);
            mults.push({ id: p.toString(), multiplier: m, type: 'TOTAL', label: `Total ${p} x${m}` });
        }
    } else if (gameType === GameType.SIC_BO) {
        // Lightning Triple (50x)
        const triple = randomInt(1, 6);
        mults.push({ id: `TRIPLE_${triple}`, multiplier: 50, type: 'TOTAL', label: `Triple ${triple}s x50` });
        
        // Aura Number (2x-5x for matches)
        let aura;
        do { aura = randomInt(1, 6); } while (aura === triple);
        mults.push({ id: `AURA_${aura}`, multiplier: 1, type: 'NUMBER', label: `Aura ${aura}` });
    } else if (gameType === GameType.CASINO_WAR) {
        // Lightning Rank
        const r = randomItem(RANKS);
        mults.push({ id: r, multiplier: 5, type: 'RANK', label: `${r}s x5` });
    } else if (gameType === GameType.THREE_CARD) {
        // Aura Card 
        const deck = createDeck();
        const c = deck[0];
        const isWild = Math.random() < 0.05;
        mults.push({ 
            id: 'AURA_CARD', 
            multiplier: isWild ? 999 : 2, 
            type: 'CARD', 
            label: isWild ? `WILD AURA ${c.rank}${c.suit}` : `AURA ${c.rank}${c.suit}`,
            meta: c 
        });
    } else if (gameType === GameType.ULTIMATE_HOLDEM) {
        // Flop Lightning Cards (1-3)
        const deck = createDeck();
        const count = randomInt(1, 3);
        for (let i = 0; i < count; i++) {
            const c = deck[i];
            const m = randomInt(2, 5);
            mults.push({ id: `${c.rank}${c.suit}`, multiplier: m, type: 'CARD', label: `${c.rank}${c.suit} x${m}` });
        }
        // Aura Suit
        const suit = randomItem(SUITS);
        mults.push({ id: `SUIT_${suit}`, multiplier: 5, type: 'SUIT', label: `Aura ${suit}` });
    } else if (gameType === GameType.VIDEO_POKER) {
        // Wild Lightning Card
        const deck = createDeck();
        const c = deck[0];
        mults.push({ 
            id: `WILD_${c.rank}${c.suit}`, 
            multiplier: 1, 
            type: 'CARD', 
            label: `WILD ${c.rank}${c.suit}`,
            meta: c 
        });
    } else if (gameType === GameType.HILO) {
        const deck = createDeck();
        const c = deck[0];
        mults.push({ 
            id: `LIGHTNING_${c.rank}${c.suit}`, 
            multiplier: 2, 
            type: 'CARD', 
            label: `L-CARD ${c.rank}${c.suit}`, 
            meta: c 
        });
    } else if (gameType === GameType.BLACKJACK) {
        // Multipliers are persistent, handled in hook logic
    }

    return mults;
};

// --- HAND VALUES ---
export const getHandValue = (cards: Card[]): number => {
  if (!cards || !Array.isArray(cards)) return 0;
  // Filter out undefined/null cards and cards with invalid values
  const validCards = cards.filter(c => c && typeof c.value === 'number' && !isNaN(c.value));
  let value = validCards.reduce((acc, c) => acc + c.value, 0);
  let aces = validCards.filter(c => c.rank === 'A').length;
  while (value > 21 && aces > 0) {
    value -= 10;
    aces--;
  }
  return value;
};

export const getBaccaratValue = (cards: Card[]): number => {
  if (!cards || !Array.isArray(cards)) return 0;
  // Filter out undefined/null cards
  const validCards = cards.filter(c => c && c.rank !== undefined);
  return validCards.reduce((acc, c) => {
    let val = c.value;
    if (c.rank === '10' || c.rank === 'J' || c.rank === 'Q' || c.rank === 'K') val = 0;
    if (c.rank === 'A') val = 1;
    return acc + val;
  }, 0) % 10;
};

export const getHiLoRank = (card: Card) => {
    if (card.rank === 'A') return 1;
    if (card.rank === 'K') return 13;
    if (card.rank === 'Q') return 12;
    if (card.rank === 'J') return 11;
    return parseInt(card.rank);
};

// Video Poker with Wild Card Support
export const evaluateVideoPokerHand = (cards: Card[], wildRank?: string, wildSuit?: string): { rank: string, multiplier: number, score: number } => {
  const wilds = cards.filter(c => 
      (wildRank && c.rank === wildRank) && (wildSuit && c.suit === wildSuit)
  );
  const nonWilds = cards.filter(c => 
      !((wildRank && c.rank === wildRank) && (wildSuit && c.suit === wildSuit))
  );
  
  const numWilds = wilds.length;

  const evaluateConcrete = (hand: Card[]) => {
      const getVal = (r: string) => {
        if (r === 'A') return 14;
        if (r === 'K') return 13;
        if (r === 'Q') return 12;
        if (r === 'J') return 11;
        return parseInt(r);
      };

      const pokerValues = hand.map(c => getVal(c.rank)).sort((a, b) => a - b);
      const suits = hand.map(c => c.suit);
      
      const isFlush = suits.every(s => s === suits[0]);
      let isStraight = true;
      for (let i = 0; i < pokerValues.length - 1; i++) {
        if (pokerValues[i+1] !== pokerValues[i] + 1) isStraight = false;
      }
      if (!isStraight && pokerValues[0] === 2 && pokerValues[1] === 3 && pokerValues[2] === 4 && pokerValues[3] === 5 && pokerValues[4] === 14) {
          isStraight = true;
      }
      
      const counts: Record<string, number> = {};
      hand.forEach(c => counts[c.rank] = (counts[c.rank] || 0) + 1);
      const countsArr = Object.values(counts).sort((a, b) => b - a);

      if (isFlush && isStraight) {
          if (pokerValues[0] === 10) return { rank: "ROYAL FLUSH", multiplier: 800, score: 9 };
          return { rank: "STRAIGHT FLUSH", multiplier: 50, score: 8 };
      }
      if (countsArr[0] === 4) return { rank: "FOUR OF A KIND", multiplier: 25, score: 7 };
      if (countsArr[0] === 3 && countsArr[1] === 2) return { rank: "FULL HOUSE", multiplier: 9, score: 6 };
      if (isFlush) return { rank: "FLUSH", multiplier: 6, score: 5 };
      if (isStraight) return { rank: "STRAIGHT", multiplier: 4, score: 4 };
      if (countsArr[0] === 3) return { rank: "THREE OF A KIND", multiplier: 3, score: 3 };
      if (countsArr[0] === 2 && countsArr[1] === 2) return { rank: "TWO PAIR", multiplier: 2, score: 2 };
      if (countsArr[0] === 2) {
          const pairRank = Object.keys(counts).find(r => counts[r] === 2);
          const val = getVal(pairRank!);
          if (val >= 11) return { rank: "JACKS OR BETTER", multiplier: 1, score: 1 };
      }
      return { rank: "HIGH CARD", multiplier: 0, score: 0 };
  };

  if (numWilds === 0) return evaluateConcrete(cards);

  let bestRes = { rank: "HIGH CARD", multiplier: 0, score: -1 };
  
  const iterateWildsFull = (idx: number, currentHand: Card[]) => {
      if (idx === numWilds) {
          const res = evaluateConcrete(currentHand);
          if (res.score > bestRes.score || (res.score === bestRes.score && res.multiplier > bestRes.multiplier)) {
              bestRes = res;
          }
          return;
      }
      const suitsToCheck: Suit[] = nonWilds.length > 0 ? [nonWilds[0].suit] : ['♠']; 
      
      for (const r of RANKS) {
          for (const s of suitsToCheck) {
             iterateWildsFull(idx + 1, [...currentHand, { rank: r, suit: s, value: 0 }]);
          }
      }
  };
  
  iterateWildsFull(0, nonWilds);
  return bestRes;
};

// Generic 5/7 Card Poker Evaluation (High Card to Royal Flush)
export const evaluatePokerHand = (cards: Card[]): { score: number, rank: string, best5: Card[] } => {
    const getVal = (r: string) => {
        if (r === 'A') return 14;
        if (r === 'K') return 13;
        if (r === 'Q') return 12;
        if (r === 'J') return 11;
        return parseInt(r);
    };

    if (cards.length > 5) {
        let bestScore = -1;
        let bestRes = null;
        
        const getCombinations = (arr: Card[], len: number): Card[][] => {
            if (len === 0) return [[]];
            if (arr.length < len) return [];
            const first = arr[0];
            const rest = arr.slice(1);
            const combsWithFirst = getCombinations(rest, len - 1).map(c => [first, ...c]);
            const combsWithoutFirst = getCombinations(rest, len);
            return [...combsWithFirst, ...combsWithoutFirst];
        };

        const combos = getCombinations(cards, 5);
        combos.forEach(hand => {
            const res = evaluatePokerHand(hand);
            if (res.score > bestScore) {
                bestScore = res.score;
                bestRes = res;
            }
        });
        return bestRes!;
    }

    const vals = cards.map(c => c.value = getVal(c.rank)).sort((a, b) => b - a); // Descending
    const suits = cards.map(c => c.suit);
    const isFlush = suits.every(s => s === suits[0]);
    
    let isStraight = true;
    for (let i = 0; i < vals.length - 1; i++) {
        if (vals[i] !== vals[i+1] + 1) isStraight = false;
    }
    // A-5 Straight
    if (!isStraight && vals[0] === 14 && vals[1] === 5 && vals[2] === 4 && vals[3] === 3 && vals[4] === 2) {
        isStraight = true;
    }

    const counts: Record<number, number> = {};
    vals.forEach(v => counts[v] = (counts[v] || 0) + 1);
    
    const groups: { val: number, count: number }[] = [];
    Object.keys(counts).forEach(k => groups.push({ val: parseInt(k), count: counts[parseInt(k)] }));
    groups.sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return b.val - a.val;
    });

    let rankStr = "HIGH CARD";
    let baseScore = 0; 

    if (isFlush && isStraight) {
        baseScore = 9;
        rankStr = vals[0] === 14 && vals[1] === 13 ? "ROYAL FLUSH" : "STRAIGHT FLUSH";
    } else if (groups[0].count === 4) {
        baseScore = 8;
        rankStr = "FOUR OF A KIND";
    } else if (groups[0].count === 3 && groups[1].count === 2) {
        baseScore = 7;
        rankStr = "FULL HOUSE";
    } else if (isFlush) {
        baseScore = 6;
        rankStr = "FLUSH";
    } else if (isStraight) {
        baseScore = 5;
        rankStr = "STRAIGHT";
    } else if (groups[0].count === 3) {
        baseScore = 4;
        rankStr = "THREE OF A KIND";
    } else if (groups[0].count === 2 && groups[1].count === 2) {
        baseScore = 3;
        rankStr = "TWO PAIR";
    } else if (groups[0].count === 2) {
        baseScore = 2;
        rankStr = "PAIR";
    } else {
        baseScore = 1;
        rankStr = "HIGH CARD";
    }

    let tieBreak = 0;
    if (baseScore === 5 || baseScore === 9) { 
        tieBreak = vals[0] === 14 && vals[4] === 2 ? 5 : vals[0]; 
    } else {
        groups.forEach((g, i) => {
            tieBreak += g.val * Math.pow(16, 4 - i);
        });
    }

    const score = (baseScore * Math.pow(16, 6)) + tieBreak;

    return { score, rank: rankStr, best5: cards };
};

export const evaluateThreeCardHand = (cards: Card[]): { score: number, rank: string, isPairPlus: boolean, pairPlusPayout: number, anteBonus: number } => {
    const getVal = (r: string) => {
        if (r === 'A') return 14;
        if (r === 'K') return 13;
        if (r === 'Q') return 12;
        if (r === 'J') return 11;
        return parseInt(r);
    };
    const vals = cards.map(c => getVal(c.rank)).sort((a, b) => b - a);
    const suits = cards.map(c => c.suit);
    const isFlush = suits.every(s => s === suits[0]);
    const isStraight = (vals[0] === vals[1] + 1 && vals[1] === vals[2] + 1) || (vals[0] === 14 && vals[1] === 3 && vals[2] === 2);
    
    const counts: Record<number, number> = {};
    vals.forEach(v => counts[v] = (counts[v] || 0) + 1);
    const groups = Object.values(counts).sort((a, b) => b - a);

    let score = 0;
    let rank = "HIGH CARD";
    let pairPlus = 0; 
    let anteBonus = 0; 

    if (isStraight && isFlush) {
        score = 6; rank = "STRAIGHT FLUSH";
        pairPlus = 40; anteBonus = 5;
    } else if (groups[0] === 3) {
        score = 5; rank = "THREE OF A KIND";
        pairPlus = 30; anteBonus = 4;
    } else if (isStraight) {
        score = 4; rank = "STRAIGHT";
        pairPlus = 6; anteBonus = 1;
    } else if (isFlush) {
        score = 3; rank = "FLUSH";
        pairPlus = 3; 
    } else if (groups[0] === 2) {
        score = 2; rank = "PAIR";
        pairPlus = 1; 
    } else {
        score = 1; rank = "HIGH CARD";
    }

    let tieBreak = 0;
    vals.forEach((v, i) => tieBreak += v * Math.pow(16, 2-i));
    
    return { score: (score * 100000) + tieBreak, rank, isPairPlus: pairPlus > 0, pairPlusPayout: pairPlus, anteBonus };
};


export const getVisibleHandValue = (cards: Card[]) => {
    if (!cards || !Array.isArray(cards)) return 0;
    return getHandValue(cards.filter(c => c && !c.isHidden));
};

export const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
};

// --- ROULETTE LOGIC ---
export const getRouletteColor = (num: number): 'RED' | 'BLACK' | 'GREEN' => {
    if (num === 0) return 'GREEN';
    return RED_NUMBERS.includes(num) ? 'RED' : 'BLACK';
};

export const getRouletteColumn = (num: number): number => {
    if (num === 0) return 0;
    return (num - 1) % 3 + 1;
};

export const calculateRouletteExposure = (outcome: number, bets: RouletteBet[]) => {
    let pnl = 0;
    const color = getRouletteColor(outcome);
    const column = outcome === 0 ? -1 : (outcome - 1) % 3; // 0, 1, 2 for columns
    const dozen = outcome === 0 ? -1 : Math.floor((outcome - 1) / 12); // 0, 1, 2 for dozens

    bets.forEach(bet => {
        let payoutMult = 0;

        if (bet.type === 'STRAIGHT' && bet.target === outcome) payoutMult = 35;
        else if (bet.type === 'RED' && color === 'RED') payoutMult = 1;
        else if (bet.type === 'BLACK' && color === 'BLACK') payoutMult = 1;
        else if (bet.type === 'ODD' && outcome !== 0 && outcome % 2 !== 0) payoutMult = 1;
        else if (bet.type === 'EVEN' && outcome !== 0 && outcome % 2 === 0) payoutMult = 1;
        else if (bet.type === 'LOW' && outcome >= 1 && outcome <= 18) payoutMult = 1;
        else if (bet.type === 'HIGH' && outcome >= 19 && outcome <= 36) payoutMult = 1;
        else if (bet.type === 'ZERO' && outcome === 0) payoutMult = 35;
        // Dozen bets: 1-12, 13-24, 25-36 (2:1 payout)
        else if (bet.type === 'DOZEN_1' && dozen === 0) payoutMult = 2;
        else if (bet.type === 'DOZEN_2' && dozen === 1) payoutMult = 2;
        else if (bet.type === 'DOZEN_3' && dozen === 2) payoutMult = 2;
        // Column bets: COL_1 = 1,4,7..., COL_2 = 2,5,8..., COL_3 = 3,6,9... (2:1 payout)
        else if (bet.type === 'COL_1' && column === 0) payoutMult = 2;
        else if (bet.type === 'COL_2' && column === 1) payoutMult = 2;
        else if (bet.type === 'COL_3' && column === 2) payoutMult = 2;
        // Inside bets
        else if (bet.type === 'SPLIT_H' && outcome !== 0 && bet.target !== undefined && (outcome === bet.target || outcome === bet.target + 1)) payoutMult = 17;
        else if (bet.type === 'SPLIT_V' && outcome !== 0 && bet.target !== undefined && (outcome === bet.target || outcome === bet.target + 3)) payoutMult = 17;
        else if (bet.type === 'STREET' && outcome !== 0 && bet.target !== undefined && outcome >= bet.target && outcome <= bet.target + 2) payoutMult = 11;
        else if (bet.type === 'CORNER' && outcome !== 0 && bet.target !== undefined && [bet.target, bet.target + 1, bet.target + 3, bet.target + 4].includes(outcome)) payoutMult = 8;
        else if (bet.type === 'SIX_LINE' && outcome !== 0 && bet.target !== undefined && outcome >= bet.target && outcome <= bet.target + 5) payoutMult = 5;

        if (payoutMult > 0) {
            pnl += bet.amount * payoutMult;
        } else {
            pnl -= bet.amount;
        }
    });

    return pnl;
};

/**
 * Resolves roulette bets after a spin, returning pnl and detailed results
 */
export const resolveRouletteBets = (
    outcome: number,
    bets: RouletteBet[],
    zeroRule: 'STANDARD' | 'LA_PARTAGE' | 'EN_PRISON' | 'EN_PRISON_DOUBLE' = 'STANDARD'
): { pnl: number; results: string[] } => {
    let pnl = 0;
    const results: string[] = [];
    const color = getRouletteColor(outcome);
    const column = outcome === 0 ? -1 : (outcome - 1) % 3;
    const dozen = outcome === 0 ? -1 : Math.floor((outcome - 1) / 12);

    bets.forEach(bet => {
        let payoutMult = 0;
        const isEvenMoney =
            bet.type === 'RED' || bet.type === 'BLACK' || bet.type === 'ODD' || bet.type === 'EVEN' || bet.type === 'LOW' || bet.type === 'HIGH';

        if (bet.type === 'STRAIGHT' && bet.target === outcome) payoutMult = 35;
        else if (bet.type === 'RED' && color === 'RED') payoutMult = 1;
        else if (bet.type === 'BLACK' && color === 'BLACK') payoutMult = 1;
        else if (bet.type === 'ODD' && outcome !== 0 && outcome % 2 !== 0) payoutMult = 1;
        else if (bet.type === 'EVEN' && outcome !== 0 && outcome % 2 === 0) payoutMult = 1;
        else if (bet.type === 'LOW' && outcome >= 1 && outcome <= 18) payoutMult = 1;
        else if (bet.type === 'HIGH' && outcome >= 19 && outcome <= 36) payoutMult = 1;
        else if (bet.type === 'ZERO' && outcome === 0) payoutMult = 35;
        else if (bet.type === 'DOZEN_1' && dozen === 0) payoutMult = 2;
        else if (bet.type === 'DOZEN_2' && dozen === 1) payoutMult = 2;
        else if (bet.type === 'DOZEN_3' && dozen === 2) payoutMult = 2;
        else if (bet.type === 'COL_1' && column === 0) payoutMult = 2;
        else if (bet.type === 'COL_2' && column === 1) payoutMult = 2;
        else if (bet.type === 'COL_3' && column === 2) payoutMult = 2;
        else if (bet.type === 'SPLIT_H' && outcome !== 0 && bet.target !== undefined && (outcome === bet.target || outcome === bet.target + 1)) payoutMult = 17;
        else if (bet.type === 'SPLIT_V' && outcome !== 0 && bet.target !== undefined && (outcome === bet.target || outcome === bet.target + 3)) payoutMult = 17;
        else if (bet.type === 'STREET' && outcome !== 0 && bet.target !== undefined && outcome >= bet.target && outcome <= bet.target + 2) payoutMult = 11;
        else if (bet.type === 'CORNER' && outcome !== 0 && bet.target !== undefined && [bet.target, bet.target + 1, bet.target + 3, bet.target + 4].includes(outcome)) payoutMult = 8;
        else if (bet.type === 'SIX_LINE' && outcome !== 0 && bet.target !== undefined && outcome >= bet.target && outcome <= bet.target + 5) payoutMult = 5;

        // French La Partage: half-back on zero for even-money bets.
        if (outcome === 0 && isEvenMoney) {
            const loss = zeroRule === 'LA_PARTAGE' ? Math.floor(bet.amount / 2) : bet.amount;
            pnl -= loss;
            results.push(`${bet.type} ${zeroRule === 'LA_PARTAGE' ? 'HALF' : 'LOSS'} (-$${loss})`);
            return;
        }

        if (payoutMult > 0) {
            const win = bet.amount * payoutMult;
            pnl += win;
            results.push(`${bet.type}${bet.target !== undefined ? ' ' + bet.target : ''} WIN (+$${win})`);
        } else {
            pnl -= bet.amount;
            results.push(`${bet.type}${bet.target !== undefined ? ' ' + bet.target : ''} LOSS (-$${bet.amount})`);
        }
    });

    return { pnl, results };
};

// --- CRAPS LOGIC ---

// True odds payout for PASS odds (matches on-chain craps.rs)
const crapsPassOddsPayout = (point: number, oddsAmount: number): number => {
    switch (point) {
        case 4:
        case 10:
            return oddsAmount * 2; // 2:1
        case 5:
        case 9:
            return Math.floor((oddsAmount * 3) / 2); // 3:2
        case 6:
        case 8:
            return Math.floor((oddsAmount * 6) / 5); // 6:5
        default: return 0;
    }
};

// True odds payout for DONT_PASS odds (inverse of pass odds)
const crapsDontPassOddsPayout = (point: number, oddsAmount: number): number => {
    switch (point) {
        case 4:
        case 10:
            return Math.floor(oddsAmount / 2); // 1:2
        case 5:
        case 9:
            return Math.floor((oddsAmount * 2) / 3); // 2:3
        case 6:
        case 8:
            return Math.floor((oddsAmount * 5) / 6); // 5:6
        default: return 0;
    }
};

const applyCrapsCommission1Pct = (winnings: number): number => winnings - Math.floor(winnings / 100);

// YES (Place) bet payout (profit only) with a 1% commission on winnings - matches on-chain rounding
const crapsYesPayout = (target: number, amount: number): number => {
    let trueOdds = 0;
    switch (target) {
        case 4:
        case 10:
            trueOdds = amount * 2; // 2:1
            break;
        case 5:
        case 9:
            trueOdds = Math.floor((amount * 3) / 2); // 3:2
            break;
        case 6:
        case 8:
            trueOdds = Math.floor((amount * 6) / 5); // 6:5
            break;
        default:
            trueOdds = amount;
    }
    return applyCrapsCommission1Pct(trueOdds);
};

// NO (Lay) bet payout (profit only) with a 1% commission on winnings - matches on-chain rounding
const crapsNoPayout = (target: number, amount: number): number => {
    let trueOdds = 0;
    switch (target) {
        case 4:
        case 10:
            trueOdds = Math.floor(amount / 2); // 1:2
            break;
        case 5:
        case 9:
            trueOdds = Math.floor((amount * 2) / 3); // 2:3
            break;
        case 6:
        case 8:
            trueOdds = Math.floor((amount * 5) / 6); // 5:6
            break;
        default:
            trueOdds = amount;
    }
    return applyCrapsCommission1Pct(trueOdds);
};

// BUY bet payout (profit only) - matches on-chain (commission charged separately at placement)
const crapsBuyPayout = (target: number, amount: number): number => {
    switch (target) {
        case 4: case 10: return amount * 2; // 2:1
        case 5: case 9: return Math.floor((amount * 3) / 2); // 3:2
        case 6: case 8: return Math.floor((amount * 6) / 5); // 6:5
        default: return 0;
    }
};

// NEXT (Hop) bet payout (profit only) with a 1% commission on winnings - matches on-chain rounding
const crapsNextPayout = (target: number, amount: number): number => {
    const ways = WAYS[target] || 0;
    let multiplier = 0;
    switch (ways) {
        case 1: multiplier = 35; break; // 2 or 12
        case 2: multiplier = 17; break; // 3 or 11
        case 3: multiplier = 11; break; // 4 or 10
        case 4: multiplier = 8; break;  // 5 or 9
        case 5: multiplier = 6; break;  // 6 or 8
        case 6: multiplier = 5; break;  // 7
        default: multiplier = 1;
    }
    const winnings = amount * multiplier;
    return applyCrapsCommission1Pct(winnings);
};

// Hardway bet payout - matches on-chain
const crapsHardwayPayout = (target: number, amount: number): number => {
    switch (target) {
        case 4: case 10: return amount * 7; // 7:1
        case 6: case 8: return amount * 9;  // 9:1
        default: return 0;
    }
};

const atsBitForTotal = (total: number): number => {
    switch (total) {
        case 2: return 1 << 0;
        case 3: return 1 << 1;
        case 4: return 1 << 2;
        case 5: return 1 << 3;
        case 6: return 1 << 4;
        case 8: return 1 << 5;
        case 9: return 1 << 6;
        case 10: return 1 << 7;
        case 11: return 1 << 8;
        case 12: return 1 << 9;
        default: return 0;
    }
};

const atsRequiredMask = (type: CrapsBet['type']): number => {
    const small = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4);
    const tall = (1 << 5) | (1 << 6) | (1 << 7) | (1 << 8) | (1 << 9);
    if (type === 'ATS_SMALL') return small;
    if (type === 'ATS_TALL') return tall;
    if (type === 'ATS_ALL') return small | tall;
    return 0;
};

const atsPayoutTo1 = (type: CrapsBet['type']): number => {
    if (type === 'ATS_SMALL') return 34;
    if (type === 'ATS_TALL') return 34;
    if (type === 'ATS_ALL') return 175;
    return 0;
};

// Overload to optionally specify hard roll explicitly
export const calculateCrapsExposure = (total: number, point: number | null, bets: CrapsBet[], forceHard?: boolean) => {
    let pnl = 0;
    // If forceHard is specified, use that; otherwise calculate from total
    const isHard = forceHard !== undefined ? forceHard : (total % 2 === 0 && total >= 4 && total <= 10);

    bets.forEach(bet => {
         let winAmount = 0;
         let loseAmount = 0;

         if (bet.type === 'PASS') {
              if (point === null) {
                  if (total === 7 || total === 11) winAmount = bet.amount;
                  else if (total === 2 || total === 3 || total === 12) loseAmount = bet.amount;
              } else {
                  if (total === point) {
                      winAmount = bet.amount;
                      if (bet.oddsAmount) winAmount += crapsPassOddsPayout(point, bet.oddsAmount);
                  } else if (total === 7) loseAmount = bet.amount + (bet.oddsAmount || 0);
              }
         } else if (bet.type === 'DONT_PASS') {
               if (point === null) {
                   if (total === 2 || total === 3) winAmount = bet.amount;
                   else if (total === 7 || total === 11) loseAmount = bet.amount;
                   // 12 is a push, no pnl change
               } else {
                   if (total === 7) {
                       winAmount = bet.amount;
                       if (bet.oddsAmount) winAmount += crapsDontPassOddsPayout(point, bet.oddsAmount);
                   } else if (total === point) loseAmount = bet.amount + (bet.oddsAmount || 0);
               }
         } else if (bet.type === 'COME') {
              // COME acts like PASS but on its own point
              if (bet.status === 'PENDING' || bet.target === undefined) {
                  // Pending - first roll for this bet
                  if (total === 7 || total === 11) winAmount = bet.amount;
                  else if (total === 2 || total === 3 || total === 12) loseAmount = bet.amount;
              } else {
                  // Has traveled to a point
                  if (total === bet.target) {
                      winAmount = bet.amount;
                      if (bet.oddsAmount) winAmount += crapsPassOddsPayout(bet.target, bet.oddsAmount);
                  } else if (total === 7) loseAmount = bet.amount + (bet.oddsAmount || 0);
              }
         } else if (bet.type === 'DONT_COME') {
               if (bet.status === 'PENDING' || bet.target === undefined) {
                   if (total === 2 || total === 3) winAmount = bet.amount;
                   else if (total === 7 || total === 11) loseAmount = bet.amount;
               } else {
                   if (total === 7) {
                       winAmount = bet.amount;
                       if (bet.oddsAmount) winAmount += crapsDontPassOddsPayout(bet.target, bet.oddsAmount);
                   } else if (total === bet.target) loseAmount = bet.amount + (bet.oddsAmount || 0);
               }
         } else if (bet.type === 'FIELD') {
              if ([2,12].includes(total)) winAmount = bet.amount * 2;
              else if ([3,4,9,10,11].includes(total)) winAmount = bet.amount;
              else loseAmount = bet.amount;
         } else if (bet.type === 'YES') {
              if (bet.target === total) winAmount = crapsYesPayout(bet.target, bet.amount);
              else if (total === 7) loseAmount = bet.amount;
         } else if (bet.type === 'NO') {
              if (total === 7) winAmount = crapsNoPayout(bet.target!, bet.amount);
              else if (bet.target === total) loseAmount = bet.amount;
         } else if (bet.type === 'BUY') {
              if (bet.target === total) winAmount = crapsBuyPayout(bet.target!, bet.amount);
              else if (total === 7) loseAmount = bet.amount;
         } else if (bet.type === 'NEXT') {
              if (total === bet.target) winAmount = crapsNextPayout(bet.target, bet.amount);
              else loseAmount = bet.amount;
         } else if (bet.type === 'HARDWAY') {
              const hardTarget = bet.target!;
              if (isHard && total === hardTarget) winAmount = crapsHardwayPayout(hardTarget, bet.amount);
              else if (total === hardTarget || total === 7) loseAmount = bet.amount;
              // Otherwise still working
         } else if (bet.type === 'ATS_SMALL' || bet.type === 'ATS_TALL' || bet.type === 'ATS_ALL') {
              const sevenOut = total === 7 && point !== null;
              if (sevenOut) {
                  loseAmount = bet.amount;
              } else {
                  const bit = atsBitForTotal(total);
                  const nextMask = (bet.progressMask || 0) | bit;
                  const required = atsRequiredMask(bet.type);
                  if (bit !== 0 && required !== 0 && (nextMask & required) === required) {
                      winAmount = bet.amount * atsPayoutTo1(bet.type);
                  }
              }
         }

         pnl += winAmount;
         if (loseAmount > 0) pnl -= loseAmount;
    });
    return pnl;
};

/**
 * Resolves craps bets after a roll, returning pnl and remaining bets
 * Bets are resolved (removed) when they win or lose
 * Uses the same payout calculations as on-chain craps.rs
 */
export const resolveCrapsBets = (
    totalOrDice: number | [number, number],
    point: number | null,
    bets: CrapsBet[]
): { pnl: number; remainingBets: CrapsBet[]; results: string[] } => {
    let pnl = 0;
    const remainingBets: CrapsBet[] = [];
    const results: string[] = [];
    const total = Array.isArray(totalOrDice) ? (totalOrDice[0] + totalOrDice[1]) : totalOrDice;
    const isHard = Array.isArray(totalOrDice) ? (totalOrDice[0] === totalOrDice[1]) : (total % 2 === 0);

    bets.forEach(bet => {
        let resolved = false;
        let winAmount = 0;
        let loseAmount = 0;

        if (bet.type === 'PASS') {
            if (point === null) {
                if (total === 7 || total === 11) { winAmount = bet.amount; resolved = true; }
                else if (total === 2 || total === 3 || total === 12) { loseAmount = bet.amount; resolved = true; }
            } else {
                if (total === point) {
                    winAmount = bet.amount;
                    if (bet.oddsAmount) winAmount += crapsPassOddsPayout(point, bet.oddsAmount);
                    resolved = true;
                } else if (total === 7) {
                    loseAmount = bet.amount + (bet.oddsAmount || 0);
                    resolved = true;
                }
            }
        } else if (bet.type === 'DONT_PASS') {
            if (point === null) {
                if (total === 2 || total === 3) { winAmount = bet.amount; resolved = true; }
                else if (total === 7 || total === 11) { loseAmount = bet.amount; resolved = true; }
                else if (total === 12) { resolved = true; } // Push
            } else {
                if (total === 7) {
                    winAmount = bet.amount;
                    if (bet.oddsAmount) winAmount += crapsDontPassOddsPayout(point, bet.oddsAmount);
                    resolved = true;
                } else if (total === point) {
                    loseAmount = bet.amount + (bet.oddsAmount || 0);
                    resolved = true;
                }
            }
        } else if (bet.type === 'COME') {
            if (bet.status === 'PENDING' || bet.target === undefined) {
                if (total === 7 || total === 11) { winAmount = bet.amount; resolved = true; }
                else if (total === 2 || total === 3 || total === 12) { loseAmount = bet.amount; resolved = true; }
                // Otherwise travels to point - handled elsewhere
            } else {
                if (total === bet.target) {
                    winAmount = bet.amount;
                    if (bet.oddsAmount) winAmount += crapsPassOddsPayout(bet.target, bet.oddsAmount);
                    resolved = true;
                } else if (total === 7) {
                    loseAmount = bet.amount + (bet.oddsAmount || 0);
                    resolved = true;
                }
            }
        } else if (bet.type === 'DONT_COME') {
            if (bet.status === 'PENDING' || bet.target === undefined) {
                if (total === 2 || total === 3) { winAmount = bet.amount; resolved = true; }
                else if (total === 7 || total === 11) { loseAmount = bet.amount; resolved = true; }
            } else {
                if (total === 7) {
                    winAmount = bet.amount;
                    if (bet.oddsAmount) winAmount += crapsDontPassOddsPayout(bet.target, bet.oddsAmount);
                    resolved = true;
                } else if (total === bet.target) {
                    loseAmount = bet.amount + (bet.oddsAmount || 0);
                    resolved = true;
                }
            }
        } else if (bet.type === 'FIELD') {
            if ([2, 12].includes(total)) winAmount = bet.amount * 2;
            else if ([3, 4, 9, 10, 11].includes(total)) winAmount = bet.amount;
            else loseAmount = bet.amount;
            resolved = true;
        } else if (bet.type === 'YES') {
            if (bet.target === total) { winAmount = crapsYesPayout(bet.target, bet.amount); resolved = true; }
            else if (total === 7) { loseAmount = bet.amount; resolved = true; }
        } else if (bet.type === 'NO') {
            if (total === 7) { winAmount = crapsNoPayout(bet.target!, bet.amount); resolved = true; }
            else if (bet.target === total) { loseAmount = bet.amount; resolved = true; }
        } else if (bet.type === 'BUY') {
            if (bet.target === total) { winAmount = crapsBuyPayout(bet.target!, bet.amount); resolved = true; }
            else if (total === 7) { loseAmount = bet.amount; resolved = true; }
        } else if (bet.type === 'NEXT') {
            if (total === bet.target) { winAmount = crapsNextPayout(bet.target, bet.amount); resolved = true; }
            else { loseAmount = bet.amount; resolved = true; }
        } else if (bet.type === 'HARDWAY') {
            const hardTarget = bet.target!;
            if (isHard && total === hardTarget) { winAmount = crapsHardwayPayout(hardTarget, bet.amount); resolved = true; }
            else if (total === hardTarget || total === 7) { loseAmount = bet.amount; resolved = true; }
        } else if (bet.type === 'ATS_SMALL' || bet.type === 'ATS_TALL' || bet.type === 'ATS_ALL') {
            const sevenOut = total === 7 && point !== null;
            if (sevenOut) {
                loseAmount = bet.amount;
                resolved = true;
            } else {
                const bit = atsBitForTotal(total);
                const nextMask = (bet.progressMask || 0) | bit;
                const required = atsRequiredMask(bet.type);
                if (bit !== 0) {
                    if (required !== 0 && (nextMask & required) === required) {
                        winAmount = bet.amount * atsPayoutTo1(bet.type);
                        resolved = true;
                    } else {
                        remainingBets.push({ ...bet, progressMask: nextMask });
                    }
                } else {
                    remainingBets.push(bet);
                }
            }
        }

        pnl += winAmount;
        if (loseAmount > 0) pnl -= loseAmount;

        if (resolved) {
            if (winAmount > 0) results.push(`${bet.type}${bet.target ? ' ' + bet.target : ''} WIN (+$${Math.floor(winAmount)})`);
            else if (loseAmount > 0) results.push(`${bet.type}${bet.target ? ' ' + bet.target : ''} LOSS (-$${loseAmount})`);
            else results.push(`${bet.type} PUSH`);
        } else if (!(bet.type === 'ATS_SMALL' || bet.type === 'ATS_TALL' || bet.type === 'ATS_ALL')) {
            remainingBets.push(bet);
        }
    });

    return { pnl, remainingBets, results };
};

// Returns total items for Sic Bo exposure (totals 3-18)
// Includes both triple and non-triple variants for totals that can be rolled as triples (6, 9, 12, 15)
export const getSicBoTotalItems = (): { total: number; isTriple: boolean; label: string }[] => {
    return [
        { total: 3, isTriple: true, label: '3' },      // Only possible as 1-1-1
        { total: 4, isTriple: false, label: '4' },
        { total: 5, isTriple: false, label: '5' },
        { total: 6, isTriple: true, label: '6T' },     // 2-2-2 triple
        { total: 6, isTriple: false, label: '6' },
        { total: 7, isTriple: false, label: '7' },
        { total: 8, isTriple: false, label: '8' },
        { total: 9, isTriple: true, label: '9T' },     // 3-3-3 triple
        { total: 9, isTriple: false, label: '9' },
        { total: 10, isTriple: false, label: '10' },
        { total: 11, isTriple: false, label: '11' },
        { total: 12, isTriple: true, label: '12T' },   // 4-4-4 triple
        { total: 12, isTriple: false, label: '12' },
        { total: 13, isTriple: false, label: '13' },
        { total: 14, isTriple: false, label: '14' },
        { total: 15, isTriple: true, label: '15T' },   // 5-5-5 triple
        { total: 15, isTriple: false, label: '15' },
        { total: 16, isTriple: false, label: '16' },
        { total: 17, isTriple: false, label: '17' },
        { total: 18, isTriple: true, label: '18' },    // Only possible as 6-6-6
    ];
}

// Returns combination items for Sic Bo exposure (Singles, Doubles, Triples)
// matchCount indicates how many dice show the number (for SINGLE bets: 1=1:1, 2=2:1, 3=3:1)
export const getSicBoCombinationItems = (): { type: 'SINGLE' | 'SINGLE_2X' | 'SINGLE_3X' | 'DOUBLE' | 'TRIPLE' | 'ANY_TRIPLE'; target?: number; label: string }[] => {
    return [
        // Singles 1-6 (1 match = 1:1)
        { type: 'SINGLE', target: 1, label: '1' },
        { type: 'SINGLE', target: 2, label: '2' },
        { type: 'SINGLE', target: 3, label: '3' },
        { type: 'SINGLE', target: 4, label: '4' },
        { type: 'SINGLE', target: 5, label: '5' },
        { type: 'SINGLE', target: 6, label: '6' },
        // Singles 2x (2 matches = 2:1 for single bet)
        { type: 'SINGLE_2X', target: 1, label: '1×2' },
        { type: 'SINGLE_2X', target: 2, label: '2×2' },
        { type: 'SINGLE_2X', target: 3, label: '3×2' },
        { type: 'SINGLE_2X', target: 4, label: '4×2' },
        { type: 'SINGLE_2X', target: 5, label: '5×2' },
        { type: 'SINGLE_2X', target: 6, label: '6×2' },
        // Singles 3x (3 matches = 3:1 for single bet, also triggers triple)
        { type: 'SINGLE_3X', target: 1, label: '1×3' },
        { type: 'SINGLE_3X', target: 2, label: '2×3' },
        { type: 'SINGLE_3X', target: 3, label: '3×3' },
        { type: 'SINGLE_3X', target: 4, label: '4×3' },
        { type: 'SINGLE_3X', target: 5, label: '5×3' },
        { type: 'SINGLE_3X', target: 6, label: '6×3' },
        // Doubles 1-6 (8:1)
        { type: 'DOUBLE', target: 1, label: '1-1' },
        { type: 'DOUBLE', target: 2, label: '2-2' },
        { type: 'DOUBLE', target: 3, label: '3-3' },
        { type: 'DOUBLE', target: 4, label: '4-4' },
        { type: 'DOUBLE', target: 5, label: '5-5' },
        { type: 'DOUBLE', target: 6, label: '6-6' },
        // Triples 1-6 (150:1)
        { type: 'TRIPLE', target: 1, label: '1-1-1' },
        { type: 'TRIPLE', target: 2, label: '2-2-2' },
        { type: 'TRIPLE', target: 3, label: '3-3-3' },
        { type: 'TRIPLE', target: 4, label: '4-4-4' },
        { type: 'TRIPLE', target: 5, label: '5-5-5' },
        { type: 'TRIPLE', target: 6, label: '6-6-6' },
        // Any Triple (24:1)
        { type: 'ANY_TRIPLE', label: 'ANY 3' },
    ];
}

// Legacy function for backwards compatibility
export const getSicBoCombinations = (): { total: number; combo: number[]; isTriple: boolean; label: string }[] => {
    return getSicBoTotalItems().map(item => ({
        total: item.total,
        combo: item.isTriple ? [item.total / 3, item.total / 3, item.total / 3] : [1, 1, item.total - 2],
        isTriple: item.isTriple,
        label: item.label
    }));
}

// Sic Bo payout table for Total bets - matches on-chain sic_bo.rs
const sicBoTotalPayout = (total: number): number => {
    switch (total) {
        case 3: case 18: return 180;
        case 4: case 17: return 50;
        case 5: case 16: return 18;
        case 6: case 15: return 14;
        case 7: case 14: return 12;
        case 8: case 13: return 8;
        case 9: case 10: case 11: case 12: return 6;
        default: return 0;
    }
};

// Calculate exposure for a specific total (for Small/Big/Sum bets)
// isTriple indicates if the total was rolled as a triple (e.g., 3-3-3 for 9)
// Only counts SMALL, BIG, and SUM bets - other bet types don't apply to total outcomes
export const calculateSicBoTotalExposure = (total: number, isTriple: boolean, bets: SicBoBet[]) => {
    let pnl = 0;

    // Filter to only bets that apply to total outcomes
    const totalBets = bets.filter(b => b.type === 'SMALL' || b.type === 'BIG' || b.type === 'SUM');

    totalBets.forEach(b => {
        let win = 0;
        // Small: sum 4-10, non-triple (1:1)
        if (b.type === 'SMALL') {
            if (!isTriple && total >= 4 && total <= 10) win = b.amount;
        }
        // Big: sum 11-17, non-triple (1:1)
        else if (b.type === 'BIG') {
            if (!isTriple && total >= 11 && total <= 17) win = b.amount;
        }
        // Sum: specific total (various payouts)
        else if (b.type === 'SUM' && total === b.target) {
            win = b.amount * sicBoTotalPayout(total);
        }

        if (win > 0) pnl += win;
        else pnl -= b.amount;
    });
    return pnl;
}

// Calculate exposure for a specific combination outcome (Single/Double/Triple/Any Triple)
// For SINGLE: shows P&L if that number appears once (1:1)
// For SINGLE_2X: shows P&L if that number appears twice (2:1 for single bet, also triggers double)
// For SINGLE_3X: shows P&L if that number appears three times (3:1 for single bet, also triggers triple)
// For DOUBLE: shows P&L if that double hits (8:1)
// For TRIPLE: shows P&L if that specific triple hits (150:1)
// For ANY_TRIPLE: shows P&L if any triple hits (24:1)
export const calculateSicBoCombinationExposure = (
    type: 'SINGLE' | 'SINGLE_2X' | 'SINGLE_3X' | 'DOUBLE' | 'TRIPLE' | 'ANY_TRIPLE',
    target: number | undefined,
    bets: SicBoBet[]
) => {
    let pnl = 0;

    // Filter to only bets that apply to combination outcomes
    const comboBets = bets.filter(b =>
        b.type === 'SINGLE_DIE' ||
        b.type === 'DOUBLE_SPECIFIC' ||
        b.type === 'TRIPLE_SPECIFIC' ||
        b.type === 'TRIPLE_ANY'
    );

    comboBets.forEach(b => {
        let win = 0;

        // SINGLE (1 match = 1:1)
        if (type === 'SINGLE' && b.type === 'SINGLE_DIE' && b.target === target) {
            win = b.amount * 1;
        }
        // SINGLE_2X (2 matches = 2:1 for single bet)
        else if (type === 'SINGLE_2X' && b.type === 'SINGLE_DIE' && b.target === target) {
            win = b.amount * 2;
        }
        // SINGLE_2X also triggers DOUBLE_SPECIFIC bet
        else if (type === 'SINGLE_2X' && b.type === 'DOUBLE_SPECIFIC' && b.target === target) {
            win = b.amount * 8;
        }
        // SINGLE_3X (3 matches = 3:1 for single bet)
        else if (type === 'SINGLE_3X' && b.type === 'SINGLE_DIE' && b.target === target) {
            win = b.amount * 3;
        }
        // SINGLE_3X also triggers TRIPLE_SPECIFIC bet
        else if (type === 'SINGLE_3X' && b.type === 'TRIPLE_SPECIFIC' && b.target === target) {
            win = b.amount * 150;
        }
        // SINGLE_3X also triggers TRIPLE_ANY bet
        else if (type === 'SINGLE_3X' && b.type === 'TRIPLE_ANY') {
            win = b.amount * 24;
        }
        // DOUBLE (8:1)
        else if (type === 'DOUBLE' && b.type === 'DOUBLE_SPECIFIC' && b.target === target) {
            win = b.amount * 8;
        }
        // TRIPLE (150:1)
        else if (type === 'TRIPLE' && b.type === 'TRIPLE_SPECIFIC' && b.target === target) {
            win = b.amount * 150;
        }
        // ANY_TRIPLE (24:1)
        else if (type === 'ANY_TRIPLE' && b.type === 'TRIPLE_ANY') {
            win = b.amount * 24;
        }
        // TRIPLE outcome also triggers ANY_TRIPLE bet
        else if (type === 'TRIPLE' && b.type === 'TRIPLE_ANY') {
            win = b.amount * 24;
        }

        if (win > 0) pnl += win;
        else pnl -= b.amount;
    });
    return pnl;
}

// Legacy function - calculates exposure for a specific dice combination
export const calculateSicBoOutcomeExposure = (combo: number[], bets: SicBoBet[]) => {
    let pnl = 0;
    const sum = combo.reduce((a,b)=>a+b,0);
    const d1 = combo[0], d2 = combo[1], d3 = combo[2];
    const isTriple = d1 === d2 && d2 === d3;
    const isDistinct = d1 !== d2 && d1 !== d3 && d2 !== d3;

	    bets.forEach(b => {
	         let win = 0;
	         if (b.type === 'SMALL' && sum >= 4 && sum <= 10 && !isTriple) win = b.amount;
	         else if (b.type === 'BIG' && sum >= 11 && sum <= 17 && !isTriple) win = b.amount;
	         else if (b.type === 'ODD' && sum % 2 === 1 && !isTriple) win = b.amount;
	         else if (b.type === 'EVEN' && sum % 2 === 0 && !isTriple) win = b.amount;
	         else if (b.type === 'SUM' && sum === b.target) win = b.amount * sicBoTotalPayout(sum);
	         else if (b.type === 'TRIPLE_ANY' && isTriple) win = b.amount * 24;
	         else if (b.type === 'TRIPLE_SPECIFIC' && isTriple && d1 === b.target) win = b.amount * 150;
	         else if (b.type === 'DOUBLE_SPECIFIC') {
             const count = [d1, d2, d3].filter(d => d === b.target).length;
             if (count >= 2) win = b.amount * 8;
         }
         else if (b.type === 'DOMINO' && b.target !== undefined) {
             const min = (b.target >> 4) & 0x0f;
             const max = b.target & 0x0f;
             if ([d1, d2, d3].includes(min) && [d1, d2, d3].includes(max)) {
                 win = b.amount * 5;
             }
         }
         else if (b.type === 'HOP3_EASY' && b.target !== undefined) {
             const diceMask = (1 << (d1 - 1)) | (1 << (d2 - 1)) | (1 << (d3 - 1));
             if (isDistinct && (diceMask & b.target) === diceMask) {
                 win = b.amount * 30;
             }
         }
         else if (b.type === 'HOP3_HARD' && b.target !== undefined) {
             const doubled = (b.target >> 4) & 0x0f;
             const single = b.target & 0x0f;
             const countD = [d1, d2, d3].filter(d => d === doubled).length;
             const countS = [d1, d2, d3].filter(d => d === single).length;
             if (countD === 2 && countS === 1) {
                 win = b.amount * 50;
             }
         }
         else if (b.type === 'HOP4_EASY' && b.target !== undefined) {
             const diceMask = (1 << (d1 - 1)) | (1 << (d2 - 1)) | (1 << (d3 - 1));
             if (isDistinct && (diceMask & b.target) === diceMask) {
                 win = b.amount * 7;
             }
         }
         else if (b.type === 'SINGLE_DIE') {
             const count = [d1, d2, d3].filter(d => d === b.target).length;
             if (count === 1) win = b.amount * 1;
             else if (count === 2) win = b.amount * 2;
             else if (count === 3) win = b.amount * 3;
         }

         if (win > 0) pnl += win;
         else pnl -= b.amount;
    });
    return pnl;
}

/**
 * Resolves Sic Bo bets after a roll, returning pnl and detailed results
 */
export const resolveSicBoBets = (combo: number[], bets: SicBoBet[]): { pnl: number; results: string[] } => {
    let pnl = 0;
    const results: string[] = [];
    const sum = combo.reduce((a,b)=>a+b,0);
    const d1 = combo[0], d2 = combo[1], d3 = combo[2];
    const isTriple = d1 === d2 && d2 === d3;
    const isDistinct = d1 !== d2 && d1 !== d3 && d2 !== d3;

	    bets.forEach(b => {
	         let win = 0;
	         if (b.type === 'SMALL' && sum >= 4 && sum <= 10 && !isTriple) win = b.amount;
	         else if (b.type === 'BIG' && sum >= 11 && sum <= 17 && !isTriple) win = b.amount;
	         else if (b.type === 'ODD' && sum % 2 === 1 && !isTriple) win = b.amount;
	         else if (b.type === 'EVEN' && sum % 2 === 0 && !isTriple) win = b.amount;
	         else if (b.type === 'SUM' && sum === b.target) win = b.amount * sicBoTotalPayout(sum);
	         else if (b.type === 'TRIPLE_ANY' && isTriple) win = b.amount * 24;
	         else if (b.type === 'TRIPLE_SPECIFIC' && isTriple && d1 === b.target) win = b.amount * 150;
	         else if (b.type === 'DOUBLE_SPECIFIC') {
             const count = [d1, d2, d3].filter(d => d === b.target).length;
             if (count >= 2) win = b.amount * 8;
         }
         else if (b.type === 'DOMINO' && b.target !== undefined) {
             const min = (b.target >> 4) & 0x0f;
             const max = b.target & 0x0f;
             if ([d1, d2, d3].includes(min) && [d1, d2, d3].includes(max)) {
                 win = b.amount * 5;
             }
         }
         else if (b.type === 'HOP3_EASY' && b.target !== undefined) {
             // 3-number easy hop: wins if all three chosen numbers are rolled (distinct).
             const diceMask = (1 << (d1 - 1)) | (1 << (d2 - 1)) | (1 << (d3 - 1));
             if (isDistinct && (diceMask & b.target) === diceMask) {
                 win = b.amount * 30;
             }
         }
         else if (b.type === 'HOP3_HARD' && b.target !== undefined) {
             // 3-number hard hop: (double<<4)|single, wins on exactly two of the first and one of the second.
             const doubled = (b.target >> 4) & 0x0f;
             const single = b.target & 0x0f;
             const countD = [d1, d2, d3].filter(d => d === doubled).length;
             const countS = [d1, d2, d3].filter(d => d === single).length;
             if (countD === 2 && countS === 1) {
                 win = b.amount * 50;
             }
         }
         else if (b.type === 'HOP4_EASY' && b.target !== undefined) {
             // 4-number easy hop: wins if the (distinct) roll is a subset of the chosen 4 numbers.
             const diceMask = (1 << (d1 - 1)) | (1 << (d2 - 1)) | (1 << (d3 - 1));
             if (isDistinct && (diceMask & b.target) === diceMask) {
                 win = b.amount * 7;
             }
         }
         else if (b.type === 'SINGLE_DIE') {
             const count = [d1, d2, d3].filter(d => d === b.target).length;
             if (count === 1) win = b.amount * 1;
             else if (count === 2) win = b.amount * 2;
             else if (count === 3) win = b.amount * 3;
         }

         const betLabel = (() => {
             if (b.type === 'DOMINO' && b.target !== undefined) {
                 const min = (b.target >> 4) & 0x0f;
                 const max = b.target & 0x0f;
                 return `${b.type} ${min}-${max}`;
             }
             if ((b.type === 'HOP3_EASY' || b.type === 'HOP4_EASY') && b.target !== undefined) {
                 const nums = [1, 2, 3, 4, 5, 6].filter((n) => (b.target! & (1 << (n - 1))) !== 0);
                 return `${b.type} ${nums.join('-')}`;
             }
             if (b.type === 'HOP3_HARD' && b.target !== undefined) {
                 const doubled = (b.target >> 4) & 0x0f;
                 const single = b.target & 0x0f;
                 return `${b.type} ${doubled}-${doubled}-${single}`;
             }
             return `${b.type}${b.target !== undefined ? ' ' + b.target : ''}`;
         })();

         if (win > 0) {
             pnl += win;
             results.push(`${betLabel} WIN (+$${win})`);
         } else {
             pnl -= b.amount;
             results.push(`${betLabel} LOSS (-$${b.amount})`);
         }
    });
    return { pnl, results };
};

export const calculateHiLoProjection = (cards: Card[], deck: Card[], currentPot: number) => {
    if (cards.length === 0) return { high: 0, low: 0 };
    const current = getHiLoRank(cards[cards.length - 1]);
    let highWins = 0, lowWins = 0;
    
    deck.forEach(c => {
        const r = getHiLoRank(c);
        if (r > current) highWins++;
        if (r < current) lowWins++;
    });
    
    // Odds = Total / Wins
    const total = deck.length;
    return {
        high: highWins > 0 ? Math.floor(currentPot * (total / highWins) * 0.95) : 0,
        low: lowWins > 0 ? Math.floor(currentPot * (total / lowWins) * 0.95) : 0
    };
};
