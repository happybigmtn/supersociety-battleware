
import React from 'react';
import { GameState, SicBoBet } from '../../types';
import { DiceRender } from '../GameComponents';
import { calculateSicBoOutcomeExposure, getSicBoCombinations } from '../../utils/gameUtils';

export const SicBoView: React.FC<{ gameState: GameState, numberInput?: string }> = ({ gameState, numberInput = "" }) => {
    
    const combinations = getSicBoCombinations();
    const splitIndex = Math.ceil(combinations.length / 2);
    const leftCombos = combinations.slice(0, splitIndex);
    const rightCombos = combinations.slice(splitIndex);

    const renderBetItem = (bet: SicBoBet, i: number) => (
        <div key={i} className="flex justify-between items-center text-xs border border-gray-800 p-1 rounded bg-black/50">
            <div className="flex flex-col">
                <span className="text-terminal-green font-bold text-[10px]">{bet.type} {bet.target}</span>
            </div>
            <div className="text-white text-[10px]">${bet.amount}</div>
        </div>
    );

    const renderExposureRow = (combo: number[]) => {
        const pnl = calculateSicBoOutcomeExposure(combo, gameState.sicBoBets);
        const label = combo.join('-');
        
        // PnL display optimized for visibility without horizontal bars taking up space
        return (
            <div key={label} className="flex items-center h-5 text-[10px] w-full">
                <div className="flex-1 flex justify-end items-center text-right pr-2 overflow-hidden">
                    {pnl < 0 && <span className="text-terminal-accent font-mono truncate">{Math.abs(pnl).toLocaleString()}</span>}
                </div>
                
                {/* Fixed Center Indicator */}
                <div className="flex-none w-10 flex justify-center items-center relative">
                    <span className="text-gray-500 font-mono tracking-tighter z-10 bg-terminal-black/80 px-1">{label}</span>
                    {pnl < 0 && <div className="absolute right-0 top-1 bottom-1 w-0.5 bg-terminal-accent" />}
                    {pnl > 0 && <div className="absolute left-0 top-1 bottom-1 w-0.5 bg-terminal-green" />}
                </div>

                <div className="flex-1 flex justify-start items-center pl-2 overflow-hidden">
                    {pnl > 0 && <span className="text-terminal-green font-mono truncate">{pnl.toLocaleString()}</span>}
                </div>
            </div>
        );
    };

    return (
        <>
            <div className="flex-1 w-full flex flex-col items-center justify-center gap-8 relative z-10 pl-96 pr-60 pb-20">
                <h1 className="absolute top-0 text-xl font-bold text-gray-500 tracking-widest uppercase">SIC BO</h1>
                {/* Dice Display */}
                <div className="min-h-[120px] flex items-center justify-center">
                    {gameState.dice.length === 3 ? (
                        <div className="flex flex-col gap-2 items-center">
                             <span className="text-xs uppercase tracking-widest text-gray-500">ROLL</span>
                             <div className="flex gap-4">
                                {gameState.dice.map((d, i) => <DiceRender key={i} value={d} />)}
                             </div>
                             <div className="text-terminal-gold font-bold mt-2 text-xl">
                                 TOTAL: {gameState.dice.reduce((a,b)=>a+b,0)}
                             </div>
                        </div>
                    ) : (
                        <div className="flex gap-4">
                            {[1,2,3].map(i => (
                                <div key={i} className="w-16 h-16 border border-dashed border-gray-700 rounded flex items-center justify-center text-gray-700 text-2xl">?</div>
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

                {/* History */}
                 {gameState.sicBoHistory.length > 0 && (
                     <div className="flex flex-col items-center gap-1">
                         <span className="text-[10px] text-gray-600 tracking-widest">HISTORY</span>
                         <div className="flex gap-2 opacity-50">
                             {gameState.sicBoHistory.slice(-5).reverse().map((roll, i) => (
                                 <div key={i} className="flex gap-0.5 border border-gray-800 p-1 rounded">
                                     {roll.map((d, j) => <span key={j} className="text-[10px] text-gray-400">{d}</span>)}
                                 </div>
                             ))}
                         </div>
                     </div>
                 )}
            </div>

             {/* EXPOSURE SIDEBAR - Keep wide for combinations text */}
             <div className="absolute top-0 left-0 bottom-24 w-96 bg-terminal-black/80 border-r border-terminal-dim p-2 overflow-hidden backdrop-blur-sm z-30 flex flex-col">
                <h3 className="text-[10px] font-bold text-gray-500 mb-2 tracking-widest text-center border-b border-gray-800 pb-1 flex-none">EXPOSURE (COMBOS)</h3>
                <div className="flex-1 flex flex-row relative">
                     {/* Vertical Divider */}
                    <div className="absolute left-1/2 top-0 bottom-0 w-px bg-gray-800 -translate-x-1/2"></div>
                    
                    {/* Left Column */}
                    <div className="flex-1 flex flex-col justify-between pr-2 border-r border-gray-800/50">
                        {leftCombos.map(combo => renderExposureRow(combo))}
                    </div>

                    {/* Right Column */}
                    <div className="flex-1 flex flex-col justify-between pl-2">
                        {rightCombos.map(combo => renderExposureRow(combo))}
                    </div>
                </div>
            </div>

            {/* ACTIVE BETS SIDEBAR - Reduced to w-60 */}
            <div className="absolute top-0 right-0 bottom-24 w-60 bg-terminal-black/80 border-l border-terminal-dim p-2 backdrop-blur-sm z-30 flex flex-col">
                    <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-2 border-b border-gray-800 pb-1 flex-none text-center">Table Bets</div>
                    <div className="flex-1 overflow-y-auto flex flex-col justify-center space-y-1">
                        {gameState.sicBoBets.length > 0 ? (
                            gameState.sicBoBets.map((b, i) => renderBetItem(b, i))
                        ) : (
                            <div className="text-center text-[10px] text-gray-700 italic">NO BETS</div>
                        )}
                    </div>
            </div>

            {/* CONTROLS */}
            <div className="absolute bottom-8 left-0 right-0 h-16 bg-terminal-black/90 border-t border-terminal-dim flex items-center justify-center gap-2 p-2 z-40 overflow-x-auto">
                    <div className="flex gap-2">
                        <div className="flex flex-col items-center border border-terminal-dim rounded bg-black/50 px-3 py-1">
                            <span className="text-white font-bold text-sm">S</span>
                            <span className="text-[10px] text-gray-500">SMALL</span>
                        </div>
                        <div className="flex flex-col items-center border border-terminal-dim rounded bg-black/50 px-3 py-1">
                            <span className="text-white font-bold text-sm">B</span>
                            <span className="text-[10px] text-gray-500">BIG</span>
                        </div>
                    </div>
                    <div className="w-px h-8 bg-gray-800 mx-2"></div>
                    <div className="flex gap-2">
                         <div className="flex flex-col items-center border border-terminal-dim rounded bg-black/50 px-3 py-1">
                            <span className="text-white font-bold text-sm">N</span>
                            <span className="text-[10px] text-gray-500">DIE</span>
                        </div>
                        <div className="flex flex-col items-center border border-terminal-dim rounded bg-black/50 px-3 py-1">
                            <span className="text-white font-bold text-sm">D</span>
                            <span className="text-[10px] text-gray-500">DOUBLE</span>
                        </div>
                        <div className="flex flex-col items-center border border-terminal-dim rounded bg-black/50 px-3 py-1">
                            <span className="text-white font-bold text-sm">T</span>
                            <span className="text-[10px] text-gray-500">TRIPLE</span>
                        </div>
                         <div className="flex flex-col items-center border border-terminal-dim rounded bg-black/50 px-3 py-1">
                            <span className="text-white font-bold text-sm">M</span>
                            <span className="text-[10px] text-gray-500">SUM</span>
                        </div>
                    </div>
                    <div className="w-px h-8 bg-gray-800 mx-2"></div>
                    <div className="flex gap-2">
                        <div className="flex flex-col items-center border border-terminal-dim rounded bg-black/50 px-3 py-1">
                            <span className="text-white font-bold text-sm">A</span>
                            <span className="text-[10px] text-gray-500">ANY 3</span>
                        </div>
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
                        <span className="text-[10px] text-gray-500">ROLL</span>
                    </div>
            </div>

            {/* SIC BO MODAL */}
            {gameState.sicBoInputMode !== 'NONE' && (
                 <div className="absolute inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center">
                     <div className="bg-terminal-black border border-terminal-green p-6 rounded-lg shadow-xl flex flex-col items-center gap-4">
                         <div className="text-sm tracking-widest text-gray-400 uppercase">
                             {gameState.sicBoInputMode === 'SINGLE' && "SELECT NUMBER (1-6)"}
                             {gameState.sicBoInputMode === 'DOUBLE' && "SELECT DOUBLE (1-6)"}
                             {gameState.sicBoInputMode === 'TRIPLE' && "SELECT TRIPLE (1-6)"}
                             {gameState.sicBoInputMode === 'SUM' && "TYPE TOTAL (4-17)"}
                         </div>
                         
                         {gameState.sicBoInputMode === 'SUM' ? (
                              <div className="text-4xl text-white font-bold font-mono h-12 flex items-center justify-center border-b border-gray-700 w-32">
                                 {numberInput}
                                 <span className="animate-pulse">_</span>
                              </div>
                         ) : (
                             <div className="flex gap-2">
                                 {[1,2,3,4,5,6].map(n => (
                                     <div key={n} className="flex flex-col items-center gap-1">
                                         <div className="w-10 h-10 flex items-center justify-center border border-gray-700 rounded bg-gray-900 text-white font-bold">
                                             {n}
                                         </div>
                                          <div className="text-[9px] text-gray-500">[{n}]</div>
                                     </div>
                                 ))}
                             </div>
                         )}

                         <div className="text-xs text-gray-500 mt-2">[ESC] CANCEL {gameState.sicBoInputMode === 'SUM' && "[ENTER] CONFIRM"}</div>
                     </div>
                 </div>
            )}
        </>
    );
};
