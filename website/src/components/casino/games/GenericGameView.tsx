
import React, { useMemo } from 'react';
import { GameState, GameType } from '../../../types';
import { Hand } from '../GameComponents';
import { getVisibleHandValue } from '../../../utils/gameUtils';

export const GenericGameView = React.memo<{ gameState: GameState }>(({ gameState }) => {
    const dealerValue = useMemo(() => getVisibleHandValue(gameState.dealerCards), [gameState.dealerCards]);
    const playerValue = useMemo(() => getVisibleHandValue(gameState.playerCards), [gameState.playerCards]);
    const gameTitle = useMemo(() => gameState.type.replace(/_/g, ' '), [gameState.type]);
    const isWarState = useMemo(() => gameState.type === GameType.CASINO_WAR && gameState.message.includes('WAR'), [gameState.type, gameState.message]);
    return (
        <>
            <div className="flex-1 w-full flex flex-col items-center justify-center gap-8 relative z-10 pb-20">
                <h1 className="absolute top-0 text-xl font-bold text-gray-500 tracking-widest uppercase">{gameTitle}</h1>
                {/* Dealer/Opponent */}
                <div className="min-h-[120px] flex items-center justify-center opacity-75">
                    {gameState.dealerCards.length > 0 ? (
                        <div className="flex flex-col items-center gap-2">
                            <span className="text-lg font-bold tracking-widest text-terminal-accent">DEALER</span>
                            <Hand
                                cards={gameState.dealerCards}
                                title={`(${dealerValue})`}
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
                    <div className="text-2xl font-bold text-terminal-gold tracking-widest animate-pulse">
                        {gameState.message}
                    </div>
                </div>

                {/* Player */}
                <div className="min-h-[120px] flex gap-8 items-center justify-center">
                     <div className="flex flex-col items-center gap-2 scale-110">
                        <span className="text-lg font-bold tracking-widest text-terminal-green">YOU</span>
                        {gameState.playerCards.length > 0 ? (
                            <Hand
                                cards={gameState.playerCards}
                                title={`(${playerValue})`}
                                forcedColor="text-terminal-green"
                            />
                        ) : (
                            <div className="w-16 h-24 border border-dashed border-terminal-green/50 rounded" />
                        )}
                    </div>
                </div>
            </div>

            {/* CONTROLS */}
             <div className="absolute bottom-8 left-0 right-0 h-16 bg-terminal-black/90 border-t-2 border-gray-700 flex items-center justify-center gap-2 p-2 z-40">
                 {isWarState ? (
                    <>
                        <div className="flex flex-col items-center border border-terminal-green/50 rounded bg-black/50 px-3 py-1">
                            <span className="text-terminal-green font-bold text-sm">W</span>
                            <span className="text-[10px] text-gray-500">WAR</span>
                        </div>
                        <div className="flex flex-col items-center border border-terminal-accent/50 rounded bg-black/50 px-3 py-1">
                            <span className="text-terminal-accent font-bold text-sm">S</span>
                            <span className="text-[10px] text-gray-500">SURRENDER</span>
                        </div>
                    </>
                 ) : (
                    <div className="flex flex-col items-center border border-terminal-green/50 rounded bg-black/50 px-3 py-1 w-24">
                        <span className="text-terminal-green font-bold text-sm">SPACE</span>
                        <span className="text-[10px] text-gray-500">DEAL</span>
                    </div>
                 )}
             </div>
        </>
    );
});
