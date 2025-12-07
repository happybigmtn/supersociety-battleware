import React from 'react';
import { GameState } from '../../../types';
import { DiceRender } from '../../shared/GameElements';
import { calculateCrapsExposure } from '../../../utils/crapsUtils';

interface CrapsBoardProps {
    gameState: GameState;
}

export const CrapsBoard: React.FC<CrapsBoardProps> = ({ gameState }) => {
    return (
        <>
            <div className="flex-1 w-full flex flex-col items-center justify-center gap-8 relative z-10">
                {/* Dealer Area / Craps Point */}
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
                     <div className="text-sm text-gray-500 flex flex-col items-center gap-1">
                         <span>POT/BET SIZE: ${gameState.bet.toLocaleString()}</span>
                         {gameState.crapsRollHistory.length > 0 && (
                             <div className="text-[10px] text-gray-600 tracking-widest mt-1">
                                 LAST: {gameState.crapsRollHistory.slice(-10).join(' - ')}
                             </div>
                         )}
                     </div>
                </div>

                {/* Player Area (Dice) */}
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

            {/* CRAPS EXPOSURE SIMULATOR (Inside Game Window - Left) */}
            <div className="absolute top-0 left-0 bottom-16 w-36 bg-terminal-black/80 border-r border-terminal-dim p-2 overflow-y-auto backdrop-blur-sm z-30 flex flex-col">
                <h3 className="text-[10px] font-bold text-gray-500 mb-2 tracking-widest text-center border-b border-gray-800 pb-1 flex-none">EXPOSURE</h3>
                <div className="flex-1 flex flex-col justify-center space-y-2">
                    {[2,3,4,5,6,7,8,9,10,11,12].map(num => {
                        const pnl = calculateCrapsExposure(num, gameState.crapsPoint, gameState.crapsBets);
                        const maxScale = 5000; 
                        const barPercent = Math.min(Math.abs(pnl) / maxScale * 50, 50);
                        
                        return (
                            <div key={num} className="flex items-center h-5 text-[10px]">
                                <div className="flex-1 flex justify-end items-center pr-1 gap-1">
                                    {pnl < 0 && <span className="text-[9px] text-gray-400">{Math.abs(pnl)}</span>}
                                    {pnl < 0 && (
                                        <div className="bg-terminal-accent/80 h-3 rounded-l" style={{ width: `${barPercent}%` }} />
                                    )}
                                </div>
                                <div className={`w-6 text-center font-bold ${num === 7 ? 'text-terminal-accent' : 'text-white'}`}>{num}</div>
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
            </div>

            {/* CRAPS ACTIVE BETS OVERLAY (Inside Game Window - Right) */}
            {gameState.crapsBets.length > 0 && (
                <div className="absolute top-0 right-0 bottom-16 w-36 bg-terminal-black/80 border-l border-terminal-dim p-2 backdrop-blur-sm z-30 flex flex-col">
                    <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-2 border-b border-gray-800 pb-1 flex-none text-center">Table Bets</div>
                    <div className="flex-1 overflow-y-auto flex flex-col justify-center space-y-1">
                        {gameState.crapsBets.map((b, i) => (
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
                        ))}
                    </div>
                </div>
            )}

            {/* CRAPS CONTROLS (Inside Game Window - Bottom) */}
            <div className="absolute bottom-0 left-0 right-0 h-16 bg-terminal-black/90 border-t border-terminal-dim flex items-center justify-center gap-2 p-2 z-40">
                 {/* Core Bets */}
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
                     {/* MOVED HARDWAY HERE */}
                     <div className="flex flex-col items-center border border-terminal-dim rounded bg-black/50 px-3 py-1">
                         <span className="text-white font-bold text-sm">H</span>
                         <span className="text-[10px] text-gray-500">HARD</span>
                     </div>
                 </div>
                 <div className="w-px h-8 bg-gray-800 mx-2"></div>
                 {/* Advanced Bets */}
                 <div className="flex gap-2">
                     <div className="flex flex-col items-center border border-gray-700 rounded bg-black/50 px-3 py-1">
                         <span className="text-white font-bold text-sm">Y</span>
                         <span className="text-[10px] text-gray-500">YES</span>
                     </div>
                     <div className="flex flex-col items-center border border-gray-700 rounded bg-black/50 px-3 py-1">
                         <span className="text-white font-bold text-sm">N</span>
                         <span className="text-[10px] text-gray-500">NO</span>
                     </div>
                 </div>
            </div>
        </>
    );
};
