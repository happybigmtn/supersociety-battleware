import React from 'react';
import { GameState } from '../../../types';
import { Hand } from '../../shared/GameElements';
import { getBaccaratValue } from '../../../utils/gameUtils';

interface BaccaratBoardProps {
    gameState: GameState;
}

export const BaccaratBoard: React.FC<BaccaratBoardProps> = ({ gameState }) => {
    return (
        <>
            <div className="flex-1 w-full flex flex-col items-center justify-center gap-8 relative z-10">
                 {/* Dealer Area (Banker) */}
                 <div className="min-h-[120px] flex items-center justify-center">
                    {gameState.dealerCards.length > 0 ? (
                        <Hand 
                            cards={gameState.dealerCards} 
                            title={`BANKER (${getBaccaratValue(gameState.dealerCards)})`}
                        />
                    ) : (
                        <div className="flex flex-col gap-2 items-center">
                            <span className="text-xs uppercase tracking-widest text-gray-500">BANKER</span>
                            <div className="w-16 h-24 border border-dashed border-gray-800 rounded flex items-center justify-center text-gray-800">?</div>
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
                         {gameState.stage === 'BETTING' && (
                           <div className="flex gap-4 mt-2">
                                <div className="flex items-center gap-2 border border-gray-800 rounded px-2">
                                   <span className={gameState.baccaratSelection === 'PLAYER' ? 'text-terminal-green font-bold' : 'text-gray-600'}>[P]LAYER</span>
                                   <span className="text-gray-700">/</span>
                                   <span className={gameState.baccaratSelection === 'BANKER' ? 'text-terminal-green font-bold' : 'text-gray-600'}>[B]ANKER</span>
                                </div>
                           </div>
                         )}
                     </div>
                 </div>

                 {/* Player Area */}
                 <div className="min-h-[120px] flex gap-8 items-center justify-center">
                    {gameState.playerCards.length > 0 ? (
                        <Hand 
                            cards={gameState.playerCards} 
                            title={`PLAYER (${getBaccaratValue(gameState.playerCards)})`} 
                        />
                    ) : (
                        <div className="flex flex-col gap-2 items-center">
                            <span className="text-xs uppercase tracking-widest text-gray-500">PLAYER</span>
                            <div className="w-16 h-24 border border-dashed border-gray-800 rounded flex items-center justify-center text-gray-800">?</div>
                        </div>
                    )}
                 </div>
            </div>

            {/* BACCARAT ACTIVE BETS OVERLAY (Right) */}
            {gameState.baccaratBets.length > 0 && (
                <div className="absolute top-0 right-0 bottom-16 w-36 bg-terminal-black/80 border-l border-terminal-dim p-2 backdrop-blur-sm z-30 flex flex-col">
                    <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-2 border-b border-gray-800 pb-1 flex-none text-center">Side Bets</div>
                    <div className="flex-1 overflow-y-auto flex flex-col justify-center space-y-1">
                        {gameState.baccaratBets.map((b, i) => (
                            <div key={i} className="flex justify-between items-center text-xs border border-gray-800 p-1 rounded bg-black/50">
                                <span className="text-terminal-green font-bold text-[10px]">{b.type}</span>
                                <div className="text-white text-[10px]">${b.amount}</div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </>
    );
};
