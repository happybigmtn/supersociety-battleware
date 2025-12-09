
import React, { useMemo, useCallback } from 'react';
import { GameState, RouletteBet } from '../../../types';
import { getRouletteColor, calculateRouletteExposure } from '../../../utils/gameUtils';

export const RouletteView = React.memo<{ gameState: GameState; numberInput?: string }>(({ gameState, numberInput = "" }) => {
    const lastNum = useMemo(() =>
        gameState.rouletteHistory.length > 0 ? gameState.rouletteHistory[gameState.rouletteHistory.length - 1] : null,
        [gameState.rouletteHistory]
    );

    const renderBetItem = useCallback((bet: RouletteBet, i: number) => (
        <div key={i} className="flex justify-between items-center text-xs border border-gray-800 p-1 rounded bg-black/50">
            <div className="flex flex-col">
                <span className="text-terminal-green font-bold text-[10px]">{bet.type} {bet.target !== undefined ? bet.target : ''}</span>
            </div>
            <div className="text-white text-[10px]">${bet.amount}</div>
        </div>
    ), []);

    const renderExposureRow = useCallback((num: number) => {
        const pnl = calculateRouletteExposure(num, gameState.rouletteBets);
        const maxScale = 5000; 
        const barPercent = Math.min(Math.abs(pnl) / maxScale * 50, 50);
        const color = getRouletteColor(num);
        const colorClass = color === 'RED' ? 'text-terminal-accent' : color === 'BLACK' ? 'text-white' : 'text-terminal-green';

        return (
            <div key={num} className="flex items-center h-7 text-base">
                <div className="flex-1 flex justify-end items-center pr-1 gap-1 min-w-0">
                    {pnl < 0 && <span className="text-sm text-gray-400 truncate">{Math.abs(pnl)}</span>}
                    {pnl < 0 && (
                        <div className="bg-terminal-accent/80 h-3 rounded-l" style={{ width: `${barPercent}%` }} />
                    )}
                </div>
                <div className={`w-7 text-center font-bold ${colorClass} flex-shrink-0`}>{num}</div>
                <div className="flex-1 flex justify-start items-center pl-1 gap-1 min-w-0">
                    {pnl > 0 && (
                        <div className="bg-terminal-green/80 h-3 rounded-r" style={{ width: `${barPercent}%` }} />
                    )}
                    {pnl > 0 && <span className="text-sm text-gray-400 truncate">{pnl}</span>}
                </div>
            </div>
        );
    }, [gameState.rouletteBets]);

    return (
        <>
            <div className="flex-1 w-full flex flex-col items-center justify-center gap-8 relative z-10 pb-20">
                <h1 className="absolute top-0 text-xl font-bold text-gray-500 tracking-widest uppercase">ROULETTE</h1>
                {/* Last Number Display */}
                <div className="min-h-[120px] flex flex-col items-center justify-center gap-4">
                     {lastNum !== null ? (
                        <div className={`w-32 h-32 rounded-full border-4 flex items-center justify-center text-5xl font-bold shadow-[0_0_30px_rgba(0,0,0,0.5)] ${getRouletteColor(lastNum) === 'RED' ? 'border-terminal-accent text-terminal-accent' : getRouletteColor(lastNum) === 'BLACK' ? 'border-gray-500 text-white' : 'border-terminal-green text-terminal-green'}`}>
                            {lastNum}
                        </div>
                     ) : (
                        <div className="w-32 h-32 rounded-full border-4 border-gray-800 flex items-center justify-center text-sm text-gray-600 animate-pulse">
                            SPIN
                        </div>
                     )}
                     
                     {/* History */}
                     {gameState.rouletteHistory.length > 0 && (
                         <div className="flex gap-2 opacity-75">
                             {gameState.rouletteHistory.slice(-8).reverse().map((num, i) => (
                                 <div key={i} className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold border ${getRouletteColor(num) === 'RED' ? 'border-terminal-accent text-terminal-accent' : getRouletteColor(num) === 'BLACK' ? 'border-gray-500 text-white' : 'border-terminal-green text-terminal-green'}`}>
                                     {num}
                                 </div>
                             ))}
                         </div>
                     )}
                </div>

                {/* Center Info */}
                <div className="text-center space-y-3 relative z-20">
                    <div className="text-2xl font-bold text-white tracking-widest animate-pulse">
                        {gameState.message}
                    </div>
                </div>
            </div>

            {/* EXPOSURE SIDEBAR */}
            <div className="absolute top-0 left-0 bottom-24 w-60 bg-terminal-black/80 border-r-2 border-gray-700 p-2 overflow-hidden backdrop-blur-sm z-30 flex flex-col">
                <h3 className="text-[10px] font-bold text-gray-500 mb-2 tracking-widest text-center border-b border-gray-800 pb-1 flex-none">EXPOSURE</h3>
                
                {/* 0 Row */}
                <div className="flex-none mb-1">
                    {renderExposureRow(0)}
                </div>

                <div className="flex-1 flex flex-row relative overflow-hidden">
                    {/* Vertical Divider */}
                    <div className="absolute left-1/2 top-0 bottom-0 w-px bg-gray-800 -translate-x-1/2"></div>

                    {/* 1-18 */}
                    <div className="flex-1 flex flex-col gap-0.5 pr-1">
                        {Array.from({ length: 18 }, (_, i) => i + 1).map(num => renderExposureRow(num))}
                    </div>

                    {/* 19-36 */}
                    <div className="flex-1 flex flex-col gap-0.5 pl-1">
                        {Array.from({ length: 18 }, (_, i) => i + 19).map(num => renderExposureRow(num))}
                    </div>
                </div>
            </div>

            {/* ACTIVE BETS SIDEBAR */}
            <div className="absolute top-0 right-0 bottom-24 w-60 bg-terminal-black/80 border-l-2 border-gray-700 p-2 backdrop-blur-sm z-30 flex flex-col">
                <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-2 border-b border-gray-800 pb-1 flex-none text-center">Table Bets</div>
                <div className="flex-1 overflow-y-auto flex flex-col justify-center space-y-1">
                    {gameState.rouletteBets.length === 0 ? (
                        <div className="text-center text-[10px] text-gray-700 italic">NO BETS</div>
                    ) : (
                        gameState.rouletteBets.map((b, i) => renderBetItem(b, i))
                    )}
                </div>
            </div>

            {/* CONTROLS */}
            <div className="absolute bottom-8 left-0 right-0 h-16 bg-terminal-black/90 border-t-2 border-gray-700 flex items-center justify-center gap-2 p-2 z-40 overflow-x-auto">
                    <div className="flex gap-2">
                        <div className="flex flex-col items-center border border-terminal-accent rounded bg-black/50 px-3 py-1">
                            <span className="text-terminal-accent font-bold text-sm">R</span>
                            <span className="text-[10px] text-gray-500">RED</span>
                        </div>
                        <div className="flex flex-col items-center border border-gray-500 rounded bg-black/50 px-3 py-1">
                            <span className="text-white font-bold text-sm">B</span>
                            <span className="text-[10px] text-gray-500">BLACK</span>
                        </div>
                    </div>
                    <div className="w-px h-8 bg-gray-800 mx-2"></div>
                    <div className="flex gap-2">
                         <div className="flex flex-col items-center border border-terminal-dim rounded bg-black/50 px-3 py-1">
                            <span className="text-white font-bold text-sm">E</span>
                            <span className="text-[10px] text-gray-500">EVEN</span>
                        </div>
                        <div className="flex flex-col items-center border border-terminal-dim rounded bg-black/50 px-3 py-1">
                            <span className="text-white font-bold text-sm">O</span>
                            <span className="text-[10px] text-gray-500">ODD</span>
                        </div>
                    </div>
                    <div className="w-px h-8 bg-gray-800 mx-2"></div>
                    <div className="flex gap-2">
                         <div className="flex flex-col items-center border border-terminal-dim rounded bg-black/50 px-3 py-1">
                            <span className="text-white font-bold text-sm">L</span>
                            <span className="text-[10px] text-gray-500">1-18</span>
                        </div>
                        <div className="flex flex-col items-center border border-terminal-dim rounded bg-black/50 px-3 py-1">
                            <span className="text-white font-bold text-sm">H</span>
                            <span className="text-[10px] text-gray-500">19-36</span>
                        </div>
                    </div>
                     <div className="w-px h-8 bg-gray-800 mx-2"></div>
                     <div className="flex gap-2">
                        <div className="flex flex-col items-center border border-terminal-green rounded bg-black/50 px-3 py-1">
                            <span className="text-terminal-green font-bold text-sm">0</span>
                            <span className="text-[10px] text-gray-500">ZERO</span>
                        </div>
                         <div className="flex flex-col items-center border border-terminal-dim rounded bg-black/50 px-3 py-1 cursor-pointer">
                            <span className="text-white font-bold text-sm">N</span>
                            <span className="text-[10px] text-gray-500">NUM</span>
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
                        <span className="text-[10px] text-gray-500">SPIN</span>
                    </div>
            </div>

            {/* NUM INPUT MODAL */}
            {gameState.rouletteInputMode === 'NUMBER' && (
                 <div className="absolute inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center">
                     <div className="bg-terminal-black border border-terminal-green p-6 rounded-lg shadow-xl flex flex-col items-center gap-4">
                         <div className="text-sm tracking-widest text-gray-400 uppercase">TYPE NUMBER (0-36)</div>
                         <div className="text-4xl text-white font-bold font-mono h-12 flex items-center justify-center border-b border-gray-700 w-32">
                             {numberInput}
                             <span className="animate-pulse">_</span>
                         </div>
                         <div className="text-xs text-gray-500">[ENTER] CONFIRM</div>
                         <div className="text-xs text-gray-500">[ESC] CANCEL</div>
                     </div>
                 </div>
            )}
        </>
    );
});
