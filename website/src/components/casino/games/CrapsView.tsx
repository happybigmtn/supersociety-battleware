
import React from 'react';
import { GameState } from '../../types';
import { DiceRender } from '../GameComponents';
import { calculateCrapsExposure } from '../../utils/gameUtils';

export const CrapsView: React.FC<{ gameState: GameState }> = ({ gameState }) => {
    return (
        <>
            <div className="flex-1 w-full flex flex-col items-center justify-center gap-8 relative z-10 pb-20">
                <h1 className="absolute top-0 text-xl font-bold text-gray-500 tracking-widest uppercase">CRAPS</h1>
                {/* Point Indicator */}
                <div className="min-h-[120px] flex items-center justify-center">
                        <div className="flex flex-col items-center gap-2">
                        <span className="text-xs uppercase tracking-widest text-gray-500">POINT</span>
                        <div className={`w-16 h-16 border-2 flex items-center justify-center text-xl font-bold rounded-full shadow-[0_0_15px_rgba(0,0,0,0.5)] ${gameState.crapsPoint ? 'border-terminal-accent text-terminal-accent' : 'border-gray-700 text-gray-700'}`}>
                            {gameState.crapsPoint || "OFF"}
                        </div>
                        </div>
                </div>

                {/* Center Info */}
                <div className="text-center space-y-3 relative z-20">
                    <div className="text-2xl font-bold text-white tracking-widest animate-pulse">
                        {gameState.message}
                    </div>
                    {gameState.crapsRollHistory.length > 0 && (
                        <div className="text-[10px] text-gray-600 tracking-widest mt-1">
                            LAST: {gameState.crapsRollHistory.slice(-10).join(' - ')}
                        </div>
                    )}
                </div>

                {/* Dice Area */}
                <div className="min-h-[120px] flex gap-8 items-center justify-center">
                    {gameState.dice.length > 0 && (
                        <div className="flex flex-col gap-2 items-center">
                            <span className="text-xs uppercase tracking-widest text-gray-500">ROLL</span>
                            <div className="flex gap-4">
                                {gameState.dice.map((d, i) => <DiceRender key={i} value={d} />)}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* EXPOSURE SIDEBAR */}
            <div className="absolute top-0 left-0 bottom-24 w-36 bg-terminal-black/80 border-r border-terminal-dim p-2 overflow-y-auto backdrop-blur-sm z-30 flex flex-col">
                <h3 className="text-[10px] font-bold text-gray-500 mb-2 tracking-widest text-center border-b border-gray-800 pb-1 flex-none">EXPOSURE</h3>
                <div className="flex-1 flex flex-col justify-center space-y-2">
                    {[2,3,4,5,6,7,8,9,10,11,12].map(num => {
                        const pnl = calculateCrapsExposure(num, gameState.crapsPoint, gameState.crapsBets);
                        const maxScale = 5000; 
                        const barPercent = Math.min(Math.abs(pnl) / maxScale * 50, 50);
                        const isHardwayBet = gameState.crapsBets.some(b => b.type === 'HARDWAY' && b.target === num);
                        
                        return (
                            <div key={num} className="flex items-center h-5 text-[10px]">
                                <div className="flex-1 flex justify-end items-center pr-1 gap-1">
                                    {pnl < 0 && <span className="text-[9px] text-gray-400">{Math.abs(pnl)}</span>}
                                    {pnl < 0 && (
                                        <div className="bg-terminal-accent/80 h-3 rounded-l" style={{ width: `${barPercent}%` }} />
                                    )}
                                </div>
                                <div className={`w-6 text-center font-bold relative ${num === 7 ? 'text-terminal-accent' : 'text-white'}`}>
                                    {num}
                                    {isHardwayBet && <span className="absolute -top-1 -right-1 text-[8px] text-terminal-gold">*</span>}
                                </div>
                                <div className="flex-1 flex justify-start items-center pl-1 gap-1">
                                    {pnl > 0 && (
                                        <div className="bg-terminal-green/80 h-3 rounded-r" style={{ width: `${barPercent}%` }} />
                                    )}
                                    {pnl > 0 && <span className="text-[9px] text-gray-400">{pnl}</span>}
                                </div>
                            </div>
                        );
                    })}
                </div>
                <div className="mt-2 pt-2 border-t border-gray-800 text-[8px] text-gray-600 text-center">
                    (*) IF HARD
                </div>
            </div>

            {/* ACTIVE BETS SIDEBAR */}
            <div className="absolute top-0 right-0 bottom-24 w-36 bg-terminal-black/80 border-l border-terminal-dim p-2 backdrop-blur-sm z-30 flex flex-col">
                <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-2 border-b border-gray-800 pb-1 flex-none text-center">Table Bets</div>
                <div className="flex-1 overflow-y-auto flex flex-col justify-center space-y-1">
                    {gameState.crapsBets.length > 0 ? (
                        gameState.crapsBets.map((b, i) => (
                            <div key={i} className="flex justify-between items-center text-xs border border-gray-800 p-1 rounded bg-black/50">
                                <div className="flex flex-col">
                                    <span className="text-terminal-green font-bold text-[10px]">{b.type} {b.target}</span>
                                    <span className="text-[9px] text-gray-500">{b.status === 'PENDING' ? 'WAIT' : 'ON'}</span>
                                </div>
                                <div className="text-right">
                                    <div className="text-white text-[10px]">${b.amount}</div>
                                    {b.oddsAmount && <div className="text-[9px] text-terminal-gold">+${b.oddsAmount}</div>}
                                </div>
                            </div>
                        ))
                    ) : (
                        <div className="text-center text-[10px] text-gray-700 italic">NO BETS</div>
                    )}
                </div>
            </div>

            {/* CONTROLS */}
            <div className="absolute bottom-8 left-0 right-0 h-16 bg-terminal-black/90 border-t border-terminal-dim flex items-center justify-center gap-2 p-2 z-40">
                    <div className="flex gap-2">
                        <div className="flex flex-col items-center border border-terminal-dim rounded bg-black/50 px-3 py-1">
                            <span className="text-white font-bold text-sm">P</span>
                            <span className="text-[10px] text-gray-500">{gameState.crapsPoint ? 'COME' : 'PASS'}</span>
                        </div>
                        <div className="flex flex-col items-center border border-terminal-dim rounded bg-black/50 px-3 py-1">
                            <span className="text-white font-bold text-sm">D</span>
                            <span className="text-[10px] text-gray-500">DONT</span>
                        </div>
                        <div className="flex flex-col items-center border border-terminal-dim rounded bg-black/50 px-3 py-1">
                            <span className="text-white font-bold text-sm">F</span>
                            <span className="text-[10px] text-gray-500">FIELD</span>
                        </div>
                        <div className="flex flex-col items-center border border-terminal-dim rounded bg-black/50 px-3 py-1">
                            <span className="text-white font-bold text-sm">O</span>
                            <span className="text-[10px] text-gray-500">ODDS</span>
                        </div>
                        <div className="flex flex-col items-center border border-terminal-dim rounded bg-black/50 px-3 py-1">
                            <span className="text-white font-bold text-sm">H</span>
                            <span className="text-[10px] text-gray-500">HARD</span>
                        </div>
                    </div>
                    <div className="w-px h-8 bg-gray-800 mx-2"></div>
                    <div className="flex gap-2">
                        <div className="flex flex-col items-center border border-gray-700 rounded bg-black/50 px-3 py-1">
                            <span className="text-white font-bold text-sm">Y</span>
                            <span className="text-[10px] text-gray-500">YES</span>
                        </div>
                        <div className="flex flex-col items-center border border-gray-700 rounded bg-black/50 px-3 py-1">
                            <span className="text-white font-bold text-sm">N</span>
                            <span className="text-[10px] text-gray-500">NO</span>
                        </div>
                        <div className="flex flex-col items-center border border-gray-700 rounded bg-black/50 px-3 py-1">
                            <span className="text-white font-bold text-sm">X</span>
                            <span className="text-[10px] text-gray-500">NEXT</span>
                        </div>
                    </div>
                    <div className="w-px h-8 bg-gray-800 mx-2"></div>
                    <div className="flex gap-2">
                        <div className="flex flex-col items-center border border-terminal-accent/50 rounded bg-black/50 px-3 py-1 cursor-pointer">
                            <span className="text-terminal-accent font-bold text-sm">U</span>
                            <span className="text-[10px] text-gray-500">UNDO</span>
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

            {/* MODAL */}
            {gameState.crapsInputMode !== 'NONE' && (
                     <div className="absolute inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center">
                         <div className="bg-terminal-black border border-terminal-green p-6 rounded-lg shadow-xl flex flex-col items-center gap-4">
                             <div className="text-sm tracking-widest text-gray-400 uppercase">SELECT {gameState.crapsInputMode} NUMBER</div>
                             <div className="grid grid-cols-4 gap-3">
                                 {(() => {
                                     let numbersToRender: { num: number, label: string, payout?: string }[] = [];
                                     
                                     // Helper for payout text
                                     const getProfit = (type: string, n: number) => {
                                         if (type === 'NEXT') {
                                             if (n === 2 || n === 12) return "35x";
                                             if (n === 3 || n === 11) return "17x";
                                             if (n === 4 || n === 10) return "11x";
                                             if (n === 5 || n === 9) return "8x";
                                             if (n === 6 || n === 8) return "6.2x";
                                             if (n === 7) return "5x";
                                         } else if (type === 'YES') {
                                             if (n === 4 || n === 10) return "2.0x";
                                             if (n === 5 || n === 9) return "1.5x";
                                             if (n === 6 || n === 8) return "1.2x";
                                         } else if (type === 'NO') {
                                             if (n === 4 || n === 10) return "0.5x";
                                             if (n === 5 || n === 9) return "0.7x";
                                             if (n === 6 || n === 8) return "0.8x";
                                         }
                                         return "";
                                     };

                                     if (gameState.crapsInputMode === 'YES' || gameState.crapsInputMode === 'NO') {
                                         [4,5,6,8,9,10].forEach(n => {
                                            numbersToRender.push({ num: n, label: n.toString(), payout: getProfit(gameState.crapsInputMode, n) });
                                         });
                                     } else if (gameState.crapsInputMode === 'NEXT') {
                                         [2,3,4,5,6,7,8,9,10,11,12].forEach(n => {
                                             numbersToRender.push({ num: n, label: n === 10 ? '0' : n === 11 ? '-' : n === 12 ? '=' : n.toString(), payout: getProfit('NEXT', n) });
                                         });
                                     } else if (gameState.crapsInputMode === 'HARDWAY') {
                                         numbersToRender = [4,6,8,10].map(n => ({ num: n, label: n === 10 ? '0' : n.toString(), payout: (n===4||n===10) ? '7x' : '9x' }));
                                     }
                                     
                                     return numbersToRender.map(item => {
                                         if (item.num === 7) {
                                             return (
                                                <div key={item.num} className="flex flex-col items-center gap-1">
                                                    <div className="w-12 h-12 flex items-center justify-center border border-terminal-accent rounded bg-gray-900 text-terminal-accent font-bold text-lg relative">
                                                        7
                                                        <span className="absolute bottom-0.5 text-[8px] text-terminal-gold">{item.payout}</span>
                                                    </div>
                                                    <div className="text-[10px] text-gray-500 bg-gray-800 px-1 rounded uppercase">
                                                        KEY 7
                                                    </div>
                                                </div>
                                             );
                                         }

                                         return (
                                            <div key={item.num} className="flex flex-col items-center gap-1">
                                                <div className="w-12 h-12 flex items-center justify-center border border-gray-700 rounded bg-gray-900 text-white font-bold text-lg relative">
                                                    {item.num}
                                                    {item.payout && <span className="absolute bottom-0.5 text-[8px] text-terminal-gold">({item.payout})</span>}
                                                </div>
                                                <div className="text-[10px] text-gray-500 bg-gray-800 px-1 rounded uppercase">
                                                    KEY {item.label}
                                                </div>
                                            </div>
                                         );
                                     });
                                 })()}
                             </div>
                             <div className="text-xs text-gray-500 mt-2">[ESC] CANCEL</div>
                         </div>
                     </div>
                )}
        </>
    );
};
