
import React from 'react';
import { GameState } from '../../types';
import { Hand } from '../GameComponents';
import { getVisibleHandValue } from '../../utils/gameUtils';

export const BlackjackView: React.FC<{ gameState: GameState }> = ({ gameState }) => {
    return (
        <>
            <div className="flex-1 w-full flex flex-col items-center justify-center gap-8 relative z-10 pb-20">
                <h1 className="absolute top-0 text-xl font-bold text-gray-500 tracking-widest uppercase">BLACKJACK</h1>
                {/* Dealer Area */}
                <div className="min-h-[120px] flex items-center justify-center opacity-75">
                    {gameState.dealerCards.length > 0 ? (
                        <div className="flex flex-col items-center gap-2">
                            <span className="text-lg font-bold tracking-widest text-terminal-accent">DEALER</span>
                            <Hand 
                                cards={gameState.dealerCards} 
                                title={`(${getVisibleHandValue(gameState.dealerCards)})`}
                                forcedColor="text-terminal-accent"
                            />
                        </div>
                    ) : (
                        <div className="flex flex-col items-center gap-2">
                             <span className="text-lg font-bold tracking-widest text-terminal-accent">DEALER</span>
                             <div className="w-16 h-24 border border-dashed border-terminal-accent rounded" />
                        </div>
                    )}
                </div>

                {/* Center Info */}
                <div className="text-center space-y-3 relative z-20">
                        <div className="text-2xl font-bold text-white tracking-widest animate-pulse">
                            {gameState.message}
                        </div>
                </div>

                {/* Player Area - Highlighted */}
                <div className="min-h-[120px] flex gap-8 items-center justify-center">
                    {/* Finished Split Hands */}
                    {gameState.completedHands.length > 0 && gameState.stage !== 'RESULT' && (
                            <div className="flex gap-2 opacity-50 scale-75 origin-right">
                            {gameState.completedHands.map((h, i) => <Hand key={i} cards={h.cards} title={`HAND ${i+1}`} forcedColor="text-terminal-green" />)}
                            </div>
                    )}

                    <div className="flex flex-col items-center gap-2 scale-110 transition-transform">
                        <span className="text-lg font-bold tracking-widest text-terminal-green">YOU</span>
                        {gameState.playerCards.length > 0 ? (
                             <Hand 
                                cards={gameState.playerCards} 
                                title={`(${getVisibleHandValue(gameState.playerCards)})`} 
                                forcedColor="text-terminal-green"
                            />
                        ) : (
                            <div className="w-16 h-24 border border-dashed border-terminal-green/50 rounded" />
                        )}
                    </div>

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

            {/* CONTROLS */}
            <div className="absolute bottom-8 left-0 right-0 h-16 bg-terminal-black/90 border-t border-terminal-dim flex items-center justify-center gap-2 p-2 z-40">
                    {(gameState.stage === 'BETTING' || gameState.stage === 'RESULT') ? (
                        <>
                             <div className="flex gap-2">
                                 <div className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${gameState.activeModifiers.shield ? 'border-cyan-400 text-cyan-400' : 'border-gray-700 text-gray-500'}`}>
                                    <span className="font-bold text-sm">Z</span>
                                    <span className="text-[10px]">SHIELD</span>
                                </div>
                                 <div className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${gameState.activeModifiers.double ? 'border-purple-400 text-purple-400' : 'border-gray-700 text-gray-500'}`}>
                                    <span className="font-bold text-sm">X</span>
                                    <span className="text-[10px]">DOUBLE</span>
                                </div>
                            </div>
                            <div className="w-px h-8 bg-gray-800 mx-2"></div>
                            <div className="flex flex-col items-center border border-terminal-green/50 rounded bg-black/50 px-3 py-1 w-24">
                                <span className="text-terminal-green font-bold text-sm">SPACE</span>
                                <span className="text-[10px] text-gray-500">DEAL</span>
                            </div>
                        </>
                    ) : (
                        <div className="flex gap-2">
                            <div className="flex flex-col items-center border border-terminal-green/50 rounded bg-black/50 px-3 py-1">
                                <span className="text-terminal-green font-bold text-sm">H</span>
                                <span className="text-[10px] text-gray-500">HIT</span>
                            </div>
                            <div className="flex flex-col items-center border border-terminal-accent/50 rounded bg-black/50 px-3 py-1">
                                <span className="text-terminal-accent font-bold text-sm">S</span>
                                <span className="text-[10px] text-gray-500">STAND</span>
                            </div>
                            <div className="flex flex-col items-center border border-terminal-gold/50 rounded bg-black/50 px-3 py-1">
                                <span className="text-terminal-gold font-bold text-sm">D</span>
                                <span className="text-[10px] text-gray-500">DOUBLE</span>
                            </div>
                            <div className="flex flex-col items-center border border-terminal-dim rounded bg-black/50 px-3 py-1">
                                <span className="text-white font-bold text-sm">P</span>
                                <span className="text-[10px] text-gray-500">SPLIT</span>
                            </div>
                        </div>
                    )}
            </div>
        </>
    );
};
