
import { useState, useEffect, useRef } from 'react';
import { GameType, PlayerStats, GameState, Card, LeaderboardEntry, TournamentPhase, CompletedHand, CrapsBet, RouletteBet, SicBoBet, BaccaratBet } from '../types';
import { GameType as ChainGameType, CasinoGameStartedEvent, CasinoGameMovedEvent, CasinoGameCompletedEvent } from '../types/casino';
import { createDeck, rollDie, getHandValue, getBaccaratValue, getHiLoRank, WAYS, getRouletteColor, evaluateVideoPokerHand, calculateCrapsExposure, calculateSicBoOutcomeExposure, getSicBoCombinations } from '../utils/gameUtils';
import { getStrategicAdvice } from '../services/geminiService';
import { CasinoChainService } from '../services/CasinoChainService';
import { CasinoClient } from '../api/client.js';
import { WasmWrapper } from '../api/wasm.js';

const INITIAL_CHIPS = 1000;
const INITIAL_SHIELDS = 3;
const INITIAL_DOUBLES = 3;

// Map frontend GameType to chain GameType
const GAME_TYPE_MAP: Record<GameType, ChainGameType> = {
  [GameType.BACCARAT]: ChainGameType.Baccarat,
  [GameType.BLACKJACK]: ChainGameType.Blackjack,
  [GameType.CASINO_WAR]: ChainGameType.CasinoWar,
  [GameType.CRAPS]: ChainGameType.Craps,
  [GameType.VIDEO_POKER]: ChainGameType.VideoPoker,
  [GameType.HILO]: ChainGameType.HiLo,
  [GameType.ROULETTE]: ChainGameType.Roulette,
  [GameType.SIC_BO]: ChainGameType.SicBo,
  [GameType.THREE_CARD]: ChainGameType.ThreeCard,
  [GameType.ULTIMATE_HOLDEM]: ChainGameType.UltimateHoldem,
  [GameType.NONE]: ChainGameType.Blackjack, // Fallback
};

