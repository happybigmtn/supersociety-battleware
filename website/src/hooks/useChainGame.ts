import { useState, useEffect, useCallback, useRef } from 'react';
import { GameType as FrontendGameType, PlayerStats, GameState, Card, LeaderboardEntry, TournamentPhase, BaccaratBet, RouletteBet, SicBoBet, CrapsBet } from '../types';
import {
    ChainService,
    GameType as ChainGameType,
    parseBlackjackState,
    parseHiLoState,
    parseBaccaratState,
    parseVideoPokerState,
    parseThreeCardState,
    parseUltimateHoldemState,
    parseRouletteState,
    parseCasinoWarState,
    decodeCard
} from '../services/chainService';

const INITIAL_CHIPS = 1000;
const INITIAL_SHIELDS = 3;
const INITIAL_DOUBLES = 3;

// Map frontend GameType to chain GameType
const GAME_TYPE_MAP: Record<string, number> = {
    [FrontendGameType.BACCARAT]: ChainGameType.BACCARAT,
    [FrontendGameType.BLACKJACK]: ChainGameType.BLACKJACK,
    [FrontendGameType.CASINO_WAR]: ChainGameType.CASINO_WAR,
    [FrontendGameType.CRAPS]: ChainGameType.CRAPS,
    [FrontendGameType.VIDEO_POKER]: ChainGameType.VIDEO_POKER,
    [FrontendGameType.HILO]: ChainGameType.HILO,
    [FrontendGameType.ROULETTE]: ChainGameType.ROULETTE,
    [FrontendGameType.SIC_BO]: ChainGameType.SIC_BO,
    [FrontendGameType.THREE_CARD]: ChainGameType.THREE_CARD,
    [FrontendGameType.ULTIMATE_HOLDEM]: ChainGameType.ULTIMATE_HOLDEM,
};

// Check if chain is available (for graceful fallback)
let chainAvailable = true;

