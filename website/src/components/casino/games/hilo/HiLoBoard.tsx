import React from 'react';
import { GameState, Card } from '../../../types';
import { Hand } from '../../shared/GameElements';
import { calculateHiLoProjection, getHiLoMultiplier } from '../../../utils/hiloUtils';

interface HiLoBoardProps {
    gameState: GameState;
    deck: Card[];
}

export const HiLoBoard: React.FC<HiLoBoardProps> = ({ gameState, deck }) => {
    const hiloProjections = calculateHiLoProjection(gameState, deck);

    return (
        <div className="flex-1 w-full flex flex-col items-center justify-center gap-8 relative z-10">
             {/* History */}
             <div className="min-h-[120px] flex items-center justify-center">
                {gameState.playerCards.length > 1 && (
                    <div className="flex flex-col items-center gap-2">
                        <span className="text-xs uppercase tracking-widest text-gray-500">HISTORY</span>
                        <div className="flex gap-2 opacity-50 scale-50">
                            {gameState.playerCards.slice(0, -1).slice(-5).map((c, i) => (
                                <Hand key={i} cards={[c]} />
                            ))}
                        </div>
                    </div>
                )}
             </div>

             {/* Center Info */}
             <div className="text-center space-y-3 relative z-20">
                 <div className="text-2xl font-bold text-white tracking-widest animate-pulse">
                     {gameState.message}
                 </div>
                 <div className="text-sm text-gray-500 flex flex-col items-center gap-1">
                     <span>POT/BET SIZE: ${gameState.bet.toLocaleString()}</span>
                 </div>
             </div>

             {/* Player Area (Active Card) */}
             <div className="min-h-[120px] flex gap-8 items-center justify-center">
                {gameState.playerCards.length > 0 && (
                    <div className="flex flex-col gap-2 items-center">
                        <span className="text-xs uppercase tracking-widest text-gray-500">CURRENT CARD</span>
                        <div className="flex items-center gap-4">
                            {/* LOWER PROJECTION */}
                            <div className="text-right opacity-80">
                                <div className="text-[10px] text-gray-500 uppercase">LOWER</div>
                                <div className="text-terminal-green font-bold text-sm">
                                    {getHiLoMultiplier(hiloProjections.low, gameState.hiloAccumulator)}
                                </div>
                            </div>

                            <Hand cards={[gameState.playerCards[gameState.playerCards.length - 1]]} />
                            
                            {/* HIGHER PROJECTION */}
                            <div className="text-left opacity-80">
                                <div className="text-[10px] text-gray-500 uppercase">HIGHER</div>
                                <div className="text-terminal-green font-bold text-sm">
                                    {getHiLoMultiplier(hiloProjections.high, gameState.hiloAccumulator)}
                                </div>
                            </div>
                        </div>
                        <div className="text-lg text-terminal-gold mt-2">POT: ${gameState.hiloAccumulator}</div>
                    </div>
                )}
             </div>
        </div>
    );
};