// Reverse mapping from chain game type to frontend game type
const CHAIN_TO_FRONTEND_GAME_TYPE: Record<ChainGameType, GameType> = {
  [ChainGameType.Baccarat]: GameType.BACCARAT,
  [ChainGameType.Blackjack]: GameType.BLACKJACK,
  [ChainGameType.CasinoWar]: GameType.CASINO_WAR,
  [ChainGameType.Craps]: GameType.CRAPS,
  [ChainGameType.VideoPoker]: GameType.VIDEO_POKER,
  [ChainGameType.HiLo]: GameType.HILO,
  [ChainGameType.Roulette]: GameType.ROULETTE,
  [ChainGameType.SicBo]: GameType.SIC_BO,
  [ChainGameType.ThreeCard]: GameType.THREE_CARD,
  [ChainGameType.UltimateHoldem]: GameType.ULTIMATE_HOLDEM,
};

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

  // Chain service integration
  const [chainService, setChainService] = useState<CasinoChainService | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<bigint | null>(null);
  const currentSessionIdRef = useRef<bigint | null>(null);
  const gameTypeRef = useRef<GameType>(GameType.NONE);
  const [isOnChain, setIsOnChain] = useState(false);
  const [lastTxSig, setLastTxSig] = useState<string | null>(null);
  const clientRef = useRef<CasinoClient | null>(null);
  const publicKeyBytesRef = useRef<Uint8Array | null>(null);

  // Initialize chain service
  useEffect(() => {
    const initChain = async () => {
      try {
        // Get the network identity from environment for update verification
        const networkIdentity = import.meta.env.VITE_IDENTITY as string | undefined;
        const wasm = new WasmWrapper(networkIdentity);
        await wasm.init();
        const client = new CasinoClient('/api', wasm);
        await client.init();

        // Initialize keypair for transaction signing
        const keypair = client.getOrCreateKeypair();
        console.log('[useTerminalGame] Keypair initialized, public key:', keypair.publicKeyHex);

        // Store refs for later use
        clientRef.current = client;
        publicKeyBytesRef.current = keypair.publicKey;

        // Connect to WebSocket updates stream with "All" filter for debugging
        // TODO: Change back to account-specific filter once working
        await client.connectUpdates(null);  // null = receive ALL updates
        console.log('[useTerminalGame] Connected to updates WebSocket (All filter)');

        // Fetch on-chain player state to sync chips, shields, doubles, and active modifiers
        try {
          const playerState = await client.getCasinoPlayer(keypair.publicKey);
          if (playerState) {
            console.log('[useTerminalGame] Found on-chain player state:', playerState);
            setStats(prev => ({
              ...prev,
              chips: playerState.chips,
              shields: playerState.shields,
              doubles: playerState.doubles,
            }));

            // Sync active modifiers from chain
            setGameState(prev => ({
              ...prev,
              activeModifiers: {
                shield: playerState.activeShield || false,
                double: playerState.activeDouble || false,
              }
            }));

            setIsRegistered(true);

            // Check for active session and restore game state
            if (playerState.activeSession) {
              const sessionId = BigInt(playerState.activeSession);
              console.log('[useTerminalGame] Found active session:', sessionId.toString());
              try {
                const sessionState = await client.getCasinoSession(sessionId);
                if (sessionState && !sessionState.isComplete) {
                  console.log('[useTerminalGame] Restoring active session:', sessionState);
                  currentSessionIdRef.current = sessionId;
                  setCurrentSessionId(sessionId);
                  // Set the game type from the session
                  const frontendGameType = CHAIN_TO_FRONTEND_GAME_TYPE[sessionState.gameType as ChainGameType];
                  if (frontendGameType) {
                    gameTypeRef.current = frontendGameType;
                    setGameState(prev => ({
                      ...prev,
                      type: frontendGameType,
                      bet: Number(sessionState.bet),
                      stage: 'PLAYING',
                      message: 'GAME IN PROGRESS - RESTORED FROM CHAIN',
                    }));
                    // Parse the state blob to restore UI
                    parseGameState(sessionState.stateBlob, frontendGameType);
                  }
                }
              } catch (sessionError) {
                console.warn('[useTerminalGame] Failed to fetch session state:', sessionError);
              }
            }
          } else {
            console.log('[useTerminalGame] No on-chain player state found, using defaults');
          }
        } catch (playerError) {
          console.warn('[useTerminalGame] Failed to fetch player state:', playerError);
        }

        const service = new CasinoChainService(client);
        setChainService(service);
        setIsOnChain(true);
      } catch (error) {
        console.error('[useTerminalGame] Failed to initialize chain service:', error);
        setIsOnChain(false);
      }
    };
    initChain();
  }, []);

  // --- TOURNAMENT CLOCK ---
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const regDuration = 10 * 1000; // 10 seconds registration
      const activeDuration = 5 * 60 * 1000; // 5 mins active
      const cycleDuration = regDuration + activeDuration;
      const elapsed = now % cycleDuration;

      const isReg = elapsed < regDuration;

      if (isReg) {
          if (phase !== 'REGISTRATION') {
              setPhase('REGISTRATION');
              setIsRegistered(false);
              // Auto-register for the next round
              setTimeout(async () => {
                if (!isRegistered && chainService && clientRef.current && publicKeyBytesRef.current) {
                  const playerName = `Player_${Date.now().toString(36)}`;
                  try {
                    await chainService.register(playerName);
                    setIsRegistered(true);
                    hasRegisteredRef.current = true;

                    // Fetch on-chain player state instead of using hardcoded values
                    // Wait a moment for the registration to be processed
                    setTimeout(async () => {
                      try {
                        const playerState = await clientRef.current!.getCasinoPlayer(publicKeyBytesRef.current!);
                        if (playerState) {
                          setStats(prev => ({
                            ...prev,
                            chips: playerState.chips,
                            shields: playerState.shields,
                            doubles: playerState.doubles,
                            history: [],
                            pnlByGame: {},
                            pnlHistory: []
                          }));
                        }
                      } catch (e) {
                        console.warn('[useTerminalGame] Failed to fetch player state after registration:', e);
                      }
                    }, 500);
                  } catch (e) {
                    console.error('[useTerminalGame] Registration failed:', e);
                  }
                }
              }, 100);
          }
          setTournamentTime(Math.floor((regDuration - elapsed) / 1000));
      } else {
          if (phase !== 'ACTIVE') {
               setPhase('ACTIVE');
          }
          const activeElapsed = elapsed - regDuration;
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
  }, [stats.chips, phase, chainService, isRegistered]);

  // Subscribe to chain events
  useEffect(() => {
    if (!chainService || !isOnChain) return;

    const unsubStarted = chainService.onGameStarted((event: CasinoGameStartedEvent) => {
      // Only process events for our current session
      if (currentSessionIdRef.current && event.sessionId === currentSessionIdRef.current) {
        // Store game type for use in subsequent move events
        const frontendGameType = CHAIN_TO_FRONTEND_GAME_TYPE[event.gameType];
        gameTypeRef.current = frontendGameType;

        // Parse the initial state to get dealt cards
        if (event.initialState && event.initialState.length > 0) {
          parseGameState(event.initialState, frontendGameType);
        } else {
          setGameState(prev => ({
            ...prev,
            stage: 'PLAYING',
            message: 'GAME STARTED - WAITING FOR CARDS',
          }));
        }
      }
    });

    const unsubMoved = chainService.onGameMoved((event: CasinoGameMovedEvent) => {
      // Only process events for our current session
      if (currentSessionIdRef.current && event.sessionId === currentSessionIdRef.current) {
        // Parse state and update UI using the tracked game type from ref (not stale closure)
        parseGameState(event.newState, gameTypeRef.current);
      }
    });

    const unsubCompleted = chainService.onGameCompleted((event: CasinoGameCompletedEvent) => {
      // Only process events for our current session
      if (currentSessionIdRef.current && event.sessionId === currentSessionIdRef.current) {
        const payout = Number(event.payout);
        const finalChips = Number(event.finalChips);

        setStats(prev => ({
          ...prev,
          chips: finalChips,
          // Decrement shields/doubles if they were used in this game
          shields: event.wasShielded ? prev.shields - 1 : prev.shields,
          doubles: event.wasDoubled ? prev.doubles - 1 : prev.doubles,
        }));

        // Reset active modifiers since they were consumed
        if (event.wasShielded || event.wasDoubled) {
          setGameState(prev => ({
            ...prev,
            activeModifiers: { shield: false, double: false }
          }));
        }

        setGameState(prev => ({
          ...prev,
          stage: 'RESULT',
          message: payout >= 0 ? `WON ${payout}` : `LOST ${Math.abs(payout)}`,
          lastResult: payout,
        }));

        // Clear session
        currentSessionIdRef.current = null;
        setCurrentSessionId(null);
      }
    });

    return () => {
      unsubStarted();
      unsubMoved();
      unsubCompleted();
    };
  }, [chainService, isOnChain]);

  // Helper to parse game state from event
  const parseGameState = (stateBlob: Uint8Array, gameType?: GameType) => {
    try {
      const view = new DataView(stateBlob.buffer, stateBlob.byteOffset, stateBlob.byteLength);
      const currentType = gameType ?? gameState.type;

      // Parse based on game type
      if (currentType === GameType.BLACKJACK) {
        // [pLen:u8] [pCards:u8×pLen] [dLen:u8] [dCards:u8×dLen] [stage:u8]
        let offset = 0;
        const pLen = stateBlob[offset++];
        const pCards: Card[] = [];
        for (let i = 0; i < pLen; i++) {
          const cardVal = stateBlob[offset++];
          pCards.push(decodeCard(cardVal));
        }
        const dLen = stateBlob[offset++];
        const dCards: Card[] = [];
        for (let i = 0; i < dLen; i++) {
          const cardVal = stateBlob[offset++];
          dCards.push({ ...decodeCard(cardVal), isHidden: i > 0 }); // First dealer card visible
        }
        const stage = stateBlob[offset++];

        setGameState(prev => ({
          ...prev,
          type: currentType,
          playerCards: pCards,
          dealerCards: dCards,
          stage: stage === 3 ? 'RESULT' : 'PLAYING',
          message: stage === 3 ? 'GAME COMPLETE' : 'HIT (H) / STAND (S)',
        }));
      } else if (currentType === GameType.HILO) {
        // [currentCard:u8] [accumulator:i64 BE]
        const currentCard = decodeCard(stateBlob[0]);
        const accumulator = Number(view.getBigInt64(1, false)); // Big Endian

        setGameState(prev => ({
          ...prev,
          type: currentType,
          playerCards: [currentCard],
          hiloAccumulator: accumulator,
          stage: 'PLAYING',
          message: `POT: ${accumulator} | HIGHER (H) / LOWER (L)`,
        }));
      } else if (currentType === GameType.BACCARAT) {
        // [playerHandLen:u8] [playerCards:u8×n] [bankerHandLen:u8] [bankerCards:u8×n]
        let offset = 0;
        const pLen = stateBlob[offset++];
        const pCards: Card[] = [];
        for (let i = 0; i < pLen; i++) {
          pCards.push(decodeCard(stateBlob[offset++]));
        }
        const bLen = stateBlob[offset++];
        const bCards: Card[] = [];
        for (let i = 0; i < bLen; i++) {
          bCards.push(decodeCard(stateBlob[offset++]));
        }

        setGameState(prev => ({
          ...prev,
          type: currentType,
          playerCards: pCards,
          dealerCards: bCards,
          stage: 'RESULT',
          message: 'BACCARAT DEALT',
        }));
      } else if (currentType === GameType.VIDEO_POKER) {
        // [stage:u8] [c1:u8] [c2:u8] [c3:u8] [c4:u8] [c5:u8]
        const stage = stateBlob[0];
        const cards: Card[] = [];
        for (let i = 1; i <= 5; i++) {
          cards.push(decodeCard(stateBlob[i]));
        }

        setGameState(prev => ({
          ...prev,
          type: currentType,
          playerCards: cards,
          stage: stage === 2 ? 'RESULT' : 'PLAYING',
          message: stage === 0 ? 'HOLD (1-5), DRAW (D)' : stage === 1 ? 'DRAW (D)' : 'GAME COMPLETE',
        }));
      } else if (currentType === GameType.CASINO_WAR) {
        // [playerCard:u8] [dealerCard:u8] [stage:u8]
        const playerCard = decodeCard(stateBlob[0]);
        const dealerCard = decodeCard(stateBlob[1]);
        const stage = stateBlob[2];

        setGameState(prev => ({
          ...prev,
          type: currentType,
          playerCards: [playerCard],
          dealerCards: [dealerCard],
          stage: stage === 2 ? 'RESULT' : 'PLAYING',
          message: stage === 2 ? 'GAME COMPLETE' : stage === 1 ? 'WAR! GO TO WAR (W) / SURRENDER (S)' : 'DEALT',
        }));
      } else if (currentType === GameType.CRAPS) {
        // [phase:u8] [main_point:u8] [d1:u8] [d2:u8] [bet_count:u8] [bets...]
        const phase = stateBlob[0]; // 0=ComeOut, 1=Point
        const mainPoint = stateBlob[1];
        const d1 = stateBlob[2];
        const d2 = stateBlob[3];
        // bet_count at stateBlob[4], bets follow

        setGameState(prev => ({
          ...prev,
          type: currentType,
          dice: [d1, d2],
          crapsPoint: mainPoint > 0 ? mainPoint : null,
          stage: 'PLAYING',
          message: phase === 0 ? `COME OUT ROLL: ${d1 + d2}` : `POINT: ${mainPoint} | ROLLED: ${d1 + d2}`,
        }));
      } else if (currentType === GameType.ROULETTE) {
        // [result:u8] after spin (empty before)
        if (stateBlob.length > 0) {
          const result = stateBlob[0];
          setGameState(prev => ({
            ...prev,
            type: currentType,
            rouletteHistory: [...prev.rouletteHistory, result],
            stage: 'RESULT',
            message: `LANDED ON ${result}`,
          }));
        } else {
          setGameState(prev => ({
            ...prev,
            type: currentType,
            stage: 'PLAYING',
            message: 'PLACE YOUR BETS',
          }));
        }
      } else if (currentType === GameType.SIC_BO) {
        // [die1:u8] [die2:u8] [die3:u8]
        if (stateBlob.length >= 3) {
          const dice = [stateBlob[0], stateBlob[1], stateBlob[2]];
          const total = dice[0] + dice[1] + dice[2];
          setGameState(prev => ({
            ...prev,
            type: currentType,
            dice: dice,
            sicBoHistory: [...prev.sicBoHistory, dice],
            stage: 'RESULT',
            message: `ROLLED ${total} (${dice.join('-')})`,
          }));
        } else {
          setGameState(prev => ({
            ...prev,
            type: currentType,
            stage: 'PLAYING',
            message: 'PLACE YOUR BETS',
          }));
        }
      } else if (currentType === GameType.THREE_CARD) {
        // [pCard1:u8] [pCard2:u8] [pCard3:u8] [dCard1:u8] [dCard2:u8] [dCard3:u8] [stage:u8]
        const pCards: Card[] = [
          decodeCard(stateBlob[0]),
          decodeCard(stateBlob[1]),
          decodeCard(stateBlob[2]),
        ];
        const stage = stateBlob[6];
        const dCards: Card[] = [
          { ...decodeCard(stateBlob[3]), isHidden: stage === 0 },
          { ...decodeCard(stateBlob[4]), isHidden: stage === 0 },
          { ...decodeCard(stateBlob[5]), isHidden: stage === 0 },
        ];

        setGameState(prev => ({
          ...prev,
          type: currentType,
          playerCards: pCards,
          dealerCards: dCards,
          stage: stage === 1 ? 'RESULT' : 'PLAYING',
          message: stage === 1 ? 'GAME COMPLETE' : 'PLAY (P) OR FOLD (F)',
        }));
      } else if (currentType === GameType.ULTIMATE_HOLDEM) {
        // [stage:u8] [pCard1:u8] [pCard2:u8] [community1-5:u8×5] [dCard1:u8] [dCard2:u8] [playBetMultiplier:u8]
        const stage = stateBlob[0]; // 0=Preflop, 1=Flop, 2=River, 3=Showdown
        const pCards: Card[] = [
          decodeCard(stateBlob[1]),
          decodeCard(stateBlob[2]),
        ];
        const community: Card[] = [];
        // Community cards revealed based on stage
        for (let i = 0; i < 5; i++) {
          const card = decodeCard(stateBlob[3 + i]);
          if (stage >= 1 && i < 3) community.push(card); // Flop: first 3
          else if (stage >= 2) community.push(card); // River: all 5
        }
        const dCards: Card[] = [
          { ...decodeCard(stateBlob[8]), isHidden: stage < 3 },
          { ...decodeCard(stateBlob[9]), isHidden: stage < 3 },
        ];
        const playBet = stateBlob[10];

        let message = 'CHECK (C) OR BET 4X';
        if (stage === 1) message = 'CHECK (C) OR BET 2X';
        else if (stage === 2) message = playBet > 0 ? 'WAITING...' : 'FOLD (F) OR BET 1X';
        else if (stage === 3) message = 'GAME COMPLETE';

        setGameState(prev => ({
          ...prev,
          type: currentType,
          playerCards: pCards,
          dealerCards: dCards,
          communityCards: community,
          stage: stage === 3 ? 'RESULT' : 'PLAYING',
          message,
        }));
      }
    } catch (error) {
      console.error('[useTerminalGame] Failed to parse state:', error);
    }
  };

  // Helper to decode card value (0-51) to Card object
  const decodeCard = (value: number): Card => {
    const suits: readonly ['♠', '♥', '♦', '♣'] = ['♠', '♥', '♦', '♣'] as const;
    const ranks: readonly ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;

    const suit = suits[Math.floor(value / 13)];
    const rank = ranks[value % 13];
    const cardValue = value % 13 + 1;

    return {
      suit,
      rank,
      value: cardValue > 10 ? 10 : cardValue,
      isHidden: false,
    };
  };

  // --- CORE ACTIONS ---

  // Track if we've registered on-chain
  const hasRegisteredRef = useRef(false);

  const startGame = async (type: GameType) => {
    // Optimistic update
    setGameState(prev => ({
      ...prev,
      type,
      message: "STARTING GAME...",
      bet: prev.bet,
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
    }));
    setAiAdvice(null);

    // If on-chain mode is enabled, submit transaction
    if (isOnChain && chainService) {
      try {
        // Ensure player is registered on-chain first
        if (!hasRegisteredRef.current) {
          const playerName = `Player_${Date.now().toString(36)}`;
          console.log('[useTerminalGame] Registering on-chain as:', playerName);
          await chainService.register(playerName);
          hasRegisteredRef.current = true;
          console.log('[useTerminalGame] Registration submitted');
        }

        const chainGameType = GAME_TYPE_MAP[type];
        const result = await chainService.startGame(chainGameType, BigInt(gameState.bet));
        const sessionId = result.sessionId;
        if (result.txHash) setLastTxSig(result.txHash);

        // Store session ID and game type for tracking events
        currentSessionIdRef.current = sessionId;
        gameTypeRef.current = type;
        setCurrentSessionId(sessionId);

        // State will update when CasinoGameStarted event arrives
        setGameState(prev => ({
          ...prev,
          message: "WAITING FOR CHAIN...",
        }));
      } catch (error) {
        console.error('[useTerminalGame] Failed to start game on-chain:', error);

        // Rollback on failure
        setGameState(prev => ({
          ...prev,
          stage: 'BETTING',
          message: 'TRANSACTION FAILED - TRY AGAIN',
        }));
      }
    } else {
      // Fallback to local mode
      setGameState(prev => ({
        ...prev,
        message: "SPACE TO DEAL",
        stage: 'BETTING',
      }));
    }
  };

  const setBetAmount = (amount: number) => {
    // Allow bet changes during BETTING, or during PLAYING for table games
    const isTableGame = [GameType.CRAPS, GameType.ROULETTE, GameType.SIC_BO].includes(gameState.type);
    if (gameState.stage === 'PLAYING' && !isTableGame) return;
    if (stats.chips < amount) {
      setGameState(prev => ({ ...prev, message: "INSUFFICIENT FUNDS" }));
      return;
    }
    setGameState(prev => ({ ...prev, bet: amount, message: `BET SIZE: ${amount}` }));
  };

  const toggleShield = async () => {
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

    // Optimistic update
    const newShieldState = !gameState.activeModifiers.shield;
    setGameState(prev => ({ ...prev, activeModifiers: { ...prev.activeModifiers, shield: newShieldState } }));

    // Submit to chain if enabled
    if (isOnChain && chainService) {
      try {
        const result = await chainService.toggleShield();
        if (result.txHash) setLastTxSig(result.txHash);
      } catch (error) {
        console.error('[useTerminalGame] Failed to toggle shield:', error);
        // Rollback on failure
        setGameState(prev => ({ ...prev, activeModifiers: { ...prev.activeModifiers, shield: !newShieldState } }));
      }
    }
  };

  const toggleDouble = async () => {
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

    // Optimistic update
    const newDoubleState = !gameState.activeModifiers.double;
    setGameState(prev => ({ ...prev, activeModifiers: { ...prev.activeModifiers, double: newDoubleState } }));

    // Submit to chain if enabled
    if (isOnChain && chainService) {
      try {
        const result = await chainService.toggleDouble();
        if (result.txHash) setLastTxSig(result.txHash);
      } catch (error) {
        console.error('[useTerminalGame] Failed to toggle double:', error);
        // Rollback on failure
        setGameState(prev => ({ ...prev, activeModifiers: { ...prev.activeModifiers, double: !newDoubleState } }));
      }
    }
  };

  // --- SERIALIZATION HELPERS ---

  /**
   * Serialize a Sic Bo bet to the binary format expected by the Rust backend.
   *
   * Payload format: [betType:u8] [number:u8]
   *
   * Bet types (from execution/src/casino/sic_bo.rs):
   * 0 = Small (4-10, 1:1) - loses on triple
   * 1 = Big (11-17, 1:1) - loses on triple
   * 2 = Odd total (1:1)
   * 3 = Even total (1:1)
   * 4 = Specific triple (150:1) - number = 1-6
   * 5 = Any triple (24:1)
   * 6 = Specific double (8:1) - number = 1-6
   * 7 = Total of N (various payouts) - number = 4-17
   * 8 = Single number appears (1:1 to 3:1) - number = 1-6
   */
  const serializeSicBoBet = (bet: SicBoBet): Uint8Array => {
    // Map frontend bet type to backend bet type
    const betTypeMap: Record<SicBoBet['type'], number> = {
      'SMALL': 0,
      'BIG': 1,
      'TRIPLE_ANY': 5,
      'TRIPLE_SPECIFIC': 4,
      'DOUBLE_SPECIFIC': 6,
      'SUM': 7,
      'SINGLE_DIE': 8,
    };

    const betType = betTypeMap[bet.type];
    const number = bet.target ?? 0;

    return new Uint8Array([betType, number]);
  };

  // --- GAME ENGINES (Condensed for brevity, same logic as before) ---
  
  // BLACKJACK ENGINE
  const bjHit = async () => {
    // If on-chain mode, submit move
    if (isOnChain && chainService && currentSessionIdRef.current) {
      try {
        // Payload: [0] for Hit
        const result = await chainService.sendMove(currentSessionIdRef.current, new Uint8Array([0]));
        if (result.txHash) setLastTxSig(result.txHash);
        // State will update when CasinoGameMoved event arrives
        setGameState(prev => ({ ...prev, message: 'HITTING...' }));
        return;
      } catch (error) {
        console.error('[useTerminalGame] Hit failed:', error);
        setGameState(prev => ({ ...prev, message: 'MOVE FAILED' }));
        return;
      }
    }

    // Local mode fallback
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

  const bjStand = async () => {
    // If on-chain mode, submit move
    if (isOnChain && chainService && currentSessionIdRef.current) {
      try {
        // Payload: [1] for Stand
        const result = await chainService.sendMove(currentSessionIdRef.current, new Uint8Array([1]));
        if (result.txHash) setLastTxSig(result.txHash);
        setGameState(prev => ({ ...prev, message: 'STANDING...' }));
        return;
      } catch (error) {
        console.error('[useTerminalGame] Stand failed:', error);
        setGameState(prev => ({ ...prev, message: 'MOVE FAILED' }));
        return;
      }
    }

    // Local mode fallback
    bjStandAuto(gameState.playerCards);
  };

  const bjDouble = async () => {
    // If on-chain mode, submit move
    if (isOnChain && chainService && currentSessionIdRef.current) {
      try {
        // Payload: [2] for Double
        const result = await chainService.sendMove(currentSessionIdRef.current, new Uint8Array([2]));
        if (result.txHash) setLastTxSig(result.txHash);
        setGameState(prev => ({ ...prev, message: 'DOUBLING...' }));
        return;
      } catch (error) {
        console.error('[useTerminalGame] Double failed:', error);
        setGameState(prev => ({ ...prev, message: 'MOVE FAILED' }));
        return;
      }
    }

    // Local mode fallback
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
  const deal = async () => {
    if (gameState.type === GameType.NONE) return;
    if (gameState.type === GameType.CRAPS) { rollCraps(); return; }
    if (gameState.type === GameType.ROULETTE) { spinRoulette(); return; }
    if (gameState.type === GameType.SIC_BO) { rollSicBo(); return; }

    // On-chain Baccarat/Casino War: These games receive CasinoGameStarted with empty state,
    // then need a move to trigger the deal. Handle BEFORE the stage check since they're
    // already in PLAYING stage waiting for the deal move.
    if (isOnChain && chainService && currentSessionIdRef.current) {
      const sessionId = currentSessionIdRef.current;

      // Baccarat: needs bet type move to deal cards (stage will be PLAYING after GameStarted)
      if (gameState.type === GameType.BACCARAT && gameState.stage === 'PLAYING' && gameState.playerCards.length === 0) {
        try {
          // Map baccaratSelection to bet type: PLAYER=0, BANKER=1
          const betType = gameState.baccaratSelection === 'PLAYER' ? 0 : 1;
          const payload = new Uint8Array([betType]);
          const result = await chainService.sendMove(sessionId, payload);
          if (result.txHash) setLastTxSig(result.txHash);
          setGameState(prev => ({ ...prev, message: 'DEALING...' }));
          return;
        } catch (error) {
          console.error('[useTerminalGame] Baccarat deal failed:', error);
          setGameState(prev => ({ ...prev, message: 'DEAL FAILED' }));
          return;
        }
      }

      // Casino War: when cards are dealt (message='DEALT'), send confirm move to trigger result
      if (gameState.type === GameType.CASINO_WAR && gameState.stage === 'PLAYING' && gameState.message === 'DEALT') {
        try {
          const payload = new Uint8Array([0]); // Confirm deal - triggers comparison
          const result = await chainService.sendMove(sessionId, payload);
          if (result.txHash) setLastTxSig(result.txHash);
          setGameState(prev => ({ ...prev, message: 'CONFIRMING...' }));
          return;
        } catch (error) {
          console.error('[useTerminalGame] Casino War confirm failed:', error);
          setGameState(prev => ({ ...prev, message: 'CONFIRM FAILED' }));
          return;
        }
      }
    }

    // Block deal for games already in play (except Baccarat/Casino War handled above)
    if (gameState.stage === 'PLAYING') return;
    if (stats.chips < gameState.bet) { setGameState(prev => ({ ...prev, message: "INSUFFICIENT FUNDS" })); return; }

    // If on-chain mode for other games, just wait for chain events
    if (isOnChain && chainService && currentSessionIdRef.current) {
      setGameState(prev => ({ ...prev, message: 'WAITING FOR DEAL...' }));
      return;
    }

    // Local mode fallback
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
        setGameState(prev => ({ ...prev, message: `${winner} WINS`, lastResult: totalWin }));
    } else if (gameState.type === GameType.CASINO_WAR) {
        const p1 = newDeck.pop()!, d1 = newDeck.pop()!;
        let win = p1.value > d1.value ? gameState.bet : p1.value < d1.value ? -gameState.bet : 0;
        setGameState(prev => ({ ...prev, stage: 'RESULT', playerCards: [p1], dealerCards: [d1] }));
        setGameState(prev => ({ ...prev, message: win > 0 ? "WIN" : win < 0 ? "LOSE" : "TIE", lastResult: win }));
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

  const drawVideoPoker = async () => {
      // Build hold mask: bit N = 1 if card N should be held (isHidden = true means held)
      let holdMask = 0;
      gameState.playerCards.forEach((c, i) => {
        if (c.isHidden) holdMask |= (1 << i);
      });

      // If on-chain mode, submit move to chain
      if (isOnChain && chainService && currentSessionIdRef.current) {
        try {
          const payload = new Uint8Array([holdMask]);
          const result = await chainService.sendMove(currentSessionIdRef.current, payload);
          if (result.txHash) setLastTxSig(result.txHash);
          setGameState(prev => ({ ...prev, message: 'DRAWING...' }));
          return;
        } catch (error) {
          console.error('[useTerminalGame] Video Poker draw failed:', error);
          setGameState(prev => ({ ...prev, message: 'DRAW FAILED' }));
          return;
        }
      }

      // Local mode fallback (shouldn't be used in production)
      const hand = gameState.playerCards.map((c, i) => {
        if (c.isHidden) return { ...c, isHidden: false };
        const newCard = deck.pop();
        return newCard || c; // Fallback to original if deck empty
      });
      const { rank, multiplier } = evaluateVideoPokerHand(hand);
      const profit = (gameState.bet * multiplier) - gameState.bet;
      setGameState(prev => ({ ...prev, playerCards: hand, stage: 'RESULT', lastResult: profit }));
      setGameState(prev => ({ ...prev, message: multiplier > 0 ? `${rank}!` : "LOST" }));
  };

  const hiloPlay = async (guess: 'HIGHER' | 'LOWER') => {
      // If on-chain mode, submit move
      if (isOnChain && chainService && currentSessionIdRef.current) {
        try {
          // Payload: [0] for Higher, [1] for Lower
          const payload = guess === 'HIGHER' ? new Uint8Array([0]) : new Uint8Array([1]);
          const result = await chainService.sendMove(currentSessionIdRef.current, payload);
          if (result.txHash) setLastTxSig(result.txHash);
          setGameState(prev => ({ ...prev, message: `GUESSING ${guess}...` }));
          return;
        } catch (error) {
          console.error('[useTerminalGame] HiLo move failed:', error);
          setGameState(prev => ({ ...prev, message: 'MOVE FAILED' }));
          return;
        }
      }

      // Local mode fallback
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
          setGameState(prev => ({ ...prev, message: "WRONG", lastResult: -gameState.bet }));
      }
  };
  const hiloCashout = async () => {
       // If on-chain mode, submit cashout
       if (isOnChain && chainService && currentSessionIdRef.current) {
         try {
           // Payload: [2] for Cashout
           const result = await chainService.sendMove(currentSessionIdRef.current, new Uint8Array([2]));
           if (result.txHash) setLastTxSig(result.txHash);
           setGameState(prev => ({ ...prev, message: 'CASHING OUT...' }));
           return;
         } catch (error) {
           console.error('[useTerminalGame] Cashout failed:', error);
           setGameState(prev => ({ ...prev, message: 'MOVE FAILED' }));
           return;
         }
       }

       // Local mode fallback
      const profit = gameState.hiloAccumulator - gameState.bet;
      setGameState(prev => ({ ...prev, message: "CASHED OUT", lastResult: profit }));
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
  // Helper to serialize roulette bets to the format expected by the Rust backend
  const serializeRouletteBets = (bets: RouletteBet[]): Uint8Array => {
    // For roulette, we only send one bet at a time
    // The backend expects: [betType:u8] [number:u8]
    // Bet types: 0=Straight, 1=Red, 2=Black, 3=Even, 4=Odd, 5=Low, 6=High, 7=Dozen, 8=Column

    if (bets.length === 0) {
      throw new Error('No bets to serialize');
    }

    // Take the first bet (or we could sum all bets later)
    // For now, send the first bet only - multi-bet support would need backend changes
    const bet = bets[0];
    const payload = new Uint8Array(2);

    // Map frontend bet types to backend bet types
    switch (bet.type) {
      case 'STRAIGHT':
        payload[0] = 0; // BetType::Straight
        payload[1] = bet.target ?? 0;
        break;
      case 'RED':
        payload[0] = 1; // BetType::Red
        payload[1] = 0; // No number needed
        break;
      case 'BLACK':
        payload[0] = 2; // BetType::Black
        payload[1] = 0;
        break;
      case 'EVEN':
        payload[0] = 3; // BetType::Even
        payload[1] = 0;
        break;
      case 'ODD':
        payload[0] = 4; // BetType::Odd
        payload[1] = 0;
        break;
      case 'LOW':
        payload[0] = 5; // BetType::Low
        payload[1] = 0;
        break;
      case 'HIGH':
        payload[0] = 6; // BetType::High
        payload[1] = 0;
        break;
      case 'DOZEN_1':
        payload[0] = 7; // BetType::Dozen
        payload[1] = 0;
        break;
      case 'DOZEN_2':
        payload[0] = 7; // BetType::Dozen
        payload[1] = 1;
        break;
      case 'DOZEN_3':
        payload[0] = 7; // BetType::Dozen
        payload[1] = 2;
        break;
      case 'COL_1':
        payload[0] = 8; // BetType::Column
        payload[1] = 0;
        break;
      case 'COL_2':
        payload[0] = 8; // BetType::Column
        payload[1] = 1;
        break;
      case 'COL_3':
        payload[0] = 8; // BetType::Column
        payload[1] = 2;
        break;
      case 'ZERO':
        payload[0] = 0; // BetType::Straight
        payload[1] = 0;
        break;
      default:
        throw new Error(`Unknown bet type: ${bet.type}`);
    }

    return payload;
  };

  const spinRoulette = async () => {
      if (gameState.rouletteBets.length === 0) { setGameState(prev => ({ ...prev, message: "PLACE BET" })); return; }

      // If on-chain mode, submit move to chain
      if (isOnChain && chainService && currentSessionIdRef.current) {
        try {
          // Serialize the first bet to the format expected by the Rust backend
          const payload = serializeRouletteBets(gameState.rouletteBets);
          const result = await chainService.sendMove(currentSessionIdRef.current, payload);
          if (result.txHash) setLastTxSig(result.txHash);

          // Update UI to show we're waiting for chain
          setGameState(prev => ({
            ...prev,
            message: 'SPINNING ON CHAIN...',
            rouletteLastRoundBets: prev.rouletteBets,
            rouletteBets: [],
            rouletteUndoStack: []
          }));

          // Result will come via CasinoGameMoved/CasinoGameCompleted events
          return;
        } catch (error) {
          console.error('[useTerminalGame] Roulette spin failed:', error);
          setGameState(prev => ({ ...prev, message: 'SPIN FAILED - TRY AGAIN' }));
          return;
        }
      }

      // Local mode fallback (original logic)
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
      setGameState(prev => ({ ...prev, message: `SPUN ${num}`, lastResult: win }));
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
  const rollSicBo = async () => {
       if (gameState.sicBoBets.length === 0) { setGameState(prev => ({...prev, message: "PLACE BET"})); return; }

       // If on-chain mode, submit move
       if (isOnChain && chainService && currentSessionIdRef.current) {
         try {
           // NOTE: On-chain Sic Bo currently only supports ONE bet per session
           // We'll send the first bet only
           const firstBet = gameState.sicBoBets[0];
           const payload = serializeSicBoBet(firstBet);
           const result = await chainService.sendMove(currentSessionIdRef.current, payload);
           if (result.txHash) setLastTxSig(result.txHash);
           setGameState(prev => ({
             ...prev,
             sicBoLastRoundBets: prev.sicBoBets,
             sicBoBets: [],
             sicBoUndoStack: [],
             message: 'ROLLING...'
           }));
           return;
         } catch (error) {
           console.error('[useTerminalGame] Sic Bo roll failed:', error);
           setGameState(prev => ({ ...prev, message: 'MOVE FAILED' }));
           return;
         }
       }

       // Local mode fallback
       const d = [rollDie(), rollDie(), rollDie()];
       const win = calculateSicBoOutcomeExposure(d, gameState.sicBoBets); // reuse helper for actual calc
       setGameState(prev => ({ ...prev, dice: d, sicBoHistory: [...prev.sicBoHistory, d], sicBoLastRoundBets: prev.sicBoBets, sicBoBets: [], sicBoUndoStack: [] }));
       setGameState(prev => ({ ...prev, message: `ROLLED ${d.reduce((a,b)=>a+b,0)}`, lastResult: win }));
  };

  // Helper to serialize a single Craps bet for chain submission
  const serializeCrapsBet = (bet: CrapsBet): Uint8Array => {
    // Payload format: [0, bet_type, target, amount_bytes...]
    // Map frontend bet types to Rust BetType enum values
    const BET_TYPE_MAP: Record<CrapsBet['type'], number> = {
      'PASS': 0,
      'DONT_PASS': 1,
      'COME': 2,
      'DONT_COME': 3,
      'FIELD': 4,
      'YES': 5,
      'NO': 6,
      'NEXT': 7,
      'HARDWAY': 8, // Will be refined based on target
    };

    let betTypeValue = BET_TYPE_MAP[bet.type];

    // For HARDWAY bets, determine specific hardway type based on target
    if (bet.type === 'HARDWAY' && bet.target) {
      if (bet.target === 4) betTypeValue = 8;       // Hardway4
      else if (bet.target === 6) betTypeValue = 9;  // Hardway6
      else if (bet.target === 8) betTypeValue = 10; // Hardway8
      else if (bet.target === 10) betTypeValue = 11; // Hardway10
    }

    const payload = new Uint8Array(11);
    payload[0] = 0; // Command: Place bet
    payload[1] = betTypeValue;
    payload[2] = bet.target ?? 0;

    // Amount as u64 big-endian (8 bytes)
    const amount = BigInt(bet.amount);
    const view = new DataView(payload.buffer);
    view.setBigUint64(3, amount, false); // false = big-endian

    return payload;
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
  const rollCraps = async () => {
       // If on-chain mode, submit roll move
       if (isOnChain && chainService && currentSessionIdRef.current) {
         try {
           // First, place all pending bets on-chain
           for (const bet of gameState.crapsBets) {
             const betPayload = serializeCrapsBet(bet);
             await chainService.sendMove(currentSessionIdRef.current, betPayload);
           }

           // Then submit roll command: [2]
           const rollPayload = new Uint8Array([2]);
           const result = await chainService.sendMove(currentSessionIdRef.current, rollPayload);
           if (result.txHash) setLastTxSig(result.txHash);

           // Clear local bets since they're now on-chain
           setGameState(prev => ({
             ...prev,
             crapsBets: [],
             message: 'ROLLING DICE...'
           }));
           return;
         } catch (error) {
           console.error('[useTerminalGame] Craps roll failed:', error);
           setGameState(prev => ({ ...prev, message: 'ROLL FAILED' }));
           return;
         }
       }

       // Local mode fallback
       const d1=rollDie(), d2=rollDie(), total=d1+d2;
       const pnl = calculateCrapsExposure(total, gameState.crapsPoint, gameState.crapsBets); // Reuse helper for PnL
       // Update point logic simplified
       let newPoint = gameState.crapsPoint;
       if (gameState.crapsPoint === null && [4,5,6,8,9,10].includes(total)) newPoint = total;
       else if (gameState.crapsPoint === total || total === 7) newPoint = null;

       setGameState(prev => ({ ...prev, dice: [d1, d2], crapsPoint: newPoint, crapsRollHistory: [...prev.crapsRollHistory, total], message: `ROLLED ${total}` }));
       setGameState(prev => ({ ...prev, message: `ROLLED ${total}`, lastResult: pnl }));
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

  const threeCardPlay = async () => {
      if (gameState.type !== GameType.THREE_CARD || gameState.stage !== 'PLAYING') return;

      // If on-chain mode, submit move
      if (isOnChain && chainService && currentSessionIdRef.current) {
        try {
          // Payload: [0] for Play
          const payload = new Uint8Array([0]);
          const result = await chainService.sendMove(currentSessionIdRef.current, payload);
          if (result.txHash) setLastTxSig(result.txHash);
          setGameState(prev => ({ ...prev, message: 'PLAYING...' }));
          return;
        } catch (error) {
          console.error('[useTerminalGame] Three Card Play failed:', error);
          setGameState(prev => ({ ...prev, message: 'MOVE FAILED' }));
          return;
        }
      }

      // Local mode fallback
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
      setGameState(prev => ({ ...prev, message, lastResult: totalWin }));
  };

  const threeCardFold = async () => {
      if (gameState.type !== GameType.THREE_CARD || gameState.stage !== 'PLAYING') return;

      // If on-chain mode, submit move
      if (isOnChain && chainService && currentSessionIdRef.current) {
        try {
          // Payload: [1] for Fold
          const payload = new Uint8Array([1]);
          const result = await chainService.sendMove(currentSessionIdRef.current, payload);
          if (result.txHash) setLastTxSig(result.txHash);
          setGameState(prev => ({ ...prev, message: 'FOLDING...' }));
          return;
        } catch (error) {
          console.error('[useTerminalGame] Three Card Fold failed:', error);
          setGameState(prev => ({ ...prev, message: 'MOVE FAILED' }));
          return;
        }
      }

      // Local mode fallback
      const dealerRevealed = gameState.dealerCards.map(c => ({ ...c, isHidden: false }));
      setGameState(prev => ({ ...prev, dealerCards: dealerRevealed, stage: 'RESULT' }));
      setGameState(prev => ({ ...prev, message: "FOLDED", lastResult: -gameState.bet }));
  };

  // --- ULTIMATE HOLDEM ---
  const uhCheck = async () => {
      if (gameState.type !== GameType.ULTIMATE_HOLDEM || gameState.stage !== 'PLAYING') return;

      // If on-chain mode, submit move
      if (isOnChain && chainService && currentSessionIdRef.current) {
        try {
          // Payload: [0] for Check
          const payload = new Uint8Array([0]);
          const result = await chainService.sendMove(currentSessionIdRef.current, payload);
          if (result.txHash) setLastTxSig(result.txHash);
          setGameState(prev => ({ ...prev, message: 'CHECKING...' }));
          return;
        } catch (error) {
          console.error('[useTerminalGame] Ultimate Holdem Check failed:', error);
          setGameState(prev => ({ ...prev, message: 'MOVE FAILED' }));
          return;
        }
      }

      // Local mode fallback
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

  const uhBet = async (multiplier: number) => {
      if (gameState.type !== GameType.ULTIMATE_HOLDEM || gameState.stage !== 'PLAYING') return;

      // If on-chain mode, submit move
      if (isOnChain && chainService && currentSessionIdRef.current) {
        try {
          // Payload: [1] for Bet4x, [2] for Bet2x, [3] for Bet1x
          let payload: Uint8Array;
          if (multiplier === 4) {
            payload = new Uint8Array([1]); // Bet4x
          } else if (multiplier === 2) {
            payload = new Uint8Array([2]); // Bet2x
          } else if (multiplier === 1) {
            payload = new Uint8Array([3]); // Bet1x
          } else {
            console.error('[useTerminalGame] Invalid bet multiplier:', multiplier);
            setGameState(prev => ({ ...prev, message: 'INVALID BET' }));
            return;
          }
          const result = await chainService.sendMove(currentSessionIdRef.current, payload);
          if (result.txHash) setLastTxSig(result.txHash);
          setGameState(prev => ({ ...prev, message: `BETTING ${multiplier}X...` }));
          return;
        } catch (error) {
          console.error('[useTerminalGame] Ultimate Holdem Bet failed:', error);
          setGameState(prev => ({ ...prev, message: 'MOVE FAILED' }));
          return;
        }
      }

      // Local mode fallback
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
      setGameState(prev => ({ ...prev, message, lastResult: totalWin }));
  };

  const uhFold = async () => {
      if (gameState.type !== GameType.ULTIMATE_HOLDEM || gameState.stage !== 'PLAYING') return;

      // If on-chain mode, submit move
      if (isOnChain && chainService && currentSessionIdRef.current) {
        try {
          // Payload: [4] for Fold
          const payload = new Uint8Array([4]);
          const result = await chainService.sendMove(currentSessionIdRef.current, payload);
          if (result.txHash) setLastTxSig(result.txHash);
          setGameState(prev => ({ ...prev, message: 'FOLDING...' }));
          return;
        } catch (error) {
          console.error('[useTerminalGame] Ultimate Holdem Fold failed:', error);
          setGameState(prev => ({ ...prev, message: 'MOVE FAILED' }));
          return;
        }
      }

      // Local mode fallback
      const dealerRevealed = gameState.dealerCards.map(c => ({ ...c, isHidden: false }));
      setGameState(prev => ({ ...prev, dealerCards: dealerRevealed, stage: 'RESULT' }));
      setGameState(prev => ({ ...prev, message: "FOLDED", lastResult: -gameState.bet * 2 }));
  };

  const registerForTournament = async () => {
      // Register on-chain first
      if (chainService) {
        try {
          const playerName = `Player_${Date.now().toString(36)}`;
          await chainService.register(playerName);
          console.log('[useTerminalGame] Registered on-chain as:', playerName);
        } catch (error) {
          console.error('[useTerminalGame] Failed to register on-chain:', error);
          // Continue anyway - the registration will be retried
        }
      }
      setIsRegistered(true);

      // Fetch on-chain player state instead of using hardcoded values
      if (clientRef.current && publicKeyBytesRef.current) {
        setTimeout(async () => {
          try {
            const playerState = await clientRef.current!.getCasinoPlayer(publicKeyBytesRef.current!);
            if (playerState) {
              setStats(prev => ({
                ...prev,
                chips: playerState.chips,
                shields: playerState.shields,
                doubles: playerState.doubles,
                history: [],
                pnlByGame: {},
                pnlHistory: []
              }));
            }
          } catch (e) {
            console.warn('[useTerminalGame] Failed to fetch player state after registration:', e);
          }
        }, 500);
      }
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
    lastTxSig,
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
