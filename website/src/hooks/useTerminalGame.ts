
import { useState, useEffect, useRef } from 'react';
import { GameType, PlayerStats, GameState, Card, LeaderboardEntry, TournamentPhase, CompletedHand, CrapsBet, RouletteBet, SicBoBet, BaccaratBet } from '../types';
import { GameType as ChainGameType, CasinoGameStartedEvent, CasinoGameMovedEvent, CasinoGameCompletedEvent } from '../types/casino';
import { createDeck, rollDie, getHandValue, getBaccaratValue, getHiLoRank, WAYS, getRouletteColor, evaluateVideoPokerHand, calculateCrapsExposure, calculateSicBoOutcomeExposure, getSicBoCombinations } from '../utils/gameUtils';
import { getStrategicAdvice } from '../services/geminiService';
import { CasinoChainService } from '../services/CasinoChainService';
import { CasinoClient } from '../api/client.js';
import { WasmWrapper } from '../api/wasm.js';
import { BotConfig, DEFAULT_BOT_CONFIG, BotService } from '../services/BotService';

const INITIAL_CHIPS = 1000;
const INITIAL_SHIELDS = 3;
const INITIAL_DOUBLES = 3;
const MAX_GRAPH_POINTS = 100; // Limit for graph/history arrays to prevent memory leaks

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

// Baccarat bet type mapping for on-chain: 0=Player, 1=Banker, 2=Tie, 3=P_PAIR, 4=B_PAIR
// Payload format: [action:u8] [betType:u8] [amount:u64 BE] - 10 bytes total
// Action 0 = Place bet, Action 1 = Deal cards, Action 2 = Clear bets
const serializeBaccaratBet = (betType: number, amount: number): Uint8Array => {
  const payload = new Uint8Array(10);
  payload[0] = 0; // Action 0: Place bet
  payload[1] = betType;
  // Write amount as big-endian u64 starting at byte 2
  const view = new DataView(payload.buffer);
  view.setBigUint64(2, BigInt(amount), false);
  return payload;
};

