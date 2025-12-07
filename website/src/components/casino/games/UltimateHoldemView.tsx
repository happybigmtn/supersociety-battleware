
import React from 'react';
import { GameState } from '../../types';
import { Hand } from '../GameComponents';

interface UltimateHoldemViewProps {
    gameState: GameState;
}

// Helper to describe the current betting stage
const getStageDescription = (stage: string, communityCards: number): string => {
    if (stage === 'BETTING') return 'ANTE + BLIND';
    if (communityCards === 0) return 'PRE-FLOP';
    if (communityCards === 3) return 'FLOP';
    if (communityCards === 5) return 'RIVER';
    return '';
};

export const UltimateHoldemView: React.FC<UltimateHoldemViewProps> = ({ gameState }) => {
    const stageDesc = getStageDescription(gameState.stage, gameState.communityCards.length);
    const showDealerCards = gameState.stage === 'RESULT' || gameState.dealerCards.every(c => !c.isHidden);

    return (
        <>
            <div className="flex-1 w-full flex flex-col items-center justify-center gap-6 relative z-10 pb-20">
                <h1 className="absolute top-0 text-xl font-bold text-gray-500 tracking-widest uppercase">ULTIMATE TEXAS HOLD'EM</h1>

                {/* Dealer Area */}
                <div className="min-h-[100px] flex items-center justify-center opacity-75">
                    {gameState.dealerCards.length > 0 ? (
                        <div className="flex flex-col items-center gap-2">
                            <span className="text-lg font-bold tracking-widest text-terminal-accent">DEALER</span>
                            <Hand
                                cards={gameState.dealerCards}
                                forcedColor="text-terminal-accent"
                            />
                        </div>
                    ) : (
                        <div className="flex flex-col items-center gap-2">
                            <span className="text-lg font-bold tracking-widest text-terminal-accent">DEALER</span>
                            <div className="flex gap-2">
                                {[0, 1].map(i => (
                                    <div key={i} className="w-12 h-16 border border-dashed border-terminal-accent/50 rounded" />
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                {/* Community Cards */}
                <div className="flex flex-col items-center gap-2">
                    <span className="text-xs uppercase tracking-widest text-gray-500">COMMUNITY</span>
                    <div className="flex gap-2">
                        {gameState.communityCards.length > 0 ? (
                            <Hand cards={gameState.communityCards} />
                        ) : (
                            [0, 1, 2, 3, 4].map(i => (
                                <div key={i} className="w-12 h-16 border border-dashed border-gray-700 rounded" />
                            ))
                        )}
                    </div>
                </div>

                {/* Center Info */}
                <div className="text-center space-y-2 relative z-20">
                    <div className="text-xl font-bold text-white tracking-widest animate-pulse">
                        {gameState.message}
                    </div>
                    <div className="text-xs text-gray-500 flex gap-4 justify-center">
                        <span>ANTE: ${gameState.bet}</span>
                        <span>BLIND: ${gameState.bet}</span>
                        <span className="text-terminal-gold">{stageDesc}</span>
                    </div>
                </div>

                {/* Player Area */}
                <div className="min-h-[100px] flex gap-8 items-center justify-center">
                    {gameState.playerCards.length > 0 ? (
                        <div className="flex flex-col items-center gap-2 scale-110">
                            <span className="text-lg font-bold tracking-widest text-terminal-green">YOU</span>
                            <Hand
                                cards={gameState.playerCards}
                                forcedColor="text-terminal-green"
                            />
                        </div>
                    ) : (
                        <div className="flex flex-col items-center gap-2 scale-110">
                            <span className="text-lg font-bold tracking-widest text-terminal-green">YOU</span>
                            <div className="flex gap-2">
                                {[0, 1].map(i => (
                                    <div key={i} className="w-12 h-16 border border-dashed border-terminal-green/50 rounded" />
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Blind Payouts Sidebar */}
            <div className="absolute top-0 left-0 bottom-24 w-36 bg-terminal-black/80 border-r border-terminal-dim p-2 overflow-y-auto backdrop-blur-sm z-30 flex flex-col">
                <h3 className="text-[10px] font-bold text-gray-500 mb-2 tracking-widest text-center border-b border-gray-800 pb-1 flex-none">BLIND BONUS</h3>
                <div className="flex-1 flex flex-col justify-center space-y-2 text-[10px]">
                    <div className="flex justify-between"><span className="text-gray-400">Royal Flush</span><span className="text-terminal-gold">500:1</span></div>
                    <div className="flex justify-between"><span className="text-gray-400">Straight Flush</span><span className="text-terminal-gold">50:1</span></div>
                    <div className="flex justify-between"><span className="text-gray-400">Four of Kind</span><span className="text-terminal-gold">10:1</span></div>
                    <div className="flex justify-between"><span className="text-gray-400">Full House</span><span className="text-terminal-gold">3:1</span></div>
                    <div className="flex justify-between"><span className="text-gray-400">Flush</span><span className="text-terminal-gold">3:2</span></div>
                    <div className="flex justify-between"><span className="text-gray-400">Straight</span><span className="text-terminal-gold">1:1</span></div>
                    <div className="border-t border-gray-800 pt-2 mt-2">
                        <div className="text-[9px] text-gray-500 italic">Dealer must have pair or better to qualify</div>
                    </div>
                </div>
            </div>

            {/* Betting Guide Sidebar */}
            <div className="absolute top-0 right-0 bottom-24 w-36 bg-terminal-black/80 border-l border-terminal-dim p-2 backdrop-blur-sm z-30 flex flex-col">
                <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-2 border-b border-gray-800 pb-1 flex-none text-center">Betting</div>
                <div className="flex-1 overflow-y-auto flex flex-col justify-center space-y-2 text-[9px] text-gray-400">
                    <div className="border-b border-gray-800 pb-2">
                        <div className="text-terminal-green mb-1">PRE-FLOP</div>
                        <div>• Check OR</div>
                        <div>• Bet 3x/4x Ante</div>
                    </div>
                    <div className="border-b border-gray-800 pb-2">
                        <div className="text-terminal-green mb-1">FLOP</div>
                        <div>• Check OR</div>
                        <div>• Bet 2x Ante</div>
                    </div>
                    <div>
                        <div className="text-terminal-green mb-1">RIVER</div>
                        <div>• Fold OR</div>
                        <div>• Bet 1x Ante</div>
                    </div>
                </div>
            </div>

            {/* Controls */}
            <div className="absolute bottom-8 left-0 right-0 h-16 bg-terminal-black/90 border-t border-terminal-dim flex items-center justify-center gap-2 p-2 z-40">
                {gameState.stage === 'BETTING' && (
                    <div className="flex flex-col items-center border border-terminal-green/50 rounded bg-black/50 px-3 py-1 w-24">
                        <span className="text-terminal-green font-bold text-sm">SPACE</span>
                        <span className="text-[10px] text-gray-500">DEAL</span>
                    </div>
                )}
                {gameState.stage === 'PLAYING' && gameState.communityCards.length === 0 && (
                    <>
                        <div className="flex flex-col items-center border border-gray-700 rounded bg-black/50 px-3 py-1">
                            <span className="text-white font-bold text-sm">C</span>
                            <span className="text-[10px] text-gray-500">CHECK</span>
                        </div>
                        <div className="w-px h-8 bg-gray-800 mx-2"></div>
                        <div className="flex flex-col items-center border border-terminal-gold rounded bg-black/50 px-3 py-1">
                            <span className="text-terminal-gold font-bold text-sm">4</span>
                            <span className="text-[10px] text-gray-500">BET 4X</span>
                        </div>
                        <div className="flex flex-col items-center border border-terminal-gold rounded bg-black/50 px-3 py-1">
                            <span className="text-terminal-gold font-bold text-sm">3</span>
                            <span className="text-[10px] text-gray-500">BET 3X</span>
                        </div>
                    </>
                )}
                {gameState.stage === 'PLAYING' && gameState.communityCards.length === 3 && (
                    <>
                        <div className="flex flex-col items-center border border-gray-700 rounded bg-black/50 px-3 py-1">
                            <span className="text-white font-bold text-sm">C</span>
                            <span className="text-[10px] text-gray-500">CHECK</span>
                        </div>
                        <div className="w-px h-8 bg-gray-800 mx-2"></div>
                        <div className="flex flex-col items-center border border-terminal-gold rounded bg-black/50 px-3 py-1">
                            <span className="text-terminal-gold font-bold text-sm">2</span>
                            <span className="text-[10px] text-gray-500">BET 2X</span>
                        </div>
                    </>
                )}
                {gameState.stage === 'PLAYING' && gameState.communityCards.length === 5 && (
                    <>
                        <div className="flex flex-col items-center border border-terminal-accent rounded bg-black/50 px-3 py-1">
                            <span className="text-terminal-accent font-bold text-sm">F</span>
                            <span className="text-[10px] text-gray-500">FOLD</span>
                        </div>
                        <div className="w-px h-8 bg-gray-800 mx-2"></div>
                        <div className="flex flex-col items-center border border-terminal-gold rounded bg-black/50 px-3 py-1">
                            <span className="text-terminal-gold font-bold text-sm">1</span>
                            <span className="text-[10px] text-gray-500">BET 1X</span>
                        </div>
                    </>
                )}
                {gameState.stage === 'RESULT' && (
                    <div className="flex flex-col items-center border border-terminal-green/50 rounded bg-black/50 px-3 py-1 w-24">
                        <span className="text-terminal-green font-bold text-sm">SPACE</span>
                        <span className="text-[10px] text-gray-500">NEW HAND</span>
                    </div>
                )}
            </div>
        </>
    );
};