export const useChainGame = () => {
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
        type: FrontendGameType.NONE,
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

    // Session tracking - use ref for immediate access (React state is async)
    const [sessionId, setSessionId] = useState<bigint | null>(null);
    const sessionIdRef = useRef<bigint | null>(null);
    const [publicKeyHex, setPublicKeyHex] = useState<string>('');
    const pollingRef = useRef<NodeJS.Timeout | null>(null);
    const [chainError, setChainError] = useState<string | null>(null);

    // Initialize chain service
    useEffect(() => {
        const init = async () => {
            await ChainService.init();
            const pkHex = await ChainService.getPublicKeyHex();
            setPublicKeyHex(pkHex);
            console.log('[useChainGame] Initialized with pubkey:', pkHex);
        };
        init();
    }, []);

    // Poll for player state
    useEffect(() => {
        if (!publicKeyHex) return;

        const pollPlayer = async () => {
            try {
                const player = await ChainService.getPlayer(publicKeyHex);
                if (player) {
                    setStats(prev => ({
                        ...prev,
                        chips: player.chips,
                        shields: player.shields,
                        doubles: player.doubles,
                        rank: player.rank
                    }));
                }
            } catch (e) {
                console.warn('[useChainGame] Failed to poll player:', e);
            }
        };

        pollPlayer();
        const interval = setInterval(pollPlayer, 5000);
        return () => clearInterval(interval);
    }, [publicKeyHex]);

    // Poll session state when game is active
    const pollSession = useCallback(async () => {
        if (!sessionId) return;

        try {
            const session = await ChainService.getSession(sessionId.toString());
            if (!session) return;

            // Parse state based on game type
            const stateBlob = session.state_blob;

            if (session.game_type === ChainGameType.BLACKJACK) {
                const parsed = parseBlackjackState(stateBlob);
                if (parsed) {
                    setGameState(prev => ({
                        ...prev,
                        playerCards: parsed.playerCards.map(c => ({ ...c, isHidden: false })),
                        dealerCards: parsed.dealerCards.map((c, i) => ({
                            ...c,
                            isHidden: i > 0 && !parsed.isComplete
                        })),
                        stage: parsed.isComplete ? 'RESULT' : 'PLAYING',
                        message: parsed.isComplete ? 'GAME OVER' : 'HIT (H) / STAND (S)'
                    }));
                }
            } else if (session.game_type === ChainGameType.HILO) {
                const parsed = parseHiLoState(stateBlob);
                if (parsed) {
                    setGameState(prev => ({
                        ...prev,
                        playerCards: [parsed.currentCard],
                        hiloAccumulator: parsed.accumulator,
                        stage: parsed.isComplete ? 'RESULT' : 'PLAYING',
                        message: `POT: ${parsed.accumulator} | HIGHER (H) / LOWER (L)`
                    }));
                }
            } else if (session.game_type === ChainGameType.BACCARAT) {
                const parsed = parseBaccaratState(stateBlob);
                if (parsed) {
                    setGameState(prev => ({
                        ...prev,
                        playerCards: parsed.playerCards,
                        dealerCards: parsed.bankerCards,
                        stage: parsed.stage === 'COMPLETE' ? 'RESULT' : 'PLAYING',
                        message: parsed.result || 'AWAITING RESULT'
                    }));
                }
            } else if (session.game_type === ChainGameType.VIDEO_POKER) {
                const parsed = parseVideoPokerState(stateBlob);
                if (parsed) {
                    setGameState(prev => ({
                        ...prev,
                        playerCards: parsed.cards.map((c, i) => ({ ...c, isHidden: parsed.held[i] })),
                        stage: parsed.stage === 'COMPLETE' ? 'RESULT' : 'PLAYING',
                        message: parsed.stage === 'DEAL' ? 'HOLD (1-5), DRAW (D)' : 'GAME OVER'
                    }));
                }
            } else if (session.game_type === ChainGameType.THREE_CARD) {
                const parsed = parseThreeCardState(stateBlob);
                if (parsed) {
                    setGameState(prev => ({
                        ...prev,
                        playerCards: parsed.playerCards,
                        dealerCards: parsed.dealerCards.map(c => ({
                            ...c,
                            isHidden: parsed.stage !== 'COMPLETE'
                        })),
                        stage: parsed.stage === 'COMPLETE' ? 'RESULT' : 'PLAYING',
                        message: parsed.stage === 'DEALT' ? 'PLAY (P) OR FOLD (F)' : 'GAME OVER'
                    }));
                }
            } else if (session.game_type === ChainGameType.ULTIMATE_HOLDEM) {
                const parsed = parseUltimateHoldemState(stateBlob);
                if (parsed) {
                    setGameState(prev => ({
                        ...prev,
                        playerCards: parsed.playerCards,
                        dealerCards: parsed.dealerCards.map(c => ({
                            ...c,
                            isHidden: parsed.stage !== 'SHOWDOWN' && parsed.stage !== 'COMPLETE'
                        })),
                        communityCards: parsed.communityCards,
                        stage: parsed.stage === 'COMPLETE' ? 'RESULT' : 'PLAYING',
                        message: getUHMessage(parsed.stage)
                    }));
                }
            } else if (session.game_type === ChainGameType.ROULETTE) {
                const parsed = parseRouletteState(stateBlob);
                if (parsed) {
                    setGameState(prev => ({
                        ...prev,
                        rouletteHistory: parsed.lastResult !== undefined
                            ? [...prev.rouletteHistory, parsed.lastResult]
                            : prev.rouletteHistory,
                        stage: parsed.stage === 'COMPLETE' ? 'RESULT' : 'BETTING',
                        message: parsed.lastResult !== undefined ? `SPUN ${parsed.lastResult}` : 'PLACE BETS'
                    }));
                }
            } else if (session.game_type === ChainGameType.CASINO_WAR) {
                const parsed = parseCasinoWarState(stateBlob);
                if (parsed) {
                    setGameState(prev => ({
                        ...prev,
                        playerCards: parsed.playerCard ? [parsed.playerCard] : [],
                        dealerCards: parsed.dealerCard ? [parsed.dealerCard] : [],
                        stage: parsed.stage === 'COMPLETE' ? 'RESULT' :
                               parsed.stage === 'WAR' ? 'PLAYING' : 'BETTING',
                        message: parsed.stage === 'WAR' ? 'SURRENDER (S) OR WAR (W)' :
                                 parsed.stage === 'COMPLETE' ? 'GAME OVER' : 'SPACE TO DEAL'
                    }));
                }
            }

            // If session is complete, stop polling
            if (session.is_complete) {
                if (pollingRef.current) {
                    clearInterval(pollingRef.current);
                    pollingRef.current = null;
                }
            }
        } catch (e) {
            console.warn('[useChainGame] Failed to poll session:', e);
        }
    }, [sessionId]);

    // Start polling when session changes
    useEffect(() => {
        if (sessionId) {
            pollSession();
            pollingRef.current = setInterval(pollSession, 1000);
            return () => {
                if (pollingRef.current) {
                    clearInterval(pollingRef.current);
                    pollingRef.current = null;
                }
            };
        }
    }, [sessionId, pollSession]);

    // Tournament clock (same as before)
    useEffect(() => {
        const interval = setInterval(() => {
            const now = Date.now();
            const cycleDuration = 6 * 60 * 1000;
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
        }, 1000);
        return () => clearInterval(interval);
    }, [phase]);

    // Helper for Ultimate Holdem messages
    const getUHMessage = (stage: string): string => {
        switch (stage) {
            case 'PREFLOP': return 'CHECK (C) OR BET 4X/3X';
            case 'FLOP': return 'CHECK (C) OR BET 2X';
            case 'RIVER': return 'FOLD (F) OR BET 1X';
            default: return 'GAME OVER';
        }
    };

    // --- ON-CHAIN ACTIONS ---

    const startGame = async (type: FrontendGameType) => {
        const chainGameType = GAME_TYPE_MAP[type];
        if (chainGameType === undefined) {
            console.error('[useChainGame] Unknown game type:', type);
            return;
        }

        // Generate new session ID
        const newSessionId = BigInt(Date.now());
        // Update both ref (immediate) and state (for re-renders)
        sessionIdRef.current = newSessionId;
        setSessionId(newSessionId);
        setChainError(null);

        setGameState(prev => ({
            ...prev,
            type,
            message: 'STARTING GAME...',
            stage: 'BETTING',
            playerCards: [],
            dealerCards: [],
            communityCards: [],
            dice: [],
            hiloAccumulator: 0,
            hiloGraphData: []
        }));

        try {
            await ChainService.startGame(chainGameType, gameState.bet, newSessionId);

            setGameState(prev => ({
                ...prev,
                message: 'SPACE TO DEAL',
                stage: 'BETTING'
            }));

            console.log('[useChainGame] Started game:', type, 'session:', newSessionId.toString());
        } catch (e) {
            console.error('[useChainGame] Failed to start game:', e);
            const errorMsg = (e instanceof Error && e.message?.includes('fetch')) ? 'CHAIN UNAVAILABLE' : 'FAILED TO START';
            setChainError(errorMsg);
            setGameState(prev => ({ ...prev, message: errorMsg }));
            // Keep sessionId for offline testing - game can still function with local state
            // sessionIdRef.current = null;
            // setSessionId(null);
        }
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
        const allowedInPlay = [FrontendGameType.CRAPS, FrontendGameType.ROULETTE, FrontendGameType.SIC_BO].includes(gameState.type);
        if (gameState.stage === 'PLAYING' && !allowedInPlay) return;
        if (stats.shields <= 0 && !gameState.activeModifiers.shield) {
            setGameState(prev => ({ ...prev, message: "NO SHIELDS REMAINING" }));
            return;
        }
        setGameState(prev => ({
            ...prev,
            activeModifiers: { ...prev.activeModifiers, shield: !prev.activeModifiers.shield }
        }));
    };

    const toggleDouble = () => {
        const allowedInPlay = [FrontendGameType.CRAPS, FrontendGameType.ROULETTE, FrontendGameType.SIC_BO].includes(gameState.type);
        if (gameState.stage === 'PLAYING' && !allowedInPlay) return;
        if (stats.doubles <= 0 && !gameState.activeModifiers.double) {
            setGameState(prev => ({ ...prev, message: "NO DOUBLES REMAINING" }));
            return;
        }
        setGameState(prev => ({
            ...prev,
            activeModifiers: { ...prev.activeModifiers, double: !prev.activeModifiers.double }
        }));
    };

    // DEAL / Primary action
    const deal = async () => {
        if (gameState.type === FrontendGameType.NONE) return;

        // Use ref for immediate access (state might not be updated yet)
        const currentSessionId = sessionIdRef.current;
        if (!currentSessionId) {
            setGameState(prev => ({ ...prev, message: "START A GAME FIRST" }));
            return;
        }

        // Route to specific game handlers
        if (gameState.type === FrontendGameType.CRAPS) { await crapsRoll(); return; }
        if (gameState.type === FrontendGameType.ROULETTE) { await spinRoulette(); return; }
        if (gameState.type === FrontendGameType.SIC_BO) { await rollSicBo(); return; }

        if (gameState.stage === 'PLAYING') return;

        try {
            setGameState(prev => ({ ...prev, message: 'DEALING...', stage: 'PLAYING' }));

            // For games that need initial deal action
            if (gameState.type === FrontendGameType.VIDEO_POKER) {
                await ChainService.videoPokerDeal(currentSessionId);
            } else if (gameState.type === FrontendGameType.THREE_CARD) {
                await ChainService.threeCardDeal(currentSessionId);
            } else if (gameState.type === FrontendGameType.ULTIMATE_HOLDEM) {
                await ChainService.uhDeal(currentSessionId);
            } else if (gameState.type === FrontendGameType.CASINO_WAR) {
                await ChainService.casinoWarDeal(currentSessionId);
            }
            // Blackjack, HiLo, Baccarat start with StartGame action

            // State will update via polling
        } catch (e) {
            console.error('[useChainGame] Deal failed:', e);
            setGameState(prev => ({ ...prev, message: 'DEAL FAILED' }));
        }
    };

    // Helper to get current session ID
    const getSessionId = (): bigint | null => sessionIdRef.current;

    // --- BLACKJACK ---
    const bjHit = async () => {
        const sid = getSessionId();
        if (!sid || gameState.type !== FrontendGameType.BLACKJACK) return;
        try {
            await ChainService.blackjackMove(sid, 'HIT');
        } catch (e) {
            console.error('[useChainGame] Hit failed:', e);
        }
    };

    const bjStand = async () => {
        const sid = getSessionId();
        if (!sid || gameState.type !== FrontendGameType.BLACKJACK) return;
        try {
            await ChainService.blackjackMove(sid, 'STAND');
        } catch (e) {
            console.error('[useChainGame] Stand failed:', e);
        }
    };

    const bjDouble = async () => {
        const sid = getSessionId();
        if (!sid || gameState.type !== FrontendGameType.BLACKJACK) return;
        try {
            await ChainService.blackjackMove(sid, 'DOUBLE');
        } catch (e) {
            console.error('[useChainGame] Double failed:', e);
        }
    };

    const bjSplit = () => {
        // Split is not currently supported in the on-chain blackjack implementation
        setGameState(prev => ({ ...prev, message: "SPLIT NOT AVAILABLE ON-CHAIN" }));
    };

    const bjInsurance = (take: boolean) => {
        // Insurance is not currently supported in the on-chain blackjack implementation
        setGameState(prev => ({ ...prev, message: take ? "INSURANCE NOT AVAILABLE" : "CONTINUING" }));
    };

    // --- HILO ---
    const hiloPlay = async (guess: 'HIGHER' | 'LOWER') => {
        const sid = getSessionId();
        if (!sid || gameState.type !== FrontendGameType.HILO) return;
        try {
            await ChainService.hiloMove(sid, guess);
        } catch (e) {
            console.error('[useChainGame] HiLo move failed:', e);
        }
    };

    const hiloCashout = async () => {
        const sid = getSessionId();
        if (!sid || gameState.type !== FrontendGameType.HILO) return;
        try {
            await ChainService.hiloMove(sid, 'CASHOUT');
        } catch (e) {
            console.error('[useChainGame] HiLo cashout failed:', e);
        }
    };

    // --- VIDEO POKER ---
    const toggleHold = (idx: number) => {
        if (gameState.type !== FrontendGameType.VIDEO_POKER) return;
        const cards = [...gameState.playerCards];
        cards[idx] = { ...cards[idx], isHidden: !cards[idx].isHidden };
        setGameState(prev => ({ ...prev, playerCards: cards }));
    };

    const drawVideoPoker = async () => {
        const sid = getSessionId();
        if (!sid || gameState.type !== FrontendGameType.VIDEO_POKER) return;
        try {
            const heldIndices = gameState.playerCards
                .map((c, i) => c.isHidden ? i : -1)
                .filter(i => i >= 0);
            await ChainService.videoPokerDraw(sid, heldIndices);
        } catch (e) {
            console.error('[useChainGame] Draw failed:', e);
        }
    };

    // --- THREE CARD POKER ---
    const threeCardPlay = async () => {
        const sid = getSessionId();
        if (!sid || gameState.type !== FrontendGameType.THREE_CARD) return;
        try {
            await ChainService.threeCardPlay(sid);
        } catch (e) {
            console.error('[useChainGame] Three Card play failed:', e);
        }
    };

    const threeCardFold = async () => {
        const sid = getSessionId();
        if (!sid || gameState.type !== FrontendGameType.THREE_CARD) return;
        try {
            await ChainService.threeCardFold(sid);
        } catch (e) {
            console.error('[useChainGame] Three Card fold failed:', e);
        }
    };

    // --- ULTIMATE HOLDEM ---
    const uhCheck = async () => {
        const sid = getSessionId();
        if (!sid || gameState.type !== FrontendGameType.ULTIMATE_HOLDEM) return;
        try {
            await ChainService.uhCheck(sid);
        } catch (e) {
            console.error('[useChainGame] UH check failed:', e);
        }
    };

    const uhBet = async (multiplier: number) => {
        const sid = getSessionId();
        if (!sid || gameState.type !== FrontendGameType.ULTIMATE_HOLDEM) return;
        try {
            await ChainService.uhBet(sid, multiplier as 1 | 2 | 3 | 4);
        } catch (e) {
            console.error('[useChainGame] UH bet failed:', e);
        }
    };

    const uhFold = async () => {
        const sid = getSessionId();
        if (!sid || gameState.type !== FrontendGameType.ULTIMATE_HOLDEM) return;
        try {
            await ChainService.uhFold(sid);
        } catch (e) {
            console.error('[useChainGame] UH fold failed:', e);
        }
    };

    // --- ROULETTE ---
    const placeRouletteBet = async (type: RouletteBet['type'], target?: number) => {
        const sid = getSessionId();
        if (!sid || gameState.type !== FrontendGameType.ROULETTE) return;
        if (stats.chips < gameState.bet) return;

        // Map bet types to chain format
        const betTypeMap: Record<string, number> = {
            'STRAIGHT': 0, 'RED': 1, 'BLACK': 2, 'ODD': 3, 'EVEN': 4,
            'LOW': 5, 'HIGH': 6, 'ZERO': 0
        };

        try {
            await ChainService.roulettePlaceBet(
                sid,
                betTypeMap[type] || 0,
                type === 'STRAIGHT' || type === 'ZERO' ? (target ?? 0) : -1,
                BigInt(gameState.bet)
            );

            // Update local state for display
            setGameState(prev => ({
                ...prev,
                rouletteUndoStack: [...prev.rouletteUndoStack, prev.rouletteBets],
                rouletteBets: [...prev.rouletteBets, { type, amount: prev.bet, target }],
                message: `BET ${type}`,
                rouletteInputMode: 'NONE'
            }));
        } catch (e) {
            console.error('[useChainGame] Roulette bet failed:', e);
        }
    };

    const spinRoulette = async () => {
        const sid = getSessionId();
        if (!sid || gameState.type !== FrontendGameType.ROULETTE) return;
        if (gameState.rouletteBets.length === 0) {
            setGameState(prev => ({ ...prev, message: "PLACE BET" }));
            return;
        }
        try {
            await ChainService.rouletteSpin(sid);
            setGameState(prev => ({
                ...prev,
                rouletteLastRoundBets: prev.rouletteBets,
                rouletteBets: [],
                rouletteUndoStack: []
            }));
        } catch (e) {
            console.error('[useChainGame] Roulette spin failed:', e);
        }
    };

    const undoRouletteBet = async () => {
        const sid = getSessionId();
        if (!sid) return;
        try {
            await ChainService.rouletteClearBets(sid);
            if (gameState.rouletteUndoStack.length > 0) {
                setGameState(prev => ({
                    ...prev,
                    rouletteBets: prev.rouletteUndoStack[prev.rouletteUndoStack.length - 1],
                    rouletteUndoStack: prev.rouletteUndoStack.slice(0, -1)
                }));
            }
        } catch (e) {
            console.error('[useChainGame] Undo failed:', e);
        }
    };

    const rebetRoulette = () => {
        if (gameState.rouletteLastRoundBets.length === 0) return;
        // Re-place all previous bets
        gameState.rouletteLastRoundBets.forEach(async bet => {
            await placeRouletteBet(bet.type, bet.target);
        });
    };

    // --- CRAPS ---
    const placeCrapsBet = async (type: CrapsBet['type'], target?: number) => {
        const sid = getSessionId();
        if (!sid || gameState.type !== FrontendGameType.CRAPS) return;

        const betTypeMap: Record<string, number> = {
            'PASS': 0, 'DONT_PASS': 1, 'FIELD': 2, 'COME': 3, 'DONT_COME': 1
        };

        try {
            await ChainService.crapsPlaceBet(sid, betTypeMap[type] || 0, BigInt(gameState.bet));
            setGameState(prev => ({
                ...prev,
                crapsUndoStack: [...prev.crapsUndoStack, prev.crapsBets],
                crapsBets: [...prev.crapsBets, { type, amount: prev.bet, target, status: 'ON' }],
                message: `BET ${type}`,
                crapsInputMode: 'NONE'
            }));
        } catch (e) {
            console.error('[useChainGame] Craps bet failed:', e);
        }
    };

    const crapsRoll = async () => {
        const sid = getSessionId();
        if (!sid || gameState.type !== FrontendGameType.CRAPS) return;
        try {
            await ChainService.crapsRoll(sid);
        } catch (e) {
            console.error('[useChainGame] Craps roll failed:', e);
        }
    };

    const undoCrapsBet = () => {
        if (gameState.crapsUndoStack.length === 0) return;
        setGameState(prev => ({
            ...prev,
            crapsBets: prev.crapsUndoStack[prev.crapsUndoStack.length - 1],
            crapsUndoStack: prev.crapsUndoStack.slice(0, -1)
        }));
    };

    const addCrapsOdds = () => {
        setGameState(prev => ({ ...prev, message: "ODDS NOT IMPLEMENTED ON-CHAIN" }));
    };

    // --- SIC BO ---
    const placeSicBoBet = async (type: SicBoBet['type'], target?: number) => {
        const sid = getSessionId();
        if (!sid || gameState.type !== FrontendGameType.SIC_BO) return;

        const betTypeMap: Record<string, number> = {
            'SMALL': 0, 'BIG': 1, 'ODD': 2, 'EVEN': 3, 'TRIPLE_ANY': 4, 'SUM': 7
        };

        try {
            await ChainService.sicBoPlaceBet(
                sid,
                betTypeMap[type] || 0,
                target ?? 0,
                0,
                BigInt(gameState.bet)
            );
            setGameState(prev => ({
                ...prev,
                sicBoUndoStack: [...prev.sicBoUndoStack, prev.sicBoBets],
                sicBoBets: [...prev.sicBoBets, { type, amount: prev.bet, target }],
                message: `BET ${type}`,
                sicBoInputMode: 'NONE'
            }));
        } catch (e) {
            console.error('[useChainGame] Sic Bo bet failed:', e);
        }
    };

    const rollSicBo = async () => {
        const sid = getSessionId();
        if (!sid || gameState.type !== FrontendGameType.SIC_BO) return;
        if (gameState.sicBoBets.length === 0) {
            setGameState(prev => ({ ...prev, message: "PLACE BET" }));
            return;
        }
        try {
            await ChainService.sicBoRoll(sid);
            setGameState(prev => ({
                ...prev,
                sicBoLastRoundBets: prev.sicBoBets,
                sicBoBets: [],
                sicBoUndoStack: []
            }));
        } catch (e) {
            console.error('[useChainGame] Sic Bo roll failed:', e);
        }
    };

    const undoSicBoBet = async () => {
        const sid = getSessionId();
        if (!sid) return;
        try {
            await ChainService.sicBoClearBets(sid);
            if (gameState.sicBoUndoStack.length > 0) {
                setGameState(prev => ({
                    ...prev,
                    sicBoBets: prev.sicBoUndoStack[prev.sicBoUndoStack.length - 1],
                    sicBoUndoStack: prev.sicBoUndoStack.slice(0, -1)
                }));
            }
        } catch (e) {
            console.error('[useChainGame] Undo failed:', e);
        }
    };

    const rebetSicBo = () => {
        if (gameState.sicBoLastRoundBets.length === 0) return;
        gameState.sicBoLastRoundBets.forEach(async bet => {
            await placeSicBoBet(bet.type, bet.target);
        });
    };

    // --- BACCARAT ---
    const baccaratActions = {
        toggleSelection: (sel: 'PLAYER' | 'BANKER') => {
            setGameState(prev => ({ ...prev, baccaratSelection: sel }));
        },
        placeBet: async (type: BaccaratBet['type']) => {
            const sid = getSessionId();
            if (!sid || stats.chips < gameState.bet) return;

            // For baccarat, the bet type is sent directly
            const betMap: Record<string, 'PLAYER' | 'BANKER' | 'TIE'> = {
                'PLAYER': 'PLAYER', 'BANKER': 'BANKER', 'TIE': 'TIE'
            };

            if (betMap[type]) {
                try {
                    await ChainService.baccaratMove(sid, betMap[type]);
                } catch (e) {
                    console.error('[useChainGame] Baccarat bet failed:', e);
                }
            }

            setGameState(prev => ({
                ...prev,
                baccaratUndoStack: [...prev.baccaratUndoStack, prev.baccaratBets],
                baccaratBets: [...prev.baccaratBets, { type, amount: prev.bet }]
            }));
        },
        undo: () => {
            if (gameState.baccaratUndoStack.length > 0) {
                setGameState(prev => ({
                    ...prev,
                    baccaratBets: prev.baccaratUndoStack[prev.baccaratUndoStack.length - 1],
                    baccaratUndoStack: prev.baccaratUndoStack.slice(0, -1)
                }));
            }
        },
        rebet: () => {
            if (gameState.baccaratLastRoundBets.length > 0) {
                setGameState(prev => ({
                    ...prev,
                    baccaratBets: [...prev.baccaratBets, ...prev.baccaratLastRoundBets]
                }));
            }
        }
    };

    // --- REGISTRATION ---
    const registerForTournament = async () => {
        try {
            await ChainService.register("Player_" + Date.now());
            await ChainService.deposit(INITIAL_CHIPS);
            setIsRegistered(true);
            setStats(prev => ({
                ...prev,
                chips: INITIAL_CHIPS,
                shields: INITIAL_SHIELDS,
                doubles: INITIAL_DOUBLES,
                history: [],
                pnlByGame: {},
                pnlHistory: []
            }));
        } catch (e) {
            console.error('[useChainGame] Registration failed:', e);
        }
    };

    const getAdvice = async () => {
        setAiAdvice("AI advice disabled for on-chain play");
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