// Get all baccarat bets to place (main selection + side bets)
const getBaccaratBetsToPlace = (selection: 'PLAYER' | 'BANKER', sideBets: BaccaratBet[], mainBetAmount: number): Array<{betType: number, amount: number}> => {
  const bets: Array<{betType: number, amount: number}> = [];

  // Add main bet (player or banker)
  const mainBetType = selection === 'PLAYER' ? 0 : 1;
  bets.push({ betType: mainBetType, amount: mainBetAmount });

  // Add side bets
  for (const sideBet of sideBets) {
    let betType: number;
    switch (sideBet.type) {
      case 'TIE': betType = 2; break;
      case 'P_PAIR': betType = 3; break;
      case 'B_PAIR': betType = 4; break;
      default: continue;
    }
    bets.push({ betType, amount: sideBet.amount });
  }

  return bets;
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
    crapsLastRoundBets: [],
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
  const [phase, setPhase] = useState<TournamentPhase>('REGISTRATION');
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [isRegistered, setIsRegistered] = useState(false);
  const [botConfig, setBotConfig] = useState<BotConfig>(DEFAULT_BOT_CONFIG);
  const botServiceRef = useRef<BotService | null>(null);
  const [isTournamentStarting, setIsTournamentStarting] = useState(false);
  const [manualTournamentEndTime, setManualTournamentEndTime] = useState<number | null>(null);

  // Chain service integration
  const [chainService, setChainService] = useState<CasinoChainService | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<bigint | null>(null);
  const currentSessionIdRef = useRef<bigint | null>(null);
  const gameTypeRef = useRef<GameType>(GameType.NONE);
  const baccaratSelectionRef = useRef<'PLAYER' | 'BANKER'>('PLAYER');
  const baccaratBetsRef = useRef<BaccaratBet[]>([]); // Track bets for event handlers
  const gameStateRef = useRef<GameState | null>(null); // Track game state for event handlers
  const isPendingRef = useRef<boolean>(false); // Prevent double-submits on rapid space key presses
  const [isOnChain, setIsOnChain] = useState(false);
  const [lastTxSig, setLastTxSig] = useState<string | null>(null);
  const clientRef = useRef<CasinoClient | null>(null);
  const publicKeyBytesRef = useRef<Uint8Array | null>(null);

  // Balance update race condition fix: Track last WebSocket balance update time
  const lastBalanceUpdateRef = useRef<number>(0);
  const BALANCE_UPDATE_COOLDOWN = 2000; // 2 second cooldown after WebSocket update

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

        // Connect to WebSocket updates stream with account-specific filter
        await client.connectUpdates(keypair.publicKey);
        console.log('[useTerminalGame] Connected to updates WebSocket (account-specific filter)');

        // Fetch account state for nonce synchronization - this is critical!
        // The NonceManager needs the account data to sync the local nonce with chain state.
        // If the backend was restarted and chain state was reset, this ensures we reset
        // the local nonce to 0 instead of using a stale higher nonce from localStorage.
        const account = await client.getAccount(keypair.publicKey);
        await client.initNonceManager(keypair.publicKeyHex, keypair.publicKey, account);
        console.log('[useTerminalGame] NonceManager initialized with account:', account ? `nonce=${account.nonce}` : 'null (new account)');

        // Fetch on-chain player state to sync chips, shields, doubles, and active modifiers
        try {
          const playerState = await client.getCasinoPlayer(keypair.publicKey);
          if (playerState) {
            console.log('[useTerminalGame] Found on-chain player state:', playerState);

            // Check if we should respect WebSocket update cooldown
            const timeSinceLastUpdate = Date.now() - lastBalanceUpdateRef.current;
            const shouldUpdateBalance = timeSinceLastUpdate > BALANCE_UPDATE_COOLDOWN;

            setStats(prev => ({
              ...prev,
              chips: shouldUpdateBalance ? playerState.chips : prev.chips,
              shields: playerState.shields,
              doubles: playerState.doubles,
            }));

            if (!shouldUpdateBalance) {
              console.log('[useTerminalGame] Skipped balance update from polling (within cooldown)');
            }

            // Sync active modifiers from chain
            setGameState(prev => ({
              ...prev,
              activeModifiers: {
                shield: playerState.activeShield || false,
                double: playerState.activeDouble || false,
              }
            }));

            setIsRegistered(true);
            hasRegisteredRef.current = true;

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
            console.log('[useTerminalGame] No on-chain player state found, resetting registration state');
            // Player doesn't exist on chain - reset registration state
            // This handles the case where the backend was restarted and chain state was lost
            hasRegisteredRef.current = false;
            setIsRegistered(false);
            // Also clear the localStorage registration flag
            const privateKeyHex = localStorage.getItem('casino_private_key');
            if (privateKeyHex) {
              localStorage.removeItem(`casino_registered_${privateKeyHex}`);
              console.log('[useTerminalGame] Cleared localStorage registration flag for key:', privateKeyHex.substring(0, 8) + '...');
            }
          }
        } catch (playerError) {
          console.warn('[useTerminalGame] Failed to fetch player state:', playerError);
        }

        const service = new CasinoChainService(client);
        setChainService(service);
        setIsOnChain(true);

        // Fetch initial leaderboard
        try {
          const leaderboardData = await client.getCasinoLeaderboard();
          if (leaderboardData && leaderboardData.entries) {
            const myPublicKeyHex = keypair.publicKey
              ? Array.from(keypair.publicKey).map(b => b.toString(16).padStart(2, '0')).join('')
              : null;

            const newBoard = leaderboardData.entries.map((entry: { player?: string; name?: string; chips: bigint | number }) => ({
              name: entry.name || `Player_${entry.player?.substring(0, 8)}`,
              chips: Number(entry.chips),
              status: 'ALIVE' as const
            }));

            // Check if current player is in the leaderboard
            const isPlayerInBoard = myPublicKeyHex && leaderboardData.entries.some(
              (entry: { player?: string }) => entry.player && entry.player.toLowerCase() === myPublicKeyHex.toLowerCase()
            );

            // Mark current player if in leaderboard
            if (isPlayerInBoard && myPublicKeyHex) {
              const playerIdx = leaderboardData.entries.findIndex(
                (entry: { player?: string }) => entry.player && entry.player.toLowerCase() === myPublicKeyHex.toLowerCase()
              );
              if (playerIdx >= 0) {
                newBoard[playerIdx].name = `${newBoard[playerIdx].name} (YOU)`;
              }
            }

            newBoard.sort((a, b) => b.chips - a.chips);
            setLeaderboard(newBoard);
            console.log('[useTerminalGame] Initial leaderboard loaded:', newBoard.length, 'entries');
          }
        } catch (leaderboardError) {
          console.debug('[useTerminalGame] Failed to fetch initial leaderboard:', leaderboardError);
        }

        // Fetch tournament state to sync timer on page load
        try {
          const CURRENT_TOURNAMENT_ID = 1; // Default tournament ID
          const tournamentState = await client.getCasinoTournament(CURRENT_TOURNAMENT_ID);
          if (tournamentState) {
            console.log('[useTerminalGame] Found tournament state:', tournamentState);
            // Check if tournament is active and has valid end time
            // Client normalizes snake_case to camelCase, so use endTimeMs
            if (tournamentState.phase === 'Active' && tournamentState.endTimeMs) {
              const endTimeMs = Number(tournamentState.endTimeMs);
              const now = Date.now();
              if (endTimeMs > now) {
                // Tournament is still active - sync the timer
                console.log('[useTerminalGame] Syncing active tournament timer, end time:', endTimeMs);
                setManualTournamentEndTime(endTimeMs);
                setPhase('ACTIVE');
                const remaining = Math.ceil((endTimeMs - now) / 1000);
                setTournamentTime(remaining);
              } else {
                // Tournament has ended
                console.log('[useTerminalGame] Tournament has ended');
                setPhase('REGISTRATION');
                setManualTournamentEndTime(null);
              }
            } else {
              console.log('[useTerminalGame] Tournament not active, phase:', tournamentState.phase);
            }
          } else {
            console.log('[useTerminalGame] No tournament state found on-chain');
          }
        } catch (tournamentError) {
          console.debug('[useTerminalGame] Failed to fetch tournament state:', tournamentError);
        }
      } catch (error) {
        console.error('[useTerminalGame] Failed to initialize chain service:', error);
        setIsOnChain(false);
      }
    };
    initChain();
  }, []);

  // Track tick counter for leaderboard polling (every 3 ticks = 3 seconds)
  const tickCounterRef = useRef(0);

  // Track current chips with a ref to avoid stale closure in polling interval
  const currentChipsRef = useRef(stats.chips);

  // Keep chips ref in sync with stats
  useEffect(() => {
    currentChipsRef.current = stats.chips;
  }, [stats.chips]);

  // --- TOURNAMENT CLOCK ---
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();

      // If we have a manual tournament running, use that timer
      if (manualTournamentEndTime !== null) {
        const remaining = Math.max(0, manualTournamentEndTime - now);
        setTournamentTime(Math.ceil(remaining / 1000));

        // Tournament ended
        if (remaining <= 0) {
          console.log('[useTerminalGame] Manual tournament ended');
          setManualTournamentEndTime(null);
          setPhase('REGISTRATION');

          // Stop bots
          const botService = botServiceRef.current;
          if (botService) {
            botService.stop();
          }
        }
      } else {
        // Manual tournament mode - stay in REGISTRATION until user starts tournament
        // No cyclic automatic phase switching
        if (phase === 'REGISTRATION') {
          setTournamentTime(0); // No countdown when waiting for user to start
        }
      }

      // Poll on-chain leaderboard every 2 seconds during ACTIVE and REGISTRATION phases
      tickCounterRef.current++;
      if ((phase === 'ACTIVE' || phase === 'REGISTRATION') && clientRef.current && tickCounterRef.current % 2 === 0) {
        (async () => {
          try {
            const leaderboardData = await clientRef.current!.getCasinoLeaderboard();
            if (leaderboardData && leaderboardData.entries) {
              // Get current player's public key hex for identification
              const myPublicKeyHex = publicKeyBytesRef.current
                ? Array.from(publicKeyBytesRef.current).map(b => b.toString(16).padStart(2, '0')).join('')
                : null;

              // Map on-chain entries to our LeaderboardEntry format
              const newBoard: LeaderboardEntry[] = leaderboardData.entries.map((entry: { player?: string; name?: string; chips: bigint | number }) => ({
                name: entry.name || `Player_${entry.player?.substring(0, 8)}`,
                chips: Number(entry.chips),
                status: 'ALIVE' as const
              }));

              // Check if current player is in the leaderboard
              const isPlayerInBoard = myPublicKeyHex && leaderboardData.entries.some(
                (entry: { player?: string }) => entry.player?.toLowerCase() === myPublicKeyHex.toLowerCase()
              );

              // If not in leaderboard, add current player (they might be outside top 10)
              if (!isPlayerInBoard && myPublicKeyHex && isRegistered) {
                newBoard.push({ name: "YOU", chips: currentChipsRef.current, status: 'ALIVE' });
              } else if (myPublicKeyHex) {
                // Mark the current player's entry
                const playerEntry = newBoard.find((_, idx) =>
                  leaderboardData.entries[idx]?.player?.toLowerCase() === myPublicKeyHex.toLowerCase()
                );
                if (playerEntry) {
                  playerEntry.name = `${playerEntry.name} (YOU)`;
                }
              }

              // Sort by chips descending
              newBoard.sort((a, b) => b.chips - a.chips);
              setLeaderboard(newBoard);

              // Update player's rank
              const myRank = newBoard.findIndex(p => p.name.includes("YOU")) + 1;
              if (myRank > 0) {
                setStats(s => ({ ...s, rank: myRank }));
              }
            }
          } catch (e) {
            console.warn('[useTerminalGame] Failed to fetch leaderboard:', e);
          }
        })();
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [phase, chainService, isRegistered, manualTournamentEndTime]);

  // --- BOT SERVICE MANAGEMENT ---
  useEffect(() => {
    // Initialize bot service if we have the identity
    const identityHex = import.meta.env.VITE_IDENTITY;
    if (identityHex && !botServiceRef.current) {
      try {
        // Get base URL from environment or default to /api
        const baseUrl = import.meta.env.VITE_URL || '/api';
        botServiceRef.current = new BotService(baseUrl, identityHex);
      } catch (e) {
        console.warn('[useTerminalGame] Failed to initialize bot service:', e);
      }
    }
  }, []);

  // Start/stop bots based on phase
  useEffect(() => {
    const botService = botServiceRef.current;
    if (!botService) return;

    // Update bot config
    botService.setConfig(botConfig);

    if (phase === 'ACTIVE' && botConfig.enabled) {
      // Start bots when entering ACTIVE phase
      console.log('[useTerminalGame] Starting bots for tournament...');
      botService.start();
    } else if (phase === 'REGISTRATION') {
      // Stop bots when entering REGISTRATION phase
      console.log('[useTerminalGame] Stopping bots...');
      botService.stop();
    }

    return () => {
      // Cleanup on unmount
      if (botService) {
        botService.stop();
      }
    };
  }, [phase, botConfig]);

  // Keep gameStateRef in sync with gameState for event handlers
  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  // Helper to generate descriptive result messages
  const generateResultMessage = (gameType: GameType, state: GameState | null, payout: number): string => {
    // Show net P&L with sign (e.g., "+$50" or "-$50")
    const resultPart = payout >= 0 ? `+$${payout}` : `-$${Math.abs(payout)}`;

    if (!state) return resultPart;

    switch (gameType) {
      case GameType.BACCARAT: {
        // Skip formatting if no cards dealt yet
        if (state.playerCards.length === 0 || state.dealerCards.length === 0) {
          return resultPart;
        }
        // Use getBaccaratValue directly on the full hand - it handles modulo internally
        const pScore = getBaccaratValue(state.playerCards);
        const bScore = getBaccaratValue(state.dealerCards);
        const winner = pScore > bScore ? 'PLAYER' : bScore > pScore ? 'BANKER' : 'TIE';
        // Show winner's score first
        const scoreDisplay = winner === 'TIE' ? `${pScore}-${bScore}` :
                            winner === 'PLAYER' ? `${pScore}-${bScore}` : `${bScore}-${pScore}`;
        return `${winner} wins ${scoreDisplay}. ${resultPart}`;
      }
      case GameType.BLACKJACK: {
        // Defensive checks for missing card data
        if (!state.playerCards?.length || !state.dealerCards?.length) {
          return resultPart;
        }
        const pVal = getHandValue(state.playerCards);
        const dVal = getHandValue(state.dealerCards);
        const pBust = pVal > 21;
        const dBust = dVal > 21;
        if (pVal === 21 && state.playerCards.length === 2) return `BLACKJACK! ${resultPart}`;
        if (pBust) return `Bust (${pVal}). ${resultPart}`;
        if (dBust) return `Dealer bust (${dVal}). ${resultPart}`;
        return `${pVal} vs ${dVal}. ${resultPart}`;
      }
      case GameType.CASINO_WAR: {
        const pCard = state.playerCards[0];
        const dCard = state.dealerCards[0];
        if (!pCard || !dCard) return resultPart;
        return `${pCard.rank} vs ${dCard.rank}. ${resultPart}`;
      }
      case GameType.HILO: {
        const lastCard = state.playerCards[state.playerCards.length - 1];
        if (!lastCard) return resultPart;
        return `${lastCard.rank}${lastCard.suit}. ${resultPart}`;
      }
      case GameType.VIDEO_POKER: {
        const hand = evaluateVideoPokerHand(state.playerCards);
        return `${hand.rank}. ${resultPart}`;
      }
      case GameType.THREE_CARD: {
        const pHand = evaluateThreeCardHand(state.playerCards);
        const dHand = evaluateThreeCardHand(state.dealerCards);
        return `${pHand.rank} vs ${dHand.rank}. ${resultPart}`;
      }
      case GameType.ULTIMATE_HOLDEM: {
        const pVal = getHandValue(state.playerCards);
        const dVal = getHandValue(state.dealerCards);
        return `Player ${pVal} vs Dealer ${dVal}. ${resultPart}`;
      }
      case GameType.CRAPS: {
        if (!state.dice || state.dice.length < 2) return resultPart;
        const d1 = state.dice[0];
        const d2 = state.dice[1];
        const total = d1 + d2;
        // Simple message format: Rolled: [total]. Won $X / Lost $Y.
        return `Rolled: ${total}. ${resultPart}`;
      }
      case GameType.ROULETTE: {
        const last = state.rouletteHistory[state.rouletteHistory.length - 1];
        if (last === undefined) return resultPart;
        const color = getRouletteColor(last);
        return `${last} ${color}. ${resultPart}`;
      }
      case GameType.SIC_BO: {
        if (!state.dice || state.dice.length < 3) return resultPart;
        const total = state.dice.reduce((a, b) => a + b, 0);
        return `Rolled ${total} (${state.dice.join('-')}). ${resultPart}`;
      }
      default:
        return resultPart;
    }
  };

  // Subscribe to chain events
  useEffect(() => {
    if (!chainService || !isOnChain) return;

    const unsubStarted = chainService.onGameStarted((event: CasinoGameStartedEvent) => {
      // Ensure both session IDs are BigInt for consistent comparison
      const eventSessionId = BigInt(event.sessionId);
      const currentSessionId = currentSessionIdRef.current ? BigInt(currentSessionIdRef.current) : null;

      // DEBUG: Log all incoming CasinoGameStarted events
      console.log('[useTerminalGame] CasinoGameStarted received:', {
        eventSessionId: eventSessionId.toString(),
        eventSessionIdType: typeof eventSessionId,
        currentSessionId: currentSessionId?.toString(),
        currentSessionIdType: typeof currentSessionId,
        match: currentSessionId !== null && eventSessionId === currentSessionId,
        gameType: event.gameType,
        initialStateLen: event.initialState?.length,
      });

      // Only process events for our current session
      if (currentSessionId !== null && eventSessionId === currentSessionId) {
        console.log('[useTerminalGame] Session ID matched! Processing CasinoGameStarted');
        // Clear pending flag - session is now active and ready for moves
        isPendingRef.current = false;

        // Store game type for use in subsequent move events
        const frontendGameType = CHAIN_TO_FRONTEND_GAME_TYPE[event.gameType];
        gameTypeRef.current = frontendGameType;

        // Parse the initial state to get dealt cards
        if (event.initialState && event.initialState.length > 0) {
          console.log('[useTerminalGame] Parsing initial state for game type:', frontendGameType);
          parseGameState(event.initialState, frontendGameType);

          // For Casino War, auto-confirm after cards are dealt (unless it's a war situation)
          // Stage 0 = Initial deal, Stage 1 = War (tie occurred, needs user decision)
          if (frontendGameType === GameType.CASINO_WAR && chainService && currentSessionIdRef.current) {
            const stage = event.initialState[2]; // [playerCard, dealerCard, stage]
            if (stage === 0) {
              // Guard against duplicate submissions
              if (isPendingRef.current) {
                console.log('[useTerminalGame] Casino War auto-confirm blocked - transaction pending');
                return;
              }

              console.log('[useTerminalGame] Auto-confirming Casino War deal');
              (async () => {
                isPendingRef.current = true;
                try {
                  const payload = new Uint8Array([0]); // Confirm - triggers comparison
                  const result = await chainService.sendMove(currentSessionIdRef.current!, payload);
                  if (result.txHash) setLastTxSig(result.txHash);
                  setGameState(prev => ({ ...prev, message: 'COMPARING...' }));
                  // NOTE: Do NOT clear isPendingRef here - wait for CasinoGameMoved event
                } catch (error) {
                  console.error('[useTerminalGame] Casino War auto-confirm failed:', error);
                  setGameState(prev => ({ ...prev, message: 'CONFIRM FAILED' }));
                  // Only clear isPending on error, not on success
                  isPendingRef.current = false;
                }
              })();
            }
          }
        } else {
          console.log('[useTerminalGame] Empty initial state, setting stage to PLAYING');
          // Use game-appropriate message for empty initial state
          const initialMessage = frontendGameType === GameType.CRAPS
            ? 'PLACE BETS - SPACE TO ROLL'
            : frontendGameType === GameType.ROULETTE
            ? 'PLACE BETS - SPACE TO SPIN'
            : frontendGameType === GameType.SIC_BO
            ? 'PLACE BETS - SPACE TO ROLL'
            : 'GAME STARTED - SPACE TO DEAL';
          setGameState(prev => ({
            ...prev,
            stage: 'PLAYING',
            message: initialMessage,
          }));

          // For Baccarat, auto-send bets then deal immediately after game starts
          // This allows single space bar press to start, place bets, and deal
          if (frontendGameType === GameType.BACCARAT && chainService && currentSessionIdRef.current) {
            // Guard against duplicate submissions
            if (isPendingRef.current) {
              console.log('[useTerminalGame] Baccarat auto-deal blocked - transaction pending');
              return;
            }

            const mainBetAmount = gameStateRef.current?.bet ?? 100;
            const betsToPlace = getBaccaratBetsToPlace(baccaratSelectionRef.current, baccaratBetsRef.current, mainBetAmount);
            console.log('[useTerminalGame] Auto-dealing Baccarat with bets:', betsToPlace);

            // Send all bets sequentially, then deal
            (async () => {
              isPendingRef.current = true;
              try {
                setGameState(prev => ({ ...prev, message: 'PLACING BETS...' }));

                // Send all bets (action 0 for each)
                for (const bet of betsToPlace) {
                  const betPayload = serializeBaccaratBet(bet.betType, bet.amount);
                  const result = await chainService.sendMove(currentSessionIdRef.current!, betPayload);
                  if (result.txHash) setLastTxSig(result.txHash);
                }

                // Send deal command (action 1)
                setGameState(prev => ({ ...prev, message: 'DEALING...' }));
                const dealPayload = new Uint8Array([1]); // Action 1: Deal cards
                const result = await chainService.sendMove(currentSessionIdRef.current!, dealPayload);
                if (result.txHash) setLastTxSig(result.txHash);
                // NOTE: Do NOT clear isPendingRef here - wait for CasinoGameMoved event
              } catch (error) {
                console.error('[useTerminalGame] Baccarat auto-deal failed:', error);
                setGameState(prev => ({ ...prev, message: 'DEAL FAILED' }));
                // Only clear isPending on error, not on success
                isPendingRef.current = false;
              }
            })();
          }

          // For Roulette, auto-send bets then spin immediately after game starts
          if (frontendGameType === GameType.ROULETTE && chainService && currentSessionIdRef.current) {
            // Guard against duplicate submissions
            if (isPendingRef.current) {
              console.log('[useTerminalGame] Roulette auto-spin blocked - transaction pending');
              return;
            }

            const rouletteBets = gameStateRef.current?.rouletteBets ?? [];
            if (rouletteBets.length > 0) {
              console.log('[useTerminalGame] Auto-spinning Roulette with bets:', rouletteBets);

              (async () => {
                isPendingRef.current = true;
                try {
                  setGameState(prev => ({ ...prev, message: 'PLACING BETS...' }));

                  // Send all bets (action 0 for each)
                  for (const bet of rouletteBets) {
                    const betPayload = serializeRouletteBet(bet);
                    const result = await chainService.sendMove(currentSessionIdRef.current!, betPayload);
                    if (result.txHash) setLastTxSig(result.txHash);
                  }

                  // Send spin command (action 1)
                  setGameState(prev => ({ ...prev, message: 'SPINNING ON CHAIN...' }));
                  const spinPayload = new Uint8Array([1]);
                  const result = await chainService.sendMove(currentSessionIdRef.current!, spinPayload);
                  if (result.txHash) setLastTxSig(result.txHash);

                  // Clear bets from UI
                  setGameState(prev => ({
                    ...prev,
                    rouletteLastRoundBets: prev.rouletteBets,
                    rouletteBets: [],
                    rouletteUndoStack: []
                  }));
                  // NOTE: Do NOT clear isPendingRef here - wait for CasinoGameMoved event
                } catch (error) {
                  console.error('[useTerminalGame] Roulette auto-spin failed:', error);
                  setGameState(prev => ({ ...prev, message: 'SPIN FAILED' }));
                  // Only clear isPending on error, not on success
                  isPendingRef.current = false;
                }
              })();
            }
          }

          // For SicBo, auto-send bets then roll immediately after game starts
          if (frontendGameType === GameType.SIC_BO && chainService && currentSessionIdRef.current) {
            // Guard against duplicate submissions
            if (isPendingRef.current) {
              console.log('[useTerminalGame] SicBo auto-roll blocked - transaction pending');
              return;
            }

            const sicBoBets = gameStateRef.current?.sicBoBets ?? [];
            if (sicBoBets.length > 0) {
              console.log('[useTerminalGame] Auto-rolling SicBo with bets:', sicBoBets);

              (async () => {
                isPendingRef.current = true;
                try {
                  setGameState(prev => ({ ...prev, message: 'PLACING BETS...' }));

                  // Send all bets (action 0 for each)
                  for (const bet of sicBoBets) {
                    const betPayload = serializeSicBoBet(bet);
                    const result = await chainService.sendMove(currentSessionIdRef.current!, betPayload);
                    if (result.txHash) setLastTxSig(result.txHash);
                  }

                  // Send roll command (action 1)
                  setGameState(prev => ({ ...prev, message: 'ROLLING ON CHAIN...' }));
                  const rollPayload = new Uint8Array([1]);
                  const result = await chainService.sendMove(currentSessionIdRef.current!, rollPayload);
                  if (result.txHash) setLastTxSig(result.txHash);

                  // Clear bets from UI
                  setGameState(prev => ({
                    ...prev,
                    sicBoLastRoundBets: prev.sicBoBets,
                    sicBoBets: [],
                    sicBoUndoStack: []
                  }));
                  // NOTE: Do NOT clear isPendingRef here - wait for CasinoGameMoved event
                } catch (error) {
                  console.error('[useTerminalGame] SicBo auto-roll failed:', error);
                  setGameState(prev => ({ ...prev, message: 'ROLL FAILED' }));
                  // Only clear isPending on error, not on success
                  isPendingRef.current = false;
                }
              })();
            }
          }

          // For Craps, auto-send bets then roll immediately after game starts
          if (frontendGameType === GameType.CRAPS && chainService && currentSessionIdRef.current) {
            // Guard against duplicate submissions
            if (isPendingRef.current) {
              console.log('[useTerminalGame] Craps auto-roll blocked - transaction pending');
              return;
            }

            // Only auto-send LOCAL bets (not already on-chain)
            const localBets = (gameStateRef.current?.crapsBets ?? []).filter(b => b.local === true);
            if (localBets.length > 0) {
              console.log('[useTerminalGame] Auto-rolling Craps with local bets:', localBets);

              (async () => {
                isPendingRef.current = true;
                try {
                  setGameState(prev => ({ ...prev, message: 'PLACING BETS...' }));

                  // Send only LOCAL bets (action 0 for each)
                  for (const bet of localBets) {
                    const betPayload = serializeCrapsBet(bet);
                    const result = await chainService.sendMove(currentSessionIdRef.current!, betPayload);
                    if (result.txHash) setLastTxSig(result.txHash);
                  }

                  // Send roll command (action 2)
                  setGameState(prev => ({ ...prev, message: 'ROLLING ON CHAIN...' }));
                  const rollPayload = new Uint8Array([2]);
                  const result = await chainService.sendMove(currentSessionIdRef.current!, rollPayload);
                  if (result.txHash) setLastTxSig(result.txHash);

                  // Clear local bets from UI (chain state will repopulate on-chain bets)
                  setGameState(prev => ({
                    ...prev,
                    crapsBets: prev.crapsBets.filter(b => !b.local),
                    crapsUndoStack: []
                  }));
                  // NOTE: Do NOT clear isPendingRef here - wait for CasinoGameMoved event
                } catch (error) {
                  console.error('[useTerminalGame] Craps auto-roll failed:', error);
                  setGameState(prev => ({ ...prev, message: 'ROLL FAILED' }));
                  // Only clear isPending on error, not on success
                  isPendingRef.current = false;
                }
              })();
            }
          }

        }
      } else {
        console.log('[useTerminalGame] Session ID mismatch or no current session');
      }
    });

    const unsubMoved = chainService.onGameMoved((event: CasinoGameMovedEvent) => {
      // Ensure both session IDs are BigInt for consistent comparison
      const eventSessionId = BigInt(event.sessionId);
      const currentSessionId = currentSessionIdRef.current ? BigInt(currentSessionIdRef.current) : null;

      // DEBUG: Log all incoming CasinoGameMoved events
      console.log('[useTerminalGame] CasinoGameMoved received:', {
        eventSessionId: eventSessionId.toString(),
        eventSessionIdType: typeof eventSessionId,
        currentSessionId: currentSessionId?.toString(),
        currentSessionIdType: typeof currentSessionId,
        match: currentSessionId !== null && eventSessionId === currentSessionId,
        newStateLen: event.newState?.length,
        gameType: gameTypeRef.current,
        isPending: isPendingRef.current,
      });

      // Only process events for our current session
      if (currentSessionId !== null && eventSessionId === currentSessionId) {
        console.log('[useTerminalGame] Session ID matched! Parsing new state for game type:', gameTypeRef.current);
        // Parse state and update UI using the tracked game type from ref (not stale closure)
        parseGameState(event.newState, gameTypeRef.current);

        // Clear pending flag since we received the chain response
        console.log('[useTerminalGame] Clearing isPending flag after CasinoGameMoved');
        isPendingRef.current = false;
      } else {
        console.log('[useTerminalGame] Session ID mismatch or no current session - ignoring CasinoGameMoved');
      }
    });

    const unsubCompleted = chainService.onGameCompleted((event: CasinoGameCompletedEvent) => {
      // Ensure both session IDs are BigInt for consistent comparison
      const eventSessionId = BigInt(event.sessionId);
      const currentSessionId = currentSessionIdRef.current ? BigInt(currentSessionIdRef.current) : null;

      // DEBUG: Log all incoming CasinoGameCompleted events
      console.log('[useTerminalGame] CasinoGameCompleted received:', {
        eventSessionId: eventSessionId.toString(),
        eventSessionIdType: typeof eventSessionId,
        currentSessionId: currentSessionId?.toString(),
        currentSessionIdType: typeof currentSessionId,
        match: currentSessionId !== null && eventSessionId === currentSessionId,
        finalChips: event.finalChips?.toString(),
        payout: event.payout?.toString(),
      });

      // Only process events for our current session
      if (currentSessionId !== null && eventSessionId === currentSessionId) {
        const payout = Number(event.payout);
        const finalChips = Number(event.finalChips);
        console.log('[useTerminalGame] Session ID matched! Updating chips to:', finalChips);

        // Mark the time of this WebSocket balance update to prevent polling from overwriting
        lastBalanceUpdateRef.current = Date.now();

        // Generate descriptive result message using current game state
        const resultMessage = generateResultMessage(gameTypeRef.current, gameStateRef.current, payout);

        // Update stats including history and pnlByGame
        setStats(prev => {
          const currentGameType = gameTypeRef.current;
          const pnlEntry = { [currentGameType]: (prev.pnlByGame[currentGameType] || 0) + payout };
          return {
            ...prev,
            chips: finalChips,
            // Decrement shields/doubles if they were used in this game
            shields: event.wasShielded ? prev.shields - 1 : prev.shields,
            doubles: event.wasDoubled ? prev.doubles - 1 : prev.doubles,
            // Add to history log
            history: [...prev.history, resultMessage],
            pnlByGame: { ...prev.pnlByGame, ...pnlEntry },
            pnlHistory: [...prev.pnlHistory, (prev.pnlHistory[prev.pnlHistory.length - 1] || 0) + payout].slice(-MAX_GRAPH_POINTS),
          };
        });

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
          message: resultMessage,
          lastResult: payout,
        }));

        // Clear session and pending flag
        currentSessionIdRef.current = null;
        setCurrentSessionId(null);
        isPendingRef.current = false;
      }
    });

    const unsubLeaderboard = chainService.onLeaderboardUpdated((leaderboardData: any) => {
      console.log('[useTerminalGame] Leaderboard updated event:', leaderboardData);
      try {
        if (leaderboardData && leaderboardData.entries) {
          const myPublicKeyHex = publicKeyBytesRef.current
            ? Array.from(publicKeyBytesRef.current).map(b => b.toString(16).padStart(2, '0')).join('')
            : null;

          const newBoard = leaderboardData.entries.map((entry: { player?: string; name?: string; chips: bigint | number }) => ({
            name: entry.name || `Player_${entry.player?.substring(0, 8)}`,
            chips: Number(entry.chips),
            status: 'ALIVE' as const
          }));

          // Check if current player is in the leaderboard
          const isPlayerInBoard = myPublicKeyHex && leaderboardData.entries.some(
            (entry: { player?: string }) => entry.player && entry.player.toLowerCase() === myPublicKeyHex.toLowerCase()
          );

          // If not in leaderboard, add current player (they might be outside top 10)
          if (!isPlayerInBoard && myPublicKeyHex && isRegistered) {
            newBoard.push({ name: "YOU", chips: currentChipsRef.current, status: 'ALIVE' });
          } else if (myPublicKeyHex) {
            // Mark the current player's entry
            const playerIdx = leaderboardData.entries.findIndex(
              (entry: { player?: string }) => entry.player && entry.player.toLowerCase() === myPublicKeyHex.toLowerCase()
            );
            if (playerIdx >= 0) {
              newBoard[playerIdx].name = `${newBoard[playerIdx].name} (YOU)`;
            }
          }

          newBoard.sort((a, b) => b.chips - a.chips);
          setLeaderboard(newBoard);

          // Update player's rank
          const myRank = newBoard.findIndex(p => p.name.includes("YOU")) + 1;
          if (myRank > 0) {
            setStats(s => ({ ...s, rank: myRank }));
          }
        }
      } catch (e) {
        console.error('[useTerminalGame] Failed to process leaderboard update:', e);
      }
    });

    return () => {
      unsubStarted();
      unsubMoved();
      unsubCompleted();
      unsubLeaderboard();
    };
  }, [chainService, isOnChain, isRegistered]);

  // Helper to parse game state from event
  const parseGameState = (stateBlob: Uint8Array, gameType?: GameType) => {
    try {
      const view = new DataView(stateBlob.buffer, stateBlob.byteOffset, stateBlob.byteLength);
      const currentType = gameType ?? gameState.type;

      // Parse based on game type
      if (currentType === GameType.BLACKJACK) {
        console.log('[parseGameState] Blackjack state blob received:', {
          length: stateBlob.length,
          bytes: Array.from(stateBlob).slice(0, 20),
          fullBlob: Array.from(stateBlob),
        });
        if (stateBlob.length < 3) {
          console.error('[parseGameState] Blackjack state blob too short');
          return;
        }

        let offset = 0;
        const versionOrPLen = stateBlob[offset++];
        console.log('[parseGameState] Blackjack version/pLen:', versionOrPLen);
        
        let pCards: Card[] = [];
        let dCards: Card[] = [];
        let stage = 0;
        let pendingStack: { cards: Card[], bet: number, isDoubled: boolean }[] = [];
        let finishedHands: CompletedHand[] = [];
        let activeHandIdx = 0;

        // Version 1 starts with 1. Legacy starts with pLen (>= 2).
        if (versionOrPLen === 1) {
            // New format (v1)
            activeHandIdx = stateBlob[offset++];
            const handCount = stateBlob[offset++];
            
            // When activeHandIdx >= handCount, all hands are finished (dealer's turn or game over)
            // In this case, we still want to display the last played hand as "playerCards"
            const allHandsFinished = activeHandIdx >= handCount;

            for (let h = 0; h < handCount; h++) {
                const betMult = stateBlob[offset++];
                const status = stateBlob[offset++]; // 0=Play, 1=Stand, 2=Bust, 3=BJ
                const cLen = stateBlob[offset++];

                const handCards: Card[] = [];
                for (let i = 0; i < cLen; i++) {
                    handCards.push(decodeCard(stateBlob[offset++]));
                }

                const isDoubled = betMult === 2;
                // Use current bet from state, or default to 100 if missing
                const baseBet = gameStateRef.current?.bet || 100;
                const handBet = baseBet * betMult;

                if (h === activeHandIdx) {
                    // This is the currently active hand
                    pCards = handCards;
                } else if (allHandsFinished && h === handCount - 1) {
                    // All hands finished - show the last hand as player cards for display
                    pCards = handCards;
                } else if (h > activeHandIdx) {
                    pendingStack.push({ cards: handCards, bet: handBet, isDoubled });
                } else {
                    // Completed hand (for multi-hand scenarios like splits)
                    let msg = "";
                    if (status === 2) msg = "BUST";
                    else if (status === 3) msg = "BLACKJACK";
                    else if (status === 1) msg = "STAND";

                    finishedHands.push({
                        cards: handCards,
                        bet: handBet,
                        isDoubled,
                        message: msg
                    });
                }
            }
            
            // Dealer cards
            const dLen = stateBlob[offset++];
            for (let i = 0; i < dLen; i++) {
                dCards.push(decodeCard(stateBlob[offset++]));
            }
            
            stage = offset < stateBlob.length ? stateBlob[offset++] : 0;

            console.log('[parseGameState] Blackjack v1 parsed:', {
              activeHandIdx,
              handCount: pCards.length > 0 ? 1 : 0,
              playerCardsCount: pCards.length,
              playerCards: pCards.map(c => `${c.rank}${c.suit}`),
              dealerCardsCount: dCards.length,
              dealerCards: dCards.map(c => `${c.rank}${c.suit}`),
              stage,
              pendingStackLen: pendingStack.length,
              finishedHandsLen: finishedHands.length,
            });
        } else {
            // Legacy format fallback
            const pLen = versionOrPLen;
            for (let i = 0; i < pLen && offset < stateBlob.length; i++) {
                const cardVal = stateBlob[offset++];
                pCards.push(decodeCard(cardVal));
            }
            const dLen = stateBlob[offset++];
            for (let i = 0; i < dLen && offset < stateBlob.length; i++) {
                const cardVal = stateBlob[offset++];
                dCards.push(decodeCard(cardVal));
            }
            stage = offset < stateBlob.length ? stateBlob[offset++] : 0;
        }

        // Set isHidden based on stage: reveal all cards when game is complete (stage=2)
        const isComplete = stage === 2;
        const dealerCardsWithVisibility = dCards.map((card, i) => ({
          ...card,
          isHidden: !isComplete && i > 0 // Only hide non-first cards during play
        }));

        // Build new state and update ref BEFORE setGameState to avoid race condition
        // with CasinoGameCompleted event that may arrive before setGameState callback runs
        const prevState = gameStateRef.current;
        const newState = {
          ...prevState,
          type: currentType,
          playerCards: pCards,
          dealerCards: dealerCardsWithVisibility,
          blackjackStack: pendingStack,
          completedHands: finishedHands,
          stage: (isComplete ? 'RESULT' : 'PLAYING') as 'RESULT' | 'PLAYING',
          message: isComplete ? 'GAME COMPLETE' : 'HIT (H) / STAND (S)',
        };
        // Update ref synchronously BEFORE setGameState
        gameStateRef.current = newState;
        setGameState(newState);
      } else if (currentType === GameType.HILO) {
        // [currentCard:u8] [accumulator:i64 BE]
        // Accumulator is in basis points (10000 = 1x multiplier)
        if (stateBlob.length < 9) {
          console.error('[parseGameState] HiLo state blob too short:', stateBlob.length);
          return;
        }
        const currentCard = decodeCard(stateBlob[0]);
        const accumulatorBasisPoints = Number(view.getBigInt64(1, false)); // Big Endian

        // Update ref BEFORE setGameState to ensure CasinoGameCompleted handler has access to cards
        // (React 18's automatic batching defers the updater function execution)
        if (gameStateRef.current) {
          const prevCards = gameStateRef.current.playerCards || [];
          const lastCard = prevCards.length > 0 ? prevCards[prevCards.length - 1] : null;
          const newCards = (lastCard && lastCard.rank === currentCard.rank && lastCard.suit === currentCard.suit)
            ? prevCards
            : [...prevCards, currentCard];
          gameStateRef.current = {
            ...gameStateRef.current,
            playerCards: newCards,
          };
        }

        setGameState(prev => {
          // Calculate actual pot value: bet * accumulator / 10000
          const actualPot = Math.floor(prev.bet * accumulatorBasisPoints / 10000);
          // Preserve card history by appending new card if it's different from last
          const prevCards = prev.playerCards || [];
          const lastCard = prevCards.length > 0 ? prevCards[prevCards.length - 1] : null;
          const newCards = (lastCard && lastCard.rank === currentCard.rank && lastCard.suit === currentCard.suit)
            ? prevCards
            : [...prevCards, currentCard];

          const newState = {
            ...prev,
            type: currentType,
            playerCards: newCards,
            hiloAccumulator: actualPot,
            hiloGraphData: [...(prev.hiloGraphData || []), actualPot].slice(-MAX_GRAPH_POINTS),
            stage: 'PLAYING' as const,
            message: `POT: $${actualPot.toLocaleString()} | HIGHER (H) / LOWER (L)`,
          };
          // Also update ref inside for consistency
          gameStateRef.current = newState;
          return newState;
        });
      } else if (currentType === GameType.BACCARAT) {
        // State format: [bet_count:u8] [bets:9bytes×count] [playerHandLen:u8] [playerCards:u8×n] [bankerHandLen:u8] [bankerCards:u8×n]
        // Each BaccaratBet is 9 bytes: [bet_type:u8] [amount:u64 BE]
        if (stateBlob.length < 1) {
          console.error('[parseGameState] Baccarat state blob too short:', stateBlob.length);
          return;
        }

        const betCount = stateBlob[0];
        const betsSize = betCount * 9; // Each bet is 9 bytes
        const cardsStartOffset = 1 + betsSize;

        console.log('[parseGameState] Baccarat: betCount=' + betCount + ', betsSize=' + betsSize + ', cardsStartOffset=' + cardsStartOffset + ', totalLen=' + stateBlob.length);

        // If we don't have card data yet, we're in betting stage
        if (stateBlob.length <= cardsStartOffset) {
          console.log('[parseGameState] Baccarat in BETTING stage (no cards yet)');
          setGameState(prev => ({
            ...prev,
            type: currentType,
            playerCards: [],
            dealerCards: [],
            stage: 'PLAYING' as const,
            message: 'PLACE BETS - SPACE TO DEAL',
          }));
          return;
        }

        // Parse cards starting after the bets
        let offset = cardsStartOffset;
        const pLen = stateBlob[offset++];

        console.log('[parseGameState] Baccarat: playerHandLen=' + pLen + ' at offset=' + (offset - 1));

        if (stateBlob.length < offset + pLen + 1) {
          console.error('[parseGameState] Baccarat state blob too short for player cards:', stateBlob.length, 'need', offset + pLen + 1);
          return;
        }

        const pCards: Card[] = [];
        for (let i = 0; i < pLen && offset < stateBlob.length; i++) {
          const cardByte = stateBlob[offset++];
          console.log('[parseGameState] Baccarat player card ' + i + ': byte=' + cardByte);
          pCards.push(decodeCard(cardByte));
        }

        const bLen = offset < stateBlob.length ? stateBlob[offset++] : 0;
        console.log('[parseGameState] Baccarat: bankerHandLen=' + bLen + ' at offset=' + (offset - 1));

        const bCards: Card[] = [];
        for (let i = 0; i < bLen && offset < stateBlob.length; i++) {
          const cardByte = stateBlob[offset++];
          console.log('[parseGameState] Baccarat banker card ' + i + ': byte=' + cardByte);
          bCards.push(decodeCard(cardByte));
        }

        console.log('[parseGameState] Baccarat: parsed ' + pCards.length + ' player cards and ' + bCards.length + ' banker cards');

        // If no cards dealt yet, we're in PLAYING stage (waiting for bets + deal)
        // Cards are only dealt after player presses SPACE to deal
        if (pCards.length === 0 && bCards.length === 0) {
          console.log('[parseGameState] Baccarat in PLAYING stage (no cards dealt yet)');
          setGameState(prev => ({
            ...prev,
            type: currentType,
            playerCards: [],
            dealerCards: [],
            stage: 'PLAYING' as const,
            message: 'PLACE BETS - SPACE TO DEAL',
          }));
          return;
        }

        // Update ref BEFORE setGameState - React batches updates so callback runs later
        if (gameStateRef.current) {
          gameStateRef.current = {
            ...gameStateRef.current,
            type: currentType,
            playerCards: pCards,
            dealerCards: bCards,
            stage: 'RESULT' as const,
            message: 'BACCARAT DEALT',
          };
        }
        setGameState(prev => ({
          ...prev,
          type: currentType,
          playerCards: pCards,
          dealerCards: bCards,
          stage: 'RESULT' as const,
          message: 'BACCARAT DEALT',
        }));
      } else if (currentType === GameType.VIDEO_POKER) {
        // [stage:u8] [c1:u8] [c2:u8] [c3:u8] [c4:u8] [c5:u8]
        // Stage: 0 = Deal (waiting for hold selection), 1 = Draw (game complete)
        if (stateBlob.length < 6) {
          console.error('[parseGameState] Video Poker state blob too short:', stateBlob.length);
          return;
        }
        const stage = stateBlob[0];
        const cards: Card[] = [];
        for (let i = 1; i <= 5 && i < stateBlob.length; i++) {
          cards.push(decodeCard(stateBlob[i]));
        }

        // Update ref BEFORE setGameState to ensure CasinoGameCompleted handler has access to cards
        // (React 18's automatic batching defers the updater function execution)
        if (gameStateRef.current) {
          gameStateRef.current = {
            ...gameStateRef.current,
            playerCards: cards,
          };
        }

        setGameState(prev => {
          const newState = {
            ...prev,
            type: currentType,
            playerCards: cards,
            stage: (stage === 1 ? 'RESULT' : 'PLAYING') as 'RESULT' | 'PLAYING',
            message: stage === 0 ? 'HOLD (1-5), DRAW (D)' : 'GAME COMPLETE',
          };
          // Also update ref inside for consistency
          gameStateRef.current = newState;
          return newState;
        });
      } else if (currentType === GameType.CASINO_WAR) {
        // [playerCard:u8] [dealerCard:u8] [stage:u8]
        if (stateBlob.length < 3) {
          console.error('[parseGameState] Casino War state blob too short:', stateBlob.length);
          return;
        }
        const playerCard = decodeCard(stateBlob[0]);
        const dealerCard = decodeCard(stateBlob[1]);
        const stage = stateBlob[2];

        // Update ref BEFORE setGameState to ensure CasinoGameCompleted handler has access to cards
        // (React 18's automatic batching defers the updater function execution)
        if (gameStateRef.current) {
          gameStateRef.current = {
            ...gameStateRef.current,
            playerCards: [playerCard],
            dealerCards: [dealerCard],
          };
        }

        // Stage: 0 = Initial (cards dealt), 1 = War (tie occurred)
        // Game completion comes from CasinoGameCompleted event, not stage value
        setGameState(prev => {
          const newState = {
            ...prev,
            type: currentType,
            playerCards: [playerCard],
            dealerCards: [dealerCard],
            stage: 'PLAYING' as const,
            message: stage === 1 ? 'WAR! GO TO WAR (W) / SURRENDER (S)' : 'DEALT',
          };
          // Also update ref inside for consistency
          gameStateRef.current = newState;
          return newState;
        });
      } else if (currentType === GameType.CRAPS) {
        // [phase:u8] [main_point:u8] [d1:u8] [d2:u8] [bet_count:u8] [bets...]
        // Each bet entry is 19 bytes: [bet_type:u8] [target:u8] [status:u8] [amount:u64 BE] [odds_amount:u64 BE]
        if (stateBlob.length < 5) {
          console.error('[parseGameState] Craps state blob too short:', stateBlob.length);
          return;
        }
        const phase = stateBlob[0]; // 0=ComeOut, 1=Point
        const mainPoint = stateBlob[1];
        const d1 = stateBlob[2];
        const d2 = stateBlob[3];
        const total = d1 + d2;
        const betCount = stateBlob[4];

        // Parse bets from state blob
        const BET_TYPE_REVERSE: Record<number, CrapsBet['type']> = {
          0: 'PASS', 1: 'DONT_PASS', 2: 'COME', 3: 'DONT_COME',
          4: 'FIELD', 5: 'YES', 6: 'NO', 7: 'NEXT',
          8: 'HARDWAY', 9: 'HARDWAY', 10: 'HARDWAY', 11: 'HARDWAY'
        };
        const parsedBets: CrapsBet[] = [];
        let offset = 5;
        for (let i = 0; i < betCount && offset + 19 <= stateBlob.length; i++) {
          const betTypeVal = stateBlob[offset];
          const target = stateBlob[offset + 1];
          const statusVal = stateBlob[offset + 2];
          const amountView = new DataView(stateBlob.slice(offset + 3, offset + 11).buffer);
          const amount = Number(amountView.getBigUint64(0, false));
          const oddsView = new DataView(stateBlob.slice(offset + 11, offset + 19).buffer);
          const oddsAmount = Number(oddsView.getBigUint64(0, false));

          const betType = BET_TYPE_REVERSE[betTypeVal] || 'PASS';
          parsedBets.push({
            type: betType,
            target: target > 0 ? target : undefined,
            status: statusVal === 1 ? 'PENDING' : 'ON',
            amount,
            oddsAmount: oddsAmount > 0 ? oddsAmount : undefined,
          });
          offset += 19;
        }

        // Update ref BEFORE setGameState to ensure CasinoGameCompleted handler has access to dice
        // (React 18's automatic batching defers the updater function execution)
        if (gameStateRef.current) {
          gameStateRef.current = {
            ...gameStateRef.current,
            dice: [d1, d2],
            crapsPoint: mainPoint > 0 ? mainPoint : null,
          };
        }

        setGameState(prev => {
          // Only update history if dice actually changed (avoids duplicate entries from multiple events)
          const prevDice = prev.dice;
          const diceChanged = !prevDice || prevDice[0] !== d1 || prevDice[1] !== d2;

          // Reset roll history when 7 is rolled (seven-out), otherwise only add if dice changed
          let newHistory = prev.crapsRollHistory;
          if (diceChanged) {
            newHistory = total === 7 ? [total] : [...prev.crapsRollHistory, total].slice(-MAX_GRAPH_POINTS);
          }

          const newState = {
            ...prev,
            type: currentType,
            dice: [d1, d2],
            crapsPoint: mainPoint > 0 ? mainPoint : null,
            crapsBets: parsedBets,
            crapsRollHistory: newHistory,
            stage: 'PLAYING' as const,
            message: `ROLLED ${total}`,
          };
          // Also update ref inside for consistency
          gameStateRef.current = newState;
          return newState;
        });
      } else if (currentType === GameType.ROULETTE) {
        // State format: [bet_count:u8] [bets:10bytes×count] [result:u8]?
        // Each RouletteBet is 10 bytes: [bet_type:u8] [number:u8] [amount:u64 BE]
        if (stateBlob.length < 1) {
          console.error('[parseGameState] Roulette state blob too short:', stateBlob.length);
          return;
        }

        const betCount = stateBlob[0];
        const betsSize = betCount * 10; // Each bet is 10 bytes
        const resultOffset = 1 + betsSize;

        console.log('[parseGameState] Roulette: betCount=' + betCount + ', betsSize=' + betsSize + ', resultOffset=' + resultOffset + ', totalLen=' + stateBlob.length);

        // Check if we have a result (state length > bet section)
        if (stateBlob.length > resultOffset) {
          const result = stateBlob[resultOffset];
          console.log('[parseGameState] Roulette: result=' + result);
          setGameState(prev => ({
            ...prev,
            type: currentType,
            rouletteHistory: [...prev.rouletteHistory, result].slice(-MAX_GRAPH_POINTS),
            stage: 'RESULT',
            message: `LANDED ON ${result}`,
          }));
        } else {
          // Betting stage - no result yet
          console.log('[parseGameState] Roulette in BETTING stage (no result yet)');
          setGameState(prev => ({
            ...prev,
            type: currentType,
            stage: 'PLAYING',
            message: 'PLACE YOUR BETS',
          }));
        }
      } else if (currentType === GameType.SIC_BO) {
        // State format: [bet_count:u8] [bets:10bytes×count] [die1:u8]? [die2:u8]? [die3:u8]?
        // Each SicBoBet is 10 bytes: [bet_type:u8] [number:u8] [amount:u64 BE]
        if (stateBlob.length < 1) {
          console.error('[parseGameState] SicBo state blob too short:', stateBlob.length);
          return;
        }

        const betCount = stateBlob[0];
        const betsSize = betCount * 10; // Each bet is 10 bytes
        const diceOffset = 1 + betsSize;

        console.log('[parseGameState] SicBo: betCount=' + betCount + ', betsSize=' + betsSize + ', diceOffset=' + diceOffset + ', totalLen=' + stateBlob.length);

        // Check if we have dice (state length >= dice section)
        if (stateBlob.length >= diceOffset + 3) {
          const dice = [stateBlob[diceOffset], stateBlob[diceOffset + 1], stateBlob[diceOffset + 2]];
          const total = dice[0] + dice[1] + dice[2];
          console.log('[parseGameState] SicBo: dice=' + dice.join(',') + ', total=' + total);
          setGameState(prev => ({
            ...prev,
            type: currentType,
            dice: dice,
            sicBoHistory: [...prev.sicBoHistory, dice].slice(-MAX_GRAPH_POINTS),
            stage: 'RESULT',
            message: `ROLLED ${total} (${dice.join('-')})`,
          }));
        } else {
          // Betting stage - no dice yet
          console.log('[parseGameState] SicBo in BETTING stage (no dice yet)');
          setGameState(prev => ({
            ...prev,
            type: currentType,
            stage: 'PLAYING',
            message: 'PLACE YOUR BETS',
          }));
        }
      } else if (currentType === GameType.THREE_CARD) {
        // [pCard1:u8] [pCard2:u8] [pCard3:u8] [dCard1:u8] [dCard2:u8] [dCard3:u8] [stage:u8]
        if (stateBlob.length < 7) {
          console.error('[parseGameState] Three Card state blob too short:', stateBlob.length);
          return;
        }
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

        setGameState(prev => {
          const newState = {
            ...prev,
            type: currentType,
            playerCards: pCards,
            dealerCards: dCards,
            stage: (stage === 1 ? 'RESULT' : 'PLAYING') as 'RESULT' | 'PLAYING',
            message: stage === 1 ? 'GAME COMPLETE' : 'PLAY (P) OR FOLD (F)',
          };
          // Update ref synchronously so CasinoGameCompleted handler has access to cards
          gameStateRef.current = newState;
          return newState;
        });
      } else if (currentType === GameType.ULTIMATE_HOLDEM) {
        // [stage:u8] [pCard1:u8] [pCard2:u8] [community1-5:u8×5] [dCard1:u8] [dCard2:u8] [playBetMultiplier:u8]
        if (stateBlob.length < 11) {
          console.error('[parseGameState] Ultimate Holdem state blob too short:', stateBlob.length);
          return;
        }
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

        setGameState(prev => {
          const newState = {
            ...prev,
            type: currentType,
            playerCards: pCards,
            dealerCards: dCards,
            communityCards: community,
            stage: (stage === 3 ? 'RESULT' : 'PLAYING') as 'RESULT' | 'PLAYING',
            message,
          };
          // Update ref synchronously so CasinoGameCompleted handler has access to cards
          gameStateRef.current = newState;
          return newState;
        });
      }
    } catch (error) {
      console.error('[useTerminalGame] Failed to parse state:', error);
    }
  };

  // Helper to decode card value (0-51) to Card object
  const decodeCard = (value: number): Card => {
    // Handle invalid input
    if (value === undefined || value === null || isNaN(value) || value < 0 || value > 51) {
      console.warn('[decodeCard] Invalid card value:', value);
      return { rank: '2', suit: '♠', value: 2, isHidden: false };
    }
    const suits: readonly ['♠', '♥', '♦', '♣'] = ['♠', '♥', '♦', '♣'] as const;
    const ranks: readonly ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;

    const suit = suits[Math.floor(value / 13)];
    const rankIdx = value % 13;
    const rank = ranks[rankIdx];
    // Calculate proper blackjack value: 2-10 for number cards, 10 for face cards, 11 for Ace
    let cardValue: number;
    if (rankIdx === 0) {
      cardValue = 11; // Ace
    } else if (rankIdx <= 8) {
      cardValue = rankIdx + 1; // 2-9 -> value 2-9 (index 1-8)
    } else if (rankIdx === 9) {
      cardValue = 10; // 10
    } else {
      cardValue = 10; // J, Q, K
    }

    return {
      suit,
      rank,
      value: cardValue,
      isHidden: false,
    };
  };

  // --- CORE ACTIONS ---

  // Track if we've registered on-chain - check localStorage first
  // Note: We use casino_private_key as identifier since that's what client.js stores
  // Using lazy initialization to avoid calling on every render
  const hasRegisteredRef = useRef<boolean | null>(null);
  if (hasRegisteredRef.current === null) {
    const privateKeyHex = localStorage.getItem('casino_private_key');
    if (privateKeyHex) {
      hasRegisteredRef.current = localStorage.getItem(`casino_registered_${privateKeyHex}`) === 'true';
      console.log('[useTerminalGame] Loaded registration status from localStorage:', hasRegisteredRef.current, 'for key:', privateKeyHex.substring(0, 8) + '...');
    } else {
      console.log('[useTerminalGame] No private key in localStorage, assuming not registered');
      hasRegisteredRef.current = false;
    }
  }

  const startGame = async (type: GameType) => {
    // Clear pending flag when starting a new game - prevents stale flag from blocking auto-deal
    isPendingRef.current = false;

    // Optimistic update - preserve table game bets for immediate re-deal
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
      // Preserve craps bets when restarting same game type for single-press deal
      crapsBets: type === GameType.CRAPS ? prev.crapsBets : [],
      crapsUndoStack: type === GameType.CRAPS ? prev.crapsUndoStack : [],
      crapsInputMode: 'NONE',
      crapsRollHistory: type === GameType.CRAPS ? prev.crapsRollHistory : [],
      crapsLastRoundBets: prev.crapsLastRoundBets,
      // Preserve roulette bets when restarting
      rouletteBets: type === GameType.ROULETTE ? prev.rouletteBets : [],
      rouletteUndoStack: type === GameType.ROULETTE ? prev.rouletteUndoStack : [],
      rouletteLastRoundBets: prev.rouletteLastRoundBets,
      rouletteHistory: prev.rouletteHistory,
      rouletteInputMode: 'NONE',
      // Preserve sic bo bets when restarting
      sicBoBets: type === GameType.SIC_BO ? prev.sicBoBets : [],
      sicBoHistory: prev.sicBoHistory,
      sicBoInputMode: 'NONE',
      sicBoUndoStack: type === GameType.SIC_BO ? prev.sicBoUndoStack : [],
      sicBoLastRoundBets: prev.sicBoLastRoundBets,
      // Preserve baccarat bets when restarting
      baccaratBets: type === GameType.BACCARAT ? prev.baccaratBets : [],
      baccaratUndoStack: type === GameType.BACCARAT ? prev.baccaratUndoStack : [],
      baccaratLastRoundBets: prev.baccaratLastRoundBets,
      lastResult: 0,
      activeModifiers: { shield: false, double: false },
      baccaratSelection: prev.baccaratSelection, // Preserve selection from previous game
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
        // Always verify player exists on-chain before starting game
        // This handles network resets where localStorage flag is stale
        console.log('[useTerminalGame] Verifying on-chain state, clientRef:', !!clientRef.current, 'publicKeyBytesRef:', !!publicKeyBytesRef.current, 'hasRegisteredRef:', hasRegisteredRef.current);

        let playerExistsOnChain = false;
        try {
          if (!clientRef.current) {
            console.warn('[useTerminalGame] clientRef.current is null, cannot check on-chain state');
          } else if (!publicKeyBytesRef.current) {
            console.warn('[useTerminalGame] publicKeyBytesRef.current is null, cannot check on-chain state');
          } else {
            const existingPlayer = await clientRef.current.getCasinoPlayer(publicKeyBytesRef.current);
            console.log('[useTerminalGame] getCasinoPlayer result:', existingPlayer);
            if (existingPlayer) {
              console.log('[useTerminalGame] Player exists on-chain:', existingPlayer);
              playerExistsOnChain = true;
              hasRegisteredRef.current = true;
              // Persist to localStorage as well
              const privateKeyHex = localStorage.getItem('casino_private_key');
              if (privateKeyHex) {
                localStorage.setItem(`casino_registered_${privateKeyHex}`, 'true');
              }
              setIsRegistered(true);

              // Check if we should respect WebSocket update cooldown
              const timeSinceLastUpdate = Date.now() - lastBalanceUpdateRef.current;
              const shouldUpdateBalance = timeSinceLastUpdate > BALANCE_UPDATE_COOLDOWN;

              setStats(prev => ({
                ...prev,
                chips: shouldUpdateBalance ? existingPlayer.chips : prev.chips,
                shields: existingPlayer.shields,
                doubles: existingPlayer.doubles,
              }));

              if (!shouldUpdateBalance) {
                console.log('[useTerminalGame] Skipped balance update from registration polling (within cooldown)');
              }
            } else {
              // Player doesn't exist on-chain - clear stale localStorage flag
              console.log('[useTerminalGame] Player NOT found on-chain, clearing stale registration flag');
              hasRegisteredRef.current = false;
              const privateKeyHex = localStorage.getItem('casino_private_key');
              if (privateKeyHex) {
                localStorage.removeItem(`casino_registered_${privateKeyHex}`);
              }
            }
          }
        } catch (e) {
          // Log actual error, not just assume player doesn't exist
          console.error('[useTerminalGame] Error checking player on-chain:', e);
          // On error, clear registration flag to be safe
          hasRegisteredRef.current = false;
        }

        // Register if player doesn't exist on-chain
        if (!playerExistsOnChain) {
          const playerName = `Player_${Date.now().toString(36)}`;
          console.log('[useTerminalGame] Registering on-chain as:', playerName);
          await chainService.register(playerName);
          hasRegisteredRef.current = true;
          // Persist registration status to localStorage
          const privateKeyHex = localStorage.getItem('casino_private_key');
          if (privateKeyHex) {
            localStorage.setItem(`casino_registered_${privateKeyHex}`, 'true');
          }
          console.log('[useTerminalGame] Registration submitted, waiting for confirmation...');

          // Poll for player state to confirm registration (max 5 seconds)
          const maxAttempts = 10;
          for (let i = 0; i < maxAttempts; i++) {
            await new Promise(resolve => setTimeout(resolve, 500));
            try {
              const playerState = await clientRef.current?.getCasinoPlayer(publicKeyBytesRef.current!);
              if (playerState) {
                console.log('[useTerminalGame] Registration confirmed:', playerState);

                // Check if we should respect WebSocket update cooldown
                const timeSinceLastUpdate = Date.now() - lastBalanceUpdateRef.current;
                const shouldUpdateBalance = timeSinceLastUpdate > BALANCE_UPDATE_COOLDOWN;

                setStats(prev => ({
                  ...prev,
                  chips: shouldUpdateBalance ? playerState.chips : prev.chips,
                  shields: playerState.shields,
                  doubles: playerState.doubles,
                }));

                if (!shouldUpdateBalance) {
                  console.log('[useTerminalGame] Skipped balance update from registration confirmation polling (within cooldown)');
                }
                break;
              }
            } catch (e) {
              console.log('[useTerminalGame] Waiting for registration...', i + 1);
            }
          }
        }

        const chainGameType = GAME_TYPE_MAP[type];

        // Generate session ID FIRST and store it in ref BEFORE submitting
        // This prevents race condition where WebSocket event arrives before ref is set
        const sessionId = chainService.generateNextSessionId();
        console.log('[useTerminalGame] Pre-storing sessionId in ref:', sessionId.toString(), 'type:', typeof sessionId);
        currentSessionIdRef.current = sessionId;
        gameTypeRef.current = type;
        setCurrentSessionId(sessionId);

        // For table games (Baccarat, Craps, Roulette, Sic Bo), actual bets are placed via moves.
        // However, the chain requires a non-zero initial bet to start a game.
        // We pass the minimum bet amount (1) which satisfies the chain requirement.
        // For other games (Blackjack, etc.), the initial bet is used.
        const isTableGame = [GameType.BACCARAT, GameType.CRAPS, GameType.ROULETTE, GameType.SIC_BO].includes(type);
        const initialBetAmount = isTableGame ? 1n : BigInt(gameState.bet);

        // Now submit the transaction - WebSocket events can be matched immediately
        const result = await chainService.startGameWithSessionId(chainGameType, initialBetAmount, sessionId);
        if (result.txHash) setLastTxSig(result.txHash);

        // State will update when CasinoGameStarted event arrives
        setGameState(prev => ({
          ...prev,
          message: "WAITING FOR CHAIN...",
        }));
      } catch (error) {
        console.error('[useTerminalGame] Failed to start game on-chain:', error);

        // Clear the session ID we pre-stored since the transaction failed
        currentSessionIdRef.current = null;
        gameTypeRef.current = GameType.NONE;
        setCurrentSessionId(null);

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
   * Payload format: [action:u8] [betType:u8] [number:u8] [amount:u64 BE]
   * Action 0 = Place bet, Action 1 = Roll dice, Action 2 = Clear bets
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

    // Create place bet payload: [0, bet_type, number, amount_bytes...]
    const payload = new Uint8Array(11);
    payload[0] = 0; // Action 0: Place bet
    payload[1] = betType;
    payload[2] = number;
    // Write amount as big-endian u64
    const view = new DataView(payload.buffer);
    view.setBigUint64(3, BigInt(bet.amount), false);

    return payload;
  };

  // --- GAME ENGINES (Condensed for brevity, same logic as before) ---
  
  // BLACKJACK ENGINE
  const bjHit = async () => {
    // Prevent double-submission
    if (isPendingRef.current) {
      console.log('[bjHit] Blocked - transaction already pending');
      return;
    }

    // If on-chain mode, submit move
    if (isOnChain && chainService && currentSessionIdRef.current) {
      try {
        isPendingRef.current = true;
        console.log('[bjHit] Set isPending = true, sending move...');
        // Payload: [0] for Hit
        const result = await chainService.sendMove(currentSessionIdRef.current, new Uint8Array([0]));
        if (result.txHash) setLastTxSig(result.txHash);
        // State will update when CasinoGameMoved event arrives
        // NOTE: Do NOT clear isPendingRef here - wait for the event
        setGameState(prev => ({ ...prev, message: 'HITTING...' }));
        console.log('[bjHit] Move sent successfully, waiting for chain event...');
        return;
      } catch (error) {
        console.error('[useTerminalGame] Hit failed:', error);
        setGameState(prev => ({ ...prev, message: 'MOVE FAILED' }));
        // Only clear isPending on error, not on success
        isPendingRef.current = false;
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
    // Prevent double-submission
    if (isPendingRef.current) {
      console.log('[bjStand] Blocked - transaction already pending');
      return;
    }

    // If on-chain mode, submit move
    if (isOnChain && chainService && currentSessionIdRef.current) {
      try {
        isPendingRef.current = true;
        console.log('[bjStand] Set isPending = true, sending move...');
        // Payload: [1] for Stand
        const result = await chainService.sendMove(currentSessionIdRef.current, new Uint8Array([1]));
        if (result.txHash) setLastTxSig(result.txHash);
        setGameState(prev => ({ ...prev, message: 'STANDING...' }));
        // NOTE: Do NOT clear isPendingRef here - wait for the event
        console.log('[bjStand] Move sent successfully, waiting for chain event...');
        return;
      } catch (error) {
        console.error('[useTerminalGame] Stand failed:', error);
        setGameState(prev => ({ ...prev, message: 'MOVE FAILED' }));
        // Only clear isPending on error, not on success
        isPendingRef.current = false;
        return;
      }
    }

    // Local mode fallback
    bjStandAuto(gameState.playerCards);
  };

  const bjDouble = async () => {
    // Prevent double-submission
    if (isPendingRef.current) {
      console.log('[bjDouble] Blocked - transaction already pending');
      return;
    }

    // If on-chain mode, submit move
    if (isOnChain && chainService && currentSessionIdRef.current) {
      try {
        isPendingRef.current = true;
        console.log('[bjDouble] Set isPending = true, sending move...');
        // Payload: [2] for Double
        const result = await chainService.sendMove(currentSessionIdRef.current, new Uint8Array([2]));
        if (result.txHash) setLastTxSig(result.txHash);
        setGameState(prev => ({ ...prev, message: 'DOUBLING...' }));
        // NOTE: Do NOT clear isPendingRef here - wait for the event
        console.log('[bjDouble] Move sent successfully, waiting for chain event...');
        return;
      } catch (error) {
        console.error('[useTerminalGame] Double failed:', error);
        setGameState(prev => ({ ...prev, message: 'MOVE FAILED' }));
        // Only clear isPending on error, not on success
        isPendingRef.current = false;
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

  const bjSplit = async () => {
    // Validate split is possible before attempting
    if (gameState.stage !== 'PLAYING') {
      console.log('[useTerminalGame] Split rejected - not in PLAYING stage');
      return;
    }
    if (gameState.playerCards.length !== 2) {
      console.log('[useTerminalGame] Split rejected - not 2 cards:', gameState.playerCards.length);
      setGameState(prev => ({ ...prev, message: 'CANNOT SPLIT' }));
      return;
    }
    if (gameState.playerCards[0].rank !== gameState.playerCards[1].rank) {
      console.log('[useTerminalGame] Split rejected - ranks do not match:', gameState.playerCards[0].rank, gameState.playerCards[1].rank);
      setGameState(prev => ({ ...prev, message: 'CARDS MUST MATCH TO SPLIT' }));
      return;
    }
    if (stats.chips < gameState.bet) {
      console.log('[useTerminalGame] Split rejected - insufficient chips');
      setGameState(prev => ({ ...prev, message: 'INSUFFICIENT FUNDS TO SPLIT' }));
      return;
    }

    // If on-chain mode, submit move
    if (isOnChain && chainService && currentSessionIdRef.current) {
      try {
        if (isPendingRef.current) {
          console.log('[useTerminalGame] Split blocked - transaction pending');
          return;
        }
        isPendingRef.current = true;
        console.log('[useTerminalGame] Sending split command to chain');
        // Payload: [3] for Split
        const result = await chainService.sendMove(currentSessionIdRef.current, new Uint8Array([3]));
        if (result.txHash) setLastTxSig(result.txHash);
        setGameState(prev => ({ ...prev, message: 'SPLITTING...' }));
        // NOTE: isPendingRef will be cleared by CasinoGameMoved handler
        return;
      } catch (error) {
        console.error('[useTerminalGame] Split failed:', error);
        isPendingRef.current = false;
        setGameState(prev => ({ ...prev, message: 'SPLIT FAILED' }));
        return;
      }
    }

    // Local mode fallback
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
        pnlHistory: [...prev.pnlHistory, (prev.pnlHistory[prev.pnlHistory.length - 1] || 0) + finalWin].slice(-MAX_GRAPH_POINTS)
      }));
      setGameState(prev => ({ ...prev, message: finalWin >= 0 ? `WON ${finalWin}` : `LOST ${Math.abs(finalWin)}`, stage: 'RESULT', lastResult: finalWin }));
  };

  const bjInsurance = (take: boolean) => {
      // Insurance not supported on chain
      if (isOnChain) return;
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

      // Baccarat: needs bets + deal move (stage will be PLAYING after GameStarted)
      if (gameState.type === GameType.BACCARAT && gameState.stage === 'PLAYING' && gameState.playerCards.length === 0) {
        // Guard against duplicate submissions
        if (isPendingRef.current) {
          console.log('[useTerminalGame] Baccarat manual deal blocked - transaction pending');
          return;
        }
        isPendingRef.current = true;
        try {
          // Get all bets to place
          const betsToPlace = getBaccaratBetsToPlace(gameState.baccaratSelection, gameState.baccaratBets, gameState.bet);
          console.log('[useTerminalGame] Manual Baccarat deal with bets:', betsToPlace);

          setGameState(prev => ({ ...prev, message: 'PLACING BETS...' }));

          // Send all bets (action 0 for each)
          for (const bet of betsToPlace) {
            const betPayload = serializeBaccaratBet(bet.betType, bet.amount);
            const result = await chainService.sendMove(sessionId, betPayload);
            if (result.txHash) setLastTxSig(result.txHash);
          }

          // Send deal command (action 1)
          setGameState(prev => ({ ...prev, message: 'DEALING...' }));
          const dealPayload = new Uint8Array([1]); // Action 1: Deal cards
          const result = await chainService.sendMove(sessionId, dealPayload);
          if (result.txHash) setLastTxSig(result.txHash);
          // NOTE: Do NOT clear isPendingRef here - wait for CasinoGameMoved event
          return;
        } catch (error) {
          console.error('[useTerminalGame] Baccarat deal failed:', error);
          setGameState(prev => ({ ...prev, message: 'DEAL FAILED' }));
          // Only clear isPending on error, not on success
          isPendingRef.current = false;
          return;
        }
      }

      // Casino War: when cards are dealt (message='DEALT'), send confirm move to trigger result
      if (gameState.type === GameType.CASINO_WAR && gameState.stage === 'PLAYING' && gameState.message === 'DEALT') {
        // Guard against duplicate submissions
        if (isPendingRef.current) {
          console.log('[useTerminalGame] Casino War confirm blocked - transaction pending');
          return;
        }

        isPendingRef.current = true;
        try {
          const payload = new Uint8Array([0]); // Confirm deal - triggers comparison
          const result = await chainService.sendMove(sessionId, payload);
          if (result.txHash) setLastTxSig(result.txHash);
          setGameState(prev => ({ ...prev, message: 'CONFIRMING...' }));
          // NOTE: Do NOT clear isPendingRef here - wait for CasinoGameMoved event
          return;
        } catch (error) {
          console.error('[useTerminalGame] Casino War confirm failed:', error);
          setGameState(prev => ({ ...prev, message: 'CONFIRM FAILED' }));
          // Only clear isPending on error, not on success
          isPendingRef.current = false;
          return;
        }
      }
    }

    // Block deal for games already in play (except Baccarat/Casino War handled above)
    if (gameState.stage === 'PLAYING') return;
    if (stats.chips < gameState.bet) { setGameState(prev => ({ ...prev, message: "INSUFFICIENT FUNDS" })); return; }

    // If on-chain mode with no active session, start a new game
    // This handles the case where a previous game completed and user presses space to play again
    if (isOnChain && chainService && !currentSessionIdRef.current) {
      console.log('[useTerminalGame] deal() - No active session, starting new game for:', gameState.type);
      startGame(gameState.type);
      return;
    }

    // If on-chain mode with active session, wait for chain events
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
             // Only offer insurance in local mode, as backend does not support it
             if (d1.rank === 'A' && !isOnChain) msg = "INSURANCE? (I) / NO (N)";
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
        
        setGameState(prev => ({ ...prev, stage: 'RESULT', playerCards: [p1, p2], dealerCards: [b1, b2], baccaratLastRoundBets: prev.baccaratBets, baccaratUndoStack: [] }));
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
      // Prevent double-submission
      if (isPendingRef.current) {
        console.log('[hiloPlay] Blocked - transaction already pending');
        return;
      }

      // If on-chain mode, submit move
      if (isOnChain && chainService && currentSessionIdRef.current) {
        try {
          isPendingRef.current = true;
          console.log('[hiloPlay] Set isPending = true, sending move...');
          // Payload: [0] for Higher, [1] for Lower
          const payload = guess === 'HIGHER' ? new Uint8Array([0]) : new Uint8Array([1]);
          const result = await chainService.sendMove(currentSessionIdRef.current, payload);
          if (result.txHash) setLastTxSig(result.txHash);
          setGameState(prev => ({ ...prev, message: `GUESSING ${guess}...` }));
          // NOTE: Do NOT clear isPendingRef here - wait for the event
          console.log('[hiloPlay] Move sent successfully, waiting for chain event...');
          return;
        } catch (error) {
          console.error('[useTerminalGame] HiLo move failed:', error);
          setGameState(prev => ({ ...prev, message: 'MOVE FAILED' }));
          // Only clear isPending on error, not on success
          isPendingRef.current = false;
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
          setGameState(prev => ({ ...prev, playerCards: [...prev.playerCards, next], hiloAccumulator: newAcc, hiloGraphData: [...prev.hiloGraphData, newAcc].slice(-MAX_GRAPH_POINTS), message: `CORRECT! POT: ${newAcc}` }));
      } else {
          setGameState(prev => ({ ...prev, playerCards: [...prev.playerCards, next], hiloGraphData: [...prev.hiloGraphData, 0].slice(-MAX_GRAPH_POINTS), stage: 'RESULT' }));
          setGameState(prev => ({ ...prev, message: "WRONG", lastResult: -gameState.bet }));
      }
  };
  const hiloCashout = async () => {
       // Prevent double-submission
       if (isPendingRef.current) {
         console.log('[hiloCashout] Blocked - transaction already pending');
         return;
       }

       // If on-chain mode, submit cashout
       if (isOnChain && chainService && currentSessionIdRef.current) {
         try {
           isPendingRef.current = true;
           console.log('[hiloCashout] Set isPending = true, sending move...');
           // Payload: [2] for Cashout
           const result = await chainService.sendMove(currentSessionIdRef.current, new Uint8Array([2]));
           if (result.txHash) setLastTxSig(result.txHash);
           setGameState(prev => ({ ...prev, message: 'CASHING OUT...' }));
           // NOTE: Do NOT clear isPendingRef here - wait for the event
           console.log('[hiloCashout] Move sent successfully, waiting for chain event...');
           return;
         } catch (error) {
           console.error('[useTerminalGame] Cashout failed:', error);
           setGameState(prev => ({ ...prev, message: 'MOVE FAILED' }));
           // Only clear isPending on error, not on success
           isPendingRef.current = false;
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
  // Helper to serialize a single roulette bet to the format expected by the Rust backend
  // Payload format: [action:u8] [betType:u8] [number:u8] [amount:u64 BE]
  // Action 0 = Place bet, Action 1 = Spin wheel, Action 2 = Clear bets
  // Bet types: 0=Straight, 1=Red, 2=Black, 3=Even, 4=Odd, 5=Low, 6=High, 7=Dozen, 8=Column
  const serializeRouletteBet = (bet: RouletteBet): Uint8Array => {
    const payload = new Uint8Array(11);
    payload[0] = 0; // Action 0: Place bet

    // Map frontend bet types to backend bet types
    switch (bet.type) {
      case 'STRAIGHT':
        payload[1] = 0; // BetType::Straight
        payload[2] = bet.target ?? 0;
        break;
      case 'RED':
        payload[1] = 1; // BetType::Red
        payload[2] = 0; // No number needed
        break;
      case 'BLACK':
        payload[1] = 2; // BetType::Black
        payload[2] = 0;
        break;
      case 'EVEN':
        payload[1] = 3; // BetType::Even
        payload[2] = 0;
        break;
      case 'ODD':
        payload[1] = 4; // BetType::Odd
        payload[2] = 0;
        break;
      case 'LOW':
        payload[1] = 5; // BetType::Low
        payload[2] = 0;
        break;
      case 'HIGH':
        payload[1] = 6; // BetType::High
        payload[2] = 0;
        break;
      case 'DOZEN_1':
        payload[1] = 7; // BetType::Dozen
        payload[2] = 0;
        break;
      case 'DOZEN_2':
        payload[1] = 7; // BetType::Dozen
        payload[2] = 1;
        break;
      case 'DOZEN_3':
        payload[1] = 7; // BetType::Dozen
        payload[2] = 2;
        break;
      case 'COL_1':
        payload[1] = 8; // BetType::Column
        payload[2] = 0;
        break;
      case 'COL_2':
        payload[1] = 8; // BetType::Column
        payload[2] = 1;
        break;
      case 'COL_3':
        payload[1] = 8; // BetType::Column
        payload[2] = 2;
        break;
      case 'ZERO':
        payload[1] = 0; // BetType::Straight
        payload[2] = 0;
        break;
      default:
        throw new Error(`Unknown bet type: ${bet.type}`);
    }

    // Write amount as big-endian u64
    const view = new DataView(payload.buffer);
    view.setBigUint64(3, BigInt(bet.amount), false);

    return payload;
  };

  const spinRoulette = async () => {
      if (gameState.rouletteBets.length === 0) { setGameState(prev => ({ ...prev, message: "PLACE BET" })); return; }

      // Prevent double-submits
      if (isPendingRef.current) {
        console.log('[useTerminalGame] spinRoulette - Already pending, ignoring');
        return;
      }

      // If on-chain mode with no session, auto-start a new game
      // Note: Don't set isPendingRef here - onGameStarted handler will handle it
      // and auto-spin will be triggered there
      if (isOnChain && chainService && !currentSessionIdRef.current) {
        console.log('[useTerminalGame] spinRoulette - No active session, starting new roulette game');
        setGameState(prev => ({ ...prev, message: 'STARTING NEW SESSION...' }));
        startGame(GameType.ROULETTE);
        return;
      }

      // If on-chain mode, submit all bets then spin
      if (isOnChain && chainService && currentSessionIdRef.current) {
        try {
          isPendingRef.current = true;
          setGameState(prev => ({ ...prev, message: 'PLACING BETS...' }));

          // Send all bets sequentially (action 0 for each bet)
          for (const bet of gameState.rouletteBets) {
            const betPayload = serializeRouletteBet(bet);
            const result = await chainService.sendMove(currentSessionIdRef.current!, betPayload);
            if (result.txHash) setLastTxSig(result.txHash);
          }

          // Send spin command (action 1)
          setGameState(prev => ({ ...prev, message: 'SPINNING ON CHAIN...' }));
          const spinPayload = new Uint8Array([1]); // Action 1: Spin wheel
          const result = await chainService.sendMove(currentSessionIdRef.current, spinPayload);
          if (result.txHash) setLastTxSig(result.txHash);

          // Update UI
          setGameState(prev => ({
            ...prev,
            rouletteLastRoundBets: prev.rouletteBets,
            rouletteBets: [],
            rouletteUndoStack: []
          }));

          // Result will come via CasinoGameMoved/CasinoGameCompleted events
          // isPendingRef will be cleared in CasinoGameCompleted handler
          return;
        } catch (error) {
          console.error('[useTerminalGame] Roulette spin failed:', error);
          isPendingRef.current = false;
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
      setGameState(prev => ({ ...prev, rouletteHistory: [...prev.rouletteHistory, num].slice(-MAX_GRAPH_POINTS), rouletteLastRoundBets: prev.rouletteBets, rouletteBets: [], rouletteUndoStack: [] }));
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

       // Prevent double-submits
       if (isPendingRef.current) {
         console.log('[useTerminalGame] rollSicBo - Already pending, ignoring');
         return;
       }

       // If on-chain mode with no session, auto-start a new game
       // Note: Don't set isPendingRef here - onGameStarted handler will handle it
       // and auto-roll will be triggered there
       if (isOnChain && chainService && !currentSessionIdRef.current) {
         console.log('[useTerminalGame] rollSicBo - No active session, starting new sic bo game');
         setGameState(prev => ({ ...prev, message: 'STARTING NEW SESSION...' }));
         startGame(GameType.SIC_BO);
         return;
       }

       // If on-chain mode, submit all bets then roll
       if (isOnChain && chainService && currentSessionIdRef.current) {
         try {
           isPendingRef.current = true;
           setGameState(prev => ({ ...prev, message: 'PLACING BETS...' }));

           // Send all bets sequentially (action 0 for each bet)
           for (const bet of gameState.sicBoBets) {
             const betPayload = serializeSicBoBet(bet);
             const result = await chainService.sendMove(currentSessionIdRef.current!, betPayload);
             if (result.txHash) setLastTxSig(result.txHash);
           }

           // Send roll command (action 1)
           setGameState(prev => ({ ...prev, message: 'ROLLING...' }));
           const rollPayload = new Uint8Array([1]); // Action 1: Roll dice
           const result = await chainService.sendMove(currentSessionIdRef.current, rollPayload);
           if (result.txHash) setLastTxSig(result.txHash);

           // Update UI
           setGameState(prev => ({
             ...prev,
             sicBoLastRoundBets: prev.sicBoBets,
             sicBoBets: [],
             sicBoUndoStack: []
           }));

           // Result will come via CasinoGameMoved/CasinoGameCompleted events
           // isPendingRef will be cleared in CasinoGameCompleted handler
           return;
         } catch (error) {
           console.error('[useTerminalGame] Sic Bo roll failed:', error);
           isPendingRef.current = false;
           setGameState(prev => ({ ...prev, message: 'MOVE FAILED' }));
           return;
         }
       }

       // Local mode fallback
       const d = [rollDie(), rollDie(), rollDie()];
       const win = calculateSicBoOutcomeExposure(d, gameState.sicBoBets); // reuse helper for actual calc
       setGameState(prev => ({ ...prev, dice: d, sicBoHistory: [...prev.sicBoHistory, d].slice(-MAX_GRAPH_POINTS), sicBoLastRoundBets: prev.sicBoBets, sicBoBets: [], sicBoUndoStack: [] }));
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
      if (type === 'PASS') bets = bets.filter(b => b.type !== 'DONT_PASS' || !b.local);
      if (type === 'DONT_PASS') bets = bets.filter(b => b.type !== 'PASS' || !b.local);
      setGameState(prev => ({ ...prev, crapsUndoStack: [...prev.crapsUndoStack, prev.crapsBets], crapsBets: [...bets, { type, amount: prev.bet, target, status: (type==='COME'||type==='DONT_COME')?'PENDING':'ON', local: true }], message: `BET ${type}`, crapsInputMode: 'NONE' }));
  };
  const undoCrapsBet = () => {
       if (gameState.crapsUndoStack.length === 0) return;
       setGameState(prev => ({ ...prev, crapsBets: prev.crapsUndoStack[prev.crapsUndoStack.length-1], crapsUndoStack: prev.crapsUndoStack.slice(0, -1) }));
  };
  const rebetCraps = () => {
      if (gameState.crapsLastRoundBets.length === 0) {
          setGameState(prev => ({ ...prev, message: 'NO PREVIOUS BETS' }));
          return;
      }
      const totalRequired = gameState.crapsLastRoundBets.reduce((a, b) => a + b.amount + (b.oddsAmount || 0), 0);
      if (stats.chips < totalRequired) {
          setGameState(prev => ({ ...prev, message: 'INSUFFICIENT FUNDS' }));
          return;
      }
      // Add last round bets as new local bets
      const rebets = gameState.crapsLastRoundBets.map(b => ({ ...b, local: true }));
      setGameState(prev => ({
          ...prev,
          crapsUndoStack: [...prev.crapsUndoStack, prev.crapsBets],
          crapsBets: [...prev.crapsBets, ...rebets],
          message: 'REBET PLACED'
      }));
  };
  const addCrapsOdds = async () => {
      // Find eligible bet (PASS, DONT_PASS, COME with status ON, DONT_COME with status ON)
      const idx = gameState.crapsBets.findIndex(b =>
          (b.type === 'PASS' || b.type === 'DONT_PASS' ||
           (b.type === 'COME' && b.status === 'ON') ||
           (b.type === 'DONT_COME' && b.status === 'ON'))
      );

      if (idx === -1) {
          setGameState(prev => ({ ...prev, message: "NO BET FOR ODDS" }));
          return;
      }

      const targetBet = gameState.crapsBets[idx];
      const currentOdds = targetBet.oddsAmount || 0;
      const maxOdds = targetBet.amount * 5; // 5x cap

      if (currentOdds >= maxOdds) {
          setGameState(prev => ({ ...prev, message: "MAX ODDS REACHED (5X)" }));
          return;
      }

      // Cap the odds addition at 5x total
      const oddsToAdd = Math.min(gameState.bet, maxOdds - currentOdds);

      if (oddsToAdd <= 0) {
          setGameState(prev => ({ ...prev, message: "MAX ODDS REACHED (5X)" }));
          return;
      }

      if (stats.chips < oddsToAdd) {
          setGameState(prev => ({ ...prev, message: "INSUFFICIENT FUNDS" }));
          return;
      }

      // Update local state optimistically
      setGameState(prev => {
          const bets = [...prev.crapsBets];
          bets[idx] = { ...bets[idx], oddsAmount: currentOdds + oddsToAdd };
          return { ...prev, crapsBets: bets, message: "ADDING ODDS..." };
      });

      // Send to chain if we have an active session
      if (chainService && currentSessionIdRef.current && !isPendingRef.current) {
          isPendingRef.current = true;
          try {
              // Payload format: [1, amount_bytes...] - Add odds to last contract bet
              const payload = new Uint8Array(9);
              payload[0] = 1; // Command: Add odds
              const view = new DataView(payload.buffer);
              view.setBigUint64(1, BigInt(oddsToAdd), false); // big-endian

              const result = await chainService.sendMove(currentSessionIdRef.current, payload);
              if (result.txHash) setLastTxSig(result.txHash);

              setGameState(prev => ({ ...prev, message: `ODDS +$${oddsToAdd}` }));
          } catch (e) {
              console.error('[addCrapsOdds] Failed to add odds:', e);
              // Revert local state on failure
              setGameState(prev => {
                  const bets = [...prev.crapsBets];
                  bets[idx] = { ...bets[idx], oddsAmount: currentOdds };
                  return { ...prev, crapsBets: bets, message: "ODDS FAILED" };
              });
          } finally {
              isPendingRef.current = false;
          }
      } else {
          setGameState(prev => ({ ...prev, message: `ODDS +$${oddsToAdd}` }));
      }
  };
  const placeCrapsNumberBet = (mode: string, num: number) => {
      // Map input mode to bet type
      const betType = mode as CrapsBet['type'];
      // Validate number for each type
      if (mode === 'YES' || mode === 'NO') {
          if (![4, 5, 6, 8, 9, 10].includes(num)) return;
      } else if (mode === 'NEXT') {
          if (num < 2 || num > 12) return;
      } else if (mode === 'HARDWAY') {
          if (![4, 6, 8, 10].includes(num)) return;
      }
      placeCrapsBet(betType, num);
  };
  const rollCraps = async () => {
       // Only place NEW bets that the user explicitly added this round (local: true)
       // Bets from chain (local: false/undefined) should NOT be re-submitted
       const newBetsToPlace = gameState.crapsBets.filter(b => b.local === true);

       // Check if we have outstanding bets on-chain (any bet without local flag)
       const hasOutstandingBets = gameState.crapsBets.some(b => !b.local) || gameState.crapsPoint !== null;

       if (newBetsToPlace.length === 0 && !hasOutstandingBets) {
         // No new bets AND no outstanding bets - need at least something to bet on
         setGameState(prev => ({ ...prev, message: 'PLACE BET FIRST' }));
         return;
       }
       // If newBetsToPlace.length > 0, place those new bets
       // If hasOutstandingBets but no new bets, just roll without placing more

       // If on-chain mode with no session, auto-start a new game
       if (isOnChain && chainService && !currentSessionIdRef.current) {
         console.log('[useTerminalGame] rollCraps - No active session, starting new craps game');
         setGameState(prev => ({ ...prev, message: 'STARTING NEW SESSION...' }));
         startGame(GameType.CRAPS);
         return;
       }

       // If on-chain mode, submit roll move
       if (isOnChain && chainService && currentSessionIdRef.current) {
         // Guard against duplicate submissions
         if (isPendingRef.current) {
           console.log('[useTerminalGame] Craps roll blocked - transaction pending');
           return;
         }

         isPendingRef.current = true;
         try {
           // Only place NEW bets that user explicitly added (not repeating previous bets)
           for (const bet of newBetsToPlace) {
             const betPayload = serializeCrapsBet(bet);
             await chainService.sendMove(currentSessionIdRef.current, betPayload);
           }

           // Then submit roll command: [2]
           const rollPayload = new Uint8Array([2]);
           const result = await chainService.sendMove(currentSessionIdRef.current, rollPayload);
           if (result.txHash) setLastTxSig(result.txHash);

           // Save new bets as last round (only if we placed any), then clear local bets
           // Keep on-chain bets (chain state will refresh them anyway)
           setGameState(prev => ({
             ...prev,
             crapsLastRoundBets: newBetsToPlace.length > 0 ? newBetsToPlace : prev.crapsLastRoundBets,
             crapsBets: prev.crapsBets.filter(b => !b.local),
             message: 'ROLLING DICE...'
           }));
           return;
         // NOTE: Do NOT clear isPendingRef here - wait for CasinoGameMoved event
         } catch (error) {
           console.error('[useTerminalGame] Craps roll failed:', error);
           setGameState(prev => ({ ...prev, message: 'ROLL FAILED' }));
           // Only clear isPending on error, not on success
           isPendingRef.current = false;
           return;
         }
       }

       // Local mode fallback
       const d1=rollDie(), d2=rollDie(), total=d1+d2;
       const pnl = calculateCrapsExposure(total, gameState.crapsPoint, newBetsToPlace); // Use newBetsToPlace for PnL
       // Update point logic simplified
       let newPoint = gameState.crapsPoint;
       if (gameState.crapsPoint === null && [4,5,6,8,9,10].includes(total)) newPoint = total;
       else if (gameState.crapsPoint === total || total === 7) newPoint = null;

       // Reset roll history when 7 is rolled (seven-out), start fresh with the 7
       const newHistory = total === 7 ? [total] : [...gameState.crapsRollHistory, total].slice(-MAX_GRAPH_POINTS);
       setGameState(prev => ({
         ...prev,
         dice: [d1, d2],
         crapsPoint: newPoint,
         crapsRollHistory: newHistory,
         crapsLastRoundBets: newBetsToPlace.length > 0 ? newBetsToPlace : prev.crapsLastRoundBets,
         crapsBets: [],
         message: `ROLLED ${total}`,
         lastResult: pnl
       }));
  };

  const baccaratActions = {
      toggleSelection: (sel: 'PLAYER'|'BANKER') => {
        baccaratSelectionRef.current = sel;
        setGameState(prev => ({ ...prev, baccaratSelection: sel }));
      },
      placeBet: (type: BaccaratBet['type']) => {
          // Toggle behavior: remove if exists, add if not
          const existingIndex = gameState.baccaratBets.findIndex(b => b.type === type);
          if (existingIndex >= 0) {
              // Remove the bet
              const newBets = gameState.baccaratBets.filter((_, i) => i !== existingIndex);
              baccaratBetsRef.current = newBets;
              setGameState(prev => ({
                  ...prev,
                  baccaratUndoStack: [...prev.baccaratUndoStack, prev.baccaratBets],
                  baccaratBets: newBets
              }));
          } else {
              // Add the bet
              if (stats.chips < gameState.bet) return;
              const newBets = [...gameState.baccaratBets, { type, amount: gameState.bet }];
              baccaratBetsRef.current = newBets;
              setGameState(prev => ({
                  ...prev,
                  baccaratUndoStack: [...prev.baccaratUndoStack, prev.baccaratBets],
                  baccaratBets: newBets
              }));
          }
      },
      undo: () => {
          if (gameState.baccaratUndoStack.length > 0) {
              const newBets = gameState.baccaratUndoStack[gameState.baccaratUndoStack.length-1];
              baccaratBetsRef.current = newBets;
              setGameState(prev => ({ ...prev, baccaratBets: newBets, baccaratUndoStack: prev.baccaratUndoStack.slice(0, -1) }));
          }
      },
      rebet: () => {
          if (gameState.baccaratLastRoundBets.length > 0) {
              const newBets = [...gameState.baccaratBets, ...gameState.baccaratLastRoundBets];
              baccaratBetsRef.current = newBets;
              setGameState(prev => ({ ...prev, baccaratBets: newBets }));
          }
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
        // Guard against duplicate submissions
        if (isPendingRef.current) {
          console.log('[useTerminalGame] Three Card Play blocked - transaction pending');
          return;
        }

        isPendingRef.current = true;
        try {
          // Payload: [0] for Play
          const payload = new Uint8Array([0]);
          const result = await chainService.sendMove(currentSessionIdRef.current, payload);
          if (result.txHash) setLastTxSig(result.txHash);
          setGameState(prev => ({ ...prev, message: 'PLAYING...' }));
          return;
        // NOTE: Do NOT clear isPendingRef here - wait for CasinoGameMoved event
        } catch (error) {
          console.error('[useTerminalGame] Three Card Play failed:', error);
          setGameState(prev => ({ ...prev, message: 'MOVE FAILED' }));
          // Only clear isPending on error, not on success
          isPendingRef.current = false;
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
        // Guard against duplicate submissions
        if (isPendingRef.current) {
          console.log('[useTerminalGame] Three Card Fold blocked - transaction pending');
          return;
        }

        isPendingRef.current = true;
        try {
          // Payload: [1] for Fold
          const payload = new Uint8Array([1]);
          const result = await chainService.sendMove(currentSessionIdRef.current, payload);
          if (result.txHash) setLastTxSig(result.txHash);
          setGameState(prev => ({ ...prev, message: 'FOLDING...' }));
          return;
        // NOTE: Do NOT clear isPendingRef here - wait for CasinoGameMoved event
        } catch (error) {
          console.error('[useTerminalGame] Three Card Fold failed:', error);
          setGameState(prev => ({ ...prev, message: 'MOVE FAILED' }));
          // Only clear isPending on error, not on success
          isPendingRef.current = false;
          return;
        }
      }

      // Local mode fallback
      const dealerRevealed = gameState.dealerCards.map(c => ({ ...c, isHidden: false }));
      setGameState(prev => ({ ...prev, dealerCards: dealerRevealed, stage: 'RESULT' }));
      setGameState(prev => ({ ...prev, message: "FOLDED", lastResult: -gameState.bet }));
  };

  // --- CASINO WAR ---
  const casinoWarGoToWar = async () => {
      // Check message contains 'WAR' to ensure we're in war state
      if (gameState.type !== GameType.CASINO_WAR || gameState.stage !== 'PLAYING' || !gameState.message.includes('WAR')) return;

      // If on-chain mode, submit move
      if (isOnChain && chainService && currentSessionIdRef.current) {
        // Guard against duplicate submissions
        if (isPendingRef.current) {
          console.log('[useTerminalGame] Casino War Go To War blocked - transaction pending');
          return;
        }

        isPendingRef.current = true;
        try {
          // Payload: [1] for Go to War
          const payload = new Uint8Array([1]);
          const result = await chainService.sendMove(currentSessionIdRef.current, payload);
          if (result.txHash) setLastTxSig(result.txHash);
          setGameState(prev => ({ ...prev, message: 'GOING TO WAR...' }));
          return;
        // NOTE: Do NOT clear isPendingRef here - wait for CasinoGameMoved event
        } catch (error) {
          console.error('[useTerminalGame] Casino War Go To War failed:', error);
          setGameState(prev => ({ ...prev, message: 'MOVE FAILED' }));
          // Only clear isPending on error, not on success
          isPendingRef.current = false;
          return;
        }
      }

      // Local mode fallback - not fully implemented, just show result
      setGameState(prev => ({ ...prev, message: 'WAR NOT SUPPORTED IN LOCAL MODE' }));
  };

  const casinoWarSurrender = async () => {
      // Check message contains 'WAR' to ensure we're in war state
      if (gameState.type !== GameType.CASINO_WAR || gameState.stage !== 'PLAYING' || !gameState.message.includes('WAR')) return;

      // If on-chain mode, submit move
      if (isOnChain && chainService && currentSessionIdRef.current) {
        // Guard against duplicate submissions
        if (isPendingRef.current) {
          console.log('[useTerminalGame] Casino War Surrender blocked - transaction pending');
          return;
        }

        isPendingRef.current = true;
        try {
          // Payload: [2] for Surrender
          const payload = new Uint8Array([2]);
          const result = await chainService.sendMove(currentSessionIdRef.current, payload);
          if (result.txHash) setLastTxSig(result.txHash);
          setGameState(prev => ({ ...prev, message: 'SURRENDERING...' }));
          return;
        // NOTE: Do NOT clear isPendingRef here - wait for CasinoGameMoved event
        } catch (error) {
          console.error('[useTerminalGame] Casino War Surrender failed:', error);
          setGameState(prev => ({ ...prev, message: 'MOVE FAILED' }));
          // Only clear isPending on error, not on success
          isPendingRef.current = false;
          return;
        }
      }

      // Local mode fallback - lose half bet
      setGameState(prev => ({ ...prev, stage: 'RESULT', message: 'SURRENDERED', lastResult: -Math.floor(gameState.bet / 2) }));
  };

  // --- ULTIMATE HOLDEM ---
  const uhCheck = async () => {
      if (gameState.type !== GameType.ULTIMATE_HOLDEM || gameState.stage !== 'PLAYING') return;

      // If on-chain mode, submit move
      if (isOnChain && chainService && currentSessionIdRef.current) {
        // Guard against duplicate submissions
        if (isPendingRef.current) {
          console.log('[useTerminalGame] Ultimate Holdem Check blocked - transaction pending');
          return;
        }

        isPendingRef.current = true;
        try {
          // Payload: [0] for Check
          const payload = new Uint8Array([0]);
          const result = await chainService.sendMove(currentSessionIdRef.current, payload);
          if (result.txHash) setLastTxSig(result.txHash);
          setGameState(prev => ({ ...prev, message: 'CHECKING...' }));
          return;
        // NOTE: Do NOT clear isPendingRef here - wait for CasinoGameMoved event
        } catch (error) {
          console.error('[useTerminalGame] Ultimate Holdem Check failed:', error);
          setGameState(prev => ({ ...prev, message: 'MOVE FAILED' }));
          // Only clear isPending on error, not on success
          isPendingRef.current = false;
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
        // Guard against duplicate submissions
        if (isPendingRef.current) {
          console.log('[useTerminalGame] Ultimate Holdem Bet blocked - transaction pending');
          return;
        }

        isPendingRef.current = true;
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
        // NOTE: Do NOT clear isPendingRef here - wait for CasinoGameMoved event
        } catch (error) {
          console.error('[useTerminalGame] Ultimate Holdem Bet failed:', error);
          setGameState(prev => ({ ...prev, message: 'MOVE FAILED' }));
          // Only clear isPending on error, not on success
          isPendingRef.current = false;
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
        // Guard against duplicate submissions
        if (isPendingRef.current) {
          console.log('[useTerminalGame] Ultimate Holdem Fold blocked - transaction pending');
          return;
        }

        isPendingRef.current = true;
        try {
          // Payload: [4] for Fold
          const payload = new Uint8Array([4]);
          const result = await chainService.sendMove(currentSessionIdRef.current, payload);
          if (result.txHash) setLastTxSig(result.txHash);
          setGameState(prev => ({ ...prev, message: 'FOLDING...' }));
          return;
        // NOTE: Do NOT clear isPendingRef here - wait for CasinoGameMoved event
        } catch (error) {
          console.error('[useTerminalGame] Ultimate Holdem Fold failed:', error);
          setGameState(prev => ({ ...prev, message: 'MOVE FAILED' }));
          // Only clear isPending on error, not on success
          isPendingRef.current = false;
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
              // Check if we should respect WebSocket update cooldown
              const timeSinceLastUpdate = Date.now() - lastBalanceUpdateRef.current;
              const shouldUpdateBalance = timeSinceLastUpdate > BALANCE_UPDATE_COOLDOWN;

              setStats(prev => ({
                ...prev,
                chips: shouldUpdateBalance ? playerState.chips : prev.chips,
                shields: playerState.shields,
                doubles: playerState.doubles,
                history: [],
                pnlByGame: {},
                pnlHistory: []
              }));

              if (!shouldUpdateBalance) {
                console.log('[useTerminalGame] Skipped balance update from reset game polling (within cooldown)');
              }
            }
          } catch (e) {
            console.warn('[useTerminalGame] Failed to fetch player state after registration:', e);
          }
        }, 500);
      }
  };

  // Start a manual 5-minute tournament (solo mode or with bots)
  const startTournament = async () => {
    if (isTournamentStarting) return;

    const client = clientRef.current;
    if (!client) {
      console.error('[useTerminalGame] Cannot start tournament - client not initialized');
      return;
    }

    setIsTournamentStarting(true);
    console.log(`[useTerminalGame] Starting manual tournament${botConfig.enabled ? ` with ${botConfig.numBots} bots` : ' (solo mode)'}...`);

    // Calculate tournament times
    const TOURNAMENT_DURATION_MS = 5 * 60 * 1000; // 5 minutes
    const CURRENT_TOURNAMENT_ID = 1;
    const startTimeMs = Date.now();
    const endTimeMs = startTimeMs + TOURNAMENT_DURATION_MS;

    // Send on-chain CasinoStartTournament transaction
    // This will create a fresh tournament and automatically add the starting player
    try {
      const nonce = await client.nonceManager.getNextNonce();
      const txBytes = client.wasm.createCasinoStartTournamentTransaction(
        nonce,
        CURRENT_TOURNAMENT_ID,
        startTimeMs,
        endTimeMs
      );
      await client.submitTransaction(txBytes);
      console.log('[useTerminalGame] CasinoStartTournament transaction submitted');
    } catch (e) {
      console.error('[useTerminalGame] Failed to submit CasinoStartTournament transaction:', e);
      // Continue anyway - the local state will still work
    }

    // Force phase to ACTIVE
    setPhase('ACTIVE');

    // Set end time for 5 minutes from now (synced with on-chain)
    setManualTournamentEndTime(endTimeMs);
    setTournamentTime(5 * 60);

    // Reset local player chips to starting values immediately
    setStats(prev => ({
      ...prev,
      chips: INITIAL_CHIPS,
      shields: INITIAL_SHIELDS,
      doubles: INITIAL_DOUBLES,
      history: [],
      pnlByGame: {},
      pnlHistory: []
    }));

    // After a delay, fetch player state from chain to ensure sync
    if (publicKeyBytesRef.current) {
      setTimeout(async () => {
        try {
          const playerState = await client.getCasinoPlayer(publicKeyBytesRef.current!);
          if (playerState) {
            console.log('[useTerminalGame] Tournament started, syncing player state from chain:', playerState);
            setStats(prev => ({
              ...prev,
              chips: playerState.chips,
              shields: playerState.shields,
              doubles: playerState.doubles,
            }));
          }
        } catch (e) {
          console.warn('[useTerminalGame] Failed to sync player state after tournament start:', e);
        }
      }, 1000);
    }

    // Start the bots if enabled
    if (botConfig.enabled) {
      const botService = botServiceRef.current;
      if (botService) {
        try {
          await botService.start();
          console.log('[useTerminalGame] Bots started for tournament');
        } catch (e) {
          console.error('[useTerminalGame] Failed to start bots:', e);
        }
      }
    }

    setIsTournamentStarting(false);
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
    botConfig,
    setBotConfig,
    isTournamentStarting,
    startTournament,
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
        placeCrapsNumberBet,
        undoCrapsBet,
        rebetCraps,
        addCrapsOdds,
        // Baccarat
        baccaratActions,
        // Three Card Poker
        threeCardPlay,
        threeCardFold,
        // Casino War
        casinoWarGoToWar,
        casinoWarSurrender,
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
