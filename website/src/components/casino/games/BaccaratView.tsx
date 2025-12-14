
import React, { useMemo } from 'react';
import { GameState } from '../../../types';
import { Hand } from '../GameComponents';
import { getBaccaratValue } from '../../../utils/gameUtils';
import { MobileDrawer } from '../MobileDrawer';

export const BaccaratView = React.memo<{ gameState: GameState; actions: any }>(({ gameState, actions }) => {
    // Consolidate main bet and side bets for display
    const allBets = useMemo(() => [
        { type: gameState.baccaratSelection, amount: gameState.bet },
        ...gameState.baccaratBets
    ], [gameState.baccaratSelection, gameState.bet, gameState.baccaratBets]);

    const isPlayerSelected = useMemo(() => gameState.baccaratSelection === 'PLAYER', [gameState.baccaratSelection]);
    const isBankerSelected = useMemo(() => gameState.baccaratSelection === 'BANKER', [gameState.baccaratSelection]);

    const playerValue = useMemo(() => getBaccaratValue(gameState.playerCards), [gameState.playerCards]);
    const bankerValue = useMemo(() => getBaccaratValue(gameState.dealerCards), [gameState.dealerCards]);

    const hasTie = useMemo(() => gameState.baccaratBets.some(b => b.type === 'TIE'), [gameState.baccaratBets]);
    const hasPlayerPair = useMemo(() => gameState.baccaratBets.some(b => b.type === 'P_PAIR'), [gameState.baccaratBets]);
    const hasBankerPair = useMemo(() => gameState.baccaratBets.some(b => b.type === 'B_PAIR'), [gameState.baccaratBets]);
    const hasLucky6 = useMemo(() => gameState.baccaratBets.some(b => b.type === 'LUCKY6'), [gameState.baccaratBets]);

    const sideBetButtonClass = (active: boolean) =>
        `flex flex-col items-center border rounded bg-black/50 px-3 py-1 transition-colors ${
            active ? 'border-terminal-green/70 bg-terminal-green/10' : 'border-gray-700 hover:border-gray-500'
        }`;

    // Player always GREEN if selected, else RED (because "other side is always red")
    // Wait, the prompt says "player's selected side is always green, and the other side is always red"
    // So if Player is selected: Player=Green, Banker=Red.
    // If Banker is selected: Banker=Green, Player=Red.
    const playerColor = isPlayerSelected ? 'text-terminal-green' : 'text-terminal-accent';
    const bankerColor = isBankerSelected ? 'text-terminal-green' : 'text-terminal-accent';

    return (
        <>
            <div className="flex-1 w-full flex flex-col items-center justify-center gap-8 relative z-10 pb-20">
                <h1 className="absolute top-0 text-xl font-bold text-gray-500 tracking-widest uppercase">BACCARAT</h1>
                <div className="absolute top-2 right-2 z-40">
                    <MobileDrawer label="BETS" title="BACCARAT BETS">
                        <div className="space-y-2">
                            {allBets.map((b, i) => (
                                <div
                                    key={i}
                                    className={`flex justify-between items-center text-xs border p-2 rounded bg-black/40 ${
                                        i === 0 ? 'border-terminal-green/30' : 'border-gray-800'
                                    }`}
                                >
                                    <span className={`font-bold text-[10px] ${b.type === 'PLAYER' || b.type === 'BANKER' ? 'text-terminal-green' : 'text-gray-400'}`}>{b.type}</span>
                                    <div className="text-white text-[10px]">${b.amount}</div>
                                </div>
                            ))}
                        </div>
                    </MobileDrawer>
                </div>
                {/* Banker Area */}
                <div className={`min-h-[120px] flex items-center justify-center transition-all duration-300 ${isBankerSelected ? 'scale-110 opacity-100' : 'scale-90 opacity-75'}`}>
                    {gameState.dealerCards.length > 0 ? (
                        <Hand
                            cards={gameState.dealerCards}
                            title={`BANKER (${bankerValue})`}
                            forcedColor={bankerColor}
                        />
                    ) : (
                        <div className="flex flex-col gap-2 items-center">
                            <span className={`text-2xl font-bold tracking-widest ${bankerColor}`}>BANKER</span>
                            <div className={`w-16 h-24 border border-dashed rounded flex items-center justify-center ${bankerColor.replace('text-', 'border-')}`}>?</div>
                        </div>
                    )}
                </div>

                {/* Center Info */}
                <div className="text-center space-y-3 relative z-20 py-4">
                     <div className="text-2xl font-bold text-terminal-gold tracking-widest animate-pulse">
                         {gameState.message}
                     </div>
                </div>

                {/* Player Area */}
                <div className={`min-h-[120px] flex gap-8 items-center justify-center transition-all duration-300 ${isPlayerSelected ? 'scale-110 opacity-100' : 'scale-90 opacity-75'}`}>
                    {gameState.playerCards.length > 0 ? (
                        <Hand
                            cards={gameState.playerCards}
                            title={`PLAYER (${playerValue})`}
                            forcedColor={playerColor}
                        />
                    ) : (
                        <div className="flex flex-col gap-2 items-center">
                            <span className={`text-2xl font-bold tracking-widest ${playerColor}`}>PLAYER</span>
                            <div className={`w-16 h-24 border border-dashed rounded flex items-center justify-center ${playerColor.replace('text-', 'border-')}`}>?</div>
                        </div>
                    )}
                </div>
            </div>

            {/* BETS SIDEBAR */}
            <div className="hidden md:flex absolute top-0 right-0 bottom-24 w-40 bg-terminal-black/80 border-l-2 border-gray-700 p-2 backdrop-blur-sm z-30 flex-col">
                <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-2 border-b border-gray-800 pb-1 flex-none text-center">Bets</div>
                <div className="flex-1 overflow-y-auto flex flex-col justify-center space-y-1">
                    {allBets.map((b, i) => (
                        <div key={i} className={`flex justify-between items-center text-xs border p-1 rounded bg-black/50 ${i === 0 ? 'border-terminal-green/30' : 'border-gray-800'}`}>
                            <span className={`font-bold text-[10px] ${b.type === 'PLAYER' || b.type === 'BANKER' ? 'text-terminal-green' : 'text-gray-400'}`}>{b.type}</span>
                            <div className="text-white text-[10px]">${b.amount}</div>
                        </div>
                    ))}
                </div>
            </div>

            {/* CONTROLS */}
            <div className="absolute bottom-8 left-0 right-0 h-16 bg-terminal-black/90 border-t-2 border-gray-700 flex items-center justify-start md:justify-center gap-2 p-2 z-40 overflow-x-auto">
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={() => actions?.baccaratActions?.toggleSelection?.('PLAYER')}
                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${isPlayerSelected ? 'border-terminal-green' : 'border-terminal-dim'}`}
                        >
                            <span className={`font-bold text-sm ${isPlayerSelected ? 'text-terminal-green' : 'text-white'}`}>P</span>
                            <span className="text-[10px] text-gray-500">PLAYER</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => actions?.baccaratActions?.toggleSelection?.('BANKER')}
                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${isBankerSelected ? 'border-terminal-green' : 'border-terminal-dim'}`}
                        >
                            <span className={`font-bold text-sm ${isBankerSelected ? 'text-terminal-green' : 'text-white'}`}>B</span>
                            <span className="text-[10px] text-gray-500">BANKER</span>
                        </button>
                    </div>
                    <div className="w-px h-8 bg-gray-800 mx-2"></div>
	                    <div className="flex gap-2">
	                        <button
	                            type="button"
	                            onClick={() => actions?.baccaratActions?.placeBet?.('TIE')}
	                            className={sideBetButtonClass(hasTie)}
	                        >
	                            <span className={`font-bold text-sm ${hasTie ? 'text-terminal-green' : 'text-white'}`}>E</span>
	                            <span className={`text-[10px] ${hasTie ? 'text-terminal-green/80' : 'text-gray-500'}`}>TIE</span>
	                        </button>
	                        <button
	                            type="button"
	                            onClick={() => actions?.baccaratActions?.placeBet?.('P_PAIR')}
	                            className={sideBetButtonClass(hasPlayerPair)}
	                        >
	                            <span className={`font-bold text-sm ${hasPlayerPair ? 'text-terminal-green' : 'text-white'}`}>Q</span>
	                            <span className={`text-[10px] ${hasPlayerPair ? 'text-terminal-green/80' : 'text-gray-500'}`}>P.PAIR</span>
	                        </button>
	                        <button
	                            type="button"
	                            onClick={() => actions?.baccaratActions?.placeBet?.('B_PAIR')}
	                            className={sideBetButtonClass(hasBankerPair)}
	                        >
	                            <span className={`font-bold text-sm ${hasBankerPair ? 'text-terminal-green' : 'text-white'}`}>W</span>
	                            <span className={`text-[10px] ${hasBankerPair ? 'text-terminal-green/80' : 'text-gray-500'}`}>B.PAIR</span>
	                        </button>
	                        <button
	                            type="button"
	                            onClick={() => actions?.baccaratActions?.placeBet?.('LUCKY6')}
	                            className={sideBetButtonClass(hasLucky6)}
	                        >
	                            <span className={`font-bold text-sm ${hasLucky6 ? 'text-terminal-green' : 'text-white'}`}>6</span>
	                            <span className={`text-[10px] ${hasLucky6 ? 'text-terminal-green/80' : 'text-gray-500'}`}>LUCKY6</span>
	                        </button>
	                    </div>
                    <div className="w-px h-8 bg-gray-800 mx-2"></div>
                     <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={actions?.baccaratActions?.rebet}
                            className="flex flex-col items-center border border-gray-700 rounded bg-black/50 px-3 py-1"
                        >
                            <span className="text-gray-500 font-bold text-sm">T</span>
                            <span className="text-[10px] text-gray-600">REBET</span>
                        </button>
                        <button
                            type="button"
                            onClick={actions?.baccaratActions?.undo}
                            className="flex flex-col items-center border border-gray-700 rounded bg-black/50 px-3 py-1"
                        >
                            <span className="text-gray-500 font-bold text-sm">U</span>
                            <span className="text-[10px] text-gray-600">UNDO</span>
                        </button>
                    </div>
                    <div className="w-px h-8 bg-gray-800 mx-2"></div>
                    <div className="flex gap-2">
                         <button
                            type="button"
                            onClick={actions?.toggleShield}
                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${gameState.activeModifiers.shield ? 'border-cyan-400 text-cyan-400' : 'border-gray-700 text-gray-500'}`}
                         >
                            <span className="font-bold text-sm">Z</span>
                            <span className="text-[10px]">SHIELD</span>
                        </button>
                         <button
                            type="button"
                            onClick={actions?.toggleDouble}
                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${gameState.activeModifiers.double ? 'border-purple-400 text-purple-400' : 'border-gray-700 text-gray-500'}`}
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
                        <span className="text-[10px] text-gray-500">DEAL</span>
                    </button>
            </div>
        </>
    );
});
