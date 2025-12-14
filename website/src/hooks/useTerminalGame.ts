
import { useState, useEffect, useRef } from 'react';
import { GameType, PlayerStats, GameState, Card, LeaderboardEntry, TournamentPhase, CompletedHand, CrapsBet, RouletteBet, SicBoBet, BaccaratBet } from '../types';
import { GameType as ChainGameType, CasinoGameStartedEvent, CasinoGameMovedEvent, CasinoGameCompletedEvent } from '../types/casino';
import { createDeck, rollDie, getHandValue, getBaccaratValue, getHiLoRank, WAYS, getRouletteColor, evaluateVideoPokerHand, calculateCrapsExposure, calculateSicBoOutcomeExposure, getSicBoCombinations, resolveCrapsBets, resolveRouletteBets, resolveSicBoBets, evaluateThreeCardHand } from '../utils/gameUtils';
import { getStrategicAdvice } from '../services/geminiService';
import { CasinoChainService } from '../services/CasinoChainService';
import { CasinoClient } from '../api/client.js';
import { WasmWrapper } from '../api/wasm.js';
import { BotConfig, DEFAULT_BOT_CONFIG, BotService } from '../services/BotService';

const INITIAL_CHIPS = 1000;
const INITIAL_SHIELDS = 3;
const INITIAL_DOUBLES = 3;
const MAX_GRAPH_POINTS = 100; // Limit for graph/history arrays to prevent memory leaks

// Freeroll schedule: 60s registration + 5m active
const FREEROLL_REGISTRATION_MS = 60_000;
const FREEROLL_TOURNAMENT_MS = 5 * 60_000;
const FREEROLL_CYCLE_MS = FREEROLL_REGISTRATION_MS + FREEROLL_TOURNAMENT_MS;

function getFreerollSchedule(nowMs: number) {
  const slot = Math.floor(nowMs / FREEROLL_CYCLE_MS);
  const slotStartMs = slot * FREEROLL_CYCLE_MS;
  const startTimeMs = slotStartMs + FREEROLL_REGISTRATION_MS;
  const endTimeMs = startTimeMs + FREEROLL_TOURNAMENT_MS;
  return { slot, tournamentId: slot, slotStartMs, startTimeMs, endTimeMs, isRegistration: nowMs < startTimeMs };
}

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

// Baccarat bet type mapping for on-chain: 0=Player, 1=Banker, 2=Tie, 3=P_PAIR, 4=B_PAIR, 5=Lucky6
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
      case 'LUCKY6': betType = 5; break;
      default: continue;
    }
    bets.push({ betType, amount: sideBet.amount });
  }

  return bets;
};

type AutoPlayDraft =
  | {
      type: GameType.BACCARAT;
      baccaratSelection: 'PLAYER' | 'BANKER';
      baccaratSideBets: BaccaratBet[];
      mainBetAmount: number;
    }
  | {
      type: GameType.CRAPS;
      crapsBets: CrapsBet[];
    }
  | {
      type: GameType.ROULETTE;
      rouletteBets: RouletteBet[];
      rouletteZeroRule: GameState['rouletteZeroRule'];
    }
  | {
      type: GameType.SIC_BO;
      sicBoBets: SicBoBet[];
    };

type AutoPlayPlan = AutoPlayDraft & { sessionId: bigint };

