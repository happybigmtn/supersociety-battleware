
import { useEffect, RefObject } from 'react';
import { GameType, GameState } from '../types';

interface KeyboardControlsProps {
  gameState: GameState;
  uiState: { commandOpen: boolean; customBetOpen: boolean; helpOpen: boolean; searchQuery: string };
  uiActions: {
      setCommandOpen: (v: boolean) => void;
      setCustomBetOpen: (v: boolean) => void;
      setHelpOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
      setHelpDetail: (v: string | null) => void;
      setSearchQuery: (v: string) => void;
      setCustomBetString: (v: string | ((prev: string) => string)) => void;
      setNumberInputString: (v: string | ((prev: string) => string)) => void;
      startGame: (g: GameType) => void;
      setBetAmount: (n: number) => void;
  };
  gameActions: {
    setGameState: React.Dispatch<React.SetStateAction<GameState>>;
    registerForTournament: () => void;
    deal: () => void;
    toggleShield: () => void;
    toggleDouble: () => void;
    bjHit: () => void;
    bjStand: () => void;
    bjDouble: () => void;
    bjSplit: () => void;
    bjInsurance: (take: boolean) => void;
    drawVideoPoker: () => void;
    toggleHold: (index: number) => void;
    hiloPlay: (choice: 'HIGHER' | 'LOWER') => void;
    hiloCashout: () => void;
    baccaratActions: {
      toggleSelection: (selection: 'PLAYER' | 'BANKER') => void;
      placeBet: (betType: string) => void;
      rebet: () => void;
      undo: () => void;
    };
    placeRouletteBet: (betType: string, target?: number) => void;
    rebetRoulette: () => void;
    undoRouletteBet: () => void;
    threeCardPlay: () => void;
    threeCardFold: () => void;
    casinoWarGoToWar: () => void;
    casinoWarSurrender: () => void;
    uhCheck: () => void;
    uhFold: () => void;
    uhBet: (multiplier: number) => void;
    placeCrapsBet: (betType: string) => void;
    placeCrapsNumberBet: (inputMode: string, number: number) => void;
    addCrapsOdds: () => void;
    undoCrapsBet: () => void;
    rebetCraps: () => void;
    placeSicBoBet: (betType: string, target?: number) => void;
    rebetSicBo: () => void;
    undoSicBoBet: () => void;
  };
  phase: string;
  isRegistered: boolean;
  inputRefs: { input: RefObject<HTMLInputElement>; customBet: RefObject<HTMLInputElement> };
  sortedGames?: GameType[];
}

