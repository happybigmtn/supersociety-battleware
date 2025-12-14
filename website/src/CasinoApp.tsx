import React, { useEffect, useState, useRef } from 'react';
import { GameType } from './types';
import { useTerminalGame } from './hooks/useTerminalGame';
import { useKeyboardControls } from './hooks/useKeyboardControls';
import { PlaySwapStakeTabs } from './components/PlaySwapStakeTabs';

// Components
import { Header, Sidebar, Footer, CommandPalette, CustomBetOverlay, HelpOverlay, TournamentAlert } from './components/casino/Layout';
import { ModeSelectView, type PlayMode } from './components/casino/ModeSelectView';
import { RegistrationView } from './components/casino/RegistrationView';
import { ActiveGame } from './components/casino/ActiveGame';
import { ErrorBoundary } from './components/ErrorBoundary';

// Menu
const SORTED_GAMES = Object.values(GameType).filter(g => g !== GameType.NONE).sort();

export default function CasinoApp() {
  // Mode selection (Cash vs Freeroll)
  const [playMode, setPlayMode] = useState<PlayMode | null>(null);

  const { stats, gameState, setGameState, deck, aiAdvice, tournamentTime, phase, leaderboard, isRegistered, lastTxSig, botConfig, setBotConfig, isFaucetClaiming, freerollActiveTimeLeft, freerollActivePrizePool, freerollActivePlayerCount, freerollNextStartIn, freerollNextTournamentId, freerollIsJoinedNext, tournamentsPlayedToday, actions } = useTerminalGame(playMode);

  // UI State
  const [commandOpen, setCommandOpen] = useState(false);
  const [customBetOpen, setCustomBetOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpDetail, setHelpDetail] = useState<string | null>(null);
  const [customBetString, setCustomBetString] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [leaderboardView, setLeaderboardView] = useState<'RANK' | 'PAYOUT'>('RANK');
  const [numberInputString, setNumberInputString] = useState("");
  const [focusMode, setFocusMode] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const customBetRef = useRef<HTMLInputElement>(null);

  // Keyboard
  useKeyboardControls({
      gameState,
      uiState: { commandOpen, customBetOpen, helpOpen, searchQuery, numberInputString },
      uiActions: {
          setCommandOpen, setCustomBetOpen, setHelpOpen, setHelpDetail, setSearchQuery,
          setCustomBetString, setNumberInputString,
          startGame: actions.startGame,
          setBetAmount: actions.setBetAmount
      },
      gameActions: { ...actions, setGameState },
      phase,
      playMode,
      isRegistered,
      inputRefs: { input: inputRef, customBet: customBetRef },
      sortedGames: SORTED_GAMES
  });

  // Ensure number input is cleared whenever a numeric-input mode opens.
  useEffect(() => {
    if (gameState.rouletteInputMode !== 'NONE' || gameState.sicBoInputMode !== 'NONE') {
      setNumberInputString('');
    }
  }, [gameState.rouletteInputMode, gameState.sicBoInputMode]);

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
          if (gameState.type === GameType.ROULETTE) {
              let betType: Parameters<typeof actions.placeRouletteBet>[0] | null = null;
              let valid = true;

              switch (gameState.rouletteInputMode) {
                  case 'STRAIGHT':
                      betType = 'STRAIGHT';
                      valid = val >= 0 && val <= 36;
                      break;
                  case 'SPLIT_H':
                      betType = 'SPLIT_H';
                      valid = val >= 1 && val <= 35 && val % 3 !== 0;
                      break;
                  case 'SPLIT_V':
                      betType = 'SPLIT_V';
                      valid = val >= 1 && val <= 33;
                      break;
                  case 'STREET':
                      betType = 'STREET';
                      valid = val >= 1 && val <= 34 && (val - 1) % 3 === 0;
                      break;
                  case 'CORNER':
                      betType = 'CORNER';
                      valid = val >= 1 && val <= 32 && val % 3 !== 0;
                      break;
                  case 'SIX_LINE':
                      betType = 'SIX_LINE';
                      valid = val >= 1 && val <= 31 && (val - 1) % 3 === 0;
                      break;
                  case 'NONE':
                      betType = null;
                      valid = false;
                      break;
              }

              if (betType && valid) {
                  actions.placeRouletteBet(betType, val);
              } else {
                  setGameState((prev) => ({ ...prev, message: "INVALID NUMBER" }));
              }
          }
          if (gameState.type === GameType.SIC_BO) actions.placeSicBoBet('SUM', val);
      }
      setNumberInputString("");
      setGameState((prev) => ({ ...prev, rouletteInputMode: 'NONE', sicBoInputMode: 'NONE' }));
  };

  if (playMode === null) {
      return <ModeSelectView onSelect={setPlayMode} />;
  }

  if (playMode === 'FREEROLL' && phase === 'REGISTRATION') {
      return (
          <RegistrationView
              stats={stats}
              leaderboard={leaderboard}
              isRegistered={isRegistered}
              activeTimeLeft={freerollActiveTimeLeft}
              nextStartIn={freerollNextStartIn}
              nextTournamentId={freerollNextTournamentId}
              isJoinedNext={freerollIsJoinedNext}
              tournamentsPlayedToday={tournamentsPlayedToday}
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
            if (gameState.rouletteInputMode !== 'NONE' || gameState.sicBoInputMode === 'SUM') handleNumberInputEnter();
        }
        if (e.key.toLowerCase() === 'l' && !commandOpen && !customBetOpen) setLeaderboardView(prev => prev === 'RANK' ? 'PAYOUT' : 'RANK');
    }}>
       <Header
           phase={phase}
           tournamentTime={playMode === 'FREEROLL' ? tournamentTime : 0}
           stats={stats}
           lastTxSig={lastTxSig ?? undefined}
           focusMode={focusMode}
           setFocusMode={setFocusMode}
           showTimer={playMode === 'FREEROLL'}
       />

       <div className="border-b border-gray-800 bg-terminal-black/90 backdrop-blur px-4 py-2 flex items-center justify-center">
           <PlaySwapStakeTabs />
       </div>

       <div className="flex flex-1 overflow-hidden relative">
          <main className={`flex-1 flex flex-col relative bg-terminal-black p-4 overflow-y-auto ${gameState.type !== GameType.NONE ? 'pb-20 md:pb-4' : ''}`}>
             {playMode === 'CASH' && (
                 <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border border-gray-800 rounded bg-gray-900/30 px-3 py-2">
                     <div className="text-[10px] text-gray-500 tracking-widest">
                         MODE: <span className="text-terminal-green">CASH</span>
                     </div>
                     <div className="flex items-center gap-2">
                         <button
                             className="text-[10px] border px-2 py-1 rounded bg-gray-900 border-gray-800 text-gray-300 hover:border-gray-600"
                             onClick={() => setPlayMode(null)}
                         >
                             CHANGE MODE
                         </button>
                         <button
                             className={`text-[10px] border px-2 py-1 rounded ${
                                 isFaucetClaiming
                                     ? 'bg-gray-800 border-gray-700 text-gray-500 cursor-not-allowed'
                                     : 'bg-terminal-green/20 border-terminal-green text-terminal-green hover:bg-terminal-green/30'
                             }`}
                             onClick={actions.claimFaucet}
                             disabled={isFaucetClaiming}
                         >
                             {isFaucetClaiming ? 'CLAIMING…' : 'DAILY FAUCET'}
                         </button>
                     </div>
                 </div>
             )}

             {playMode === 'FREEROLL' && <TournamentAlert tournamentTime={tournamentTime} />}
             <ErrorBoundary>
               <ActiveGame
                  gameState={gameState}
                  deck={deck}
                  numberInput={numberInputString}
                  onToggleHold={actions.toggleHold}
                  aiAdvice={aiAdvice}
                  actions={{ ...actions, setGameState }}
               />
             </ErrorBoundary>
          </main>
          {!focusMode && (
             <Sidebar
                leaderboard={leaderboard}
                history={stats.history}
                viewMode={leaderboardView}
                currentChips={stats.chips}
                prizePool={playMode === 'FREEROLL' ? (freerollActivePrizePool ?? undefined) : undefined}
                totalPlayers={playMode === 'FREEROLL' ? (freerollActivePlayerCount ?? undefined) : undefined}
                winnersPct={0.15}
             />
          )}
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
