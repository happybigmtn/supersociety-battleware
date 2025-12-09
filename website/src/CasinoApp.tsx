import React, { useState, useRef } from 'react';
import { GameType } from './types';
import { useTerminalGame } from './hooks/useTerminalGame';
import { useKeyboardControls } from './hooks/useKeyboardControls';

// Components
import { Header, Sidebar, Footer, CommandPalette, CustomBetOverlay, HelpOverlay, TournamentAlert } from './components/casino/Layout';
import { RegistrationView } from './components/casino/RegistrationView';
import { ActiveGame } from './components/casino/ActiveGame';
import { ErrorBoundary } from './components/ErrorBoundary';

// Menu
const SORTED_GAMES = Object.values(GameType).filter(g => g !== GameType.NONE).sort();

export default function CasinoApp() {
  const { stats, gameState, setGameState, deck, aiAdvice, tournamentTime, phase, leaderboard, isRegistered, lastTxSig, botConfig, setBotConfig, actions } = useTerminalGame();

  // UI State
  const [commandOpen, setCommandOpen] = useState(false);
  const [customBetOpen, setCustomBetOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpDetail, setHelpDetail] = useState<string | null>(null);
  const [customBetString, setCustomBetString] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [leaderboardView, setLeaderboardView] = useState<'RANK' | 'PAYOUT'>('RANK');
  const [numberInputString, setNumberInputString] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);
  const customBetRef = useRef<HTMLInputElement>(null);

  // Keyboard
  useKeyboardControls({
      gameState,
      uiState: { commandOpen, customBetOpen, helpOpen, searchQuery },
      uiActions: {
          setCommandOpen, setCustomBetOpen, setHelpOpen, setHelpDetail, setSearchQuery,
          setCustomBetString, setNumberInputString,
          startGame: actions.startGame,
          setBetAmount: actions.setBetAmount
      },
      gameActions: { ...actions, setGameState },
      phase,
      isRegistered,
      inputRefs: { input: inputRef, customBet: customBetRef },
      sortedGames: SORTED_GAMES
  });

  // Handle Enter in Inputs
  const handleCommandEnter = () => {
      const match = SORTED_GAMES.find(g => g.toLowerCase().includes(searchQuery.toLowerCase()));
      if (match) actions.startGame(match as GameType);
      setCommandOpen(false);
      setSearchQuery("");
  };
  const handleCustomBetEnter = () => {
      const val = parseInt(customBetString);
      if (!isNaN(val) && val > 0) actions.setBetAmount(val);
      setCustomBetOpen(false); setCustomBetString("");
  };
  const handleNumberInputEnter = () => {
      const val = parseInt(numberInputString);
      if (!isNaN(val)) {
          if (gameState.type === GameType.ROULETTE) actions.placeRouletteBet('STRAIGHT', val);
          if (gameState.type === GameType.SIC_BO) actions.placeSicBoBet('SUM', val);
      }
      setNumberInputString("");
      setGameState((prev) => ({ ...prev, rouletteInputMode: 'NONE', sicBoInputMode: 'NONE' }));
  };

  if (phase === 'REGISTRATION') {
      return (
          <RegistrationView
              stats={stats}
              leaderboard={leaderboard}
              isRegistered={isRegistered}
              timeLeft={tournamentTime}
              onRegister={actions.registerForTournament}
              botConfig={botConfig}
              onBotConfigChange={setBotConfig}
          />
      );
  }

  return (
    <div className="flex flex-col h-screen w-screen bg-terminal-black text-white font-mono overflow-hidden select-none" onKeyDown={(e) => {
        if (e.key === 'Enter') {
            if (commandOpen) handleCommandEnter();
            if (customBetOpen) handleCustomBetEnter();
            if (gameState.rouletteInputMode === 'NUMBER' || gameState.sicBoInputMode === 'SUM') handleNumberInputEnter();
        }
        if (e.key.toLowerCase() === 'l' && !commandOpen && !customBetOpen) setLeaderboardView(prev => prev === 'RANK' ? 'PAYOUT' : 'RANK');
    }}>
       <Header
           phase={phase}
           tournamentTime={tournamentTime}
           stats={stats}
           lastTxSig={lastTxSig ?? undefined}
       />

       <div className="flex flex-1 overflow-hidden relative">
          <main className="flex-1 flex flex-col relative bg-terminal-black p-4">
             <TournamentAlert tournamentTime={tournamentTime} />
             <ErrorBoundary>
               <ActiveGame
                  gameState={gameState}
                  deck={deck}
                  numberInput={numberInputString}
                  onToggleHold={actions.toggleHold}
                  aiAdvice={aiAdvice}
               />
             </ErrorBoundary>
          </main>
          <Sidebar leaderboard={leaderboard} history={stats.history} viewMode={leaderboardView} currentChips={stats.chips} />
       </div>

       {gameState.type !== GameType.NONE && <Footer currentBet={gameState.bet} />}

       {/* MODALS */}
       <CommandPalette
            isOpen={commandOpen}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            sortedGames={SORTED_GAMES}
            onSelectGame={(g) => {
                actions.startGame(g as GameType);
                setCommandOpen(false);
                setSearchQuery("");
            }}
            inputRef={inputRef}
       />

       <CustomBetOverlay
           isOpen={customBetOpen}
           betString={customBetString}
           inputRef={customBetRef}
       />

       <HelpOverlay
           isOpen={helpOpen}
           onClose={() => {
               setHelpOpen(false);
               setHelpDetail(null);
           }}
           gameType={gameState.type}
           detail={helpDetail}
       />
    </div>
  );
}
