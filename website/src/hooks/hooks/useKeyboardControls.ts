
import { useEffect } from 'react';
import { GameType } from '../types';

interface KeyboardControlsProps {
  gameState: any;
  uiState: { commandOpen: boolean; customBetOpen: boolean; helpOpen: boolean; searchQuery: string };
  uiActions: {
      setCommandOpen: (v: boolean) => void;
      setCustomBetOpen: (v: boolean) => void;
      setHelpOpen: (v: any) => void;
      setHelpDetail: (v: any) => void;
      setSearchQuery: (v: string) => void;
      setCustomBetString: (v: any) => void;
      setNumberInputString: (v: any) => void;
      startGame: (g: GameType) => void;
      setBetAmount: (n: number) => void;
  };
  gameActions: any;
  phase: string;
  isRegistered: boolean;
  inputRefs: { input: any; customBet: any };
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
                gameActions.setGameState((prev: any) => ({ ...prev, crapsInputMode: 'NONE', rouletteInputMode: 'NONE', sicBoInputMode: 'NONE' }));
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

            // Bet Amounts (1-9)
            const bets = [0, 1, 5, 25, 100, 500, 1000, 5000, 10000, 50000];
            const num = parseInt(e.key);
            if (!isNaN(num)) {
                if (num === 0) {
                    uiActions.setCustomBetOpen(true);
                    setTimeout(() => inputRefs.customBet.current?.focus(), 10);
                } else {
                    uiActions.setBetAmount(bets[num]);
                }
                return;
            }

            // Specific Game Keys
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
                if (['1','2','3','4','5'].includes(k)) gameActions.toggleHold(parseInt(k)-1);
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
                if (k === '0') gameActions.placeRouletteBet('ZERO');
                if (k === 't') gameActions.rebetRoulette();
                if (k === 'u') gameActions.undoRouletteBet();
            } else if (gameState.type === GameType.THREE_CARD) {
                if (k === 'p') gameActions.threeCardPlay();
                if (k === 'f') gameActions.threeCardFold();
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
                if (k === 'p') gameActions.placeCrapsBet(gameState.crapsPoint ? 'COME' : 'PASS');
                if (k === 'd') gameActions.placeCrapsBet(gameState.crapsPoint ? 'DONT_COME' : 'DONT_PASS');
                if (k === 'f') gameActions.placeCrapsBet('FIELD');
                if (k === 'o') gameActions.addCrapsOdds();
                if (k === 'u') gameActions.undoCrapsBet();
            } else if (gameState.type === GameType.SIC_BO) {
                if (k === 's') gameActions.placeSicBoBet('SMALL');
                if (k === 'b') gameActions.placeSicBoBet('BIG');
                if (k === 'a') gameActions.placeSicBoBet('TRIPLE_ANY');
                if (k === 't') gameActions.rebetSicBo();
                if (k === 'u') gameActions.undoSicBoBet();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [gameState, uiState, phase, isRegistered, sortedGames]);
};
