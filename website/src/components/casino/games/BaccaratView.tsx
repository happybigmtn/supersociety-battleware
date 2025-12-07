
import React from 'react';
import { GameState } from '../../types';
import { Hand } from '../GameComponents';
import { getBaccaratValue } from '../../utils/gameUtils';

export const BaccaratView: React.FC<{ gameState: GameState }> = ({ gameState }) => {
    // Consolidate main bet and side bets for display
    const allBets = [
        { type: gameState.baccaratSelection, amount: gameState.bet },
        ...gameState.baccaratBets
    ];

    const isPlayerSelected = gameState.baccaratSelection === 'PLAYER';
    const isBankerSelected = gameState.baccaratSelection === 'BANKER';

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
                {/* Banker Area */}
                <div className={`min-h-[120px] flex items-center justify-center transition-all duration-300 ${isBankerSelected ? 'scale-110 opacity-100' : 'scale-90 opacity-75'}`}>
                    {gameState.dealerCards.length > 0 ? (
                        <Hand 
                            cards={gameState.dealerCards} 
                            title={`BANKER (${getBaccaratValue(gameState.dealerCards)})`}
                            forcedColor={bankerColor}
                        />
                    ) : (
                        <div className="flex flex-col gap-2 items-center">
                            <span className={`text-lg font-bold tracking-widest ${bankerColor}`}>BANKER</span>
                            <div className={`w-16 h-24 border border-dashed rounded flex items-center justify-center ${bankerColor.replace('text-', 'border-')}`}>?</div>
                        </div>
                    )}
                </div>

                {/* Center Info */}
                <div className="text-center space-y-3 relative z-20 py-4">
                     <div className="text-2xl font-bold text-white tracking-widest animate-pulse">
                         {gameState.message}
                     </div>
                </div>

                {/* Player Area */}
                <div className={`min-h-[120px] flex gap-8 items-center justify-center transition-all duration-300 ${isPlayerSelected ? 'scale-110 opacity-100' : 'scale-90 opacity-75'}`}>
                    {gameState.playerCards.length > 0 ? (
                        <Hand 
                            cards={gameState.playerCards} 
                            title={`PLAYER (${getBaccaratValue(gameState.playerCards)})`} 
                            forcedColor={playerColor}
                        />
                    ) : (
                        <div className="flex flex-col gap-2 items-center">
                            <span className={`text-lg font-bold tracking-widest ${playerColor}`}>PLAYER</span>
                            <div className={`w-16 h-24 border border-dashed rounded flex items-center justify-center ${playerColor.replace('text-', 'border-')}`}>?</div>
                        </div>
                    )}
                </div>
            </div>

            {/* BETS SIDEBAR */}
            <div className="absolute top-0 right-0 bottom-24 w-40 bg-terminal-black/80 border-l border-terminal-dim p-2 backdrop-blur-sm z-30 flex flex-col">
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
            <div className="absolute bottom-8 left-0 right-0 h-16 bg-terminal-black/90 border-t border-terminal-dim flex items-center justify-center gap-2 p-2 z-40">
                    <div className="flex gap-2">
                        <div className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${isPlayerSelected ? 'border-terminal-green' : 'border-terminal-dim'}`}>
                            <span className={`font-bold text-sm ${isPlayerSelected ? 'text-terminal-green' : 'text-white'}`}>P</span>
                            <span className="text-[10px] text-gray-500">PLAYER</span>
                        </div>
                        <div className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${isBankerSelected ? 'border-terminal-green' : 'border-terminal-dim'}`}>
                            <span className={`font-bold text-sm ${isBankerSelected ? 'text-terminal-green' : 'text-white'}`}>B</span>
                            <span className="text-[10px] text-gray-500">BANKER</span>
                        </div>
                    </div>
                    <div className="w-px h-8 bg-gray-800 mx-2"></div>
                    <div className="flex gap-2">
                        <div className="flex flex-col items-center border border-gray-700 rounded bg-black/50 px-3 py-1">
                            <span className="text-white font-bold text-sm">E</span>
                            <span className="text-[10px] text-gray-500">TIE</span>
                        </div>
                        <div className="flex flex-col items-center border border-gray-700 rounded bg-black/50 px-3 py-1">
                            <span className="text-white font-bold text-sm">Q</span>
                            <span className="text-[10px] text-gray-500">P.PAIR</span>
                        </div>
                        <div className="flex flex-col items-center border border-gray-700 rounded bg-black/50 px-3 py-1">
                            <span className="text-white font-bold text-sm">W</span>
                            <span className="text-[10px] text-gray-500">B.PAIR</span>
                        </div>
                    </div>
                    <div className="w-px h-8 bg-gray-800 mx-2"></div>
                     <div className="flex gap-2">
                        <div className="flex flex-col items-center border border-gray-700 rounded bg-black/50 px-3 py-1 cursor-pointer">
                            <span className="text-gray-500 font-bold text-sm">T</span>
                            <span className="text-[10px] text-gray-600">REBET</span>
                        </div>
                        <div className="flex flex-col items-center border border-gray-700 rounded bg-black/50 px-3 py-1 cursor-pointer">
                            <span className="text-gray-500 font-bold text-sm">U</span>
                            <span className="text-[10px] text-gray-600">UNDO</span>
                        </div>
                    </div>
                    <div className="w-px h-8 bg-gray-800 mx-2"></div>
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
            </div>
        </>
    );
};
