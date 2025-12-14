
import React, { useMemo } from 'react';
import { GameState, GameType } from '../../../types';
import { Hand } from '../GameComponents';
import { getVisibleHandValue } from '../../../utils/gameUtils';

export const GenericGameView = React.memo<{ gameState: GameState; actions: any }>(({ gameState, actions }) => {
    const dealerValue = useMemo(() => getVisibleHandValue(gameState.dealerCards), [gameState.dealerCards]);
    const playerValue = useMemo(() => getVisibleHandValue(gameState.playerCards), [gameState.playerCards]);
    const gameTitle = useMemo(() => gameState.type.replace(/_/g, ' '), [gameState.type]);
    const isWarState = useMemo(() => gameState.type === GameType.CASINO_WAR && gameState.message.includes('WAR'), [gameState.type, gameState.message]);
    const isCasinoWarBetting = useMemo(() => gameState.type === GameType.CASINO_WAR && gameState.stage === 'BETTING', [gameState.type, gameState.stage]);
    const casinoWarTieBet = useMemo(() => gameState.casinoWarTieBet || 0, [gameState.casinoWarTieBet]);
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
             <div className="absolute bottom-8 left-0 right-0 h-16 bg-terminal-black/90 border-t-2 border-gray-700 flex items-center justify-start md:justify-center gap-2 p-2 z-40 overflow-x-auto">
                 {isWarState ? (
                    <>
                        <button
                            type="button"
                            onClick={actions?.casinoWarGoToWar}
                            className="flex flex-col items-center border border-terminal-green/50 rounded bg-black/50 px-3 py-1"
                        >
                            <span className="text-terminal-green font-bold text-sm">W</span>
                            <span className="text-[10px] text-gray-500">WAR</span>
                        </button>
                        <button
                            type="button"
                            onClick={actions?.casinoWarSurrender}
                            className="flex flex-col items-center border border-terminal-accent/50 rounded bg-black/50 px-3 py-1"
                        >
                            <span className="text-terminal-accent font-bold text-sm">S</span>
                            <span className="text-[10px] text-gray-500">SURRENDER</span>
                        </button>
                    </>
                 ) : (
                    <>
                        {isCasinoWarBetting && (
                            <>
	                                <button
	                                    type="button"
	                                    onClick={actions?.casinoWarToggleTieBet}
	                                    className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
	                                        casinoWarTieBet > 0
	                                            ? 'border-terminal-green bg-terminal-green/10 text-terminal-green'
	                                            : 'border-gray-700 text-gray-500'
	                                    }`}
	                                >
	                                    <span className="font-bold text-sm">T</span>
	                                    <span className="text-[10px]">TIE</span>
	                                </button>
                                <div className="w-px h-8 bg-gray-800 mx-2"></div>
                            </>
                        )}

                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={actions?.toggleShield}
                                className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
                                    gameState.activeModifiers.shield
                                        ? 'border-cyan-400 text-cyan-400'
                                        : 'border-gray-700 text-gray-500'
                                }`}
                            >
                                <span className="font-bold text-sm">Z</span>
                                <span className="text-[10px]">SHIELD</span>
                            </button>
                            <button
                                type="button"
                                onClick={actions?.toggleDouble}
                                className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
                                    gameState.activeModifiers.double
                                        ? 'border-purple-400 text-purple-400'
                                        : 'border-gray-700 text-gray-500'
                                }`}
                            >
                                <span className="font-bold text-sm">X</span>
                                <span className="text-[10px]">DOUBLE</span>
                            </button>
                            <button
                                type="button"
                                onClick={actions?.toggleSuper}
                                className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
                                    gameState.activeModifiers.super
                                        ? 'border-terminal-gold text-terminal-gold'
                                        : 'border-gray-700 text-gray-500'
                                }`}
                            >
                                <span className="font-bold text-sm">G</span>
                                <span className="text-[10px]">SUPER</span>
                            </button>
                        </div>

                        <div className="w-px h-8 bg-gray-800 mx-2"></div>
                        <button
                            type="button"
                            onClick={actions?.deal}
                            className="flex flex-col items-center border border-terminal-green/50 rounded bg-black/50 px-3 py-1 w-24"
                        >
                            <span className="text-terminal-green font-bold text-sm">SPACE</span>
                            <span className="text-[10px] text-gray-500">{gameState.stage === 'RESULT' ? 'NEW HAND' : 'DEAL'}</span>
                        </button>
                    </>
                 )}
             </div>
        </>
    );
});