export const useKeyboardControls = ({
    gameState, uiState, uiActions, gameActions, phase, isRegistered, inputRefs, sortedGames = []
}: KeyboardControlsProps) => {

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Registration Phase
            if (phase === 'REGISTRATION') {
                if (e.key.toLowerCase() === 'r' && !isRegistered) {
                    gameActions.registerForTournament();
                }
                return;
            }

            // Global Shortcuts
            if (e.key === '/') {
                e.preventDefault();
                if (!uiState.commandOpen && !uiState.customBetOpen && !uiState.helpOpen) {
                    uiActions.setCommandOpen(true);
                    setTimeout(() => inputRefs.input.current?.focus(), 10);
                }
                return;
            }
            if (e.key === '?') {
                e.preventDefault();
                if (!uiState.commandOpen && !uiState.customBetOpen) {
                    uiActions.setHelpOpen((p: boolean) => !p);
                    uiActions.setHelpDetail(null);
                }
                return;
            }
            if (e.key === 'Escape') {
                uiActions.setCommandOpen(false);
                uiActions.setCustomBetOpen(false);
                if (uiState.helpOpen) {
                    uiActions.setHelpDetail(null); // Clear detail first
                    uiActions.setHelpOpen(false); // Then close
                }
                // Reset game input modes
                gameActions.setGameState((prev) => ({ ...prev, crapsInputMode: 'NONE', rouletteInputMode: 'NONE', sicBoInputMode: 'NONE' }));
                uiActions.setNumberInputString("");
                return;
            }

            // Command Palette Logic
            if (uiState.commandOpen) {
                // Number key selection (1-9) for immediate game navigation
                const num = parseInt(e.key);
                if (!isNaN(num) && num >= 1 && num <= 9) {
                    // Filter games by search query first
                    const filteredGames = uiState.searchQuery
                        ? sortedGames.filter(g => g.toLowerCase().includes(uiState.searchQuery.toLowerCase()))
                        : sortedGames;

                    const gameIndex = num - 1;
                    if (gameIndex < filteredGames.length) {
                        e.preventDefault();
                        uiActions.startGame(filteredGames[gameIndex]);
                        uiActions.setCommandOpen(false);
                        uiActions.setSearchQuery("");
                    }
                    return;
                }
                return;
            }

            // Custom Bet Logic
            if (uiState.customBetOpen) {
                if (e.key === 'Enter') {
                    // Handled in App state mostly, but we can trigger setBet here if string passed
                } else if (/^[0-9]$/.test(e.key)) {
                    uiActions.setCustomBetString((prev: string) => prev + e.key);
                } else if (e.key === 'Backspace') {
                    uiActions.setCustomBetString((prev: string) => prev.slice(0, -1));
                }
                return;
            }
            
            // Numeric Input (Roulette/SicBo)
            if (gameState.rouletteInputMode === 'NUMBER' || gameState.sicBoInputMode === 'SUM') {
                 if (e.key === 'Enter') {
                     // Trigger logic in App/Hook
                 } else if (/^[0-9]$/.test(e.key)) {
                     uiActions.setNumberInputString((prev: string) => prev + e.key);
                 } else if (e.key === 'Backspace') {
                     uiActions.setNumberInputString((prev: string) => prev.slice(0, -1));
                 }
                 return;
            }

            // Game Actions
            if (e.key === ' ') { e.preventDefault(); gameActions.deal(); return; }
            if (e.key.toLowerCase() === 'z') gameActions.toggleShield();
            if (e.key.toLowerCase() === 'x') gameActions.toggleDouble();

            // Specific Game Keys - handle BEFORE bet amounts to allow number key overrides
            const k = e.key.toLowerCase();

            if (gameState.type === GameType.BLACKJACK) {
                if (k === 'h') gameActions.bjHit();
                if (k === 's') gameActions.bjStand();
                if (k === 'd') gameActions.bjDouble();
                if (k === 'p') gameActions.bjSplit();
                if (k === 'i') gameActions.bjInsurance(true);
                if (k === 'n') gameActions.bjInsurance(false);
            } else if (gameState.type === GameType.VIDEO_POKER) {
                if (k === 'd') gameActions.drawVideoPoker();
                // 1-5 toggle hold on cards - takes priority over bet changes
                if (['1','2','3','4','5'].includes(e.key)) {
                    gameActions.toggleHold(parseInt(e.key)-1);
                    return;
                }
            } else if (gameState.type === GameType.HILO) {
                if (k === 'h') gameActions.hiloPlay('HIGHER');
                if (k === 'l') gameActions.hiloPlay('LOWER');
                if (k === 'c') gameActions.hiloCashout();
            } else if (gameState.type === GameType.BACCARAT) {
                if (k === 'p') gameActions.baccaratActions.toggleSelection('PLAYER');
                if (k === 'b') gameActions.baccaratActions.toggleSelection('BANKER');
                if (k === 'e') gameActions.baccaratActions.placeBet('TIE');
                if (k === 'q') gameActions.baccaratActions.placeBet('P_PAIR');
                if (k === 'w') gameActions.baccaratActions.placeBet('B_PAIR');
                if (k === 't') gameActions.baccaratActions.rebet();
                if (k === 'u') gameActions.baccaratActions.undo();
            } else if (gameState.type === GameType.ROULETTE) {
                if (k === 'r') gameActions.placeRouletteBet('RED');
                if (k === 'b') gameActions.placeRouletteBet('BLACK');
                if (k === 'e') gameActions.placeRouletteBet('EVEN');
                if (k === 'o') gameActions.placeRouletteBet('ODD');
                // '0' places ZERO bet - takes priority over custom bet dialog
                if (e.key === '0') {
                    gameActions.placeRouletteBet('ZERO');
                    return;
                }
                if (k === 't') gameActions.rebetRoulette();
                if (k === 'u') gameActions.undoRouletteBet();
            } else if (gameState.type === GameType.THREE_CARD) {
                if (k === 'p') gameActions.threeCardPlay();
                if (k === 'f') gameActions.threeCardFold();
            } else if (gameState.type === GameType.CASINO_WAR) {
                if (k === 'w') gameActions.casinoWarGoToWar();
                if (k === 's') gameActions.casinoWarSurrender();
            } else if (gameState.type === GameType.ULTIMATE_HOLDEM) {
                if (k === 'c') gameActions.uhCheck();
                if (k === 'f') gameActions.uhFold();
                // For betting, we override the standard bet shortcuts in Ultimate Holdem
                if (gameState.communityCards.length === 0) {
                    // Pre-flop: 3x or 4x
                    if (e.key === '3') { gameActions.uhBet(3); return; }
                    if (e.key === '4') { gameActions.uhBet(4); return; }
                } else if (gameState.communityCards.length === 3) {
                    // Flop: 2x
                    if (e.key === '2') { gameActions.uhBet(2); return; }
                } else if (gameState.communityCards.length === 5) {
                    // River: 1x
                    if (e.key === '1') { gameActions.uhBet(1); return; }
                }
            } else if (gameState.type === GameType.CRAPS) {
                // Handle input mode first - number selection
                if (gameState.crapsInputMode !== 'NONE') {
                    const numMap: Record<string, number> = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '0': 10, '-': 11, '=': 12 };
                    const selectedNum = numMap[e.key];
                    if (selectedNum !== undefined) {
                        gameActions.placeCrapsNumberBet(gameState.crapsInputMode, selectedNum);
                        gameActions.setGameState((prev) => ({ ...prev, crapsInputMode: 'NONE' }));
                        return;
                    }
                    return; // Absorb other keys while in input mode
                }

                if (k === 'p') gameActions.placeCrapsBet(gameState.crapsPoint ? 'COME' : 'PASS');
                if (k === 'd') gameActions.placeCrapsBet(gameState.crapsPoint ? 'DONT_COME' : 'DONT_PASS');
                if (k === 'f') gameActions.placeCrapsBet('FIELD');
                if (k === 'o') gameActions.addCrapsOdds();
                if (k === 'u') gameActions.undoCrapsBet();
                if (k === 't') gameActions.rebetCraps();
                if (k === 'y') gameActions.setGameState((prev) => ({ ...prev, crapsInputMode: 'YES' }));
                if (k === 'n') gameActions.setGameState((prev) => ({ ...prev, crapsInputMode: 'NO' }));
                if (k === 'x') gameActions.setGameState((prev) => ({ ...prev, crapsInputMode: 'NEXT' }));
                if (k === 'h') gameActions.setGameState((prev) => ({ ...prev, crapsInputMode: 'HARDWAY' }));
            } else if (gameState.type === GameType.SIC_BO) {
                if (k === 's') gameActions.placeSicBoBet('SMALL');
                if (k === 'b') gameActions.placeSicBoBet('BIG');
                if (k === 'a') gameActions.placeSicBoBet('TRIPLE_ANY');
                if (k === 't') gameActions.rebetSicBo();
                if (k === 'u') gameActions.undoSicBoBet();
            }

            // Bet Amounts (ArrowUp/ArrowDown to cycle, Ctrl+1-9, Ctrl+0 for custom)
            const bets = [1, 5, 25, 100, 500, 1000, 5000, 10000, 50000];

            // Arrow keys to cycle through bet amounts (only when not in input mode)
            if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !uiState.commandOpen && !uiState.customBetOpen) {
                e.preventDefault();
                const currentBet = gameState.bet || 50;
                const currentIndex = bets.findIndex(b => b >= currentBet);
                let newIndex: number;

                if (e.key === 'ArrowUp') {
                    // Increase bet - go to next higher value or stay at max
                    newIndex = currentIndex === -1 ? bets.length - 1 : Math.min(currentIndex + 1, bets.length - 1);
                } else {
                    // Decrease bet - go to next lower value or stay at min
                    newIndex = currentIndex <= 0 ? 0 : currentIndex - 1;
                }

                uiActions.setBetAmount(bets[newIndex]);
                return;
            }

            // Ctrl+1-9 for direct bet selection, Ctrl+0 for custom
            if (e.ctrlKey && !e.shiftKey && !e.altKey) {
                const num = parseInt(e.key);
                if (!isNaN(num)) {
                    e.preventDefault(); // Prevent browser shortcuts like Ctrl+1 for tabs
                    if (num === 0) {
                        uiActions.setCustomBetOpen(true);
                        setTimeout(() => inputRefs.customBet.current?.focus(), 10);
                    } else if (num <= bets.length) {
                        uiActions.setBetAmount(bets[num - 1]);
                    }
                    return;
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [gameState, uiState, phase, isRegistered, sortedGames]);
};
