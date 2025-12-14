
import React from 'react';
import { GameState, GameType, Card } from '../../types';
import { BlackjackView } from './games/BlackjackView';
import { CrapsView } from './games/CrapsView';
import { BaccaratView } from './games/BaccaratView';
import { RouletteView } from './games/RouletteView';
import { SicBoView } from './games/SicBoView';
import { HiLoView } from './games/HiLoView';
import { VideoPokerView } from './games/VideoPokerView';
import { ThreeCardPokerView } from './games/ThreeCardPokerView';
import { UltimateHoldemView } from './games/UltimateHoldemView';
import { GenericGameView } from './games/GenericGameView';
import { BigWinEffect } from './BigWinEffect';

interface ActiveGameProps {
  gameState: GameState;
  deck: Card[];
  numberInput: string;
  onToggleHold: (index: number) => void;
  aiAdvice: string | null;
  actions: any;
}

export const ActiveGame: React.FC<ActiveGameProps> = ({ gameState, deck, numberInput, onToggleHold, aiAdvice, actions }) => {
  if (gameState.type === GameType.NONE) {
     return (
         <div className="flex-1 flex flex-col items-center justify-center gap-4">
             <div className="text-[12rem] font-bold text-terminal-green leading-none animate-pulse cursor-pointer select-none" style={{ textShadow: '0 0 40px rgba(0, 255, 136, 0.5), 0 0 80px rgba(0, 255, 136, 0.3)' }}>
                 /
             </div>
             <div className="text-sm text-gray-600 tracking-[0.3em] uppercase">
                 press to play
             </div>
         </div>
     );
  }

  return (
    <>
         {gameState.superMode?.isActive && (
             <div className="absolute top-4 left-4 max-w-sm bg-terminal-black/90 border border-terminal-gold/50 p-3 rounded shadow-lg z-40 text-xs">
                 <div className="font-bold text-terminal-gold mb-1">SUPER MODE</div>
                 {Array.isArray(gameState.superMode.multipliers) && gameState.superMode.multipliers.length > 0 ? (
                     <div className="flex flex-wrap gap-1">
                         {gameState.superMode.multipliers.slice(0, 10).map((m, idx) => (
                             <span
                                 key={idx}
                                 className="px-2 py-0.5 rounded border border-terminal-gold/30 text-terminal-gold/90"
                             >
                                 {m.superType}:{m.id} x{m.multiplier}
                             </span>
                         ))}
                     </div>
                 ) : (
                     <div className="text-[10px] text-gray-400">Active</div>
                 )}
             </div>
         )}

         <BigWinEffect 
            amount={gameState.lastResult} 
            show={gameState.stage === 'RESULT' && gameState.lastResult > 0} 
            durationMs={gameState.type === GameType.BLACKJACK ? 500 : undefined}
         />

         {gameState.type === GameType.BLACKJACK && <BlackjackView gameState={gameState} actions={actions} />}
         {gameState.type === GameType.CRAPS && <CrapsView gameState={gameState} actions={actions} />}
         {gameState.type === GameType.BACCARAT && <BaccaratView gameState={gameState} actions={actions} />}
         {gameState.type === GameType.ROULETTE && <RouletteView gameState={gameState} numberInput={numberInput} actions={actions} />}
         {gameState.type === GameType.SIC_BO && <SicBoView gameState={gameState} numberInput={numberInput} actions={actions} />}
         {gameState.type === GameType.HILO && <HiLoView gameState={gameState} deck={deck} />}
         {gameState.type === GameType.VIDEO_POKER && (
             <VideoPokerView gameState={gameState} onToggleHold={onToggleHold} />
         )}
         {gameState.type === GameType.THREE_CARD && <ThreeCardPokerView gameState={gameState} actions={actions} />}
         {gameState.type === GameType.ULTIMATE_HOLDEM && <UltimateHoldemView gameState={gameState} actions={actions} />}

         {gameState.type === GameType.CASINO_WAR && (
             <GenericGameView gameState={gameState} actions={actions} />
         )}
         
         {aiAdvice && (
             <div className="absolute top-4 right-4 max-w-xs bg-terminal-black border border-terminal-accent p-4 rounded shadow-lg z-40 text-xs">
                 <div className="font-bold text-terminal-accent mb-1">AI ADVICE</div>
                 {aiAdvice}
             </div>
         )}
    </>
  );
};
