
import React from 'react';
import { GameState, GameType, Card } from '../types';
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

interface ActiveGameProps {
  gameState: GameState;
  deck: Card[];
  numberInput: string;
  onToggleHold: (index: number) => void;
  aiAdvice: string | null;
}

export const ActiveGame: React.FC<ActiveGameProps> = ({ gameState, deck, numberInput, onToggleHold, aiAdvice }) => {
  if (gameState.type === GameType.NONE) {
     return (
         <div className="flex-1 flex items-center justify-center">
             <div className="text-2xl font-bold text-gray-500 tracking-widest animate-pulse">
                 TYPE '/' FOR FUN
             </div>
         </div>
     );
  }

  return (
    <>
         {gameState.type === GameType.BLACKJACK && <BlackjackView gameState={gameState} />}
         {gameState.type === GameType.CRAPS && <CrapsView gameState={gameState} />}
         {gameState.type === GameType.BACCARAT && <BaccaratView gameState={gameState} />}
         {gameState.type === GameType.ROULETTE && <RouletteView gameState={gameState} numberInput={numberInput} />}
         {gameState.type === GameType.SIC_BO && <SicBoView gameState={gameState} numberInput={numberInput} />}
         {gameState.type === GameType.HILO && <HiLoView gameState={gameState} deck={deck} />}
         {gameState.type === GameType.VIDEO_POKER && (
             <VideoPokerView gameState={gameState} onToggleHold={onToggleHold} />
         )}
         {gameState.type === GameType.THREE_CARD && <ThreeCardPokerView gameState={gameState} />}
         {gameState.type === GameType.ULTIMATE_HOLDEM && <UltimateHoldemView gameState={gameState} />}

         {gameState.type === GameType.CASINO_WAR && (
             <GenericGameView gameState={gameState} />
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
