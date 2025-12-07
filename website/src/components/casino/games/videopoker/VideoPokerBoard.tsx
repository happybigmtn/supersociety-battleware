import React from 'react';
import { GameState } from '../../../types';
import { Hand } from '../../shared/GameElements';
import { getHandValue } from '../../../utils/gameUtils';

interface VideoPokerBoardProps {
    gameState: GameState;
}

export const VideoPokerBoard: React.FC<VideoPokerBoardProps> = ({ gameState }) => {
    const getVisibleHandValue = (cards: any[]) => {
        return getHandValue(cards.filter(c => !c.isHidden));
    };

    return (
        <div className="flex-1 w-full flex flex-col items-center justify-center gap-8 relative z-10">
             {/* Center Info */}
             <div className="text-center space-y-3 relative z-20">
                 <div className="text-2xl font-bold text-white tracking-widest animate-pulse">
                     {gameState.message}
                 </div>
                 <div className="text-sm text-gray-500 flex flex-col items-center gap-1">
                     <span>POT/BET SIZE: ${gameState.bet.toLocaleString()}</span>
                 </div>
             </div>

             {/* Player Area */}
             <div className="min-h-[120px] flex gap-8 items-center justify-center">
                {gameState.playerCards.length > 0 && (
                    <Hand 
                        cards={gameState.playerCards} 
                        title={`YOU (${getVisibleHandValue(gameState.playerCards)})`} 
                    />
                )}
             </div>
        </div>
    );
};
