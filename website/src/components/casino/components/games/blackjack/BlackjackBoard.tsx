import React from 'react';
import { GameState } from '../../../types';
import { Hand } from '../../shared/GameElements';
import { getHandValue } from '../../../utils/gameUtils';

interface BlackjackBoardProps {
    gameState: GameState;
}

export const BlackjackBoard: React.FC<BlackjackBoardProps> = ({ gameState }) => {
    const getVisibleHandValue = (cards: any[]) => {
        return getHandValue(cards.filter(c => !c.isHidden));
    };

    return (
        <div className="flex-1 w-full flex flex-col items-center justify-center gap-8 relative z-10">
             {/* Dealer Area */}
             <div className="min-h-[120px] flex items-center justify-center">
                {gameState.dealerCards.length > 0 && (
                    <Hand 
                        cards={gameState.dealerCards} 
                        title={`DEALER (${getVisibleHandValue(gameState.dealerCards)})`}
                    />
                )}
             </div>
             
             {/* Center Info */}
             <div className="text-center space-y-3 relative z-20">
                 <div className="text-2xl font-bold text-white tracking-widest animate-pulse">
                     {gameState.message}
                 </div>
                 <div className="text-sm text-gray-500 flex flex-col items-center gap-1">
                     <span>POT/BET SIZE: ${gameState.bet.toLocaleString()} {gameState.insuranceBet > 0 && `(+${gameState.insuranceBet} INS)`}</span>
                 </div>
             </div>

             {/* Player Area */}
             <div className="min-h-[120px] flex gap-8 items-center justify-center">
                {/* Completed Split Hands */}
                {gameState.completedHands.length > 0 && gameState.stage !== 'RESULT' && (
                     <div className="flex gap-2 opacity-50 scale-75 origin-right">
                        {gameState.completedHands.map((h, i) => <Hand key={i} cards={h.cards} title={`HAND ${i+1}`} />)}
                     </div>
                )}
                
                {/* Active Hand */}
                {gameState.playerCards.length > 0 && (
                    <Hand 
                        cards={gameState.playerCards} 
                        title={`YOU (${getVisibleHandValue(gameState.playerCards)})`} 
                    />
                )}
                
                {/* Pending Split Hands */}
                {gameState.blackjackStack.length > 0 && (
                     <div className="flex gap-2 opacity-50 scale-75 origin-left">
                        {gameState.blackjackStack.map((h, i) => (
                            <div key={i} className="w-12 h-16 bg-terminal-dim border border-gray-700 rounded flex items-center justify-center">
                                <span className="text-xs text-gray-500">WAIT</span>
                            </div>
                        ))}
                     </div>
                )}
             </div>
        </div>
    );
};