export const useTerminalGame = (playMode: 'CASH' | 'FREEROLL' | null = null) => {
  // --- STATE ---
  const [stats, setStats] = useState<PlayerStats>({
    chips: INITIAL_CHIPS,
    shields: INITIAL_SHIELDS,
    doubles: INITIAL_DOUBLES,
    auraMeter: 0,
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
	    crapsEpochPointEstablished: false,
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
    rouletteZeroRule: 'STANDARD',
    rouletteIsPrison: false,
    sicBoBets: [],
    sicBoHistory: [],
    sicBoInputMode: 'NONE',
    sicBoUndoStack: [],
    sicBoLastRoundBets: [],
    baccaratBets: [],
    baccaratUndoStack: [],
    baccaratLastRoundBets: [],
    lastResult: 0,
    activeModifiers: { shield: false, double: false, super: false },
    baccaratSelection: 'PLAYER',
    insuranceBet: 0,
    blackjackStack: [],
    completedHands: [],
    blackjack21Plus3Bet: 0,
    threeCardPairPlusBet: 0,
    threeCardSixCardBonusBet: 0,
    threeCardProgressiveBet: 0,
    threeCardProgressiveJackpot: 10000,
    uthTripsBet: 0,
    uthSixCardBonusBet: 0,
    uthProgressiveBet: 0,
    uthProgressiveJackpot: 10000,
    uthBonusCards: [],
    casinoWarTieBet: 0,
    hiloAccumulator: 0,
    hiloGraphData: [],
    sessionWager: 0,
    sessionInterimPayout: 0,
    superMode: null
  });

  const [deck, setDeck] = useState<Card[]>([]);
  const [aiAdvice, setAiAdvice] = useState<string | null>(null);
  const [tournamentTime, setTournamentTime] = useState(0);
  const [phase, setPhase] = useState<TournamentPhase>('REGISTRATION');
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [isRegistered, setIsRegistered] = useState(false);
  const isRegisteredRef = useRef(false);
  const [botConfig, setBotConfig] = useState<BotConfig>(DEFAULT_BOT_CONFIG);
  const botServiceRef = useRef<BotService | null>(null);
  const [isTournamentStarting, setIsTournamentStarting] = useState(false);
  const [isFaucetClaiming, setIsFaucetClaiming] = useState(false);
  const [manualTournamentEndTime, setManualTournamentEndTime] = useState<number | null>(null);
  const [freerollActiveTournamentId, setFreerollActiveTournamentId] = useState<number | null>(null);
  const [freerollActiveTimeLeft, setFreerollActiveTimeLeft] = useState(0);
  const [freerollActivePrizePool, setFreerollActivePrizePool] = useState<number | null>(null);
  const [freerollActivePlayerCount, setFreerollActivePlayerCount] = useState<number | null>(null);
  const [freerollNextTournamentId, setFreerollNextTournamentId] = useState<number | null>(null);
  const [freerollNextStartIn, setFreerollNextStartIn] = useState(0);
  const [freerollIsJoinedNext, setFreerollIsJoinedNext] = useState(false);
  const [tournamentsPlayedToday, setTournamentsPlayedToday] = useState(0);

  // Chain service integration
  const [chainService, setChainService] = useState<CasinoChainService | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<bigint | null>(null);
  const currentSessionIdRef = useRef<bigint | null>(null);
  const gameTypeRef = useRef<GameType>(GameType.NONE);
  const baccaratSelectionRef = useRef<'PLAYER' | 'BANKER'>('PLAYER');
  const baccaratBetsRef = useRef<BaccaratBet[]>([]); // Track bets for event handlers
  const gameStateRef = useRef<GameState | null>(null); // Track game state for event handlers
  const isPendingRef = useRef<boolean>(false); // Prevent double-submits on rapid space key presses
  const pendingMoveCountRef = useRef<number>(0); // Number of CasinoGameMoved events we're still waiting on
  // Baseline chips at session start (for accurate net PnL via `finalChips - startChips`).
  const sessionStartChipsRef = useRef<Map<bigint, number>>(new Map());
  const crapsPendingRollLogRef = useRef<{
    sessionId: bigint;
    prevDice: [number, number] | null;
    point: number | null;
    bets: CrapsBet[];
  } | null>(null);
  const autoPlayDraftRef = useRef<AutoPlayDraft | null>(null);
  const autoPlayPlanRef = useRef<AutoPlayPlan | null>(null);
  const [isOnChain, setIsOnChain] = useState(false);
  const [lastTxSig, setLastTxSig] = useState<string | null>(null);
  const clientRef = useRef<CasinoClient | null>(null);
  const publicKeyBytesRef = useRef<Uint8Array | null>(null);

  // Balance update race condition fix: Track last WebSocket balance update time
  const lastBalanceUpdateRef = useRef<number>(0);
  const BALANCE_UPDATE_COOLDOWN = 2000; // 2 second cooldown after WebSocket update

  // Chain response watchdog for on-chain actions that wait on WebSocket events.
  const awaitingChainResponseRef = useRef(false);
  const chainResponseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const CHAIN_RESPONSE_TIMEOUT_MS = 15_000;

  useEffect(() => {
    isRegisteredRef.current = isRegistered;
  }, [isRegistered]);

  const clearChainResponseTimeout = () => {
    awaitingChainResponseRef.current = false;
    if (chainResponseTimeoutRef.current) {
      clearTimeout(chainResponseTimeoutRef.current);
      chainResponseTimeoutRef.current = null;
    }
  };

  const armChainResponseTimeout = (context: string, expectedSessionId?: bigint | null) => {
    awaitingChainResponseRef.current = true;
    if (chainResponseTimeoutRef.current) {
      clearTimeout(chainResponseTimeoutRef.current);
    }
    chainResponseTimeoutRef.current = setTimeout(() => {
      void (async () => {
        if (!awaitingChainResponseRef.current) return;

        const sessionId = expectedSessionId ?? currentSessionIdRef.current;
        if (sessionId === null || sessionId === undefined) {
          awaitingChainResponseRef.current = false;
          isPendingRef.current = false;
          pendingMoveCountRef.current = 0;
          crapsPendingRollLogRef.current = null;
          currentSessionIdRef.current = null;
          setCurrentSessionId(null);
          setGameState(prev => ({
            ...prev,
            stage: 'BETTING',
            message: `NO CHAIN RESPONSE (${context}) — START dev-executor`,
          }));
          return;
        }
        if (currentSessionIdRef.current !== sessionId) return;

        // WS fallback: if we missed CasinoGameStarted, pull the session directly.
        try {
          const client: any = clientRef.current;
          if (client) {
            const sessionState = await client.getCasinoSession(sessionId);
            if (!awaitingChainResponseRef.current) return;
            if (currentSessionIdRef.current !== sessionId) return;

            if (sessionState && !sessionState.isComplete) {
              const frontendGameType =
                CHAIN_TO_FRONTEND_GAME_TYPE[sessionState.gameType as ChainGameType] ?? gameTypeRef.current;
              gameTypeRef.current = frontendGameType;
              setCurrentSessionId(sessionId);
              // Prime bet/type before parsing so game decoders have correct context (eg blackjack base bet).
              const primedPrev = gameStateRef.current;
              if (primedPrev) {
                const primed = {
                  ...primedPrev,
                  type: frontendGameType,
                  bet:
                    sessionState.bet !== undefined && sessionState.bet !== null
                      ? Number(sessionState.bet)
                      : primedPrev.bet,
                };
                gameStateRef.current = primed;
                setGameState(primed);
              } else {
                setGameState(prev => ({
                  ...prev,
                  type: frontendGameType,
                  bet: sessionState.bet !== undefined && sessionState.bet !== null ? Number(sessionState.bet) : prev.bet,
                }));
              }
              parseGameState(sessionState.stateBlob, frontendGameType);
              clearChainResponseTimeout();
              isPendingRef.current = false;
              pendingMoveCountRef.current = 0;
              crapsPendingRollLogRef.current = null;
              runAutoPlayPlanForSession(sessionId, frontendGameType);
              return;
            }
          }
        } catch {
          // ignore (we'll fall through to the user-facing timeout message)
        }

        // No response: clear local session so the user can retry cleanly.
        awaitingChainResponseRef.current = false;
        isPendingRef.current = false;
        crapsPendingRollLogRef.current = null;
        currentSessionIdRef.current = null;
        setCurrentSessionId(null);
        setGameState(prev => ({
          ...prev,
          stage: 'BETTING',
          message: `NO CHAIN RESPONSE (${context}) — START dev-executor`,
        }));
      })();
    }, CHAIN_RESPONSE_TIMEOUT_MS);
  };

  const ensureChainResponsive = async (): Promise<boolean> => {
    const client: any = clientRef.current;
    if (!client) return false;

    try {
      const view = client.getCurrentView?.();
      if (view !== null && view !== undefined) return true;
    } catch {
      // ignore
    }

    // First try REST to avoid waiting on WS timing.
    try {
      const latest = await client.queryLatestSeed?.();
      if (latest?.found) {
        // Prime local view cache for downstream checks.
        client.latestSeed = latest.seed;
        return true;
      }
    } catch {
      // ignore
    }

    // Finally, wait briefly for a seed over WS.
    try {
      await Promise.race([
        client.waitForFirstSeed?.(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('seed-timeout')), 1500)),
      ]);
      const view = client.getCurrentView?.();
      return view !== null && view !== undefined;
    } catch {
      return false;
    }
  };

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
        if (!keypair) {
          console.warn('[useTerminalGame] No keypair available (passkey vault locked?)');
          setIsOnChain(false);
          setGameState(prev => ({
            ...prev,
            stage: 'BETTING',
            message: 'UNLOCK PASSKEY VAULT — OPEN VAULT TAB',
          }));
          return;
        }
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
              auraMeter: playerState.auraMeter ?? prev.auraMeter ?? 0,
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
                super: playerState.activeSuper || false,
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
                      superMode: sessionState.superMode ?? null,
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
            // Also clear the localStorage registration flag (keyed by public key when available)
            const keyId =
              localStorage.getItem('casino_public_key_hex') ?? localStorage.getItem('casino_private_key');
            if (keyId) {
              localStorage.removeItem(`casino_registered_${keyId}`);
              console.log('[useTerminalGame] Cleared localStorage registration flag for key:', keyId.substring(0, 8) + '...');
            }
          }
        } catch (playerError) {
          console.warn('[useTerminalGame] Failed to fetch player state:', playerError);
        }

        // Fetch HouseState (includes progressive jackpot meters).
        try {
          const house: any = await client.getHouse();
          if (house) {
            setGameState(prev => ({
              ...prev,
              threeCardProgressiveJackpot: Number(house.threeCardProgressiveJackpot ?? prev.threeCardProgressiveJackpot),
              uthProgressiveJackpot: Number(house.uthProgressiveJackpot ?? prev.uthProgressiveJackpot),
            }));
          }
        } catch (houseError) {
          console.debug('[useTerminalGame] Failed to fetch house state:', houseError);
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

        // Tournament state is synced by the freeroll scheduler effect (when enabled).
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

  const freerollStartInFlightRef = useRef(false);
  const freerollEndInFlightRef = useRef(false);

  // --- FREEROLL SCHEDULER + LEADERBOARD POLLING ---
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();

      if (playMode !== 'FREEROLL') {
        // Cash mode: no tournament automation.
        setTournamentTime(0);
        setFreerollActiveTournamentId(null);
        setFreerollActiveTimeLeft(0);
        setFreerollNextTournamentId(null);
        setFreerollNextStartIn(0);
        setFreerollIsJoinedNext(false);
      } else {
        const scheduleNow = getFreerollSchedule(now);

        const nextTid = scheduleNow.isRegistration ? scheduleNow.tournamentId : scheduleNow.tournamentId + 1;
        const nextStartMs = nextTid * FREEROLL_CYCLE_MS + FREEROLL_REGISTRATION_MS;
        setFreerollNextTournamentId(nextTid);
        setFreerollNextStartIn(Math.max(0, Math.ceil((nextStartMs - now) / 1000)));

        // Keep the in-game timer ticking smoothly for the active tournament the player is in.
        if (manualTournamentEndTime !== null && phase === 'ACTIVE') {
          const remaining = Math.max(0, manualTournamentEndTime - now);
          setTournamentTime(Math.ceil(remaining / 1000));
        }
      }

      tickCounterRef.current++;
      if (!clientRef.current || !publicKeyBytesRef.current || tickCounterRef.current % 2 !== 0) {
        return;
      }

      (async () => {
        const client: any = clientRef.current;
        if (!client) return;

        const myPublicKeyHex = publicKeyBytesRef.current
          ? Array.from(publicKeyBytesRef.current).map(b => b.toString(16).padStart(2, '0')).join('')
          : null;

        // Always keep player state in sync (chips/shields/doubles + freeroll entry limits).
        let playerState: any = null;
        try {
          playerState = await client.getCasinoPlayer(publicKeyBytesRef.current);
        } catch (e) {
          console.debug('[useTerminalGame] Failed to fetch player state:', e);
        }

        let shouldUpdateBalance = true;
        let playerActiveTid: number | null = null;

        if (playerState) {
          setIsRegistered(true);
          hasRegisteredRef.current = true;

          setTournamentsPlayedToday(Number(playerState.tournamentsPlayedToday ?? 0));

          // Update balances (avoid clobbering fresh WebSocket updates).
          const timeSinceLastUpdate = Date.now() - lastBalanceUpdateRef.current;
          shouldUpdateBalance = timeSinceLastUpdate > BALANCE_UPDATE_COOLDOWN;

          playerActiveTid = playerState.activeTournament != null ? Number(playerState.activeTournament) : null;

          // Joined status for the next freeroll (registration).
          if (playMode === 'FREEROLL' && freerollNextTournamentId !== null) {
            setFreerollIsJoinedNext(playerActiveTid === freerollNextTournamentId);
          }
        } else {
          setIsRegistered(false);
          hasRegisteredRef.current = false;
          setTournamentsPlayedToday(0);
        }

        if (playMode !== 'FREEROLL') {
          // Cash mode: keep wallet balances in sync even if we miss WS events.
          if (playerState) {
            setStats(prev => ({
              ...prev,
              chips: shouldUpdateBalance ? Number(playerState.chips) : prev.chips,
              shields: Number(playerState.shields),
              doubles: Number(playerState.doubles),
            }));
          }

          // Cash leaderboard
          try {
            const leaderboardData = await client.getCasinoLeaderboard();
            if (leaderboardData && leaderboardData.entries) {
              const newBoard: LeaderboardEntry[] = leaderboardData.entries.map((entry: { player?: string; name?: string; chips: bigint | number }) => {
                const name = entry.name || `Player_${entry.player?.substring(0, 8)}`;
                const isYou = !!myPublicKeyHex && !!entry.player && entry.player.toLowerCase() === myPublicKeyHex.toLowerCase();
                return {
                  name: isYou ? `${name} (YOU)` : name,
                  chips: Number(entry.chips),
                  status: 'ALIVE' as const
                };
              });

              const isPlayerInBoard = !!myPublicKeyHex && leaderboardData.entries.some(
                (entry: { player?: string }) => entry.player?.toLowerCase() === myPublicKeyHex.toLowerCase()
              );
              if (!isPlayerInBoard && isRegistered) {
                newBoard.push({ name: 'YOU', chips: currentChipsRef.current, status: 'ALIVE' as const });
              }

              newBoard.sort((a, b) => b.chips - a.chips);
              setLeaderboard(newBoard);

              const myRank = newBoard.findIndex(p => p.name.includes("YOU")) + 1;
              if (myRank > 0) {
                setStats(s => ({ ...s, rank: myRank }));
              }
            }
          } catch (e) {
            console.debug('[useTerminalGame] Failed to fetch cash leaderboard:', e);
          }
          return;
        }

        const scheduleNow = getFreerollSchedule(Date.now());
        const currentSlotTid = scheduleNow.tournamentId;
        const candidateTids = currentSlotTid > 0 ? [currentSlotTid, currentSlotTid - 1] : [currentSlotTid];

        // Find an active tournament (current or just-finished slot).
        let activeTournament: { id: number; endTimeMs: number; state: any } | null = null;
        for (const tid of candidateTids) {
          try {
            const t = await client.getCasinoTournament(tid);
            if (t && t.phase === 'Active' && t.endTimeMs) {
              const endMs = Number(t.endTimeMs);
              activeTournament = { id: tid, endTimeMs: endMs, state: t };
              break;
            }
          } catch {
            // ignore
          }
        }

        setFreerollActiveTournamentId(activeTournament ? activeTournament.id : null);
        setFreerollActiveTimeLeft(
          activeTournament ? Math.max(0, Math.ceil((activeTournament.endTimeMs - now) / 1000)) : 0
        );
        setFreerollActivePrizePool(activeTournament ? Number(activeTournament.state?.prizePool ?? 0) : null);
        setFreerollActivePlayerCount(
          activeTournament && Array.isArray(activeTournament.state?.players)
            ? activeTournament.state.players.length
            : null
        );

        const isInActiveTournament = !!activeTournament && playerActiveTid === activeTournament.id;

        if (playerState) {
          const showTournamentStack = isInActiveTournament;
          const desiredChips = showTournamentStack ? playerState.tournamentChips : playerState.chips;
          const desiredShields = showTournamentStack ? playerState.tournamentShields : playerState.shields;
          const desiredDoubles = showTournamentStack ? playerState.tournamentDoubles : playerState.doubles;

          setStats(prev => ({
            ...prev,
            chips: shouldUpdateBalance ? Number(desiredChips) : prev.chips,
            shields: Number(desiredShields),
            doubles: Number(desiredDoubles),
          }));
        }

        if (isInActiveTournament) {
          setPhase('ACTIVE');
          setManualTournamentEndTime(activeTournament!.endTimeMs);
          setTournamentTime(Math.max(0, Math.ceil((activeTournament!.endTimeMs - now) / 1000)));
        } else {
          setPhase('REGISTRATION');
          setManualTournamentEndTime(null);
          setTournamentTime(0);
        }

        // Auto-start the scheduled tournament once registration ends.
        if (!scheduleNow.isRegistration && now < scheduleNow.endTimeMs && !freerollStartInFlightRef.current) {
          try {
            const t = await client.getCasinoTournament(scheduleNow.tournamentId);
            if (t && t.phase === 'Registration' && Array.isArray(t.players) && t.players.length > 0) {
              freerollStartInFlightRef.current = true;
              setIsTournamentStarting(true);
              try {
                const result = await client.nonceManager.submitCasinoStartTournament(
                  scheduleNow.tournamentId,
                  scheduleNow.startTimeMs,
                  scheduleNow.endTimeMs
                );
                if (result?.txHash) setLastTxSig(result.txHash);
              } finally {
                setIsTournamentStarting(false);
                freerollStartInFlightRef.current = false;
              }
            }
          } catch (e) {
            console.debug('[useTerminalGame] Auto-start tournament failed:', e);
            setIsTournamentStarting(false);
            freerollStartInFlightRef.current = false;
          }
        }

        // Auto-end an active tournament once its end time passes.
        if (activeTournament && now >= activeTournament.endTimeMs && !freerollEndInFlightRef.current) {
          freerollEndInFlightRef.current = true;
          try {
            const result = await client.nonceManager.submitCasinoEndTournament(activeTournament.id);
            if (result?.txHash) setLastTxSig(result.txHash);
          } catch (e) {
            console.debug('[useTerminalGame] Auto-end tournament failed:', e);
          } finally {
            freerollEndInFlightRef.current = false;
          }
        }

        // Tournament leaderboard (preferred) while a tournament is active.
        if (activeTournament?.state?.leaderboard?.entries) {
          const entries = activeTournament.state.leaderboard.entries;
          const newBoard: LeaderboardEntry[] = entries.map((entry: { player?: string; name?: string; chips: bigint | number }) => {
            const name = entry.name || `Player_${entry.player?.substring(0, 8)}`;
            const isYou = !!myPublicKeyHex && !!entry.player && entry.player.toLowerCase() === myPublicKeyHex.toLowerCase();
            return { name: isYou ? `${name} (YOU)` : name, chips: Number(entry.chips), status: 'ALIVE' as const };
          });

          const isPlayerInBoard = !!myPublicKeyHex && entries.some(
            (entry: { player?: string }) => entry.player?.toLowerCase() === myPublicKeyHex.toLowerCase()
          );
          if (!isPlayerInBoard && isInActiveTournament) {
            newBoard.push({ name: 'YOU', chips: currentChipsRef.current, status: 'ALIVE' as const });
          }

          newBoard.sort((a, b) => b.chips - a.chips);
          setLeaderboard(newBoard);

          const myRank = newBoard.findIndex(p => p.name.includes("YOU")) + 1;
          if (myRank > 0) {
            setStats(s => ({ ...s, rank: myRank }));
          }
        } else {
          // Fallback: show the cash leaderboard in the freeroll lobby when no active tournament board is available.
          try {
            const leaderboardData = await client.getCasinoLeaderboard();
            if (leaderboardData && leaderboardData.entries) {
              const newBoard: LeaderboardEntry[] = leaderboardData.entries.map((entry: { player?: string; name?: string; chips: bigint | number }) => {
                const name = entry.name || `Player_${entry.player?.substring(0, 8)}`;
                const isYou = !!myPublicKeyHex && !!entry.player && entry.player.toLowerCase() === myPublicKeyHex.toLowerCase();
                return { name: isYou ? `${name} (YOU)` : name, chips: Number(entry.chips), status: 'ALIVE' as const };
              });
              newBoard.sort((a, b) => b.chips - a.chips);
              setLeaderboard(newBoard);
            }
          } catch (e) {
            console.debug('[useTerminalGame] Failed to fetch lobby leaderboard:', e);
          }
        }
      })();
    }, 1000);

    return () => clearInterval(interval);
  }, [playMode, phase, manualTournamentEndTime, freerollNextTournamentId]);

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

  // Prepare bots during freeroll registration, then start playing when the player enters the active tournament.
  useEffect(() => {
    const botService = botServiceRef.current;
    if (!botService) return;

    botService.setConfig(botConfig);

    if (playMode !== 'FREEROLL' || !botConfig.enabled) {
      botService.stop();
      return;
    }

    if (phase === 'REGISTRATION') {
      if (freerollNextTournamentId !== null) {
        console.log('[useTerminalGame] Preparing bots for tournament', freerollNextTournamentId);
        botService.prepareTournamentBots(freerollNextTournamentId).catch((e) => {
          console.warn('[useTerminalGame] Failed to prepare bots:', e);
        });
      }
      return;
    }

    if (phase === 'ACTIVE') {
      console.log('[useTerminalGame] Starting bot play loops...');
      botService.startPlaying();
    }

    return () => {
      botService.stop();
    };
  }, [playMode, phase, botConfig, freerollNextTournamentId]);

  // Keep gameStateRef in sync with gameState for event handlers
  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  // Helper to generate descriptive result messages and detailed logs
  const generateGameResult = (gameType: GameType, state: GameState | null, netPnL: number): { summary: string, details: string[] } => {
    // Show net P&L with sign
    const resultPart = netPnL >= 0 ? `+$${netPnL}` : `-$${Math.abs(netPnL)}`;
    const details: string[] = [];

    if (!state) return { summary: resultPart, details };

    let summary = resultPart;

    switch (gameType) {
      case GameType.BACCARAT: {
        if (state.playerCards.length === 0 || state.dealerCards.length === 0) return { summary, details };
        const pScore = getBaccaratValue(state.playerCards);
        const bScore = getBaccaratValue(state.dealerCards);
        const winner = pScore > bScore ? 'PLAYER' : bScore > pScore ? 'BANKER' : 'TIE';
        const scoreDisplay = winner === 'TIE' ? `${pScore}-${bScore}` : winner === 'PLAYER' ? `${pScore}-${bScore}` : `${bScore}-${pScore}`;
        summary = `${winner} wins ${scoreDisplay}. ${resultPart}`;
        
        // Generate details for bets
        state.baccaratBets.forEach(bet => {
            let win = false;
            let amount = 0;
            if (bet.type === 'TIE' && winner === 'TIE') { win = true; amount = bet.amount * 8; }
            else if (bet.type === 'P_PAIR' && state.playerCards[0].rank === state.playerCards[1].rank) { win = true; amount = bet.amount * 11; }
            else if (bet.type === 'B_PAIR' && state.dealerCards[0].rank === state.dealerCards[1].rank) { win = true; amount = bet.amount * 11; }
            else if (bet.type === 'LUCKY6' && winner === 'BANKER' && bScore === 6) {
              win = true;
              amount = bet.amount * (state.dealerCards.length === 2 ? 12 : 23);
            }
            
            if (win) details.push(`${bet.type} WIN (+$${amount})`);
            else details.push(`${bet.type} LOSS (-$${bet.amount})`);
        });
        // Main bet detail
        const mainBet = state.sessionWager - state.baccaratBets.reduce((a,b) => a + b.amount, 0); // Approx
        if (mainBet > 0) {
             if (state.baccaratSelection === winner) details.push(`${state.baccaratSelection} WIN (+$${mainBet})`);
             else if (winner !== 'TIE') details.push(`${state.baccaratSelection} LOSS (-$${mainBet})`);
             else details.push(`${state.baccaratSelection} PUSH`);
        }
        break;
      }
      case GameType.BLACKJACK: {
        if (!state.playerCards?.length || !state.dealerCards?.length) return { summary, details };
        const pVal = getHandValue(state.playerCards);
        const dVal = getHandValue(state.dealerCards);
        const pBust = pVal > 21;
        const dBust = dVal > 21;
        
        if (pVal === 21 && state.playerCards.length === 2) summary = `BLACKJACK! ${resultPart}`;
        else if (pBust) summary = `Bust (${pVal}). ${resultPart}`;
        else if (dBust) summary = `Dealer bust (${dVal}). ${resultPart}`;
        else summary = `${pVal} vs ${dVal}. ${resultPart}`;
        
        if (netPnL > 0) details.push(`WIN (+$${netPnL})`);
        else if (netPnL < 0) details.push(`LOSS (-$${Math.abs(netPnL)})`);
        else details.push(`PUSH`);
        break;
      }
      case GameType.CASINO_WAR: {
        const pCard = state.playerCards[0];
        const dCard = state.dealerCards[0];
        if (!pCard || !dCard) return { summary, details };
        summary = `${pCard.rank} vs ${dCard.rank}. ${resultPart}`;
        if (netPnL > 0) details.push(`WIN (+$${netPnL})`);
        else if (netPnL < 0) details.push(`LOSS (-$${Math.abs(netPnL)})`);
        else details.push(`TIE/PUSH`);
        break;
      }
      case GameType.HILO: {
        const lastCard = state.playerCards[state.playerCards.length - 1];
        if (!lastCard) return { summary, details };
        summary = `${lastCard.rank}${lastCard.suit}. ${resultPart}`;
        details.push(`Outcome: ${lastCard.rank}${lastCard.suit}`);
        if (netPnL > 0) details.push(`WIN (+$${netPnL})`);
        else details.push(`LOSS (-$${Math.abs(netPnL)})`);
        break;
      }
      case GameType.VIDEO_POKER: {
        const hand = evaluateVideoPokerHand(state.playerCards);
        summary = `${hand.rank}. ${resultPart}`;
        details.push(`${hand.rank}`);
        if (netPnL > 0) details.push(`WIN (+$${netPnL})`);
        else details.push(`LOSS (-$${Math.abs(netPnL)})`);
        break;
      }
      case GameType.THREE_CARD: {
        const pHand = evaluateThreeCardHand(state.playerCards);
        const dHand = evaluateThreeCardHand(state.dealerCards);
        summary = `${pHand.rank} vs ${dHand.rank}. ${resultPart}`;
        details.push(`Player: ${pHand.rank}`);
        details.push(`Dealer: ${dHand.rank}`);
        if (netPnL > 0) details.push(`WIN (+$${netPnL})`);
        else if (netPnL < 0) details.push(`LOSS (-$${Math.abs(netPnL)})`);
        else details.push(`PUSH`);
        break;
      }
      case GameType.ULTIMATE_HOLDEM: {
        const pVal = getHandValue(state.playerCards);
        const dVal = getHandValue(state.dealerCards);
        summary = `Player ${pVal} vs Dealer ${dVal}. ${resultPart}`;
        if (netPnL > 0) details.push(`WIN (+$${netPnL})`);
        else if (netPnL < 0) details.push(`LOSS (-$${Math.abs(netPnL)})`);
        else details.push(`PUSH`);
        break;
      }
      case GameType.CRAPS: {
        if (!state.dice || state.dice.length < 2) return { summary, details };
        const d1 = state.dice[0];
        const d2 = state.dice[1];
        const total = d1 + d2;
        summary = `Rolled: ${total}. ${resultPart}`;
        
        // Use resolveCrapsBets to generate details using Bets from state
        // Note: we use state.crapsBets here, but if game is over, active bets might be cleared?
        // Actually, resolveCrapsBets processes *all* bets passed to it.
        // We need the bets that were active *before* the result cleared them.
        // gameStateRef.current holds the state from the last move.
        // If this is CasinoGameCompleted, the state might not have cleared them yet if we rely on local clearing?
        // Actually, parseGameState updates crapsBets from chain.
        // If chain cleared them, they are gone.
        // We should ideally use `crapsLastRoundBets` if `crapsBets` is empty, or combine them?
        // For simplicity, we'll try to use crapsBets + lastRoundBets?
        const betsToResolve = state.crapsBets.length > 0 ? state.crapsBets : state.crapsLastRoundBets;
        const res = resolveCrapsBets([d1, d2], state.crapsPoint, betsToResolve);
        details.push(...res.results);
        break;
      }
      case GameType.ROULETTE: {
        const last = state.rouletteHistory[state.rouletteHistory.length - 1];
        if (last === undefined) return { summary, details };
        const color = getRouletteColor(last);
        summary = `${last} ${color}. ${resultPart}`;
        
        // Use resolveRouletteBets
        const betsToResolve = state.rouletteBets.length > 0 ? state.rouletteBets : state.rouletteLastRoundBets;
        const res = resolveRouletteBets(last, betsToResolve, state.rouletteZeroRule);
        details.push(...res.results);
        break;
      }
      case GameType.SIC_BO: {
        if (!state.dice || state.dice.length < 3) return { summary, details };
        const total = state.dice.reduce((a, b) => a + b, 0);
        summary = `Rolled ${total} (${state.dice.join('-')}). ${resultPart}`;
        
        const betsToResolve = state.sicBoBets.length > 0 ? state.sicBoBets : state.sicBoLastRoundBets;
        const res = resolveSicBoBets(state.dice, betsToResolve);
        details.push(...res.results);
        break;
      }
    }
    return { summary, details };
  };

  const runAutoPlayPlanForSession = (sessionId: bigint, frontendGameType: GameType) => {
    const plan = autoPlayPlanRef.current;
    if (!plan || plan.sessionId !== sessionId) return;

    // Consume plan so we don't double-submit if we get both WS + fallback.
    autoPlayPlanRef.current = null;

    if (plan.type !== frontendGameType) {
      console.warn('[useTerminalGame] auto-play plan type mismatch:', plan.type, '!=', frontendGameType);
      return;
    }
    if (!chainService) return;
    if (isPendingRef.current) {
      console.log('[useTerminalGame] auto-play blocked - transaction pending');
      return;
    }
    if (!currentSessionIdRef.current) return;

    (async () => {
      isPendingRef.current = true;
      try {
        if (plan.type === GameType.BACCARAT) {
          const betsToPlace = getBaccaratBetsToPlace(
            plan.baccaratSelection,
            plan.baccaratSideBets,
            plan.mainBetAmount,
          );
          pendingMoveCountRef.current = betsToPlace.length + 1;

          setGameState(prev => ({
            ...prev,
            baccaratLastRoundBets: plan.baccaratSideBets,
            baccaratUndoStack: [],
            sessionWager: betsToPlace.reduce((s, b) => s + b.amount, 0),
            message: 'PLACING BETS...',
          }));

          for (const bet of betsToPlace) {
            const betPayload = serializeBaccaratBet(bet.betType, bet.amount);
            const result = await chainService.sendMove(sessionId, betPayload);
            if (result.txHash) setLastTxSig(result.txHash);
          }

          setGameState(prev => ({ ...prev, message: 'DEALING...' }));
          const dealPayload = new Uint8Array([1]);
          const result = await chainService.sendMove(sessionId, dealPayload);
          if (result.txHash) setLastTxSig(result.txHash);
          return;
        }

        if (plan.type === GameType.ROULETTE) {
          const ruleByte =
            plan.rouletteZeroRule === 'LA_PARTAGE'
              ? 1
              : plan.rouletteZeroRule === 'EN_PRISON'
                ? 2
                : plan.rouletteZeroRule === 'EN_PRISON_DOUBLE'
                  ? 3
                  : 0;
          pendingMoveCountRef.current = 1 + plan.rouletteBets.length + 1;

          const totalWager = plan.rouletteBets.reduce((s, b) => s + b.amount, 0);
          setGameState(prev => ({ ...prev, sessionWager: totalWager, message: 'PLACING BETS...' }));

          const rulePayload = new Uint8Array([3, ruleByte]);
          const ruleRes = await chainService.sendMove(sessionId, rulePayload);
          if (ruleRes.txHash) setLastTxSig(ruleRes.txHash);

          for (const bet of plan.rouletteBets) {
            const betPayload = serializeRouletteBet(bet);
            const result = await chainService.sendMove(sessionId, betPayload);
            if (result.txHash) setLastTxSig(result.txHash);
          }

          setGameState(prev => ({ ...prev, message: 'SPINNING ON CHAIN...' }));
          const spinPayload = new Uint8Array([1]);
          const result = await chainService.sendMove(sessionId, spinPayload);
          if (result.txHash) setLastTxSig(result.txHash);

          setGameState(prev => ({
            ...prev,
            rouletteLastRoundBets: plan.rouletteBets,
            rouletteBets: [],
            rouletteUndoStack: [],
          }));
          return;
        }

        if (plan.type === GameType.SIC_BO) {
          pendingMoveCountRef.current = plan.sicBoBets.length + 1;
          const totalWager = plan.sicBoBets.reduce((s, b) => s + b.amount, 0);
          setGameState(prev => ({ ...prev, sessionWager: totalWager, message: 'PLACING BETS...' }));

          for (const bet of plan.sicBoBets) {
            const betPayload = serializeSicBoBet(bet);
            const result = await chainService.sendMove(sessionId, betPayload);
            if (result.txHash) setLastTxSig(result.txHash);
          }

          setGameState(prev => ({ ...prev, message: 'ROLLING ON CHAIN...' }));
          const rollPayload = new Uint8Array([1]);
          const result = await chainService.sendMove(sessionId, rollPayload);
          if (result.txHash) setLastTxSig(result.txHash);

          setGameState(prev => ({
            ...prev,
            sicBoLastRoundBets: plan.sicBoBets,
            sicBoBets: [],
            sicBoUndoStack: [],
          }));
          return;
        }

        if (plan.type === GameType.CRAPS) {
          pendingMoveCountRef.current = plan.crapsBets.length + 1;
          setGameState(prev => ({
            ...prev,
            crapsLastRoundBets: plan.crapsBets,
            crapsUndoStack: [],
            message: 'PLACING BETS...',
          }));

          for (const bet of plan.crapsBets) {
            const betPayload = serializeCrapsBet(bet);
            const result = await chainService.sendMove(sessionId, betPayload);
            if (result.txHash) setLastTxSig(result.txHash);
          }

          setGameState(prev => ({ ...prev, message: 'ROLLING ON CHAIN...' }));
          crapsPendingRollLogRef.current = {
            sessionId,
            prevDice: null,
            point: null,
            bets: plan.crapsBets.map(b => ({ ...b })),
          };
          const rollPayload = new Uint8Array([2]);
          const result = await chainService.sendMove(sessionId, rollPayload);
          if (result.txHash) setLastTxSig(result.txHash);
          return;
        }
      } catch (error) {
        console.error('[useTerminalGame] auto-play failed:', error);
        setGameState(prev => ({ ...prev, message: 'AUTO PLAY FAILED' }));
        isPendingRef.current = false;
        pendingMoveCountRef.current = 0;
        crapsPendingRollLogRef.current = null;
      }
    })();
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
        clearChainResponseTimeout();
        // Clear pending flag - session is now active and ready for moves
        isPendingRef.current = false;
        pendingMoveCountRef.current = 0;

	        // Store game type for use in subsequent move events
	        const frontendGameType = CHAIN_TO_FRONTEND_GAME_TYPE[event.gameType];
	        gameTypeRef.current = frontendGameType;

	        // Fetch full session state to get super/aura mode metadata.
	        (async () => {
	          try {
	            const sessionState = await clientRef.current?.getCasinoSession(eventSessionId);
	            if (sessionState) {
	              setGameState(prev => ({ ...prev, superMode: sessionState.superMode ?? null }));
	            }
	          } catch (e) {
	            console.debug('[useTerminalGame] Failed to fetch session state after GameStarted:', e);
	          }
	        })();

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
	        }

	        // If this session was started by a SPACE auto-play request (rebet + play), run it now.
	        runAutoPlayPlanForSession(eventSessionId, frontendGameType);
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
        const stateBlob = event.newState;
        console.log('[useTerminalGame] Session ID matched! Parsing new state for game type:', gameTypeRef.current);
        // Craps: log per-bet resolution (WIN/LOSS/PUSH) on each roll.
        // We must compute this BEFORE parsing the post-roll state because the on-chain game removes resolved bets.
        const crapsSnap = crapsPendingRollLogRef.current;
        if (gameTypeRef.current === GameType.CRAPS && crapsSnap && crapsSnap.sessionId === eventSessionId) {
          let d1 = 0;
          let d2 = 0;
	          if (stateBlob.length >= 5 && (stateBlob[0] === 1 || stateBlob[0] === 2)) {
	            d1 = stateBlob[3] ?? 0;
	            d2 = stateBlob[4] ?? 0;
	          } else if (stateBlob.length >= 4) {
	            d1 = stateBlob[2] ?? 0;
	            d2 = stateBlob[3] ?? 0;
          }

          if (d1 > 0 && d2 > 0) {
            const diceChangedFromSnapshot =
              !crapsSnap.prevDice || crapsSnap.prevDice[0] !== d1 || crapsSnap.prevDice[1] !== d2;
            const isFinalPendingMove = pendingMoveCountRef.current === 1;

            // Consume the snapshot on the roll result (usually dice changes; if dice repeats, fall back to pending count).
            if (diceChangedFromSnapshot || isFinalPendingMove) {
              const total = d1 + d2;
              const res = resolveCrapsBets([d1, d2], crapsSnap.point, crapsSnap.bets);
              setStats(prev => ({
                ...prev,
                history: [...prev.history, `Rolled: ${total}`, ...res.results],
              }));
              crapsPendingRollLogRef.current = null;
            }
          }
        }

        // Parse state and update UI using the tracked game type from ref (not stale closure)
        parseGameState(stateBlob, gameTypeRef.current);

        // Clear pending flag since we received the chain response.
        // If we're awaiting multiple sequential moves (e.g. staged bets + roll), only clear after the final move arrives.
        if (pendingMoveCountRef.current > 0) {
          pendingMoveCountRef.current = Math.max(0, pendingMoveCountRef.current - 1);
          console.log('[useTerminalGame] Pending move events remaining:', pendingMoveCountRef.current);
          if (pendingMoveCountRef.current === 0) {
            console.log('[useTerminalGame] Clearing isPending flag after final pending move');
            isPendingRef.current = false;
          } else {
            isPendingRef.current = true;
          }
        } else {
          console.log('[useTerminalGame] Clearing isPending flag after CasinoGameMoved');
          isPendingRef.current = false;
        }

        // Blackjack uses a hidden-info-safe Reveal move (dealer hole card is drawn at Reveal).
        // Don't force a manual SPACE press: auto-submit Reveal as soon as the player is done.
        const isBlackjackAwaitingReveal =
          gameTypeRef.current === GameType.BLACKJACK &&
          stateBlob.length >= 2 &&
          stateBlob[0] === 2 && // state version
          stateBlob[1] === 2; // Stage::AwaitingReveal

        if (isBlackjackAwaitingReveal && !isPendingRef.current && currentSessionIdRef.current) {
          void (async () => {
            try {
              isPendingRef.current = true;
              setGameState(prev => {
                const next = { ...prev, message: 'REVEALING...' };
                gameStateRef.current = next;
                return next;
              });
              const result = await chainService.sendMove(
                currentSessionIdRef.current!,
                new Uint8Array([6]) // Move 6: Reveal
              );
              if (result.txHash) setLastTxSig(result.txHash);
            } catch (error) {
              console.error('[useTerminalGame] Blackjack auto-reveal failed:', error);
              isPendingRef.current = false;
              setGameState(prev => {
                const next = { ...prev, message: 'REVEAL FAILED (SPACE)' };
                gameStateRef.current = next;
                return next;
              });
            }
          })();
        }
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
        clearChainResponseTimeout();
        const payout = Number(event.payout);
        const finalChips = Number(event.finalChips);
        console.log('[useTerminalGame] Session ID matched! Updating chips to:', finalChips);

        // Mark the time of this WebSocket balance update to prevent polling from overwriting
        lastBalanceUpdateRef.current = Date.now();

        const sessionWager = gameStateRef.current?.sessionWager || 0;
        const interimPayout = gameStateRef.current?.sessionInterimPayout || 0;
        const startChips = sessionStartChipsRef.current.get(eventSessionId);

        // Prefer net PnL via chip delta to capture all mid-session deductions/credits (table games).
        // Fallback to payout/sessionWager semantics if the baseline is missing.
        const netPnL =
          startChips !== undefined
            ? finalChips - startChips
            : (payout >= 0 ? (payout + interimPayout - sessionWager) : (payout + interimPayout));
        console.log('[useTerminalGame] PnL Calc:', { payout, interimPayout, sessionWager, startChips, netPnL });

        // Generate descriptive result message using Net PnL
        const { summary: resultMessage, details } = generateGameResult(gameTypeRef.current, gameStateRef.current, netPnL);

        // Update stats including history and pnlByGame
        setStats(prev => {
          const currentGameType = gameTypeRef.current;
          const pnlEntry = { [currentGameType]: (prev.pnlByGame[currentGameType] || 0) + netPnL };
          // Format history: Summary line, then detail lines
          const newHistory = currentGameType === GameType.CRAPS ? [resultMessage] : [resultMessage, ...details];
          
          return {
            ...prev,
            chips: finalChips,
            // Decrement shields/doubles if they were used in this game
            shields: event.wasShielded ? prev.shields - 1 : prev.shields,
            doubles: event.wasDoubled ? prev.doubles - 1 : prev.doubles,
            // Add to history log
            history: [...prev.history, ...newHistory],
            pnlByGame: { ...prev.pnlByGame, ...pnlEntry },
            pnlHistory: [...prev.pnlHistory, (prev.pnlHistory[prev.pnlHistory.length - 1] || 0) + netPnL].slice(-MAX_GRAPH_POINTS),
          };
        });

        // Reset active modifiers since they were consumed
        if (event.wasShielded || event.wasDoubled) {
          setGameState(prev => ({
            ...prev,
            activeModifiers: { shield: false, double: false, super: false }
          }));
        }

        setGameState(prev => ({
          ...prev,
          stage: 'RESULT',
          message: resultMessage,
          lastResult: netPnL,
          sessionWager: 0,
          sessionInterimPayout: 0,
          rouletteIsPrison: false,
          casinoWarTieBet: 0 // Reset wager state for next round
        }));

        // Refresh progressive meters after completion (they can change due to the just-finished game).
        void (async () => {
          try {
            const client: any = clientRef.current;
            const house: any = await client?.getHouse?.();
            if (house) {
              setGameState(prev => ({
                ...prev,
                threeCardProgressiveJackpot: Number(house.threeCardProgressiveJackpot ?? prev.threeCardProgressiveJackpot),
                uthProgressiveJackpot: Number(house.uthProgressiveJackpot ?? prev.uthProgressiveJackpot),
              }));
            }
          } catch (e) {
            console.debug('[useTerminalGame] Failed to refresh house state after completion:', e);
          }
        })();

        // Clear session and pending flag
        currentSessionIdRef.current = null;
        setCurrentSessionId(null);
        isPendingRef.current = false;
        pendingMoveCountRef.current = 0;
        crapsPendingRollLogRef.current = null;
        sessionStartChipsRef.current.delete(eventSessionId);
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
          if (!isPlayerInBoard && myPublicKeyHex && isRegisteredRef.current) {
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

    // Surface on-chain errors in the play UI (otherwise we can hang on "WAITING FOR CHAIN...").
    const client: any = clientRef.current;
    const unsubError =
      client?.onEvent?.('CasinoError', (e: any) => {
        try {
          const message = (e?.message ?? 'UNKNOWN ERROR').toString();
          const sessionIdRaw = e?.sessionId ?? e?.session_id ?? null;
          const errorSessionId =
            sessionIdRaw === null || sessionIdRaw === undefined ? null : BigInt(sessionIdRaw);
          const current = currentSessionIdRef.current ? BigInt(currentSessionIdRef.current) : null;

          // If this error pertains to the current session, clear it so the user can retry.
          if (errorSessionId !== null && current !== null && errorSessionId === current) {
            currentSessionIdRef.current = null;
            setCurrentSessionId(null);
            isPendingRef.current = false;
            pendingMoveCountRef.current = 0;
            crapsPendingRollLogRef.current = null;
          }

          setGameState(prev => ({
            ...prev,
            message: message.toUpperCase().slice(0, 72),
          }));
        } finally {
          clearChainResponseTimeout();
          isPendingRef.current = false;
          pendingMoveCountRef.current = 0;
          crapsPendingRollLogRef.current = null;
        }
      }) ?? (() => {});

    return () => {
      unsubStarted();
      unsubMoved();
      unsubCompleted();
      unsubLeaderboard();
      unsubError();
      clearChainResponseTimeout();
    };
  }, [chainService, isOnChain]);

  // Blackjack auto-reveal: if we ever land in AwaitingReveal (e.g. restore from chain),
  // submit Reveal automatically instead of requiring a manual SPACE press.
  useEffect(() => {
    if (!isOnChain || !chainService || !currentSessionIdRef.current) return;
    if (gameState.type !== GameType.BLACKJACK) return;
    if (gameState.message !== 'REVEAL (SPACE)') return;
    if (isPendingRef.current) return;

    void (async () => {
      try {
        isPendingRef.current = true;
        setGameState(prev => {
          const next = { ...prev, message: 'REVEALING...' };
          gameStateRef.current = next;
          return next;
        });
        const result = await chainService.sendMove(
          currentSessionIdRef.current!,
          new Uint8Array([6]) // Move 6: Reveal
        );
        if (result.txHash) setLastTxSig(result.txHash);
      } catch (error) {
        console.error('[useTerminalGame] Blackjack auto-reveal failed:', error);
        isPendingRef.current = false;
        setGameState(prev => {
          const next = { ...prev, message: 'REVEAL FAILED (SPACE)' };
          gameStateRef.current = next;
          return next;
        });
      }
    })();
  }, [gameState.type, gameState.message, isOnChain, chainService]);

  // Helper to parse game state from event
  const parseGameState = (stateBlob: Uint8Array, gameType?: GameType) => {
    try {
      const view = new DataView(stateBlob.buffer, stateBlob.byteOffset, stateBlob.byteLength);
      const currentType = gameType ?? gameState.type;

      // Parse based on game type
      if (currentType === GameType.BLACKJACK) {
        if (stateBlob.length < 2) {
          console.error('[parseGameState] Blackjack state blob too short:', stateBlob.length);
          return;
        }

        const version = stateBlob[0];
        if (version !== 2) {
          console.error('[parseGameState] Unsupported blackjack state version:', version);
          return;
        }
        if (stateBlob.length < 14) {
          console.error('[parseGameState] Blackjack v2 state blob too short:', stateBlob.length);
          return;
        }

        let offset = 0;
        offset++; // version
        const bjStage = stateBlob[offset++]; // 0=Betting,1=PlayerTurn,2=AwaitingReveal,3=Complete
        const sideBet21p3 = Number(view.getBigUint64(offset, false));
        offset += 8;
        const initP1 = stateBlob[offset++];
        const initP2 = stateBlob[offset++];
        const activeHandIdx = stateBlob[offset++];
        const handCount = stateBlob[offset++];

	        const baseBet = gameStateRef.current?.bet || 100;
	        let pCards: Card[] = [];
	        const dCards: Card[] = [];
	        const pendingStack: { cards: Card[], bet: number, isDoubled: boolean }[] = [];
	        const finishedHands: CompletedHand[] = [];
	        let mainWagered = handCount === 0 ? baseBet : 0;

        const allHandsFinished = activeHandIdx >= handCount;

        for (let h = 0; h < handCount; h++) {
          const betMult = stateBlob[offset++];
          const status = stateBlob[offset++]; // 0=Play, 1=Stand, 2=Bust, 3=BJ
          offset++; // was_split (unused for display)
          const cLen = stateBlob[offset++];

          const handCards: Card[] = [];
          for (let i = 0; i < cLen; i++) {
            handCards.push(decodeCard(stateBlob[offset++]));
          }

          const isDoubled = betMult === 2;
	          const handBet = baseBet * betMult;
	          mainWagered += handBet;

          if (!allHandsFinished && h === activeHandIdx) {
            pCards = handCards;
          } else if (allHandsFinished && h === handCount - 1) {
            pCards = handCards;
          } else if (!allHandsFinished && h > activeHandIdx) {
            pendingStack.push({ cards: handCards, bet: handBet, isDoubled });
          } else {
            let msg = '';
            if (status === 2) msg = 'BUST';
            else if (status === 3) msg = 'BLACKJACK';
            else if (status === 1) msg = 'STAND';
            finishedHands.push({ cards: handCards, bet: handBet, isDoubled, message: msg });
          }
        }

        const dLen = stateBlob[offset++];
        for (let i = 0; i < dLen; i++) {
          dCards.push(decodeCard(stateBlob[offset++]));
        }

	        const isComplete = bjStage === 3;
	        const uiStage =
	          bjStage === 0 ? ('BETTING' as const) : isComplete ? ('RESULT' as const) : ('PLAYING' as const);

        let message = 'SPACE TO DEAL';
        if (bjStage === 1) message = 'Your move';
        else if (bjStage === 2) message = 'REVEAL (SPACE)';
        else if (bjStage === 3) message = 'GAME COMPLETE';

        const dealerCardsWithVisibility = dCards.map((card, i) => ({
          ...card,
          isHidden: !isComplete && i > 0,
        }));

	        const prevState = gameStateRef.current;
	        const totalWagered = mainWagered + sideBet21p3;
	        const newState = {
	          ...prevState,
          type: currentType,
          playerCards:
            bjStage === 0 || initP1 === 0xff || initP2 === 0xff
              ? []
              : pCards,
          dealerCards: bjStage === 0 ? [] : dealerCardsWithVisibility,
          blackjackStack: pendingStack,
	          completedHands: finishedHands,
	          blackjack21Plus3Bet: sideBet21p3,
	          sessionWager: totalWagered,
	          stage: uiStage,
	          message,
	        } as GameState;
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
          const cardsWithHolds =
            stage === 0
              ? cards.map((c, i) => ({
                  ...c,
                  isHeld: prev.playerCards?.[i]?.isHeld,
                }))
              : cards;
          const newState = {
            ...prev,
            type: currentType,
            playerCards: cardsWithHolds,
            stage: (stage === 1 ? 'RESULT' : 'PLAYING') as 'RESULT' | 'PLAYING',
            message: stage === 0 ? 'HOLD (1-5), DRAW (D)' : 'GAME COMPLETE',
          };
          // Also update ref inside for consistency
          gameStateRef.current = newState;
          return newState;
        });
      } else if (currentType === GameType.CASINO_WAR) {
        // v1: [version:u8=1] [stage:u8] [playerCard:u8] [dealerCard:u8] [tie_bet:u64 BE]
        // legacy: [playerCard:u8] [dealerCard:u8] [stage:u8]
        const looksLikeV1 = stateBlob.length >= 12 && stateBlob[0] === 1;

        if (looksLikeV1) {
          const stage = stateBlob[1];
          const playerCardByte = stateBlob[2];
          const dealerCardByte = stateBlob[3];
          const tieBet = Number(new DataView(stateBlob.buffer, stateBlob.byteOffset + 4, 8).getBigUint64(0, false));

          const playerCard = stage === 0 ? null : decodeCard(playerCardByte);
          const dealerCard = stage === 0 ? null : decodeCard(dealerCardByte);

          setGameState(prev => {
            const shouldRecordTieCredit =
              stage === 1 && tieBet > 0 && (prev.sessionInterimPayout || 0) === 0;
            const tieCredit = shouldRecordTieCredit ? tieBet * 11 : (prev.sessionInterimPayout || 0);

            const newState = {
              ...prev,
              type: currentType,
              playerCards: playerCard ? [playerCard] : [],
              dealerCards: dealerCard ? [dealerCard] : [],
              casinoWarTieBet: tieBet,
              sessionInterimPayout: stage === 0 ? 0 : tieCredit,
              stage: (stage === 0 ? 'BETTING' : 'PLAYING') as const,
              message:
                stage === 0
                  ? (tieBet > 0 ? `TIE BET $${tieBet} - SPACE TO DEAL` : 'TIE BET (T) - SPACE TO DEAL')
                  : stage === 1
                    ? 'WAR! GO TO WAR (W) / SURRENDER (S)'
                    : 'DEALT',
            };
            gameStateRef.current = newState;
            return newState;
          });
          return;
        }

        // Legacy fallback: [playerCard:u8] [dealerCard:u8] [stage:u8]
        if (stateBlob.length < 3) {
          console.error('[parseGameState] Casino War state blob too short:', stateBlob.length);
          return;
        }
        const playerCard = decodeCard(stateBlob[0]);
        const dealerCard = decodeCard(stateBlob[1]);
        const stage = stateBlob[2];

        setGameState(prev => {
          const newState = {
            ...prev,
            type: currentType,
            playerCards: [playerCard],
            dealerCards: [dealerCard],
            stage: 'PLAYING' as const,
            message: stage === 1 ? 'WAR! GO TO WAR (W) / SURRENDER (S)' : 'DEALT',
          };
          gameStateRef.current = newState;
          return newState;
        });
      } else if (currentType === GameType.CRAPS) {
        // v1:
        // [version:u8=1] [phase:u8] [main_point:u8] [d1:u8] [d2:u8] [made_points_mask:u8] [bet_count:u8] [bets...]
        // Each bet entry is 19 bytes:
        // [bet_type:u8] [target:u8] [status:u8] [amount:u64 BE] [odds_amount:u64 BE]
        //
        // Legacy (pre-version) state is also supported as a fallback:
        // [phase:u8] [main_point:u8] [d1:u8] [d2:u8] [bet_count:u8] [bets...]
        if (stateBlob.length < 5) {
          console.error('[parseGameState] Craps state blob too short:', stateBlob.length);
          return;
        }
        const looksLikeV2 = stateBlob[0] === 2 && stateBlob.length >= 8 && (stateBlob[1] === 0 || stateBlob[1] === 1);
        const looksLikeV1 = stateBlob[0] === 1 && stateBlob.length >= 7 && (stateBlob[1] === 0 || stateBlob[1] === 1);

        let d1: number;
        let d2: number;
        let mainPoint: number;
        let epochPointEstablished: boolean;
        let betCount: number;
        let betsOffset: number;

        if (looksLikeV2) {
          mainPoint = stateBlob[2];
          d1 = stateBlob[3];
          d2 = stateBlob[4];
          epochPointEstablished = stateBlob[6] === 1;
          betCount = stateBlob[7];
          betsOffset = 8;
        } else if (looksLikeV1) {
          mainPoint = stateBlob[2];
          d1 = stateBlob[3];
          d2 = stateBlob[4];
          const madePointsMask = stateBlob[5] ?? 0;
          epochPointEstablished = stateBlob[1] === 1 || mainPoint > 0 || madePointsMask !== 0;
          betCount = stateBlob[6];
          betsOffset = 7;
        } else {
          // Legacy fallback
          mainPoint = stateBlob[1];
          d1 = stateBlob[2];
          d2 = stateBlob[3];
          epochPointEstablished = stateBlob[0] === 1 || mainPoint > 0;
          betCount = stateBlob[4];
          betsOffset = 5;
        }

        const hasDice = d1 > 0 && d2 > 0;
        const dice = hasDice ? [d1, d2] : [];
        const total = hasDice ? d1 + d2 : 0;

        // Parse bets from state blob
        const BET_TYPE_REVERSE: Record<number, CrapsBet['type']> = {
          0: 'PASS', 1: 'DONT_PASS', 2: 'COME', 3: 'DONT_COME',
          4: 'FIELD', 5: 'YES', 6: 'NO', 7: 'NEXT',
          8: 'HARDWAY', 9: 'HARDWAY', 10: 'HARDWAY', 11: 'HARDWAY',
          12: 'FIRE',
          13: 'BUY',
          15: 'ATS_SMALL',
          16: 'ATS_TALL',
          17: 'ATS_ALL',
        };
        const parsedBets: CrapsBet[] = [];
        let offset = betsOffset;
        for (let i = 0; i < betCount && offset + 19 <= stateBlob.length; i++) {
          const betTypeVal = stateBlob[offset];
          const target = stateBlob[offset + 1];
          const statusVal = stateBlob[offset + 2];
          const amount = Number(view.getBigUint64(offset + 3, false));
          const oddsAmount = Number(view.getBigUint64(offset + 11, false));

          const betType = BET_TYPE_REVERSE[betTypeVal] || 'PASS';

          const isHardway = betTypeVal >= 8 && betTypeVal <= 11;
          const hardTarget = betTypeVal === 8 ? 4 : betTypeVal === 9 ? 6 : betTypeVal === 10 ? 8 : 10;

          const isAts = betTypeVal >= 15 && betTypeVal <= 17;
          const progressMask = isAts ? oddsAmount : undefined;

          parsedBets.push({
            type: betType,
            target: isHardway
              ? hardTarget
              : (target > 0 ? target : undefined),
            status: statusVal === 1 ? 'PENDING' : 'ON',
            amount,
            oddsAmount: (!isHardway && !isAts && oddsAmount > 0) ? oddsAmount : undefined,
            progressMask,
          });
          offset += 19;
        }

        // Update ref BEFORE setGameState to ensure CasinoGameCompleted handler has access to dice
        // (React 18's automatic batching defers the updater function execution)
        if (gameStateRef.current) {
          gameStateRef.current = {
            ...gameStateRef.current,
            dice,
            crapsPoint: mainPoint > 0 ? mainPoint : null,
            crapsEpochPointEstablished: epochPointEstablished,
          };
        }

        setGameState(prev => {
          // Only update history if dice actually changed (avoids duplicate entries from multiple events)
          const prevDice = prev.dice;
          const diceChanged =
            prevDice.length !== dice.length ||
            (dice.length === 2 && (prevDice[0] !== d1 || prevDice[1] !== d2));

          // Reset roll history only on seven-out (point was ON and a 7 was rolled), otherwise only add if dice changed
          let newHistory = prev.crapsRollHistory;
          if (hasDice && diceChanged) {
            const sevenOut = total === 7 && prev.crapsPoint !== null;
            newHistory = sevenOut ? [total] : [...prev.crapsRollHistory, total].slice(-MAX_GRAPH_POINTS);
          }

          // Preserve locally-staged bets (not yet submitted to chain) alongside on-chain bets.
          const localStagedBets = prev.crapsBets.filter((b) => b.local === true);
          const betKey = (b: CrapsBet) =>
            `${b.type}|${b.target ?? ''}|${b.status ?? ''}|${b.amount}|${b.oddsAmount ?? 0}|${b.progressMask ?? 0}`;
          const mergedBets: CrapsBet[] = [...parsedBets];
          const seen = new Set<string>(parsedBets.map(betKey));
          for (const bet of localStagedBets) {
            const key = betKey(bet);
            if (seen.has(key)) continue;
            seen.add(key);
            mergedBets.push(bet);
          }

          const newState = {
            ...prev,
            type: currentType,
            dice,
            crapsPoint: mainPoint > 0 ? mainPoint : null,
            crapsEpochPointEstablished: epochPointEstablished,
            crapsBets: mergedBets,
            crapsRollHistory: newHistory,
            stage: 'PLAYING' as const,
            // Only update message if dice changed, otherwise keep existing message (e.g. "ODDS +$X").
            // If there are bets on the table, don't show "PLACE BETS".
            message: hasDice
              ? (diceChanged ? `ROLLED ${total}` : prev.message)
              : (isPendingRef.current
                  ? prev.message
                  : (mergedBets.length > 0 ? 'BETS PLACED - SPACE TO ROLL' : 'PLACE BETS - SPACE TO ROLL')),
          };
          // Also update ref inside for consistency
          gameStateRef.current = newState;
          return newState;
        });
      } else if (currentType === GameType.ROULETTE) {
        // v2:
        // [bet_count:u8] [zero_rule:u8] [phase:u8] [totalWagered:u64 BE] [pendingReturn:u64 BE] [bets:10bytes×count] [result:u8]?
        // legacy:
        // [bet_count:u8] [bets:10bytes×count] [result:u8]?
        if (stateBlob.length < 1) {
          console.error('[parseGameState] Roulette state blob too short:', stateBlob.length);
          return;
        }

        const betCount = stateBlob[0];
        const betsSize = betCount * 10; // Each bet is 10 bytes
        const legacyResultOffset = 1 + betsSize;
        const v2HeaderLen = 19;
        const v2ResultOffset = v2HeaderLen + betsSize;

        const looksLikeV2 =
          stateBlob.length === v2HeaderLen + betsSize || stateBlob.length === v2HeaderLen + betsSize + 1;

        const zeroRuleByte = looksLikeV2 ? stateBlob[1] : 0;
        const phaseByte = looksLikeV2 ? stateBlob[2] : 0;
        const resultOffset = looksLikeV2 ? v2ResultOffset : legacyResultOffset;

        const zeroRule =
          zeroRuleByte === 1
            ? 'LA_PARTAGE'
            : zeroRuleByte === 2
              ? 'EN_PRISON'
              : zeroRuleByte === 3
                ? 'EN_PRISON_DOUBLE'
                : 'STANDARD';
        const rouletteIsPrison = phaseByte === 1;

        console.log('[parseGameState] Roulette: betCount=' + betCount + ', betsSize=' + betsSize + ', resultOffset=' + resultOffset + ', totalLen=' + stateBlob.length);

        // Check if we have a result (state length > bet section)
        if (stateBlob.length > resultOffset) {
          const result = stateBlob[resultOffset];
          console.log('[parseGameState] Roulette: result=' + result);
          
          // Update ref synchronously so CasinoGameCompleted handler has access to history
          if (gameStateRef.current) {
            gameStateRef.current = {
              ...gameStateRef.current,
              rouletteHistory: [...(gameStateRef.current.rouletteHistory || []), result].slice(-MAX_GRAPH_POINTS),
            };
          }

          setGameState(prev => ({
            ...prev,
            type: currentType,
            rouletteZeroRule: zeroRule,
            rouletteIsPrison,
            rouletteHistory: [...prev.rouletteHistory, result].slice(-MAX_GRAPH_POINTS),
            stage: rouletteIsPrison && result === 0 ? 'PLAYING' : 'RESULT',
            message: rouletteIsPrison && result === 0 ? 'EN PRISON - SPACE TO SPIN' : `LANDED ON ${result}`,
          }));
        } else {
          // Betting stage - no result yet
          console.log('[parseGameState] Roulette in BETTING stage (no result yet)');
          setGameState(prev => ({
            ...prev,
            type: currentType,
            rouletteZeroRule: zeroRule,
            rouletteIsPrison,
            stage: 'PLAYING',
            message: rouletteIsPrison ? 'EN PRISON - SPACE TO SPIN' : 'PLACE YOUR BETS',
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
          
          // Update ref synchronously so CasinoGameCompleted handler has access to dice
          if (gameStateRef.current) {
            gameStateRef.current = {
              ...gameStateRef.current,
              dice: dice,
              sicBoHistory: [...(gameStateRef.current.sicBoHistory || []), dice].slice(-MAX_GRAPH_POINTS),
            };
          }

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
        const version = stateBlob[0];
        if (version !== 1 && version !== 2 && version !== 3) {
          console.error('[parseGameState] Unsupported Three Card state version:', version);
          return;
        }

        // v3 (32 bytes):
        // [version:u8=3] [stage:u8] [p1..p3:u8] [d1..d3:u8] [pairplus:u64 BE] [sixcard:u64 BE] [progressive:u64 BE]
        // v2 (24 bytes):
        // [version:u8=2] [stage:u8] [p1..p3:u8] [d1..d3:u8] [pairplus:u64 BE] [sixcard:u64 BE]
        // v1 (16 bytes):
        // [version:u8=1] [stage:u8] [p1..p3:u8] [d1..d3:u8] [pairplus:u64 BE]
        const requiredLen = version === 3 ? 32 : version === 2 ? 24 : 16;
        if (stateBlob.length < requiredLen) {
          console.error('[parseGameState] Three Card state blob too short:', stateBlob.length);
          return;
        }

        const stageVal = stateBlob[1]; // 0=Betting, 1=Decision, 2=AwaitingReveal, 3=Complete
        const pairplusBet = Number(view.getBigUint64(8, false));
        const sixCardBonusBet = version >= 2 ? Number(view.getBigUint64(16, false)) : 0;
        const progressiveBet = version === 3 ? Number(view.getBigUint64(24, false)) : 0;

        const pBytes = [stateBlob[2], stateBlob[3], stateBlob[4]];
        const dBytes = [stateBlob[5], stateBlob[6], stateBlob[7]];

        const pCards: Card[] = stageVal === 0 ? [] : pBytes.map(decodeCard);
        const dCards: Card[] =
          stageVal === 0
            ? []
            : dBytes.map((b) => ({
                ...decodeCard(b),
                isHidden: stageVal !== 3,
              }));

        const uiStage =
          stageVal === 0 ? ('BETTING' as const) : stageVal === 3 ? ('RESULT' as const) : ('PLAYING' as const);

        let message = 'SPACE TO DEAL';
        if (stageVal === 0) message = 'PAIRPLUS (P), 6-CARD (6), PROG (J), SPACE TO DEAL';
        else if (stageVal === 1) message = 'PLAY (P) OR FOLD (F)';
        else if (stageVal === 2) message = 'REVEAL (SPACE)';
        else if (stageVal === 3) message = 'GAME COMPLETE';

        setGameState((prev) => {
          const newState = {
            ...prev,
            type: currentType,
            playerCards: pCards,
            dealerCards: dCards,
            threeCardPairPlusBet: pairplusBet,
            threeCardSixCardBonusBet: sixCardBonusBet,
            threeCardProgressiveBet: progressiveBet,
            stage: uiStage,
            message,
          };
          gameStateRef.current = newState;
          return newState;
        });
      } else if (currentType === GameType.ULTIMATE_HOLDEM) {
        const version = stateBlob[0];
        if (version !== 1 && version !== 2 && version !== 3) {
          console.error('[parseGameState] Unsupported Ultimate Holdem state version:', version);
          return;
        }

        // v3 (40 bytes):
        // [version:u8=3] [stage:u8] [p1..p2:u8] [c1..c5:u8] [d1..d2:u8] [play_mult:u8] [bonus1..bonus4:u8] [trips:u64 BE] [sixcard:u64 BE] [progressive:u64 BE]
        // v2 (32 bytes):
        // [version:u8=2] [stage:u8] [p1..p2:u8] [c1..c5:u8] [d1..d2:u8] [play_mult:u8] [bonus1..bonus4:u8] [trips:u64 BE] [sixcard:u64 BE]
        // v1 (20 bytes):
        // [version:u8=1] [stage:u8] [p1..p2:u8] [c1..c5:u8] [d1..d2:u8] [play_mult:u8] [trips:u64 BE]
        const requiredLen = version === 3 ? 40 : version === 2 ? 32 : 20;
        if (stateBlob.length < requiredLen) {
          console.error('[parseGameState] Ultimate Holdem state blob too short:', stateBlob.length);
          return;
        }

        const stageVal = stateBlob[1]; // 0=Betting,1=Preflop,2=Flop,3=River,4=AwaitingReveal,5=Showdown
        const pBytes = [stateBlob[2], stateBlob[3]];
        const cBytes = [stateBlob[4], stateBlob[5], stateBlob[6], stateBlob[7], stateBlob[8]];
        const dBytes = [stateBlob[9], stateBlob[10]];
        const playMult = stateBlob[11];
        const bonusBytes = version >= 2 ? [stateBlob[12], stateBlob[13], stateBlob[14], stateBlob[15]] : [0xff, 0xff, 0xff, 0xff];
        const tripsBet = Number(view.getBigUint64(version === 1 ? 12 : 16, false));
        const sixCardBonusBet = version >= 2 ? Number(view.getBigUint64(24, false)) : 0;
        const progressiveBet = version === 3 ? Number(view.getBigUint64(32, false)) : 0;

        const pCards: Card[] = pBytes[0] === 0xff ? [] : pBytes.map(decodeCard);

        const community: Card[] = [];
        for (const b of cBytes) {
          if (b !== 0xff) community.push(decodeCard(b));
        }

        const dealerVisible = stageVal === 5;
        const dCards: Card[] =
          stageVal === 0 || pCards.length === 0
            ? []
            : dBytes.map((b) => ({
                ...decodeCard(b),
                isHidden: !dealerVisible,
              }));

        const bonusVisible = stageVal === 5;
        const bonusCards: Card[] =
          version >= 2 && (sixCardBonusBet > 0 || bonusBytes.some((b) => b !== 0xff))
            ? bonusBytes.map((b) => ({
                ...decodeCard(b),
                isHidden: !bonusVisible,
              }))
            : [];

        const uiStage =
          stageVal === 0 ? ('BETTING' as const) : stageVal === 5 ? ('RESULT' as const) : ('PLAYING' as const);

        let message = 'SPACE TO DEAL';
        if (stageVal === 0) message = 'TRIPS (T), 6-CARD (6), PROG (J), SPACE TO DEAL';
        else if (stageVal === 1) message = 'CHECK (C) OR BET 3X/4X';
        else if (stageVal === 2) message = 'CHECK (C) OR BET 2X';
        else if (stageVal === 3) message = playMult > 0 ? 'REVEAL (SPACE)' : 'FOLD (F) OR BET 1X';
        else if (stageVal === 4) message = 'REVEAL (SPACE)';
        else if (stageVal === 5) message = 'GAME COMPLETE';

        setGameState((prev) => {
          const newState = {
            ...prev,
            type: currentType,
            playerCards: pCards,
            dealerCards: dCards,
            communityCards: community,
            uthTripsBet: tripsBet,
            uthSixCardBonusBet: sixCardBonusBet,
            uthProgressiveBet: progressiveBet,
            uthBonusCards: bonusCards,
            stage: uiStage,
            message,
          };
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
    // Unknown/unrevealed placeholder used by some on-chain state blobs.
    if (value === 0xff) {
      return { rank: 'A', suit: '♠', value: 0, isHidden: true };
    }
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
  // Keyed by public key when available (vault + safer), falls back to legacy private-key id.
  // Using lazy initialization to avoid calling on every render
  const hasRegisteredRef = useRef<boolean | null>(null);
  if (hasRegisteredRef.current === null) {
    const keyId = localStorage.getItem('casino_public_key_hex') ?? localStorage.getItem('casino_private_key');
    if (keyId) {
      hasRegisteredRef.current = localStorage.getItem(`casino_registered_${keyId}`) === 'true';
      console.log('[useTerminalGame] Loaded registration status from localStorage:', hasRegisteredRef.current, 'for key:', keyId.substring(0, 8) + '...');
    } else {
      console.log('[useTerminalGame] No key id in localStorage, assuming not registered');
      hasRegisteredRef.current = false;
    }
  }

  const startGame = async (type: GameType) => {
    // Clear pending flag when starting a new game - prevents stale flag from blocking auto-deal
    isPendingRef.current = false;
    pendingMoveCountRef.current = 0;
    crapsPendingRollLogRef.current = null;
    autoPlayPlanRef.current = null;
    if (autoPlayDraftRef.current && autoPlayDraftRef.current.type !== type) {
      autoPlayDraftRef.current = null;
    }

    const isTableGame = [GameType.BACCARAT, GameType.CRAPS, GameType.ROULETTE, GameType.SIC_BO].includes(type);

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
	      crapsEpochPointEstablished: false,
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
      rouletteZeroRule: prev.rouletteZeroRule,
      rouletteIsPrison: false,
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
      activeModifiers: { shield: false, double: false, super: false },
      baccaratSelection: prev.baccaratSelection, // Preserve selection from previous game
      insuranceBet: 0,
      blackjackStack: [],
      completedHands: [],
      blackjack21Plus3Bet: 0,
      threeCardPairPlusBet: 0,
      threeCardSixCardBonusBet: 0,
      threeCardProgressiveBet: 0,
      threeCardProgressiveJackpot: prev.threeCardProgressiveJackpot,
      uthTripsBet: 0,
      uthSixCardBonusBet: 0,
      uthProgressiveBet: 0,
      uthProgressiveJackpot: prev.uthProgressiveJackpot,
      uthBonusCards: [],
      casinoWarTieBet: 0,
      hiloAccumulator: 0,
      hiloGraphData: [],
      // Preserve staged table-game wagers if we're restarting the same table game (e.g. CRAPS after a completed session).
      sessionWager: isTableGame && prev.type === type ? prev.sessionWager : 0,
      sessionInterimPayout: 0,
      superMode: null
    }));
    setAiAdvice(null);

    // If on-chain mode is enabled, submit transaction
    if (isOnChain && chainService) {
      try {
        // Guard: if the executor isn't producing blocks, we won't receive CasinoGameStarted.
        const chainOk = await ensureChainResponsive();
        if (!chainOk) {
          clearChainResponseTimeout();
          setGameState(prev => ({
            ...prev,
            stage: 'BETTING',
            message: 'CHAIN OFFLINE — START nullspace-simulator + dev-executor',
          }));
          return;
        }

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
	              const keyId =
	                localStorage.getItem('casino_public_key_hex') ?? localStorage.getItem('casino_private_key');
	              if (keyId) {
	                localStorage.setItem(`casino_registered_${keyId}`, 'true');
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
                auraMeter: existingPlayer.auraMeter ?? prev.auraMeter ?? 0,
              }));

              if (!shouldUpdateBalance) {
                console.log('[useTerminalGame] Skipped balance update from registration polling (within cooldown)');
              }
	            } else {
	              // Player doesn't exist on-chain - clear stale localStorage flag
	              console.log('[useTerminalGame] Player NOT found on-chain, clearing stale registration flag');
	              hasRegisteredRef.current = false;
	              const keyId =
	                localStorage.getItem('casino_public_key_hex') ?? localStorage.getItem('casino_private_key');
	              if (keyId) {
	                localStorage.removeItem(`casino_registered_${keyId}`);
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
	          const keyId =
	            localStorage.getItem('casino_public_key_hex') ?? localStorage.getItem('casino_private_key');
	          if (keyId) {
	            localStorage.setItem(`casino_registered_${keyId}`, 'true');
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
                  auraMeter: playerState.auraMeter ?? prev.auraMeter ?? 0,
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
        sessionStartChipsRef.current.set(sessionId, currentChipsRef.current);

        const autoDraft = autoPlayDraftRef.current;
        if (autoDraft && autoDraft.type === type) {
          autoPlayPlanRef.current = { ...autoDraft, sessionId };
          autoPlayDraftRef.current = null;
        }

        // For table games (Baccarat, Craps, Roulette, Sic Bo), actual bets are placed via moves.
        // These games should start with an initial bet of 0 so we don't charge an extra "entry fee".
        const isTableGame = [GameType.BACCARAT, GameType.CRAPS, GameType.ROULETTE, GameType.SIC_BO].includes(type);
        const initialBetAmount = isTableGame ? 0n : BigInt(gameState.bet);

        // Now submit the transaction - WebSocket events can be matched immediately
        const result = await chainService.startGameWithSessionId(chainGameType, initialBetAmount, sessionId);
        if (result.txHash) setLastTxSig(result.txHash);

        // State will update when CasinoGameStarted event arrives
        setGameState(prev => ({
          ...prev,
          message: "WAITING FOR CHAIN...",
          // For table games, wagers are tracked as bets are staged in the UI. Don't overwrite.
          sessionWager: isTableGame
            ? prev.sessionWager
            : type === GameType.ULTIMATE_HOLDEM
              ? Number(initialBetAmount) * 2
              : Number(initialBetAmount)
        }));
        armChainResponseTimeout('START GAME', sessionId);
      } catch (error) {
        console.error('[useTerminalGame] Failed to start game on-chain:', error);
        clearChainResponseTimeout();

        // Clear the session ID we pre-stored since the transaction failed
        if (currentSessionIdRef.current) {
          sessionStartChipsRef.current.delete(currentSessionIdRef.current);
        }
        currentSessionIdRef.current = null;
        gameTypeRef.current = GameType.NONE;
        setCurrentSessionId(null);
        autoPlayPlanRef.current = null;
        autoPlayDraftRef.current = null;

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
    // For on-chain games where the base bet is already locked-in at session start,
    // disallow changing bet size mid-session (even if the game UI stage is "BETTING").
    const baseBetLocked =
      isOnChain &&
      !!currentSessionIdRef.current &&
      [GameType.BLACKJACK, GameType.THREE_CARD, GameType.ULTIMATE_HOLDEM].includes(gameState.type);
    if (baseBetLocked) {
      setGameState(prev => ({ ...prev, message: "BET LOCKED (START NEW GAME)" }));
      return;
    }

    // Allow bet changes during BETTING, or during PLAYING for table games
    const isTableGame = [GameType.BACCARAT, GameType.CRAPS, GameType.ROULETTE, GameType.SIC_BO].includes(gameState.type);
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

  const toggleSuper = async () => {
    // Super mode is session-scoped on-chain; allow toggling during BETTING.
    if (tournamentTime < 60 && phase === 'ACTIVE') {
      setGameState(prev => ({ ...prev, message: "LOCKED (FINAL MINUTE)" }));
      return;
    }

    const current = Boolean(gameState.activeModifiers.super);
    const next = !current;

    // Optimistic update
    setGameState(prev => ({ ...prev, activeModifiers: { ...prev.activeModifiers, super: next } }));

    // Submit to chain if enabled
    if (isOnChain && chainService) {
      try {
        const result = await chainService.toggleSuper();
        if (result.txHash) setLastTxSig(result.txHash);
      } catch (error) {
        console.error('[useTerminalGame] Failed to toggle super:', error);
        // Rollback on failure
        setGameState(prev => ({ ...prev, activeModifiers: { ...prev.activeModifiers, super: current } }));
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
   * 7 = Total of N (various payouts) - number = 3-18
   * 8 = Single number appears (1:1 to 3:1) - number = 1-6
   * 9 = Domino (two faces) (5:1) - number = (min<<4)|max
   * 10 = Three-Number Easy Hop (30:1) - number = 6-bit mask (exactly 3 bits set)
   * 11 = Three-Number Hard Hop (50:1) - number = (double<<4)|single
   * 12 = Four-Number Easy Hop (7:1) - number = 6-bit mask (exactly 4 bits set)
   */
  const serializeSicBoBet = (bet: SicBoBet): Uint8Array => {
    // Map frontend bet type to backend bet type
	    const betTypeMap: Record<SicBoBet['type'], number> = {
	      'SMALL': 0,
	      'BIG': 1,
	      'ODD': 2,
	      'EVEN': 3,
	      'TRIPLE_ANY': 5,
	      'TRIPLE_SPECIFIC': 4,
	      'DOUBLE_SPECIFIC': 6,
	      'SUM': 7,
      'SINGLE_DIE': 8,
      'DOMINO': 9,
      'HOP3_EASY': 10,
      'HOP3_HARD': 11,
      'HOP4_EASY': 12,
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
	              message: "Your move"
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
	      setGameState(prev => ({ ...prev, playerCards: newHand, message: "Your move" }));
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
	            message: "Your move"
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
	            message: "Your move"
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
          if (dVal === 21 && dealerHand.length === 2) { totalWin += gameState.insuranceBet * 3; logs.push(`Insurance WIN (+$${gameState.insuranceBet * 2})`); }
          else { totalWin -= gameState.insuranceBet; logs.push(`Insurance LOSS (-$${gameState.insuranceBet})`); }
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
          
          const handName = hands.length > 1 ? `Hand ${idx+1}` : 'Hand';
          if (win > 0) logs.push(`${handName} WIN (+$${win})`);
          else if (win < 0) logs.push(`${handName} LOSS (-$${Math.abs(win)})`);
          else logs.push(`${handName} PUSH`);
      });
      let finalWin = totalWin;
      let summarySuffix = "";
      if (finalWin < 0 && gameState.activeModifiers.shield) { finalWin = 0; summarySuffix = " [SHIELD SAVED]"; }
      if (finalWin > 0 && gameState.activeModifiers.double) { finalWin *= 2; summarySuffix = " [DOUBLE BONUS]"; }

      const summary = `${finalWin >= 0 ? 'WON' : 'LOST'} ${Math.abs(finalWin)}${summarySuffix}`;

      const pnlEntry = { [GameType.BLACKJACK]: (stats.pnlByGame[GameType.BLACKJACK] || 0) + finalWin };
      setStats(prev => ({
        ...prev,
        history: [...prev.history, summary, ...logs],
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

  const bjToggle21Plus3 = async () => {
    if (gameState.type !== GameType.BLACKJACK) return;

    const prevAmount = gameState.blackjack21Plus3Bet || 0;
    const nextAmount = prevAmount > 0 ? 0 : gameState.bet;
    const delta = nextAmount - prevAmount;

    // Local mode: track UI state only (local blackjack engine does not implement 21+3).
    if (!isOnChain || !chainService || !currentSessionIdRef.current) {
      setGameState(prev => ({
        ...prev,
        blackjack21Plus3Bet: nextAmount,
        message: nextAmount > 0 ? `21+3 +$${nextAmount}` : '21+3 OFF',
      }));
      return;
    }

    // On-chain: only allow before Deal.
    if (gameState.stage !== 'BETTING') {
      setGameState(prev => ({ ...prev, message: '21+3 CLOSED' }));
      return;
    }

    if (isPendingRef.current) return;
    if (nextAmount > 0 && stats.chips < nextAmount) {
      setGameState(prev => ({ ...prev, message: 'INSUFFICIENT FUNDS' }));
      return;
    }

    isPendingRef.current = true;
    setGameState(prev => ({
      ...prev,
      blackjack21Plus3Bet: nextAmount,
      sessionWager: prev.sessionWager + delta,
      message: nextAmount > 0 ? `21+3 +$${nextAmount}` : '21+3 OFF',
    }));

    try {
      const payload = new Uint8Array(9);
      payload[0] = 5; // Move 5: Set 21+3 bet
      new DataView(payload.buffer).setBigUint64(1, BigInt(nextAmount), false);

      const result = await chainService.sendMove(currentSessionIdRef.current, payload);
      if (result.txHash) setLastTxSig(result.txHash);
      // NOTE: Do NOT clear isPendingRef here - wait for CasinoGameMoved event
    } catch (error) {
      console.error('[useTerminalGame] 21+3 update failed:', error);
      isPendingRef.current = false;
      setGameState(prev => ({
        ...prev,
        blackjack21Plus3Bet: prevAmount,
        sessionWager: prev.sessionWager - delta,
        message: '21+3 FAILED',
      }));
    }
  };

  // DEAL HANDLER
  const deal = async () => {
    if (gameState.type === GameType.NONE) return;

	    // If we're still waiting for the session to exist on-chain (CasinoGameStarted),
	    // queue a one-shot auto-play so a single SPACE can start + play.
	    if (isOnChain && awaitingChainResponseRef.current) {
	      const sessionId = currentSessionIdRef.current;
	      if (!sessionId) return;
	      if (autoPlayPlanRef.current) return;

	      const makeCrapsRebetDraft = (): AutoPlayDraft | null => {
	        const stagedLocalBets = gameState.crapsBets.filter(b => b.local === true);
	        if (stagedLocalBets.length > 0) return { type: GameType.CRAPS, crapsBets: stagedLocalBets };
	        const fallback = gameState.crapsLastRoundBets
	          .filter(b => b.type !== 'COME' && b.type !== 'DONT_COME')
	          .map(b => ({ ...b, oddsAmount: undefined, progressMask: undefined, status: 'ON' as const, local: true }));
	        if (fallback.length === 0) return null;
	        return { type: GameType.CRAPS, crapsBets: fallback };
	      };

	      let draft: AutoPlayDraft | null = null;
	      if (gameState.type === GameType.BACCARAT) {
	        draft = {
	          type: GameType.BACCARAT,
	          baccaratSelection: gameState.baccaratSelection,
	          baccaratSideBets: gameState.baccaratBets,
	          mainBetAmount: gameState.bet,
	        };
	      } else if (gameState.type === GameType.ROULETTE) {
	        if (!gameState.rouletteIsPrison) {
	          const betsToSpin = gameState.rouletteBets.length > 0 ? gameState.rouletteBets : gameState.rouletteLastRoundBets;
	          if (betsToSpin.length > 0) {
	            draft = { type: GameType.ROULETTE, rouletteBets: betsToSpin, rouletteZeroRule: gameState.rouletteZeroRule };
	          }
	        }
	      } else if (gameState.type === GameType.SIC_BO) {
	        const betsToRoll = gameState.sicBoBets.length > 0 ? gameState.sicBoBets : gameState.sicBoLastRoundBets;
	        if (betsToRoll.length > 0) {
	          draft = { type: GameType.SIC_BO, sicBoBets: betsToRoll };
	        }
	      } else if (gameState.type === GameType.CRAPS) {
	        draft = makeCrapsRebetDraft();
	      }

	      if (draft) {
	        autoPlayPlanRef.current = { ...draft, sessionId };
	      }
	      return;
	    }

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

          pendingMoveCountRef.current = betsToPlace.length + 1;
          setGameState(prev => ({
            ...prev,
            baccaratLastRoundBets: gameState.baccaratBets,
            baccaratUndoStack: [],
            sessionWager: betsToPlace.reduce((s, b) => s + b.amount, 0),
            message: 'PLACING BETS...',
          }));

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
          pendingMoveCountRef.current = 0;
          return;
        }
      }

      // Casino War (v1): betting stage -> deal + compare.
      // Legacy fallback: stage PLAYING + message 'DEALT' -> compare.
      if (
        gameState.type === GameType.CASINO_WAR
        && (gameState.stage === 'BETTING' || (gameState.stage === 'PLAYING' && gameState.message === 'DEALT'))
      ) {
        // Guard against duplicate submissions
        if (isPendingRef.current) {
          console.log('[useTerminalGame] Casino War deal blocked - transaction pending');
          return;
        }

        isPendingRef.current = true;
        try {
          const payload = new Uint8Array([0]); // Deal + compare
          const result = await chainService.sendMove(sessionId, payload);
          if (result.txHash) setLastTxSig(result.txHash);
          setGameState(prev => ({ ...prev, message: 'DEALING...' }));
          // NOTE: Do NOT clear isPendingRef here - wait for CasinoGameMoved event
          return;
        } catch (error) {
          console.error('[useTerminalGame] Casino War deal failed:', error);
          setGameState(prev => ({ ...prev, message: 'DEAL FAILED' }));
          // Only clear isPending on error, not on success
          isPendingRef.current = false;
          return;
        }
      }

      // Blackjack: explicit Deal and Reveal moves (new staged protocol)
      if (gameState.type === GameType.BLACKJACK) {
        if (isPendingRef.current) {
          console.log('[useTerminalGame] Blackjack deal/reveal blocked - transaction pending');
          return;
        }

        // Betting stage: send Deal
        if (gameState.stage === 'BETTING') {
          isPendingRef.current = true;
          try {
            setGameState(prev => ({ ...prev, message: 'DEALING...' }));
            const result = await chainService.sendMove(sessionId, new Uint8Array([4])); // Move 4: Deal
            if (result.txHash) setLastTxSig(result.txHash);
            return;
          } catch (error) {
            console.error('[useTerminalGame] Blackjack Deal failed:', error);
            setGameState(prev => ({ ...prev, message: 'DEAL FAILED' }));
            isPendingRef.current = false;
            return;
          }
        }

        // AwaitingReveal stage: send Reveal
        if (gameState.message.includes('REVEAL')) {
          isPendingRef.current = true;
          try {
            setGameState(prev => ({ ...prev, message: 'REVEALING...' }));
            const result = await chainService.sendMove(sessionId, new Uint8Array([6])); // Move 6: Reveal
            if (result.txHash) setLastTxSig(result.txHash);
            return;
          } catch (error) {
            console.error('[useTerminalGame] Blackjack Reveal failed:', error);
            setGameState(prev => ({ ...prev, message: 'REVEAL FAILED' }));
            isPendingRef.current = false;
            return;
          }
        }
      }

      // Three Card Poker: staged Deal/Reveal protocol
      if (gameState.type === GameType.THREE_CARD) {
        if (isPendingRef.current) {
          console.log('[useTerminalGame] Three Card deal/reveal blocked - transaction pending');
          return;
        }

        if (gameState.stage === 'BETTING') {
          isPendingRef.current = true;
          try {
            setGameState(prev => ({ ...prev, message: 'DEALING...' }));
            const result = await chainService.sendMove(sessionId, new Uint8Array([2])); // Move 2: Deal
            if (result.txHash) setLastTxSig(result.txHash);
            return;
          } catch (error) {
            console.error('[useTerminalGame] Three Card Deal failed:', error);
            setGameState(prev => ({ ...prev, message: 'DEAL FAILED' }));
            isPendingRef.current = false;
            return;
          }
        }

        if (gameState.message.includes('REVEAL')) {
          isPendingRef.current = true;
          try {
            setGameState(prev => ({ ...prev, message: 'REVEALING...' }));
            const result = await chainService.sendMove(sessionId, new Uint8Array([4])); // Move 4: Reveal
            if (result.txHash) setLastTxSig(result.txHash);
            return;
          } catch (error) {
            console.error('[useTerminalGame] Three Card Reveal failed:', error);
            setGameState(prev => ({ ...prev, message: 'REVEAL FAILED' }));
            isPendingRef.current = false;
            return;
          }
        }
      }

      // Ultimate Hold'em: staged Deal/Reveal protocol
      if (gameState.type === GameType.ULTIMATE_HOLDEM) {
        if (isPendingRef.current) {
          console.log('[useTerminalGame] Ultimate Holdem deal/reveal blocked - transaction pending');
          return;
        }

        if (gameState.stage === 'BETTING') {
          isPendingRef.current = true;
          try {
            setGameState(prev => ({ ...prev, message: 'DEALING...' }));
            const result = await chainService.sendMove(sessionId, new Uint8Array([5])); // Action 5: Deal
            if (result.txHash) setLastTxSig(result.txHash);
            return;
          } catch (error) {
            console.error('[useTerminalGame] Ultimate Holdem Deal failed:', error);
            setGameState(prev => ({ ...prev, message: 'DEAL FAILED' }));
            isPendingRef.current = false;
            return;
          }
        }

        if (gameState.message.includes('REVEAL')) {
          isPendingRef.current = true;
          try {
            setGameState(prev => ({ ...prev, message: 'REVEALING...' }));
            const result = await chainService.sendMove(sessionId, new Uint8Array([7])); // Action 7: Reveal
            if (result.txHash) setLastTxSig(result.txHash);
            return;
          } catch (error) {
            console.error('[useTerminalGame] Ultimate Holdem Reveal failed:', error);
            setGameState(prev => ({ ...prev, message: 'REVEAL FAILED' }));
            isPendingRef.current = false;
            return;
          }
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
      if (gameState.type === GameType.BACCARAT) {
        autoPlayDraftRef.current = {
          type: GameType.BACCARAT,
          baccaratSelection: gameState.baccaratSelection,
          baccaratSideBets: gameState.baccaratBets,
          mainBetAmount: gameState.bet,
        };
      }
      startGame(gameState.type);
      return;
    }

    // If on-chain mode with active session, wait for chain events
    if (isOnChain && chainService && currentSessionIdRef.current) {
      // If we missed WS events (or the chain restarted), reconcile the session before we "wait" forever.
      try {
        const client: any = clientRef.current;
        const sessionId = currentSessionIdRef.current;
        if (client && sessionId !== null) {
          const sessionState = await client.getCasinoSession(sessionId);
          if (!sessionState || sessionState.isComplete) {
            currentSessionIdRef.current = null;
            setCurrentSessionId(null);
            isPendingRef.current = false;
            await startGame(gameState.type);
            return;
          }
          const frontendGameType =
            CHAIN_TO_FRONTEND_GAME_TYPE[sessionState.gameType as ChainGameType] ?? gameTypeRef.current;
          gameTypeRef.current = frontendGameType;
          parseGameState(sessionState.stateBlob, frontendGameType);
          isPendingRef.current = false;
          return;
        }
      } catch {
        // ignore
      }
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
	             let msg = "Your move";
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
        const results: string[] = [];

        // Main bet resolution
        let mainWin = 0;
        if (winner === 'TIE') {
            results.push(`${gameState.baccaratSelection} PUSH`);
        } else if (winner === gameState.baccaratSelection) {
            mainWin = gameState.bet;
            totalWin += mainWin;
            results.push(`${gameState.baccaratSelection} WIN (+$${mainWin})`);
        } else {
            totalWin -= gameState.bet;
            results.push(`${gameState.baccaratSelection} LOSS (-$${gameState.bet})`);
        }
        
        // Side bets resolution
        gameState.baccaratBets.forEach(b => {
             let win = 0;
             if (b.type === 'TIE' && winner === 'TIE') win = b.amount * 8;
             else if (b.type === 'P_PAIR' && p1.rank === p2.rank) win = b.amount * 11;
             else if (b.type === 'B_PAIR' && b1.rank === b2.rank) win = b.amount * 11;
             
             if (win > 0) {
                 totalWin += win;
                 results.push(`${b.type} WIN (+$${win})`);
             } else {
                 totalWin -= b.amount;
                 results.push(`${b.type} LOSS (-$${b.amount})`);
             }
        });
        
        const scoreDisplay = winner === 'TIE' ? `${pVal}-${bVal}` : winner === 'PLAYER' ? `${pVal}-${bVal}` : `${bVal}-${pVal}`;
        const summary = `${winner} wins ${scoreDisplay}. ${totalWin >= 0 ? '+' : '-'}$${Math.abs(totalWin)}`;

        setStats(prev => ({
            ...prev,
            chips: prev.chips + totalWin,
            history: [...prev.history, summary, ...results],
            pnlByGame: { ...prev.pnlByGame, [GameType.BACCARAT]: (prev.pnlByGame[GameType.BACCARAT] || 0) + totalWin },
            pnlHistory: [...prev.pnlHistory, (prev.pnlHistory[prev.pnlHistory.length - 1] || 0) + totalWin].slice(-MAX_GRAPH_POINTS)
        }));
        
        setGameState(prev => ({ ...prev, stage: 'RESULT', playerCards: [p1, p2], dealerCards: [b1, b2], baccaratLastRoundBets: prev.baccaratBets, baccaratUndoStack: [] }));
        setGameState(prev => ({ ...prev, message: `${winner} WINS`, lastResult: totalWin }));
    } else if (gameState.type === GameType.CASINO_WAR) {
        const p1 = newDeck.pop()!, d1 = newDeck.pop()!;
        let win = p1.value > d1.value ? gameState.bet : p1.value < d1.value ? -gameState.bet : 0;
        
        const summary = `${p1.rank} vs ${d1.rank}. ${win >= 0 ? '+' : '-'}$${Math.abs(win)}`;
        const details = [win > 0 ? `WIN (+$${win})` : win < 0 ? `LOSS (-$${Math.abs(win)})` : 'TIE'];

        setStats(prev => ({
            ...prev,
            chips: prev.chips + win,
            history: [...prev.history, summary, ...details],
            pnlByGame: { ...prev.pnlByGame, [GameType.CASINO_WAR]: (prev.pnlByGame[GameType.CASINO_WAR] || 0) + win },
            pnlHistory: [...prev.pnlHistory, (prev.pnlHistory[prev.pnlHistory.length - 1] || 0) + win].slice(-MAX_GRAPH_POINTS)
        }));

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
      cards[idx] = { ...cards[idx], isHeld: !cards[idx].isHeld };
      setGameState(prev => ({ ...prev, playerCards: cards }));
  };

  const drawVideoPoker = async () => {
      // Build hold mask: bit N = 1 if card N should be held.
      let holdMask = 0;
      gameState.playerCards.forEach((c, i) => {
        if (c.isHeld) holdMask |= (1 << i);
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
        if (c.isHeld) return { ...c, isHeld: false };
        const newCard = deck.pop();
        return newCard || c; // Fallback to original if deck empty
      });
      const { rank, multiplier } = evaluateVideoPokerHand(hand);
      const profit = (gameState.bet * multiplier) - gameState.bet;
      
      const summary = `${rank}. ${profit >= 0 ? '+' : '-'}$${Math.abs(profit)}`;
      const details = [profit > 0 ? `WIN (+$${profit})` : `LOSS (-$${Math.abs(profit)})`];

      setStats(prev => ({
          ...prev,
          chips: prev.chips + profit,
          history: [...prev.history, summary, ...details],
          pnlByGame: { ...prev.pnlByGame, [GameType.VIDEO_POKER]: (prev.pnlByGame[GameType.VIDEO_POKER] || 0) + profit },
          pnlHistory: [...prev.pnlHistory, (prev.pnlHistory[prev.pnlHistory.length - 1] || 0) + profit].slice(-MAX_GRAPH_POINTS)
      }));

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
      
      const summary = `Guess ${guess}: ${next.rank}${next.suit}.`;
      
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
          const pnl = -gameState.bet;
          const fullSummary = `${summary} -$${gameState.bet}`;
          const details = [`LOSS (-$${gameState.bet})`];
          
          setStats(prev => ({
              ...prev,
              chips: prev.chips + pnl,
              history: [...prev.history, fullSummary, ...details],
              pnlByGame: { ...prev.pnlByGame, [GameType.HILO]: (prev.pnlByGame[GameType.HILO] || 0) + pnl },
              pnlHistory: [...prev.pnlHistory, (prev.pnlHistory[prev.pnlHistory.length - 1] || 0) + pnl].slice(-MAX_GRAPH_POINTS)
          }));
          
          setGameState(prev => ({ ...prev, playerCards: [...prev.playerCards, next], hiloGraphData: [...prev.hiloGraphData, 0].slice(-MAX_GRAPH_POINTS), stage: 'RESULT' }));
          setGameState(prev => ({ ...prev, message: "WRONG", lastResult: pnl }));
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
      const summary = `CASHED OUT. +$${profit}`;
      const details = [`WIN (+$${profit})`];
      
      setStats(prev => ({
          ...prev,
          chips: prev.chips + profit,
          history: [...prev.history, summary, ...details],
          pnlByGame: { ...prev.pnlByGame, [GameType.HILO]: (prev.pnlByGame[GameType.HILO] || 0) + profit },
          pnlHistory: [...prev.pnlHistory, (prev.pnlHistory[prev.pnlHistory.length - 1] || 0) + profit].slice(-MAX_GRAPH_POINTS)
      }));
      
      setGameState(prev => ({ ...prev, message: "CASHED OUT", lastResult: profit }));
  };

  // --- ROULETTE / SIC BO / CRAPS / BACCARAT BETTING HELPERS ---
  const placeRouletteBet = (type: RouletteBet['type'], target?: number) => {
      if (gameState.rouletteIsPrison) {
          setGameState(prev => ({ ...prev, message: 'EN PRISON - NO NEW BETS' }));
          return;
      }
      if (stats.chips < gameState.bet) return;
      setGameState(prev => ({ 
          ...prev, 
          rouletteUndoStack: [...prev.rouletteUndoStack, prev.rouletteBets], 
          rouletteBets: [...prev.rouletteBets, { type, amount: prev.bet, target }], 
          message: `BET ${type}`, 
          rouletteInputMode: 'NONE',
          sessionWager: prev.sessionWager + prev.bet // Track wager
      }));
  };

  const cycleRouletteZeroRule = async () => {
      if (gameState.type !== GameType.ROULETTE) return;

      const nextRule =
        gameState.rouletteZeroRule === 'STANDARD'
          ? 'LA_PARTAGE'
          : gameState.rouletteZeroRule === 'LA_PARTAGE'
            ? 'EN_PRISON'
            : gameState.rouletteZeroRule === 'EN_PRISON'
              ? 'EN_PRISON_DOUBLE'
              : 'STANDARD';

      setGameState(prev => ({
          ...prev,
          rouletteZeroRule: nextRule,
          message: `ZERO RULE: ${nextRule.split('_').join(' ')}`,
      }));

      // If we already have an on-chain roulette session (before spinning), sync the rule immediately.
      if (isOnChain && chainService && currentSessionIdRef.current && !gameState.rouletteIsPrison) {
          if (isPendingRef.current) return;
          isPendingRef.current = true;
          try {
              const ruleByte =
                nextRule === 'LA_PARTAGE'
                  ? 1
                  : nextRule === 'EN_PRISON'
                    ? 2
                    : nextRule === 'EN_PRISON_DOUBLE'
                      ? 3
                      : 0;
              const payload = new Uint8Array([3, ruleByte]);
              const result = await chainService.sendMove(currentSessionIdRef.current, payload);
              if (result.txHash) setLastTxSig(result.txHash);
              // NOTE: Do NOT clear isPendingRef here - wait for CasinoGameMoved event
          } catch (e) {
              console.error('[useTerminalGame] Roulette rule update failed:', e);
              isPendingRef.current = false;
              setGameState(prev => ({ ...prev, message: 'RULE UPDATE FAILED' }));
          }
      }
  };
  const undoRouletteBet = () => {
      if (gameState.rouletteUndoStack.length === 0) return;
      setGameState(prev => ({ ...prev, rouletteBets: prev.rouletteUndoStack[prev.rouletteUndoStack.length-1], rouletteUndoStack: prev.rouletteUndoStack.slice(0, -1) }));
  };
	  const rebetRoulette = () => {
	      const totalRequired = gameState.rouletteLastRoundBets.reduce((a, b) => a + b.amount, 0);
	      if (gameState.rouletteLastRoundBets.length === 0 || stats.chips < totalRequired) return;
	      setGameState(prev => ({
	        ...prev,
	        rouletteUndoStack: [...prev.rouletteUndoStack, prev.rouletteBets],
	        rouletteBets: [...prev.rouletteBets, ...prev.rouletteLastRoundBets],
	        sessionWager: prev.sessionWager + totalRequired,
	        message: "REBET PLACED"
	      }));
	  };
  // Helper to serialize a single roulette bet to the format expected by the Rust backend
  // Payload format: [action:u8] [betType:u8] [number:u8] [amount:u64 BE]
  // Action 0 = Place bet, Action 1 = Spin wheel, Action 2 = Clear bets
  // Bet types: 0=Straight, 1=Red, 2=Black, 3=Even, 4=Odd, 5=Low, 6=High, 7=Dozen, 8=Column,
  // 9=SplitH, 10=SplitV, 11=Street, 12=Corner, 13=SixLine
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
      case 'SPLIT_H':
        payload[1] = 9; // BetType::SplitH
        payload[2] = bet.target ?? 0;
        break;
      case 'SPLIT_V':
        payload[1] = 10; // BetType::SplitV
        payload[2] = bet.target ?? 0;
        break;
      case 'STREET':
        payload[1] = 11; // BetType::Street
        payload[2] = bet.target ?? 0;
        break;
      case 'CORNER':
        payload[1] = 12; // BetType::Corner
        payload[2] = bet.target ?? 0;
        break;
      case 'SIX_LINE':
        payload[1] = 13; // BetType::SixLine
        payload[2] = bet.target ?? 0;
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
	      const shouldRebet = !gameState.rouletteIsPrison && gameState.rouletteBets.length === 0 && gameState.rouletteLastRoundBets.length > 0;
	      const betsToSpin = shouldRebet ? gameState.rouletteLastRoundBets : gameState.rouletteBets;

	      if (!gameState.rouletteIsPrison && betsToSpin.length === 0) {
	        setGameState(prev => ({ ...prev, message: "PLACE BET" }));
	        return;
	      }

	      // SPACE should rebet by default if we have a previous spin to reuse.
	      if (shouldRebet) {
	        const totalRequired = gameState.rouletteLastRoundBets.reduce((a, b) => a + b.amount, 0);
	        if (stats.chips < totalRequired) {
	          setGameState(prev => ({ ...prev, message: 'INSUFFICIENT FUNDS' }));
	          return;
	        }
	        setGameState(prev => ({
	          ...prev,
	          rouletteUndoStack: [...prev.rouletteUndoStack, prev.rouletteBets],
	          rouletteBets: [...gameState.rouletteLastRoundBets],
	          sessionWager: prev.sessionWager + totalRequired,
	          message: "REBET PLACED",
	        }));
	      }

	      // Prevent double-submits
	      if (isPendingRef.current) {
	        console.log('[useTerminalGame] spinRoulette - Already pending, ignoring');
        return;
      }

	      // If on-chain mode with no session, auto-start a new game
	      if (isOnChain && chainService && !currentSessionIdRef.current) {
	        if (gameState.rouletteIsPrison) {
	          setGameState(prev => ({ ...prev, message: 'PRISON - WAIT FOR SESSION' }));
	          return;
	        }
	        autoPlayDraftRef.current = {
	          type: GameType.ROULETTE,
	          rouletteBets: betsToSpin,
	          rouletteZeroRule: gameState.rouletteZeroRule,
	        };
	        console.log('[useTerminalGame] spinRoulette - No active session, starting new roulette game (auto-spin queued)');
	        setGameState(prev => ({ ...prev, message: 'STARTING NEW SESSION...' }));
	        startGame(GameType.ROULETTE);
	        return;
	      }

      // If on-chain mode, submit all bets then spin
      if (isOnChain && chainService && currentSessionIdRef.current) {
        try {
          isPendingRef.current = true;
          pendingMoveCountRef.current = gameState.rouletteIsPrison ? 1 : (1 + betsToSpin.length + 1);
          const ruleByte =
            gameState.rouletteZeroRule === 'LA_PARTAGE'
              ? 1
              : gameState.rouletteZeroRule === 'EN_PRISON'
                ? 2
                : gameState.rouletteZeroRule === 'EN_PRISON_DOUBLE'
                  ? 3
                  : 0;

          if (!gameState.rouletteIsPrison) {
            setGameState(prev => ({ ...prev, message: 'PLACING BETS...' }));

            // Set even-money-on-zero rule (action 3) before placing any bets.
            const rulePayload = new Uint8Array([3, ruleByte]);
            const ruleRes = await chainService.sendMove(currentSessionIdRef.current!, rulePayload);
            if (ruleRes.txHash) setLastTxSig(ruleRes.txHash);

            // Send all bets sequentially (action 0 for each bet)
            for (const bet of betsToSpin) {
              const betPayload = serializeRouletteBet(bet);
              const result = await chainService.sendMove(currentSessionIdRef.current!, betPayload);
              if (result.txHash) setLastTxSig(result.txHash);
            }
          }

          // Send spin command (action 1)
          setGameState(prev => ({ ...prev, message: 'SPINNING ON CHAIN...' }));
          const spinPayload = new Uint8Array([1]); // Action 1: Spin wheel
          const result = await chainService.sendMove(currentSessionIdRef.current, spinPayload);
          if (result.txHash) setLastTxSig(result.txHash);

          // Update UI (only clear local bets when we're submitting a fresh betting round).
          if (!gameState.rouletteIsPrison) {
            setGameState(prev => ({
              ...prev,
              rouletteLastRoundBets: prev.rouletteBets,
              rouletteBets: [],
              rouletteUndoStack: []
            }));
          }

          // Result will come via CasinoGameMoved/CasinoGameCompleted events
          // isPendingRef will be cleared in CasinoGameCompleted handler
          return;
        } catch (error) {
          console.error('[useTerminalGame] Roulette spin failed:', error);
          isPendingRef.current = false;
          pendingMoveCountRef.current = 0;
          setGameState(prev => ({ ...prev, message: 'SPIN FAILED - TRY AGAIN' }));
          return;
        }
      }

      // Local mode fallback (original logic)
      const num = Math.floor(Math.random() * 37);
      
	      const { pnl, results } = resolveRouletteBets(num, betsToSpin, gameState.rouletteZeroRule);
      
      // Update stats using new format
      const color = getRouletteColor(num);
      const summary = `${num} ${color}. ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl)}`;
      
      setStats(prev => ({ 
          ...prev, 
          chips: Math.max(0, prev.chips + pnl),
          history: [...prev.history, summary, ...results],
          pnlByGame: { ...prev.pnlByGame, [GameType.ROULETTE]: (prev.pnlByGame[GameType.ROULETTE] || 0) + pnl },
          pnlHistory: [...prev.pnlHistory, (prev.pnlHistory[prev.pnlHistory.length - 1] || 0) + pnl].slice(-MAX_GRAPH_POINTS)
      }));

	      setGameState(prev => ({ 
	          ...prev, 
	          rouletteHistory: [...prev.rouletteHistory, num].slice(-MAX_GRAPH_POINTS), 
	          rouletteLastRoundBets: betsToSpin, 
	          rouletteBets: [], 
	          rouletteUndoStack: [],
	          message: `SPUN ${num}`, 
	          lastResult: pnl 
	      }));
	  };

  const placeSicBoBet = (type: SicBoBet['type'], target?: number) => {
      if (stats.chips < gameState.bet) return;
      setGameState(prev => ({ 
          ...prev, 
          sicBoUndoStack: [...prev.sicBoUndoStack, prev.sicBoBets], 
          sicBoBets: [...prev.sicBoBets, { type, amount: prev.bet, target }], 
          message: `BET ${type}`, 
          sicBoInputMode: 'NONE',
          sessionWager: prev.sessionWager + prev.bet // Track wager
      }));
  };
  const undoSicBoBet = () => {
       if (gameState.sicBoUndoStack.length === 0) return;
       setGameState(prev => ({ ...prev, sicBoBets: prev.sicBoUndoStack[prev.sicBoUndoStack.length-1], sicBoUndoStack: prev.sicBoUndoStack.slice(0, -1) }));
  };
	  const rebetSicBo = () => {
	       const totalRequired = gameState.sicBoLastRoundBets.reduce((a, b) => a + b.amount, 0);
	       if (gameState.sicBoLastRoundBets.length === 0 || stats.chips < totalRequired) return;
	       setGameState(prev => ({
	         ...prev,
	         sicBoUndoStack: [...prev.sicBoUndoStack, prev.sicBoBets],
	         sicBoBets: [...prev.sicBoBets, ...prev.sicBoLastRoundBets],
	         sessionWager: prev.sessionWager + totalRequired,
	         message: "REBET"
	       }));
	  };
	  const rollSicBo = async () => {
	       const shouldRebet = gameState.sicBoBets.length === 0 && gameState.sicBoLastRoundBets.length > 0;
	       const betsToRoll = shouldRebet ? gameState.sicBoLastRoundBets : gameState.sicBoBets;

	       if (betsToRoll.length === 0) {
	         setGameState(prev => ({ ...prev, message: "PLACE BET" }));
	         return;
	       }

	       // SPACE should rebet by default if we have a previous roll to reuse.
	       if (shouldRebet) {
	         const totalRequired = gameState.sicBoLastRoundBets.reduce((a, b) => a + b.amount, 0);
	         if (stats.chips < totalRequired) {
	           setGameState(prev => ({ ...prev, message: 'INSUFFICIENT FUNDS' }));
	           return;
	         }
	         setGameState(prev => ({
	           ...prev,
	           sicBoUndoStack: [...prev.sicBoUndoStack, prev.sicBoBets],
	           sicBoBets: [...gameState.sicBoLastRoundBets],
	           sessionWager: prev.sessionWager + totalRequired,
	           message: 'REBET',
	         }));
	       }

	       // Prevent double-submits
	       if (isPendingRef.current) {
	         console.log('[useTerminalGame] rollSicBo - Already pending, ignoring');
         return;
       }

	       if (isOnChain && chainService && !currentSessionIdRef.current) {
	         autoPlayDraftRef.current = { type: GameType.SIC_BO, sicBoBets: betsToRoll };
	         console.log('[useTerminalGame] rollSicBo - No active session, starting new sic bo game (auto-roll queued)');
	         setGameState(prev => ({ ...prev, message: 'STARTING NEW SESSION...' }));
	         startGame(GameType.SIC_BO);
	         return;
	       }

       // If on-chain mode, submit all bets then roll
	       if (isOnChain && chainService && currentSessionIdRef.current) {
	         try {
	           isPendingRef.current = true;
	           pendingMoveCountRef.current = betsToRoll.length + 1;
	           setGameState(prev => ({ ...prev, message: 'PLACING BETS...' }));

	           // Send all bets sequentially (action 0 for each bet)
	           for (const bet of betsToRoll) {
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
	             sicBoLastRoundBets: betsToRoll,
	             sicBoBets: [],
	             sicBoUndoStack: []
	           }));

           // Result will come via CasinoGameMoved/CasinoGameCompleted events
           // isPendingRef will be cleared in CasinoGameCompleted handler
           return;
         } catch (error) {
           console.error('[useTerminalGame] Sic Bo roll failed:', error);
           isPendingRef.current = false;
           pendingMoveCountRef.current = 0;
           setGameState(prev => ({ ...prev, message: 'MOVE FAILED' }));
           return;
         }
       }

	       // Local mode fallback
	       const d = [rollDie(), rollDie(), rollDie()];
	       const { pnl, results } = resolveSicBoBets(d, betsToRoll);
       const total = d.reduce((a,b)=>a+b,0);
       const summary = `Rolled ${total} (${d.join('-')}). ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl)}`;

       setStats(prev => ({
           ...prev,
           chips: Math.max(0, prev.chips + pnl),
           history: [...prev.history, summary, ...results],
           pnlByGame: { ...prev.pnlByGame, [GameType.SIC_BO]: (prev.pnlByGame[GameType.SIC_BO] || 0) + pnl },
           pnlHistory: [...prev.pnlHistory, (prev.pnlHistory[prev.pnlHistory.length - 1] || 0) + pnl].slice(-MAX_GRAPH_POINTS)
       }));

	       setGameState(prev => ({ ...prev, dice: d, sicBoHistory: [...prev.sicBoHistory, d].slice(-MAX_GRAPH_POINTS), sicBoLastRoundBets: betsToRoll, sicBoBets: [], sicBoUndoStack: [] }));
	       setGameState(prev => ({ ...prev, message: `ROLLED ${total}`, lastResult: pnl }));
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
      'FIRE': 12,
      'BUY': 13,
      'ATS_SMALL': 15,
      'ATS_TALL': 16,
      'ATS_ALL': 17,
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
    // Some bet types encode their target in the bet type value (e.g., hardways).
    payload[2] = bet.type === 'HARDWAY' ? 0 : (bet.target ?? 0);

    // Amount as u64 big-endian (8 bytes)
    const amount = BigInt(bet.amount);
    const view = new DataView(payload.buffer);
    view.setBigUint64(3, amount, false); // false = big-endian

    return payload;
  };

  const crapsBuyCommission = (amount: number): number =>
    Math.floor((amount * 5 + 99) / 100); // 5% rounded up

  const crapsBetCost = (bet: CrapsBet): number =>
    bet.amount + (bet.oddsAmount || 0) + (bet.type === 'BUY' ? crapsBuyCommission(bet.amount) : 0);

  const totalCommittedCraps = () =>
    gameState.crapsBets.reduce((sum, b) => sum + crapsBetCost(b), 0);

  const placeCrapsBet = (type: CrapsBet['type'], target?: number) => {
      const committed = totalCommittedCraps();
      const betAmount = gameState.bet;
      const placementCost = type === 'BUY' ? betAmount + crapsBuyCommission(betAmount) : betAmount;

	      if (type === 'FIRE' && gameState.crapsRollHistory.length > 0) {
	          setGameState(prev => ({ ...prev, message: 'BET ONLY BEFORE FIRST ROLL' }));
	          return;
	      }

	      if (type === 'ATS_SMALL' || type === 'ATS_TALL' || type === 'ATS_ALL') {
	          const hasDice = gameState.dice.length === 2 && (gameState.dice[0] ?? 0) > 0 && (gameState.dice[1] ?? 0) > 0;
	          const lastTotal = hasDice ? (gameState.dice[0]! + gameState.dice[1]!) : null;
	          const canPlaceAts = !gameState.crapsEpochPointEstablished && (!hasDice || lastTotal === 7);
	          if (!canPlaceAts) {
	              setGameState(prev => ({ ...prev, message: 'ATS CLOSED' }));
	              return;
	          }
	      }

      if (type === 'FIRE' && gameState.crapsBets.some(b => b.type === 'FIRE' && b.local)) {
          setGameState(prev => ({ ...prev, message: 'FIRE BET ALREADY PLACED' }));
          return;
      }

      if (stats.chips - committed < placementCost) {
          setGameState(prev => ({ ...prev, message: 'INSUFFICIENT FUNDS' }));
          return;
      }
      let bets = [...gameState.crapsBets];
      if (type === 'PASS') bets = bets.filter(b => b.type !== 'DONT_PASS' || !b.local);
      if (type === 'DONT_PASS') bets = bets.filter(b => b.type !== 'PASS' || !b.local);
      setGameState(prev => ({ 
          ...prev, 
          crapsUndoStack: [...prev.crapsUndoStack, prev.crapsBets], 
          crapsBets: [...bets, { type, amount: prev.bet, target, status: (type==='COME'||type==='DONT_COME')?'PENDING':'ON', local: true }], 
          message: `BET ${type}`, 
          crapsInputMode: 'NONE',
          sessionWager: prev.sessionWager + placementCost // Track wager
      }));
  };
  const undoCrapsBet = () => {
       if (gameState.crapsUndoStack.length === 0) return;
       setGameState(prev => {
           const nextBets = prev.crapsUndoStack[prev.crapsUndoStack.length - 1];
           const localCost = (bets: CrapsBet[]) => bets.filter(b => b.local).reduce((s, b) => s + crapsBetCost(b), 0);
           const delta = localCost(nextBets) - localCost(prev.crapsBets);
           return {
               ...prev,
               crapsBets: nextBets,
               crapsUndoStack: prev.crapsUndoStack.slice(0, -1),
               sessionWager: prev.sessionWager + delta,
           };
       });
  };
  const rebetCraps = () => {
      if (gameState.crapsLastRoundBets.length === 0) {
          setGameState(prev => ({ ...prev, message: 'NO PREVIOUS BETS' }));
          return;
      }
      const totalRequired = gameState.crapsLastRoundBets.reduce((a, b) => a + crapsBetCost(b), 0);
      const committed = totalCommittedCraps();
      if (stats.chips < totalRequired + committed) {
          setGameState(prev => ({ ...prev, message: 'INSUFFICIENT FUNDS' }));
          return;
      }
      // Add last round bets as new local bets
      const rebets = gameState.crapsLastRoundBets.map(b => ({ ...b, local: true }));
      setGameState(prev => ({
          ...prev,
          crapsUndoStack: [...prev.crapsUndoStack, prev.crapsBets],
          crapsBets: [...prev.crapsBets, ...rebets],
          message: 'REBET PLACED',
          sessionWager: prev.sessionWager + totalRequired,
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
      // No odds on the come-out roll for Pass/Don't Pass
      if ((targetBet.type === 'PASS' || targetBet.type === 'DONT_PASS') && gameState.crapsPoint === null) {
          setGameState(prev => ({ ...prev, message: "WAIT FOR POINT BEFORE ODDS" }));
          return;
      }

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

      const committed = totalCommittedCraps();
      if (stats.chips - committed < oddsToAdd) {
          setGameState(prev => ({ ...prev, message: "INSUFFICIENT FUNDS" }));
          return;
      }

      // Update local state optimistically
      setGameState(prev => {
          const bets = [...prev.crapsBets];
          bets[idx] = { ...bets[idx], oddsAmount: currentOdds + oddsToAdd };
          return { 
              ...prev, 
              crapsBets: bets, 
              message: "ADDING ODDS...",
              sessionWager: prev.sessionWager + oddsToAdd // Track wager
          };
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
      if (mode === 'YES' || mode === 'NO' || mode === 'BUY') {
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
	       const hasSession = !!currentSessionIdRef.current;
	       const stagedLocalBets = gameState.crapsBets.filter(b => b.local === true);

	       const normalizeRebetBets = (bets: CrapsBet[]): CrapsBet[] =>
	         bets
	           .filter(b => b.type !== 'COME' && b.type !== 'DONT_COME')
	           .map(b => ({
	             type: b.type,
	             amount: b.amount,
	             target: b.target,
	             status: 'ON' as const,
	             local: true,
	           }));

	       // If the previous session completed and the UI cleared out bets, allow SPACE to "rebet" automatically.
	       const fallbackRebetBets =
	         stagedLocalBets.length > 0 ? [] : normalizeRebetBets(gameState.crapsLastRoundBets);

	       const betsToPlace = stagedLocalBets.length > 0 ? stagedLocalBets : (!hasSession ? fallbackRebetBets : []);

	       // Outstanding bets only exist if we already have an on-chain session.
	       const hasOutstandingBets = hasSession && (gameState.crapsBets.some(b => !b.local) || gameState.crapsPoint !== null);

	       if (betsToPlace.length === 0 && !hasOutstandingBets) {
	         setGameState(prev => ({ ...prev, message: gameState.crapsLastRoundBets.length > 0 ? 'REBET (T) OR PLACE BET' : 'PLACE BET FIRST' }));
	         return;
	       }
	       // If newBetsToPlace.length > 0, place those new bets
	       // If hasOutstandingBets but no new bets, just roll without placing more

	       // If on-chain mode with no session, auto-start a new game and auto-roll when it starts.
	       if (isOnChain && chainService && !hasSession) {
	         if (betsToPlace.length === 0) {
	           setGameState(prev => ({ ...prev, message: 'PLACE BET FIRST' }));
	           return;
	         }

	         // If we're pulling from last-round bets, stage them for UI clarity + correct PnL accounting.
	         if (stagedLocalBets.length === 0 && fallbackRebetBets.length > 0) {
	           const committed = totalCommittedCraps();
	           const totalRequired = fallbackRebetBets.reduce((a, b) => a + crapsBetCost(b), 0);
	           if (stats.chips < committed + totalRequired) {
	             setGameState(prev => ({ ...prev, message: 'INSUFFICIENT FUNDS' }));
	             return;
	           }
	           setGameState(prev => ({
	             ...prev,
	             crapsUndoStack: [...prev.crapsUndoStack, prev.crapsBets],
	             crapsBets: [...prev.crapsBets, ...fallbackRebetBets],
	             sessionWager: prev.sessionWager + totalRequired,
	             message: 'REBET PLACED',
	           }));
	         }

	         autoPlayDraftRef.current = { type: GameType.CRAPS, crapsBets: betsToPlace };
	         console.log('[useTerminalGame] rollCraps - No active session, starting new craps game (auto-roll queued)');
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
	         pendingMoveCountRef.current = betsToPlace.length + 1;
	         try {
	           if (betsToPlace.length > 0) {
	             setGameState(prev => ({ ...prev, message: 'PLACING BETS...' }));
	           } else {
	             setGameState(prev => ({ ...prev, message: 'ROLLING ON CHAIN...' }));
	           }

	           // Only place NEW bets that user explicitly added (not repeating previous bets)
	           for (const bet of betsToPlace) {
	             const betPayload = serializeCrapsBet(bet);
	             await chainService.sendMove(currentSessionIdRef.current, betPayload);
	           }

           // Then submit roll command: [2]
           // Snapshot pre-roll bets so we can log WIN/LOSS/PUSH even though the on-chain state removes resolved bets.
           crapsPendingRollLogRef.current = {
             sessionId: currentSessionIdRef.current,
             prevDice:
               gameState.dice.length === 2
                 ? [gameState.dice[0] ?? 0, gameState.dice[1] ?? 0]
                 : null,
             point: gameState.crapsPoint,
             bets: gameState.crapsBets.map(b => ({ ...b })),
           };
           const rollPayload = new Uint8Array([2]);
           const result = await chainService.sendMove(currentSessionIdRef.current, rollPayload);
           if (result.txHash) setLastTxSig(result.txHash);

	           setGameState(prev => ({
	             ...prev,
	             crapsLastRoundBets: betsToPlace.length > 0 ? betsToPlace : prev.crapsLastRoundBets,
	             crapsUndoStack: [],
	             message: 'ROLLING ON CHAIN...'
	           }));
	           return;
         // NOTE: Do NOT clear isPendingRef here - wait for CasinoGameMoved event
         } catch (error) {
           console.error('[useTerminalGame] Craps roll failed:', error);
           setGameState(prev => ({ ...prev, message: 'ROLL FAILED' }));
           // Only clear isPending on error, not on success
           isPendingRef.current = false;
           pendingMoveCountRef.current = 0;
           crapsPendingRollLogRef.current = null;
           return;
         }
       }

	       // Local mode fallback
       const d1=rollDie(), d2=rollDie(), total=d1+d2;
       
       // Calculate PnL and details
	       const { pnl, remainingBets, results } = resolveCrapsBets([d1, d2], gameState.crapsPoint, betsToPlace.length > 0 ? betsToPlace : stagedLocalBets); 
       // Note: In local mode we need to handle existing bets too if we wanted full fidelity, 
       // but current local logic focuses on new bets for simplicity or assumes bets stay? 
       // The original code passed `newBetsToPlace` to `calculateCrapsExposure`. 
       // Let's stick to that for consistency with original local behavior, 
       // but ideally we should track ALL active bets.
       // Given "newBetsToPlace" was used, we'll use that.
       
       const summary = `Rolled: ${total}. ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl)}`;

       // Update stats
      setStats(prev => ({
          ...prev,
          chips: Math.max(0, prev.chips + pnl),
          history: [...prev.history, summary, ...results],
          pnlByGame: { ...prev.pnlByGame, [GameType.CRAPS]: (prev.pnlByGame[GameType.CRAPS] || 0) + pnl },
          pnlHistory: [...prev.pnlHistory, (prev.pnlHistory[prev.pnlHistory.length - 1] || 0) + pnl].slice(-MAX_GRAPH_POINTS)
      }));

	       // Update point logic simplified
	       let newPoint = gameState.crapsPoint;
	       if (gameState.crapsPoint === null && [4,5,6,8,9,10].includes(total)) newPoint = total;
	       else if (gameState.crapsPoint === total || total === 7) newPoint = null;

	       const sevenOut = total === 7 && gameState.crapsPoint !== null;
	       // Reset roll history only on seven-out, otherwise keep building it.
	       const newHistory = sevenOut ? [total] : [...gameState.crapsRollHistory, total].slice(-MAX_GRAPH_POINTS);
	       let newEpochPointEstablished = gameState.crapsEpochPointEstablished;
	       if (sevenOut) newEpochPointEstablished = false;
	       else if (!newEpochPointEstablished && gameState.crapsPoint === null && [4, 5, 6, 8, 9, 10].includes(total)) {
	         newEpochPointEstablished = true;
	       }
		       setGameState(prev => ({
		         ...prev,
		         dice: [d1, d2],
		         crapsPoint: newPoint,
		         crapsEpochPointEstablished: newEpochPointEstablished,
		         crapsRollHistory: newHistory,
		         crapsLastRoundBets: betsToPlace.length > 0 ? betsToPlace : prev.crapsLastRoundBets,
		         crapsBets: remainingBets, // Keep unresolved bets
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
              const amountToRemove = gameState.baccaratBets[existingIndex].amount;
              const newBets = gameState.baccaratBets.filter((_, i) => i !== existingIndex);
              baccaratBetsRef.current = newBets;
              setGameState(prev => ({
                  ...prev,
                  baccaratUndoStack: [...prev.baccaratUndoStack, prev.baccaratBets],
                  baccaratBets: newBets,
                  sessionWager: prev.sessionWager - amountToRemove // Decrease wager
              }));
          } else {
              // Add the bet
              if (stats.chips < gameState.bet) return;
              const newBets = [...gameState.baccaratBets, { type, amount: gameState.bet }];
              baccaratBetsRef.current = newBets;
              setGameState(prev => ({
                  ...prev,
                  baccaratUndoStack: [...prev.baccaratUndoStack, prev.baccaratBets],
                  baccaratBets: newBets,
                  sessionWager: prev.sessionWager + prev.bet // Increase wager
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

  const threeCardTogglePairPlus = async () => {
      if (gameState.type !== GameType.THREE_CARD) return;

      const prevAmount = gameState.threeCardPairPlusBet || 0;
      const nextAmount = prevAmount > 0 ? 0 : gameState.bet;
      const delta = nextAmount - prevAmount;

      // Local mode: track UI state only (local 3-card engine doesn't implement Pairplus yet).
      if (!isOnChain || !chainService || !currentSessionIdRef.current) {
          setGameState(prev => ({
              ...prev,
              threeCardPairPlusBet: nextAmount,
              message: nextAmount > 0 ? `PAIRPLUS +$${nextAmount}` : 'PAIRPLUS OFF',
          }));
          return;
      }

      // On-chain: only allow before Deal.
      if (gameState.stage !== 'BETTING') {
          setGameState(prev => ({ ...prev, message: 'PAIRPLUS CLOSED' }));
          return;
      }

      if (isPendingRef.current) return;
      if (nextAmount > 0 && stats.chips < nextAmount) {
          setGameState(prev => ({ ...prev, message: 'INSUFFICIENT FUNDS' }));
          return;
      }

      isPendingRef.current = true;
      setGameState(prev => ({
          ...prev,
          threeCardPairPlusBet: nextAmount,
          sessionWager: prev.sessionWager + delta,
          message: nextAmount > 0 ? `PAIRPLUS +$${nextAmount}` : 'PAIRPLUS OFF',
      }));

      try {
          const payload = new Uint8Array(9);
          payload[0] = 3; // Move 3: Set Pairplus
          new DataView(payload.buffer).setBigUint64(1, BigInt(nextAmount), false);

          const result = await chainService.sendMove(currentSessionIdRef.current, payload);
          if (result.txHash) setLastTxSig(result.txHash);
          // NOTE: Do NOT clear isPendingRef here - wait for CasinoGameMoved event
      } catch (error) {
          console.error('[useTerminalGame] Pairplus update failed:', error);
          isPendingRef.current = false;
          setGameState(prev => ({
              ...prev,
              threeCardPairPlusBet: prevAmount,
              sessionWager: prev.sessionWager - delta,
              message: 'PAIRPLUS FAILED',
          }));
      }
  };

  const threeCardToggleSixCardBonus = async () => {
      if (gameState.type !== GameType.THREE_CARD) return;

      const prevAmount = gameState.threeCardSixCardBonusBet || 0;
      const nextAmount = prevAmount > 0 ? 0 : gameState.bet;
      const delta = nextAmount - prevAmount;

      // Local mode: track UI state only.
      if (!isOnChain || !chainService || !currentSessionIdRef.current) {
          setGameState(prev => ({
              ...prev,
              threeCardSixCardBonusBet: nextAmount,
              message: nextAmount > 0 ? `6-CARD +$${nextAmount}` : '6-CARD OFF',
          }));
          return;
      }

      // On-chain: only allow before Deal.
      if (gameState.stage !== 'BETTING') {
          setGameState(prev => ({ ...prev, message: '6-CARD CLOSED' }));
          return;
      }

      if (isPendingRef.current) return;
      if (nextAmount > 0 && stats.chips < nextAmount) {
          setGameState(prev => ({ ...prev, message: 'INSUFFICIENT FUNDS' }));
          return;
      }

      isPendingRef.current = true;
      setGameState(prev => ({
          ...prev,
          threeCardSixCardBonusBet: nextAmount,
          sessionWager: prev.sessionWager + delta,
          message: nextAmount > 0 ? `6-CARD +$${nextAmount}` : '6-CARD OFF',
      }));

      try {
          const payload = new Uint8Array(9);
          payload[0] = 5; // Move 5: Set 6-Card Bonus
          new DataView(payload.buffer).setBigUint64(1, BigInt(nextAmount), false);

          const result = await chainService.sendMove(currentSessionIdRef.current, payload);
          if (result.txHash) setLastTxSig(result.txHash);
          // NOTE: Do NOT clear isPendingRef here - wait for CasinoGameMoved event
      } catch (error) {
          console.error('[useTerminalGame] 6-card bonus update failed:', error);
          isPendingRef.current = false;
          setGameState(prev => ({
              ...prev,
              threeCardSixCardBonusBet: prevAmount,
              sessionWager: prev.sessionWager - delta,
              message: '6-CARD FAILED',
          }));
      }
  };

  const threeCardToggleProgressive = async () => {
      if (gameState.type !== GameType.THREE_CARD) return;

      const prevAmount = gameState.threeCardProgressiveBet || 0;
      const nextAmount = prevAmount > 0 ? 0 : 1;
      const delta = nextAmount - prevAmount;

      // Local mode: track UI state only.
      if (!isOnChain || !chainService || !currentSessionIdRef.current) {
          setGameState(prev => ({
              ...prev,
              threeCardProgressiveBet: nextAmount,
              message: nextAmount > 0 ? `PROG +$${nextAmount}` : 'PROG OFF',
          }));
          return;
      }

      // On-chain: only allow before Deal.
      if (gameState.stage !== 'BETTING') {
          setGameState(prev => ({ ...prev, message: 'PROG CLOSED' }));
          return;
      }

      if (isPendingRef.current) return;
      if (nextAmount > 0 && stats.chips < nextAmount) {
          setGameState(prev => ({ ...prev, message: 'INSUFFICIENT FUNDS' }));
          return;
      }

      isPendingRef.current = true;
      setGameState(prev => ({
          ...prev,
          threeCardProgressiveBet: nextAmount,
          sessionWager: prev.sessionWager + delta,
          message: nextAmount > 0 ? `PROG +$${nextAmount}` : 'PROG OFF',
      }));

      try {
          const payload = new Uint8Array(9);
          payload[0] = 6; // Move 6: Set Progressive
          new DataView(payload.buffer).setBigUint64(1, BigInt(nextAmount), false);

          const result = await chainService.sendMove(currentSessionIdRef.current, payload);
          if (result.txHash) setLastTxSig(result.txHash);
          // NOTE: Do NOT clear isPendingRef here - wait for CasinoGameMoved event
      } catch (error) {
          console.error('[useTerminalGame] Progressive update failed:', error);
          isPendingRef.current = false;
          setGameState(prev => ({
              ...prev,
              threeCardProgressiveBet: prevAmount,
              sessionWager: prev.sessionWager - delta,
              message: 'PROG FAILED',
          }));
      }
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
          setGameState(prev => ({ 
              ...prev, 
              message: 'PLAYING...',
              sessionWager: prev.sessionWager + prev.bet // Track Play bet
          }));
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
      const details: string[] = [];

      if (!dealerQualifies) {
          totalWin = gameState.bet; // Ante wins 1:1, Play pushes
          message = "DEALER DOESN'T QUALIFY - ANTE WINS";
          details.push(`Ante WIN (+$${gameState.bet})`);
          details.push(`Play PUSH`);
      } else {
          // Compare hands
          if (playerHand.value > dealerHand.value) {
              totalWin = gameState.bet * 2; // Ante + Play win
              message = `${playerHand.rank} WINS!`;
              details.push(`Ante WIN (+$${gameState.bet})`);
              details.push(`Play WIN (+$${gameState.bet})`);
          } else if (playerHand.value < dealerHand.value) {
              totalWin = -gameState.bet * 2; // Lose ante + play
              message = `DEALER ${dealerHand.rank} WINS`;
              details.push(`Ante LOSS (-$${gameState.bet})`);
              details.push(`Play LOSS (-$${gameState.bet})`);
          } else {
              totalWin = 0;
              message = "PUSH";
              details.push(`Ante PUSH`);
              details.push(`Play PUSH`);
          }
      }

      const summary = `${playerHand.rank} vs ${dealerHand.rank}. ${totalWin >= 0 ? '+' : '-'}$${Math.abs(totalWin)}`;

      setStats(prev => ({
          ...prev,
          chips: prev.chips + totalWin,
          history: [...prev.history, summary, ...details],
          pnlByGame: { ...prev.pnlByGame, [GameType.THREE_CARD]: (prev.pnlByGame[GameType.THREE_CARD] || 0) + totalWin },
          pnlHistory: [...prev.pnlHistory, (prev.pnlHistory[prev.pnlHistory.length - 1] || 0) + totalWin].slice(-MAX_GRAPH_POINTS)
      }));

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
      const pnl = -gameState.bet;
      const summary = `FOLDED. -$${gameState.bet}`;
      const details = [`Ante LOSS (-$${gameState.bet})`];

      setStats(prev => ({
          ...prev,
          chips: prev.chips + pnl,
          history: [...prev.history, summary, ...details],
          pnlByGame: { ...prev.pnlByGame, [GameType.THREE_CARD]: (prev.pnlByGame[GameType.THREE_CARD] || 0) + pnl },
          pnlHistory: [...prev.pnlHistory, (prev.pnlHistory[prev.pnlHistory.length - 1] || 0) + pnl].slice(-MAX_GRAPH_POINTS)
      }));

      setGameState(prev => ({ ...prev, dealerCards: dealerRevealed, stage: 'RESULT' }));
      setGameState(prev => ({ ...prev, message: "FOLDED", lastResult: pnl }));
  };

  // --- CASINO WAR ---
  const casinoWarToggleTieBet = async () => {
      if (gameState.type !== GameType.CASINO_WAR) return;

      // Only allowed before the deal.
      if (gameState.stage !== 'BETTING') {
          setGameState(prev => ({ ...prev, message: 'TIE BET CLOSED' }));
          return;
      }

      const prevAmount = gameState.casinoWarTieBet || 0;
      const nextAmount = prevAmount > 0 ? 0 : gameState.bet;
      const delta = nextAmount - prevAmount;

      if (isPendingRef.current) return;
      if (delta > 0 && stats.chips < delta) {
          setGameState(prev => ({ ...prev, message: 'INSUFFICIENT FUNDS' }));
          return;
      }

      // Optimistic update
      isPendingRef.current = true;
      setGameState(prev => ({
          ...prev,
          casinoWarTieBet: nextAmount,
          sessionWager: prev.sessionWager + delta,
          message: nextAmount > 0 ? `TIE BET +$${nextAmount}` : 'TIE BET OFF',
      }));

      // On-chain: submit move [3, tie_bet:u64 BE]
      if (isOnChain && chainService && currentSessionIdRef.current) {
        try {
          const payload = new Uint8Array(9);
          payload[0] = 3;
          new DataView(payload.buffer).setBigUint64(1, BigInt(nextAmount), false);
          const result = await chainService.sendMove(currentSessionIdRef.current, payload);
          if (result.txHash) setLastTxSig(result.txHash);
          return; // wait for moved event to clear isPending
        } catch (error) {
          console.error('[useTerminalGame] Casino War tie bet update failed:', error);
          isPendingRef.current = false;
          setGameState(prev => ({
              ...prev,
              casinoWarTieBet: prevAmount,
              sessionWager: prev.sessionWager - delta,
              message: 'TIE BET FAILED',
          }));
          return;
        }
      }

      // Local mode: just clear pending immediately.
      isPendingRef.current = false;
  };

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
  const uthToggleTrips = async () => {
      if (gameState.type !== GameType.ULTIMATE_HOLDEM) return;

      const prevAmount = gameState.uthTripsBet || 0;
      const nextAmount = prevAmount > 0 ? 0 : gameState.bet;
      const delta = nextAmount - prevAmount;

      // Local mode: track UI state only.
      if (!isOnChain || !chainService || !currentSessionIdRef.current) {
          setGameState(prev => ({
              ...prev,
              uthTripsBet: nextAmount,
              message: nextAmount > 0 ? `TRIPS +$${nextAmount}` : 'TRIPS OFF',
          }));
          return;
      }

      // On-chain: only allow before Deal.
      if (gameState.stage !== 'BETTING') {
          setGameState(prev => ({ ...prev, message: 'TRIPS CLOSED' }));
          return;
      }

      if (isPendingRef.current) return;
      if (nextAmount > 0 && stats.chips < nextAmount) {
          setGameState(prev => ({ ...prev, message: 'INSUFFICIENT FUNDS' }));
          return;
      }

      isPendingRef.current = true;
      setGameState(prev => ({
          ...prev,
          uthTripsBet: nextAmount,
          sessionWager: prev.sessionWager + delta,
          message: nextAmount > 0 ? `TRIPS +$${nextAmount}` : 'TRIPS OFF',
      }));

      try {
          const payload = new Uint8Array(9);
          payload[0] = 6; // Action 6: Set Trips
          new DataView(payload.buffer).setBigUint64(1, BigInt(nextAmount), false);

          const result = await chainService.sendMove(currentSessionIdRef.current, payload);
          if (result.txHash) setLastTxSig(result.txHash);
          // NOTE: Do NOT clear isPendingRef here - wait for CasinoGameMoved event
      } catch (error) {
          console.error('[useTerminalGame] Trips update failed:', error);
          isPendingRef.current = false;
          setGameState(prev => ({
              ...prev,
              uthTripsBet: prevAmount,
              sessionWager: prev.sessionWager - delta,
              message: 'TRIPS FAILED',
          }));
      }
  };

  const uthToggleSixCardBonus = async () => {
      if (gameState.type !== GameType.ULTIMATE_HOLDEM) return;

      const prevAmount = gameState.uthSixCardBonusBet || 0;
      const nextAmount = prevAmount > 0 ? 0 : gameState.bet;
      const delta = nextAmount - prevAmount;

      // Local mode: track UI state only.
      if (!isOnChain || !chainService || !currentSessionIdRef.current) {
          setGameState(prev => ({
              ...prev,
              uthSixCardBonusBet: nextAmount,
              message: nextAmount > 0 ? `6-CARD +$${nextAmount}` : '6-CARD OFF',
          }));
          return;
      }

      // On-chain: only allow before Deal.
      if (gameState.stage !== 'BETTING') {
          setGameState(prev => ({ ...prev, message: '6-CARD CLOSED' }));
          return;
      }

      if (isPendingRef.current) return;
      if (nextAmount > 0 && stats.chips < nextAmount) {
          setGameState(prev => ({ ...prev, message: 'INSUFFICIENT FUNDS' }));
          return;
      }

      isPendingRef.current = true;
      setGameState(prev => ({
          ...prev,
          uthSixCardBonusBet: nextAmount,
          sessionWager: prev.sessionWager + delta,
          message: nextAmount > 0 ? `6-CARD +$${nextAmount}` : '6-CARD OFF',
      }));

      try {
          const payload = new Uint8Array(9);
          payload[0] = 9; // Action 9: Set 6-Card Bonus
          new DataView(payload.buffer).setBigUint64(1, BigInt(nextAmount), false);

          const result = await chainService.sendMove(currentSessionIdRef.current, payload);
          if (result.txHash) setLastTxSig(result.txHash);
          // NOTE: Do NOT clear isPendingRef here - wait for CasinoGameMoved event
      } catch (error) {
          console.error('[useTerminalGame] 6-card bonus update failed:', error);
          isPendingRef.current = false;
          setGameState(prev => ({
              ...prev,
              uthSixCardBonusBet: prevAmount,
              sessionWager: prev.sessionWager - delta,
              message: '6-CARD FAILED',
          }));
      }
  };

  const uthToggleProgressive = async () => {
      if (gameState.type !== GameType.ULTIMATE_HOLDEM) return;

      const prevAmount = gameState.uthProgressiveBet || 0;
      const nextAmount = prevAmount > 0 ? 0 : 1;
      const delta = nextAmount - prevAmount;

      // Local mode: track UI state only.
      if (!isOnChain || !chainService || !currentSessionIdRef.current) {
          setGameState(prev => ({
              ...prev,
              uthProgressiveBet: nextAmount,
              message: nextAmount > 0 ? `PROG +$${nextAmount}` : 'PROG OFF',
          }));
          return;
      }

      // On-chain: only allow before Deal.
      if (gameState.stage !== 'BETTING') {
          setGameState(prev => ({ ...prev, message: 'PROG CLOSED' }));
          return;
      }

      if (isPendingRef.current) return;
      if (nextAmount > 0 && stats.chips < nextAmount) {
          setGameState(prev => ({ ...prev, message: 'INSUFFICIENT FUNDS' }));
          return;
      }

      isPendingRef.current = true;
      setGameState(prev => ({
          ...prev,
          uthProgressiveBet: nextAmount,
          sessionWager: prev.sessionWager + delta,
          message: nextAmount > 0 ? `PROG +$${nextAmount}` : 'PROG OFF',
      }));

      try {
          const payload = new Uint8Array(9);
          payload[0] = 10; // Action 10: Set Progressive
          new DataView(payload.buffer).setBigUint64(1, BigInt(nextAmount), false);

          const result = await chainService.sendMove(currentSessionIdRef.current, payload);
          if (result.txHash) setLastTxSig(result.txHash);
          // NOTE: Do NOT clear isPendingRef here - wait for CasinoGameMoved event
      } catch (error) {
          console.error('[useTerminalGame] Progressive update failed:', error);
          isPendingRef.current = false;
          setGameState(prev => ({
              ...prev,
              uthProgressiveBet: prevAmount,
              sessionWager: prev.sessionWager - delta,
              message: 'PROG FAILED',
          }));
      }
  };

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
          // Payload: [1] for Bet4x, [8] for Bet3x, [2] for Bet2x, [3] for Bet1x
          let payload: Uint8Array;
          if (multiplier === 4) {
            payload = new Uint8Array([1]); // Bet4x
          } else if (multiplier === 3) {
            payload = new Uint8Array([8]); // Bet3x
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
          
          // Calculate bet amount based on multiplier
          const betAmount = gameState.bet * multiplier;
          
          setGameState(prev => ({ 
              ...prev, 
              message: `BETTING ${multiplier}X...`,
              sessionWager: prev.sessionWager + betAmount // Track Play bet
          }));
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

      const details: string[] = [];

      if (!dealerQualifies) {
          totalWin = gameState.bet; // Ante wins, play/blind push
          message = "DEALER DOESN'T QUALIFY";
          details.push(`Ante WIN (+$${gameState.bet})`);
          details.push(`Play PUSH`);
          details.push(`Blind PUSH`);
      } else if (pVal > dVal) {
          totalWin = gameState.bet * (2 + multiplier); // Win ante + play (blind logic omitted for brevity in local mode)
          message = "YOU WIN!";
          details.push(`Ante WIN (+$${gameState.bet})`);
          details.push(`Play WIN (+$${playBet})`);
          details.push(`Blind PUSH (Simulated)`);
      } else if (pVal < dVal) {
          totalWin = -(gameState.bet * (2 + multiplier)); // Lose ante + play + blind
          message = "DEALER WINS";
          details.push(`Ante LOSS (-$${gameState.bet})`);
          details.push(`Play LOSS (-$${playBet})`);
          details.push(`Blind LOSS (-$${gameState.bet})`);
      } else {
          totalWin = 0;
          message = "PUSH";
          details.push(`Ante PUSH`);
          details.push(`Play PUSH`);
          details.push(`Blind PUSH`);
      }

      const summary = `Player ${pVal} vs Dealer ${dVal}. ${totalWin >= 0 ? '+' : '-'}$${Math.abs(totalWin)}`;

      setStats(prev => ({
          ...prev,
          chips: prev.chips + totalWin,
          history: [...prev.history, summary, ...details],
          pnlByGame: { ...prev.pnlByGame, [GameType.ULTIMATE_HOLDEM]: (prev.pnlByGame[GameType.ULTIMATE_HOLDEM] || 0) + totalWin },
          pnlHistory: [...prev.pnlHistory, (prev.pnlHistory[prev.pnlHistory.length - 1] || 0) + totalWin].slice(-MAX_GRAPH_POINTS)
      }));

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
      const pnl = -gameState.bet * 2; // Ante + Blind
      const summary = `FOLDED. -$${Math.abs(pnl)}`;
      const details = [`Ante LOSS (-$${gameState.bet})`, `Blind LOSS (-$${gameState.bet})`];

      setStats(prev => ({
          ...prev,
          chips: prev.chips + pnl,
          history: [...prev.history, summary, ...details],
          pnlByGame: { ...prev.pnlByGame, [GameType.ULTIMATE_HOLDEM]: (prev.pnlByGame[GameType.ULTIMATE_HOLDEM] || 0) + pnl },
          pnlHistory: [...prev.pnlHistory, (prev.pnlHistory[prev.pnlHistory.length - 1] || 0) + pnl].slice(-MAX_GRAPH_POINTS)
      }));

      setGameState(prev => ({ ...prev, dealerCards: dealerRevealed, stage: 'RESULT' }));
      setGameState(prev => ({ ...prev, message: "FOLDED", lastResult: pnl }));
  };

  const registerForTournament = async () => {
      const client: any = clientRef.current;
      if (!client || !client.nonceManager || !publicKeyBytesRef.current) {
        console.warn('[useTerminalGame] Cannot register/join - client not initialized');
        return;
      }

      try {
        // Ensure player exists on-chain.
	        if (!hasRegisteredRef.current) {
	          const playerName = `Player_${Date.now().toString(36)}`;
	          await client.nonceManager.submitCasinoRegister(playerName);
	          hasRegisteredRef.current = true;
	          const keyId = localStorage.getItem('casino_public_key_hex') ?? localStorage.getItem('casino_private_key');
	          if (keyId) {
	            localStorage.setItem(`casino_registered_${keyId}`, 'true');
	          }
	        }
        setIsRegistered(true);

        // Freeroll mode: also join the next tournament slot.
        if (playMode === 'FREEROLL') {
          const now = Date.now();
          const scheduleNow = getFreerollSchedule(now);
          const defaultNextTid = scheduleNow.isRegistration ? scheduleNow.tournamentId : scheduleNow.tournamentId + 1;
          const tid = freerollNextTournamentId ?? defaultNextTid;

          const result = await client.nonceManager.submitCasinoJoinTournament(tid);
          if (result?.txHash) setLastTxSig(result.txHash);
          setGameState(prev => ({ ...prev, message: `JOINED TOURNAMENT ${tid}` }));
        } else {
          setGameState(prev => ({ ...prev, message: 'REGISTERED' }));
        }

        // Refresh player state after submission.
        setTimeout(async () => {
          try {
            const playerState = await client.getCasinoPlayer(publicKeyBytesRef.current!);
            if (playerState) {
              const timeSinceLastUpdate = Date.now() - lastBalanceUpdateRef.current;
              const shouldUpdateBalance = timeSinceLastUpdate > BALANCE_UPDATE_COOLDOWN;

              setStats(prev => ({
                ...prev,
                chips: shouldUpdateBalance ? playerState.chips : prev.chips,
                shields: playerState.shields,
                doubles: playerState.doubles,
                auraMeter: playerState.auraMeter ?? prev.auraMeter ?? 0,
                history: [],
                pnlByGame: {},
                pnlHistory: []
              }));
            }
          } catch (e) {
            console.warn('[useTerminalGame] Failed to fetch player state after register/join:', e);
          }
        }, 750);
      } catch (e) {
        console.error('[useTerminalGame] Register/join failed:', e);
        setGameState(prev => ({ ...prev, message: 'REGISTER/JOIN FAILED' }));
      }
  };

  const claimFaucet = async () => {
      if (isFaucetClaiming) return;

      const client = clientRef.current as any;
      if (!client || !client.nonceManager) {
        console.warn('[useTerminalGame] Cannot claim faucet - client not initialized');
        return;
      }
      if (!publicKeyBytesRef.current) {
        console.warn('[useTerminalGame] Cannot claim faucet - public key not initialized');
        return;
      }

      setIsFaucetClaiming(true);
      try {
        // Ensure player exists on-chain.
	        if (!hasRegisteredRef.current) {
	          const playerName = `Player_${Date.now().toString(36)}`;
	          await client.nonceManager.submitCasinoRegister(playerName);
	          hasRegisteredRef.current = true;
	          setIsRegistered(true);
	          const keyId = localStorage.getItem('casino_public_key_hex') ?? localStorage.getItem('casino_private_key');
	          if (keyId) {
	            localStorage.setItem(`casino_registered_${keyId}`, 'true');
	          }
	        }

        // Dev faucet amount (RNG).
        const amount = 1000;
        const result = await client.nonceManager.submitCasinoDeposit(amount);
        if (result?.txHash) setLastTxSig(result.txHash);
        setGameState(prev => ({ ...prev, message: 'FAUCET CLAIMED' }));

        // Sync player state after submission.
        setTimeout(async () => {
          try {
            const playerState = await client.getCasinoPlayer(publicKeyBytesRef.current!);
            if (playerState) {
              setStats(prev => ({
                ...prev,
                chips: playerState.chips,
                shields: playerState.shields,
                doubles: playerState.doubles,
                auraMeter: playerState.auraMeter ?? prev.auraMeter ?? 0,
              }));
            }
          } catch (e) {
            console.debug('[useTerminalGame] Failed to sync player state after faucet:', e);
          }
        }, 750);
      } catch (e) {
        console.error('[useTerminalGame] Faucet claim failed:', e);
        setGameState(prev => ({ ...prev, message: 'FAUCET FAILED' }));
      } finally {
        setIsFaucetClaiming(false);
      }
  };

  const startTournament = async () => {
    console.warn('[useTerminalGame] startTournament() is deprecated; freerolls auto-schedule.');
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
    isFaucetClaiming,
    freerollActiveTournamentId,
    freerollActiveTimeLeft,
    freerollActivePrizePool,
    freerollActivePlayerCount,
    freerollNextTournamentId,
    freerollNextStartIn,
    freerollIsJoinedNext,
    tournamentsPlayedToday,
    startTournament,
    actions: {
        startGame,
        setBetAmount,
        toggleShield,
        toggleDouble,
        toggleSuper,
        deal,
        // Blackjack
        bjHit,
        bjStand,
        bjDouble,
        bjSplit,
        bjInsurance,
        bjToggle21Plus3,
        // Video Poker
        toggleHold,
        drawVideoPoker,
        // HiLo
        hiloPlay,
        hiloCashout,
        // Roulette
        placeRouletteBet,
        cycleRouletteZeroRule,
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
        threeCardTogglePairPlus,
        threeCardToggleSixCardBonus,
        threeCardToggleProgressive,
        threeCardPlay,
        threeCardFold,
        // Casino War
        casinoWarToggleTieBet,
        casinoWarGoToWar,
        casinoWarSurrender,
        // Ultimate Holdem
        uthToggleTrips,
        uthToggleSixCardBonus,
        uthToggleProgressive,
        uhCheck,
        uhBet,
        uhFold,
        // Misc
        registerForTournament,
        claimFaucet,
        getAdvice
    }
  };
};
