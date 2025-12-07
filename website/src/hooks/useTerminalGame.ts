
import { useState, useEffect } from 'react';
import { GameType, PlayerStats, GameState, Card, LeaderboardEntry, TournamentPhase, CompletedHand, CrapsBet, RouletteBet, SicBoBet, BaccaratBet } from '../types';
import { createDeck, rollDie, getHandValue, getBaccaratValue, getHiLoRank, WAYS, getRouletteColor, evaluateVideoPokerHand, calculateCrapsExposure, calculateSicBoOutcomeExposure, getSicBoCombinations } from '../utils/gameUtils';
import { getStrategicAdvice } from '../services/geminiService';

const INITIAL_CHIPS = 1000;
const INITIAL_SHIELDS = 3;
const INITIAL_DOUBLES = 3;

export const useTerminalGame = () => {
  // --- STATE ---
  const [stats, setStats] = useState<PlayerStats>({
    chips: INITIAL_CHIPS,
    shields: INITIAL_SHIELDS,
    doubles: INITIAL_DOUBLES,
    rank: 1,
    history: [],
    pnlByGame: {},
    pnlHistory: []
  });

  const [gameState, setGameState] = useState<GameState>({
    type: GameType.NONE,
    message: "TYPE '/' FOR FUN",
    bet: 50,
    stage: 'BETTING',
    playerCards: [],
    dealerCards: [],
    communityCards: [],
    dice: [],
    crapsPoint: null,
    crapsBets: [],
    crapsUndoStack: [],
    crapsInputMode: 'NONE',
    crapsRollHistory: [],
    rouletteBets: [],
    rouletteUndoStack: [],
    rouletteLastRoundBets: [],
    rouletteHistory: [],
    rouletteInputMode: 'NONE',
    sicBoBets: [],
    sicBoHistory: [],
    sicBoInputMode: 'NONE',
    sicBoUndoStack: [],
    sicBoLastRoundBets: [],
    baccaratBets: [],
    baccaratUndoStack: [],
    baccaratLastRoundBets: [],
    lastResult: 0,
    activeModifiers: { shield: false, double: false },
    baccaratSelection: 'PLAYER',
    insuranceBet: 0,
    blackjackStack: [],
    completedHands: [],
    hiloAccumulator: 0,
    hiloGraphData: []
  });

  const [deck, setDeck] = useState<Card[]>([]);
  const [aiAdvice, setAiAdvice] = useState<string | null>(null);
  const [tournamentTime, setTournamentTime] = useState(0);
  const [phase, setPhase] = useState<TournamentPhase>('ACTIVE');
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [isRegistered, setIsRegistered] = useState(false);

  // --- TOURNAMENT CLOCK ---
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const cycleDuration = 6 * 60 * 1000; // 5 mins active + 1 min registration
      const elapsed = now % cycleDuration;
      
      const isReg = elapsed < 60 * 1000;
      
      if (isReg) {
          if (phase !== 'REGISTRATION') {
              setPhase('REGISTRATION');
              setIsRegistered(false);
          }
          setTournamentTime(Math.floor((60 * 1000 - elapsed) / 1000));
      } else {
          if (phase !== 'ACTIVE') {
               setPhase('ACTIVE');
          }
          const activeElapsed = elapsed - 60000;
          const activeDuration = 5 * 60 * 1000;
          setTournamentTime(Math.floor((activeDuration - activeElapsed) / 1000));
      }
      
      // Update Leaderboard randomly
      if (Math.random() > 0.8 && phase === 'ACTIVE') {
        const names = ["Neo", "Trinity", "Morpheus", "Cipher", "Switch", "Tank", "Dozer", "Smith", "Oracle", "Seraph", "Niobe", "Ghost", "Lock", "Mouse", "Apoc", "Brown", "Jones", "Keymaker", "Merovingian", "Persephone", "Twins"];
        const newBoard = names.map(name => ({
          name,
          chips: Math.floor(Math.random() * 5000) + 500,
          status: 'ALIVE' as const
        }));
        newBoard.push({ name: "YOU", chips: stats.chips, status: 'ALIVE' });
        newBoard.sort((a, b) => b.chips - a.chips);
        setLeaderboard(newBoard);
        const myRank = newBoard.findIndex(p => p.name === "YOU") + 1;
        setStats(s => ({ ...s, rank: myRank }));
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [stats.chips, phase]);

  // --- CORE ACTIONS ---

  const startGame = (type: GameType) => {
    setGameState({
      type,
      message: "SPACE TO DEAL",
      bet: 50,
      stage: 'BETTING',
      playerCards: [],
      dealerCards: [],
      communityCards: [],
      dice: [],
      crapsPoint: null,
      crapsBets: [],
      crapsUndoStack: [],
      crapsInputMode: 'NONE',
      crapsRollHistory: [],
      rouletteBets: [],
      rouletteUndoStack: [],
      rouletteLastRoundBets: [],
      rouletteHistory: [],
      rouletteInputMode: 'NONE',
      sicBoBets: [],
      sicBoHistory: [],
      sicBoInputMode: 'NONE',
      sicBoUndoStack: [],
      sicBoLastRoundBets: [],
      baccaratBets: [],
      baccaratUndoStack: [],
      baccaratLastRoundBets: [],
      lastResult: 0,
      activeModifiers: { shield: false, double: false },
      baccaratSelection: 'PLAYER',
      insuranceBet: 0,
      blackjackStack: [],
      completedHands: [],
      hiloAccumulator: 0,
      hiloGraphData: []
    });
    setAiAdvice(null);
  };

  const setBetAmount = (amount: number) => {
    if (gameState.stage === 'PLAYING') return;
    if (stats.chips < amount) {
      setGameState(prev => ({ ...prev, message: "INSUFFICIENT FUNDS" }));
      return;
    }
    setGameState(prev => ({ ...prev, bet: amount, message: `BET SIZE: ${amount}` }));
  };

  const toggleShield = () => {
    const allowedInPlay = [GameType.CRAPS, GameType.ROULETTE, GameType.SIC_BO].includes(gameState.type);
    if (gameState.stage === 'PLAYING' && !allowedInPlay) return;
    if (tournamentTime < 60 && phase === 'ACTIVE') {
      setGameState(prev => ({ ...prev, message: "LOCKED (FINAL MINUTE)" }));
      return;
    }
    if (stats.shields <= 0 && !gameState.activeModifiers.shield) {
      setGameState(prev => ({ ...prev, message: "NO SHIELDS REMAINING" }));
      return;
    }
    setGameState(prev => ({ ...prev, activeModifiers: { ...prev.activeModifiers, shield: !prev.activeModifiers.shield } }));
  };

  const toggleDouble = () => {
    const allowedInPlay = [GameType.CRAPS, GameType.ROULETTE, GameType.SIC_BO].includes(gameState.type);
    if (gameState.stage === 'PLAYING' && !allowedInPlay) return;
    if (tournamentTime < 60 && phase === 'ACTIVE') {
      setGameState(prev => ({ ...prev, message: "LOCKED (FINAL MINUTE)" }));
      return;
    }
    if (stats.doubles <= 0 && !gameState.activeModifiers.double) {
      setGameState(prev => ({ ...prev, message: "NO DOUBLES REMAINING" }));
      return;
    }
    setGameState(prev => ({ ...prev, activeModifiers: { ...prev.activeModifiers, double: !prev.activeModifiers.double } }));
  };

  const resolveGame = (baseAmount: number, baseMessage: string) => {
    let finalAmount = baseAmount;
    let finalMessage = baseMessage;

    if (finalAmount < 0 && gameState.activeModifiers.shield) {
      finalAmount = 0;
      finalMessage += " [SHIELDED]";
    }
    if (finalAmount > 0 && gameState.activeModifiers.double) {
      finalAmount *= 2;
      finalMessage += " [DOUBLED]";
    }

    const pnlEntry = { [gameState.type]: (stats.pnlByGame[gameState.type] || 0) + finalAmount };

    setStats(prev => ({
      ...prev,
      chips: prev.chips + finalAmount,
      history: [...prev.history, finalMessage],
      pnlByGame: { ...prev.pnlByGame, ...pnlEntry },
      pnlHistory: [...prev.pnlHistory, (prev.pnlHistory[prev.pnlHistory.length - 1] || 0) + finalAmount]
    }));
    setGameState(prev => ({ ...prev, message: finalMessage, stage: 'RESULT', lastResult: finalAmount }));
  };

  // --- GAME ENGINES (Condensed for brevity, same logic as before) ---
  
  // BLACKJACK ENGINE
  const bjHit = () => {
    if (getHandValue(gameState.playerCards) >= 21) return;
    const newCard = deck.pop()!;
    const newHand = [...gameState.playerCards, newCard];
    const newVal = getHandValue(newHand);

    if (newVal > 21) {
      const lostHand: CompletedHand = { cards: newHand, bet: gameState.bet, result: -gameState.bet, message: "BUST", isDoubled: gameState.activeModifiers.double };
      const newCompleted = [...gameState.completedHands, lostHand];
      if (gameState.blackjackStack.length > 0) {
          const nextHand = gameState.blackjackStack[0];
          setGameState(prev => ({
              ...prev,
              playerCards: [...nextHand.cards, deck.pop()!], 
              bet: nextHand.bet,
              activeModifiers: { ...prev.activeModifiers, double: nextHand.isDoubled },
              blackjackStack: prev.blackjackStack.slice(1),
              completedHands: newCompleted,
              message: "NEXT HAND: HIT (H) / STAND (S)"
          }));
      } else {
          const allBust = newCompleted.every(h => (getHandValue(h.cards) > 21));
          if (allBust) {
              setGameState(prev => ({ ...prev, playerCards: newHand, completedHands: newCompleted, stage: 'RESULT' }));
              resolveBlackjackRound(newCompleted, gameState.dealerCards);
          } else {
              bjDealerPlay(newCompleted, newHand); 
          }
      }
    } else if (newVal === 21) {
      bjStandAuto(newHand);
    } else {
      setGameState(prev => ({ ...prev, playerCards: newHand, message: "HIT (H) / STAND (S)" }));
    }
  };

  const bjStandAuto = (hand: Card[]) => {
    const stoodHand: CompletedHand = { cards: hand, bet: gameState.bet, isDoubled: gameState.activeModifiers.double };
    const newCompleted = [...gameState.completedHands, stoodHand];
    if (gameState.blackjackStack.length > 0) {
        const nextHand = gameState.blackjackStack[0];
        setGameState(prev => ({
            ...prev,
            playerCards: [...nextHand.cards, deck.pop()!],
            bet: nextHand.bet,
            activeModifiers: { ...prev.activeModifiers, double: nextHand.isDoubled },
            blackjackStack: prev.blackjackStack.slice(1),
            completedHands: newCompleted,
            message: "NEXT HAND: HIT (H) / STAND (S)"
        }));
    } else {
        bjDealerPlay(newCompleted, hand);
    }
  };

  const bjStand = () => bjStandAuto(gameState.playerCards);

  const bjDouble = () => {
    if (gameState.playerCards.length !== 2 || stats.chips < gameState.bet) return;
    setGameState(prev => ({ ...prev, bet: prev.bet * 2, message: "DOUBLING..." }));
    const newCard = deck.pop()!;
    const newHand = [...gameState.playerCards, newCard];
    const stoodHand: CompletedHand = { cards: newHand, bet: gameState.bet * 2, isDoubled: true }; 
    const newCompleted = [...gameState.completedHands, stoodHand];
    if (gameState.blackjackStack.length > 0) {
        const nextHand = gameState.blackjackStack[0];
        setGameState(prev => ({
            ...prev,
            playerCards: [...nextHand.cards, deck.pop()!],
            bet: nextHand.bet,
            activeModifiers: { ...prev.activeModifiers, double: nextHand.isDoubled },
            blackjackStack: prev.blackjackStack.slice(1),
            completedHands: newCompleted,
            message: "NEXT HAND: HIT (H) / STAND (S)"
        }));
    } else {
        bjDealerPlay(newCompleted, newHand);
    }
  };

  const bjSplit = () => {
    if (gameState.playerCards.length !== 2 || gameState.playerCards[0].rank !== gameState.playerCards[1].rank || stats.chips < gameState.bet) return;
    setGameState(prev => ({
        ...prev,
        playerCards: [gameState.playerCards[0], deck.pop()!],
        blackjackStack: [{ cards: [gameState.playerCards[1]], bet: gameState.bet, isDoubled: false }, ...prev.blackjackStack],
        message: "SPLIT! PLAYING HAND 1."
    }));
  };

  const bjDealerPlay = (playerHands: CompletedHand[], lastHand: Card[], currentDealerCards?: Card[], currentDeck?: Card[]) => {
      let dealer = currentDealerCards ? [...currentDealerCards] : gameState.dealerCards.map(c => ({...c, isHidden: false}));
      let d = currentDeck ? [...currentDeck] : [...deck];
      while (getHandValue(dealer) < 17) dealer.push(d.pop()!);
      setDeck(d);
      setGameState(prev => ({ ...prev, dealerCards: dealer, completedHands: playerHands, stage: 'RESULT', playerCards: lastHand }));
      resolveBlackjackRound(playerHands, dealer);
  };

  const resolveBlackjackRound = (hands: CompletedHand[], dealerHand: Card[]) => {
      let totalWin = 0;
      let logs: string[] = [];
      const dVal = getHandValue(dealerHand);
      if (gameState.insuranceBet > 0) {
          if (dVal === 21 && dealerHand.length === 2) { totalWin += gameState.insuranceBet * 3; logs.push(`INS WON`); }
          else { totalWin -= gameState.insuranceBet; logs.push(`INS LOST`); }
      }
      hands.forEach((hand, idx) => {
          const pVal = getHandValue(hand.cards);
          let win = 0;
          if (pVal > 21) win = -hand.bet;
          else if (dVal > 21) win = hand.bet;
          else if (pVal === 21 && hand.cards.length === 2 && !(dVal === 21 && dealerHand.length === 2)) win = Math.floor(hand.bet * 1.5);
          else if (pVal > dVal) win = hand.bet;
          else if (pVal < dVal) win = -hand.bet;
          totalWin += win;
          logs.push(win > 0 ? `H${idx+1} WIN` : win < 0 ? `H${idx+1} LOSE` : `H${idx+1} PUSH`);
      });
      let finalWin = totalWin;
      let msg = logs.join('|');
      if (finalWin < 0 && gameState.activeModifiers.shield) { finalWin = 0; msg += " [SHIELD]"; }
      if (finalWin > 0 && gameState.activeModifiers.double) { finalWin *= 2; msg += " [DOUBLE]"; }
      
      const pnlEntry = { [GameType.BLACKJACK]: (stats.pnlByGame[GameType.BLACKJACK] || 0) + finalWin };
      setStats(prev => ({
        ...prev,
        chips: prev.chips + finalWin,
        history: [...prev.history, msg],
        pnlByGame: { ...prev.pnlByGame, ...pnlEntry },
        pnlHistory: [...prev.pnlHistory, (prev.pnlHistory[prev.pnlHistory.length - 1] || 0) + finalWin]
      }));
      setGameState(prev => ({ ...prev, message: finalWin >= 0 ? `WON ${finalWin}` : `LOST ${Math.abs(finalWin)}`, stage: 'RESULT', lastResult: finalWin }));
  };

  const bjInsurance = (take: boolean) => {
      if (take && stats.chips >= Math.floor(gameState.bet/2)) setGameState(prev => ({ ...prev, insuranceBet: Math.floor(prev.bet/2), message: "INSURANCE TAKEN" }));
      else setGameState(prev => ({ ...prev, message: "INSURANCE DECLINED" }));
  };

  // DEAL HANDLER
  const deal = () => {
    if (gameState.type === GameType.NONE) return;
    if (gameState.type === GameType.CRAPS) { rollCraps(); return; }
    if (gameState.type === GameType.ROULETTE) { spinRoulette(); return; }
    if (gameState.type === GameType.SIC_BO) { rollSicBo(); return; }
    if (gameState.stage === 'PLAYING') return;
    if (stats.chips < gameState.bet) { setGameState(prev => ({ ...prev, message: "INSUFFICIENT FUNDS" })); return; }

    let newShields = stats.shields;
    let newDoubles = stats.doubles;
    if (gameState.activeModifiers.shield) newShields--;
    if (gameState.activeModifiers.double) newDoubles--;
    setStats(prev => ({ ...prev, shields: newShields, doubles: newDoubles }));

    const newDeck = createDeck();
    setDeck(newDeck);

    // Initial setups for specific games
    if (gameState.type === GameType.BLACKJACK) {
        const p1 = newDeck.pop()!, d1 = newDeck.pop()!, p2 = newDeck.pop()!, d2 = { ...newDeck.pop()!, isHidden: true };
        const val = getHandValue([p1, p2]);
        if (val === 21) {
             const completed: CompletedHand = { cards: [p1, p2], bet: gameState.bet, isDoubled: gameState.activeModifiers.double };
             setGameState(prev => ({ ...prev, stage: 'PLAYING', playerCards: [p1, p2], dealerCards: [d1, d2], message: "BLACKJACK!", lastResult: 0, insuranceBet: 0, blackjackStack: [], completedHands: [] }));
             bjDealerPlay([completed], [p1, p2], [d1, d2], newDeck);
        } else {
             let msg = "HIT (H) / STAND (S)";
             if (d1.rank === 'A') msg = "INSURANCE? (I) / NO (N)";
             setGameState(prev => ({ ...prev, stage: 'PLAYING', playerCards: [p1, p2], dealerCards: [d1, d2], message: msg, lastResult: 0, insuranceBet: 0, blackjackStack: [], completedHands: [] }));
        }
    } else if (gameState.type === GameType.HILO) {
        setGameState(prev => ({ ...prev, stage: 'PLAYING', playerCards: [newDeck.pop()!], hiloAccumulator: gameState.bet, hiloGraphData: [gameState.bet], message: `HIGHER (H) / LOWER (L)? POT: ${gameState.bet}` }));
    } else if (gameState.type === GameType.VIDEO_POKER) {
        setGameState(prev => ({ ...prev, stage: 'PLAYING', playerCards: [newDeck.pop()!, newDeck.pop()!, newDeck.pop()!, newDeck.pop()!, newDeck.pop()!], message: "HOLD (1-5), DRAW (D)" }));
    } else if (gameState.type === GameType.BACCARAT) {
        const p1 = newDeck.pop()!, b1 = newDeck.pop()!, p2 = newDeck.pop()!, b2 = newDeck.pop()!;
        const pVal = (getBaccaratValue([p1]) + getBaccaratValue([p2])) % 10;
        const bVal = (getBaccaratValue([b1]) + getBaccaratValue([b2])) % 10;
        let winner = pVal > bVal ? 'PLAYER' : bVal > pVal ? 'BANKER' : 'TIE';
        let totalWin = 0;
        if (winner === 'TIE') totalWin += 0; 
        else if (winner === gameState.baccaratSelection) totalWin += gameState.bet;
        else totalWin -= gameState.bet;
        
        gameState.baccaratBets.forEach(b => {
             if (b.type === 'TIE' && winner === 'TIE') totalWin += b.amount * 8;
             else if (b.type === 'P_PAIR' && p1.rank === p2.rank) totalWin += b.amount * 11;
             else if (b.type === 'B_PAIR' && b1.rank === b2.rank) totalWin += b.amount * 11;
             else totalWin -= b.amount;
        });
        
        setGameState(prev => ({ ...prev, stage: 'RESULT', playerCards: [p1, p2], dealerCards: [b1, b2], baccaratLastRoundBets: prev.baccaratBets, baccaratBets: [], baccaratUndoStack: [] }));
        resolveGame(totalWin, `${winner} WINS`);
    } else if (gameState.type === GameType.CASINO_WAR) {
        const p1 = newDeck.pop()!, d1 = newDeck.pop()!;
        let win = p1.value > d1.value ? gameState.bet : p1.value < d1.value ? -gameState.bet : 0;
        setGameState(prev => ({ ...prev, stage: 'RESULT', playerCards: [p1], dealerCards: [d1] }));
        resolveGame(win, win > 0 ? "WIN" : win < 0 ? "LOSE" : "TIE");
    } else if (gameState.type === GameType.THREE_CARD) {
        // Three Card Poker - deal 3 cards each
        const p1 = newDeck.pop()!, p2 = newDeck.pop()!, p3 = newDeck.pop()!;
        const d1 = { ...newDeck.pop()!, isHidden: true };
        const d2 = { ...newDeck.pop()!, isHidden: true };
        const d3 = { ...newDeck.pop()!, isHidden: true };
        setGameState(prev => ({
            ...prev,
            stage: 'PLAYING',
            playerCards: [p1, p2, p3],
            dealerCards: [d1, d2, d3],
            message: "PLAY (P) OR FOLD (F)"
        }));
    } else if (gameState.type === GameType.ULTIMATE_HOLDEM) {
        // Ultimate Texas Holdem - deal 2 hole cards each
        const p1 = newDeck.pop()!, p2 = newDeck.pop()!;
        const d1 = { ...newDeck.pop()!, isHidden: true };
        const d2 = { ...newDeck.pop()!, isHidden: true };
        setGameState(prev => ({
            ...prev,
            stage: 'PLAYING',
            playerCards: [p1, p2],
            dealerCards: [d1, d2],
            communityCards: [],
            message: "CHECK (C) OR BET 4X/3X"
        }));
    } else {
        setGameState(prev => ({...prev, message: "GAME LOADING..."}));
    }
  };

  // --- SPECIFIC GAME ACTIONS (Simplified Wrappers) ---
  const toggleHold = (idx: number) => {
      if (gameState.type !== GameType.VIDEO_POKER) return;
      const cards = [...gameState.playerCards];
      cards[idx] = { ...cards[idx], isHidden: !cards[idx].isHidden };
      setGameState(prev => ({ ...prev, playerCards: cards }));
  };

  const drawVideoPoker = () => {
      const hand = gameState.playerCards.map(c => c.isHidden ? { ...c, isHidden: false } : deck.pop()!);
      const { rank, multiplier } = evaluateVideoPokerHand(hand);
      const profit = (gameState.bet * multiplier) - gameState.bet;
      setGameState(prev => ({ ...prev, playerCards: hand, stage: 'RESULT', lastResult: profit }));
      resolveGame(profit, multiplier > 0 ? `${rank}!` : "LOST");
  };

  const hiloPlay = (guess: 'HIGHER' | 'LOWER') => {
      const next = deck.pop()!; 
      const curr = gameState.playerCards[gameState.playerCards.length-1];
      const cVal = getHiLoRank(curr);
      const nVal = getHiLoRank(next);
      if (cVal === nVal) {
          setGameState(prev => ({ ...prev, playerCards: [...prev.playerCards, next], message: "PUSH. POT REMAINS." }));
          return;
      }
      const won = (guess === 'HIGHER' && nVal > cVal) || (guess === 'LOWER' && nVal < cVal);
      if (won) {
          // Simple doubling for demo, real calc is complex
          const newAcc = Math.floor(gameState.hiloAccumulator * 1.5); 
          setGameState(prev => ({ ...prev, playerCards: [...prev.playerCards, next], hiloAccumulator: newAcc, hiloGraphData: [...prev.hiloGraphData, newAcc], message: `CORRECT! POT: ${newAcc}` }));
      } else {
          setGameState(prev => ({ ...prev, playerCards: [...prev.playerCards, next], hiloGraphData: [...prev.hiloGraphData, 0], stage: 'RESULT' }));
          resolveGame(-gameState.bet, "WRONG");
      }
  };
  const hiloCashout = () => {
      const profit = gameState.hiloAccumulator - gameState.bet;
      resolveGame(profit, "CASHED OUT");
  };

  // --- ROULETTE / SIC BO / CRAPS / BACCARAT BETTING HELPERS ---
  const placeRouletteBet = (type: RouletteBet['type'], target?: number) => {
      if (stats.chips < gameState.bet) return;
      setGameState(prev => ({ ...prev, rouletteUndoStack: [...prev.rouletteUndoStack, prev.rouletteBets], rouletteBets: [...prev.rouletteBets, { type, amount: prev.bet, target }], message: `BET ${type}`, rouletteInputMode: 'NONE' }));
  };
  const undoRouletteBet = () => {
      if (gameState.rouletteUndoStack.length === 0) return;
      setGameState(prev => ({ ...prev, rouletteBets: prev.rouletteUndoStack[prev.rouletteUndoStack.length-1], rouletteUndoStack: prev.rouletteUndoStack.slice(0, -1) }));
  };
  const rebetRoulette = () => {
      if (gameState.rouletteLastRoundBets.length === 0 || stats.chips < gameState.rouletteLastRoundBets.reduce((a,b)=>a+b.amount,0)) return;
      setGameState(prev => ({ ...prev, rouletteUndoStack: [...prev.rouletteUndoStack, prev.rouletteBets], rouletteBets: [...prev.rouletteBets, ...prev.rouletteLastRoundBets], message: "REBET PLACED" }));
  };
  const spinRoulette = () => {
      if (gameState.rouletteBets.length === 0) { setGameState(prev => ({ ...prev, message: "PLACE BET" })); return; }
      const num = Math.floor(Math.random() * 37);
      let win = 0;
      gameState.rouletteBets.forEach(b => {
          const color = getRouletteColor(num);
          if (b.type === 'STRAIGHT' && b.target === num) win += b.amount * 35;
          else if (b.type === 'RED' && color === 'RED') win += b.amount;
          else if (b.type === 'BLACK' && color === 'BLACK') win += b.amount;
          else if (b.type === 'ODD' && num!==0 && num%2!==0) win += b.amount;
          else if (b.type === 'EVEN' && num!==0 && num%2===0) win += b.amount;
          else if (b.type === 'LOW' && num>=1 && num<=18) win += b.amount;
          else if (b.type === 'HIGH' && num>=19 && num<=36) win += b.amount;
          else if (b.type === 'ZERO' && num===0) win += b.amount * 35;
          else win -= b.amount;
      });
      setGameState(prev => ({ ...prev, rouletteHistory: [...prev.rouletteHistory, num], rouletteLastRoundBets: prev.rouletteBets, rouletteBets: [], rouletteUndoStack: [] }));
      resolveGame(win, `SPUN ${num}`);
  };

  const placeSicBoBet = (type: SicBoBet['type'], target?: number) => {
      if (stats.chips < gameState.bet) return;
      setGameState(prev => ({ ...prev, sicBoUndoStack: [...prev.sicBoUndoStack, prev.sicBoBets], sicBoBets: [...prev.sicBoBets, { type, amount: prev.bet, target }], message: `BET ${type}`, sicBoInputMode: 'NONE' }));
  };
  const undoSicBoBet = () => {
       if (gameState.sicBoUndoStack.length === 0) return;
       setGameState(prev => ({ ...prev, sicBoBets: prev.sicBoUndoStack[prev.sicBoUndoStack.length-1], sicBoUndoStack: prev.sicBoUndoStack.slice(0, -1) }));
  };
  const rebetSicBo = () => {
       if (gameState.sicBoLastRoundBets.length === 0 || stats.chips < gameState.sicBoLastRoundBets.reduce((a,b)=>a+b.amount,0)) return;
       setGameState(prev => ({ ...prev, sicBoUndoStack: [...prev.sicBoUndoStack, prev.sicBoBets], sicBoBets: [...prev.sicBoBets, ...prev.sicBoLastRoundBets], message: "REBET" }));
  };
  const rollSicBo = () => {
       if (gameState.sicBoBets.length === 0) { setGameState(prev => ({...prev, message: "PLACE BET"})); return; }
       const d = [rollDie(), rollDie(), rollDie()];
       const win = calculateSicBoOutcomeExposure(d, gameState.sicBoBets); // reuse helper for actual calc
       setGameState(prev => ({ ...prev, dice: d, sicBoHistory: [...prev.sicBoHistory, d], sicBoLastRoundBets: prev.sicBoBets, sicBoBets: [], sicBoUndoStack: [] }));
       resolveGame(win, `ROLLED ${d.reduce((a,b)=>a+b,0)}`);
  };

  const placeCrapsBet = (type: CrapsBet['type'], target?: number) => {
      if (stats.chips < gameState.bet) return;
      let bets = [...gameState.crapsBets];
      if (type === 'PASS') bets = bets.filter(b => b.type !== 'DONT_PASS');
      if (type === 'DONT_PASS') bets = bets.filter(b => b.type !== 'PASS');
      setGameState(prev => ({ ...prev, crapsUndoStack: [...prev.crapsUndoStack, prev.crapsBets], crapsBets: [...bets, { type, amount: prev.bet, target, status: (type==='COME'||type==='DONT_COME')?'PENDING':'ON' }], message: `BET ${type}`, crapsInputMode: 'NONE' }));
  };
  const undoCrapsBet = () => {
       if (gameState.crapsUndoStack.length === 0) return;
       setGameState(prev => ({ ...prev, crapsBets: prev.crapsUndoStack[prev.crapsUndoStack.length-1], crapsUndoStack: prev.crapsUndoStack.slice(0, -1) }));
  };
  const addCrapsOdds = () => {
      // Logic same as App.tsx
      setGameState(prev => {
          const bets = [...prev.crapsBets];
          // Find eligible bet and add odds... (simplified for brevity)
          const idx = bets.findIndex(b => (b.type==='PASS'||b.type==='DONT_PASS'||(b.type==='COME'&&b.status==='ON')||(b.type==='DONT_COME'&&b.status==='ON')));
          if (idx !== -1) {
              bets[idx] = { ...bets[idx], oddsAmount: (bets[idx].oddsAmount||0) + prev.bet };
              return { ...prev, crapsBets: bets, message: "ODDS ADDED" };
          }
          return { ...prev, message: "NO BET FOR ODDS" };
      });
  };
  const rollCraps = () => {
       const d1=rollDie(), d2=rollDie(), total=d1+d2;
       const pnl = calculateCrapsExposure(total, gameState.crapsPoint, gameState.crapsBets); // Reuse helper for PnL
       // Update point logic simplified
       let newPoint = gameState.crapsPoint;
       if (gameState.crapsPoint === null && [4,5,6,8,9,10].includes(total)) newPoint = total;
       else if (gameState.crapsPoint === total || total === 7) newPoint = null;
       
       setGameState(prev => ({ ...prev, dice: [d1, d2], crapsPoint: newPoint, crapsRollHistory: [...prev.crapsRollHistory, total], message: `ROLLED ${total}` }));
       resolveGame(pnl, `ROLLED ${total}`);
  };

  const baccaratActions = {
      toggleSelection: (sel: 'PLAYER'|'BANKER') => setGameState(prev => ({ ...prev, baccaratSelection: sel })),
      placeBet: (type: BaccaratBet['type']) => {
          if (stats.chips < gameState.bet) return;
          setGameState(prev => ({ ...prev, baccaratUndoStack: [...prev.baccaratUndoStack, prev.baccaratBets], baccaratBets: [...prev.baccaratBets, { type, amount: prev.bet }] }));
      },
      undo: () => {
          if (gameState.baccaratUndoStack.length > 0) setGameState(prev => ({ ...prev, baccaratBets: prev.baccaratUndoStack[prev.baccaratUndoStack.length-1], baccaratUndoStack: prev.baccaratUndoStack.slice(0, -1) }));
      },
      rebet: () => {
          if (gameState.baccaratLastRoundBets.length > 0) setGameState(prev => ({ ...prev, baccaratBets: [...prev.baccaratBets, ...prev.baccaratLastRoundBets] }));
      }
  };

  // --- THREE CARD POKER ---
  const evaluateThreeCardHand = (cards: Card[]): { rank: string, value: number } => {
      if (cards.length !== 3) return { rank: 'HIGH', value: 0 };
      const getRankVal = (r: string) => {
          if (r === 'A') return 12; if (r === 'K') return 11; if (r === 'Q') return 10; if (r === 'J') return 9;
          return parseInt(r) - 2;
      };
      const ranks = cards.map(c => getRankVal(c.rank)).sort((a, b) => b - a);
      const suits = cards.map(c => c.suit);
      const isFlush = suits[0] === suits[1] && suits[1] === suits[2];
      const isStraight = (ranks[0] - ranks[1] === 1 && ranks[1] - ranks[2] === 1) || (ranks[0] === 12 && ranks[1] === 1 && ranks[2] === 0);
      const isTrips = ranks[0] === ranks[1] && ranks[1] === ranks[2];
      const isPair = ranks[0] === ranks[1] || ranks[1] === ranks[2] || ranks[0] === ranks[2];

      if (isStraight && isFlush) return { rank: 'STRAIGHT FLUSH', value: 5 };
      if (isTrips) return { rank: 'THREE OF A KIND', value: 4 };
      if (isStraight) return { rank: 'STRAIGHT', value: 3 };
      if (isFlush) return { rank: 'FLUSH', value: 2 };
      if (isPair) return { rank: 'PAIR', value: 1 };
      return { rank: 'HIGH CARD', value: 0 };
  };

  const threeCardPlay = () => {
      if (gameState.type !== GameType.THREE_CARD || gameState.stage !== 'PLAYING') return;
      if (stats.chips < gameState.bet) { setGameState(prev => ({ ...prev, message: "INSUFFICIENT FUNDS" })); return; }

      // Reveal dealer cards
      const dealerRevealed = gameState.dealerCards.map(c => ({ ...c, isHidden: false }));
      const playerHand = evaluateThreeCardHand(gameState.playerCards);
      const dealerHand = evaluateThreeCardHand(dealerRevealed);

      // Check if dealer qualifies (Queen-high or better)
      const dealerQualifies = dealerHand.value > 0 ||
          (dealerHand.value === 0 && dealerRevealed.some(c => ['Q', 'K', 'A'].includes(c.rank)));

      let totalWin = 0;
      let message = '';

      if (!dealerQualifies) {
          totalWin = gameState.bet; // Ante wins 1:1, Play pushes
          message = "DEALER DOESN'T QUALIFY - ANTE WINS";
      } else {
          // Compare hands
          if (playerHand.value > dealerHand.value) {
              totalWin = gameState.bet * 2; // Ante + Play win
              message = `${playerHand.rank} WINS!`;
          } else if (playerHand.value < dealerHand.value) {
              totalWin = -gameState.bet * 2; // Lose ante + play
              message = `DEALER ${dealerHand.rank} WINS`;
          } else {
              totalWin = 0;
              message = "PUSH";
          }
      }

      setGameState(prev => ({ ...prev, dealerCards: dealerRevealed, stage: 'RESULT' }));
      resolveGame(totalWin, message);
  };

  const threeCardFold = () => {
      if (gameState.type !== GameType.THREE_CARD || gameState.stage !== 'PLAYING') return;
      const dealerRevealed = gameState.dealerCards.map(c => ({ ...c, isHidden: false }));
      setGameState(prev => ({ ...prev, dealerCards: dealerRevealed, stage: 'RESULT' }));
      resolveGame(-gameState.bet, "FOLDED");
  };

  // --- ULTIMATE HOLDEM ---
  const uhCheck = () => {
      if (gameState.type !== GameType.ULTIMATE_HOLDEM || gameState.stage !== 'PLAYING') return;

      const numCommunity = gameState.communityCards.length;

      if (numCommunity === 0) {
          // Pre-flop check - deal flop
          const c1 = deck.pop()!, c2 = deck.pop()!, c3 = deck.pop()!;
          setGameState(prev => ({
              ...prev,
              communityCards: [c1, c2, c3],
              message: "CHECK (C) OR BET 2X"
          }));
      } else if (numCommunity === 3) {
          // Flop check - deal turn + river
          const c4 = deck.pop()!, c5 = deck.pop()!;
          setGameState(prev => ({
              ...prev,
              communityCards: [...prev.communityCards, c4, c5],
              message: "FOLD (F) OR BET 1X"
          }));
      }
  };

  const uhBet = (multiplier: number) => {
      if (gameState.type !== GameType.ULTIMATE_HOLDEM || gameState.stage !== 'PLAYING') return;
      const playBet = gameState.bet * multiplier;
      if (stats.chips < playBet) { setGameState(prev => ({ ...prev, message: "INSUFFICIENT FUNDS" })); return; }

      // Deal remaining community cards if needed
      let community = [...gameState.communityCards];
      while (community.length < 5) {
          community.push(deck.pop()!);
      }

      // Reveal dealer
      const dealerRevealed = gameState.dealerCards.map(c => ({ ...c, isHidden: false }));

      // Simple hand comparison (full poker hand eval would be complex)
      const allPlayerCards = [...gameState.playerCards, ...community];
      const allDealerCards = [...dealerRevealed, ...community];

      const pVal = getHandValue(gameState.playerCards); // Simplified
      const dVal = getHandValue(dealerRevealed);

      let totalWin = 0;
      let message = '';

      // Simplified: dealer needs pair to qualify
      const dealerQualifies = dealerRevealed[0].rank === dealerRevealed[1].rank ||
          dealerRevealed.some(c => community.some(cc => cc.rank === c.rank));

      if (!dealerQualifies) {
          totalWin = gameState.bet; // Ante wins, play/blind push
          message = "DEALER DOESN'T QUALIFY";
      } else if (pVal > dVal) {
          totalWin = gameState.bet * (2 + multiplier); // Win ante + play
          message = "YOU WIN!";
      } else if (pVal < dVal) {
          totalWin = -(gameState.bet * (2 + multiplier));
          message = "DEALER WINS";
      } else {
          totalWin = 0;
          message = "PUSH";
      }

      setGameState(prev => ({
          ...prev,
          communityCards: community,
          dealerCards: dealerRevealed,
          stage: 'RESULT'
      }));
      resolveGame(totalWin, message);
  };

  const uhFold = () => {
      if (gameState.type !== GameType.ULTIMATE_HOLDEM || gameState.stage !== 'PLAYING') return;
      const dealerRevealed = gameState.dealerCards.map(c => ({ ...c, isHidden: false }));
      setGameState(prev => ({ ...prev, dealerCards: dealerRevealed, stage: 'RESULT' }));
      resolveGame(-gameState.bet * 2, "FOLDED"); // Lose ante + blind
  };

  const registerForTournament = () => {
      setIsRegistered(true);
      setStats(prev => ({ ...prev, chips: INITIAL_CHIPS, shields: INITIAL_SHIELDS, doubles: INITIAL_DOUBLES, history: [], pnlByGame: {}, pnlHistory: [] }));
  };

  const getAdvice = async () => {
      setAiAdvice("Scanning...");
      const advice = await getStrategicAdvice(gameState.type, gameState.playerCards, gameState.dealerCards[0], stats.history);
      setAiAdvice(advice);
  };

  return {
    stats,
    gameState,
    setGameState,
    deck,
    aiAdvice,
    tournamentTime,
    phase,
    leaderboard,
    isRegistered,
    actions: {
        startGame,
        setBetAmount,
        toggleShield,
        toggleDouble,
        deal,
        // Blackjack
        bjHit,
        bjStand,
        bjDouble,
        bjSplit,
        bjInsurance,
        // Video Poker
        toggleHold,
        drawVideoPoker,
        // HiLo
        hiloPlay,
        hiloCashout,
        // Roulette
        placeRouletteBet,
        undoRouletteBet,
        rebetRoulette,
        // Sic Bo
        placeSicBoBet,
        undoSicBoBet,
        rebetSicBo,
        // Craps
        placeCrapsBet,
        undoCrapsBet,
        addCrapsOdds,
        // Baccarat
        baccaratActions,
        // Three Card Poker
        threeCardPlay,
        threeCardFold,
        // Ultimate Holdem
        uhCheck,
        uhBet,
        uhFold,
        // Misc
        registerForTournament,
        getAdvice
    }
  };
};
