
import React from 'react';
import { GameState, Card } from '../../types';
import { Hand } from '../GameComponents';
import { calculateHiLoProjection } from '../../utils/gameUtils';

interface HiLoViewProps {
    gameState: GameState;
    deck: Card[];
}

export const HiLoView: React.FC<HiLoViewProps> = ({ gameState, deck }) => {
    const projections = calculateHiLoProjection(gameState.playerCards, deck, gameState.hiloAccumulator);

    const getHiLoMultiplier = (potentialPayout: number) => {
        if (potentialPayout <= 0 || gameState.hiloAccumulator <= 0) return "0.00x";
        return (potentialPayout / gameState.hiloAccumulator).toFixed(2) + "x";
    };

    // Chart Data Generation
    const data = gameState.hiloGraphData;
    const maxVal = Math.max(...data, gameState.hiloAccumulator * 1.5, 100);
    const width = 300;
    const height = 60;
    
    const points = data.map((val, i) => {
        const x = (i / (Math.max(data.length - 1, 1))) * width;
        const y = height - ((val / maxVal) * height);
        return `${x},${y}`;
    }).join(' ');

    return (
        <>
            <div className="flex-1 w-full flex flex-col items-center justify-center gap-8 relative z-10 pb-20">
                <h1 className="absolute top-0 text-xl font-bold text-gray-500 tracking-widest uppercase">HILO</h1>
                
                {/* TOP: POT & CHART */}
                <div className="min-h-[120px] flex flex-col items-center justify-center w-full max-w-md">
                     <div className="text-3xl text-terminal-gold font-bold mb-2 tracking-widest">
                         POT: ${gameState.hiloAccumulator.toLocaleString()}
                     </div>
                     
                     {/* Line Chart */}
                     <div className="w-full h-[60px] border border-gray-800 bg-black/50 relative overflow-hidden rounded">
                         <svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
                             <polyline 
                                 points={points} 
                                 fill="none" 
                                 stroke={gameState.lastResult < 0 ? '#ff003c' : '#00ff41'} 
                                 strokeWidth="2" 
                             />
                             {data.map((val, i) => {
                                 const x = (i / (Math.max(data.length - 1, 1))) * width;
                                 const y = height - ((val / maxVal) * height);
                                 return (
                                     <circle key={i} cx={x} cy={y} r="3" className="fill-white" />
                                 );
                             })}
                         </svg>
                     </div>
                </div>

                {/* Center Info */}
                <div className="text-center space-y-3 relative z-20">
                        <div className="text-2xl font-bold text-white tracking-widest animate-pulse">
                            {gameState.message}
                        </div>
                </div>

                {/* Current Card & Projections */}
                <div className="min-h-[120px] flex gap-8 items-center justify-center">
                    {gameState.playerCards.length > 0 && (
                        <div className="flex flex-col gap-2 items-center">
                            <span className="text-xs uppercase tracking-widest text-gray-500">CURRENT CARD</span>
                            <div className="flex items-center gap-4">
                                {/* LOWER PROJECTION */}
                                <div className="text-right opacity-80">
                                    <div className="text-[10px] text-gray-500 uppercase">LOWER</div>
                                    <div className="text-terminal-green font-bold text-sm">
                                        {getHiLoMultiplier(projections.low)}
                                    </div>
                                </div>

                                <Hand cards={[gameState.playerCards[gameState.playerCards.length - 1]]} />
                                
                                {/* HIGHER PROJECTION */}
                                <div className="text-left opacity-80">
                                    <div className="text-[10px] text-gray-500 uppercase">HIGHER</div>
                                    <div className="text-terminal-green font-bold text-sm">
                                        {getHiLoMultiplier(projections.high)}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                {/* BOTTOM: History */}
                <div className="min-h-[60px] flex items-center justify-center">
                     {gameState.playerCards.length > 1 && (
                        <div className="flex flex-col items-center gap-2">
                            <span className="text-[10px] uppercase tracking-widest text-gray-600">CARD HISTORY</span>
                            <div className="flex gap-2 opacity-50 scale-75 origin-top">
                                {gameState.playerCards.slice(0, -1).slice(-8).map((c, i) => (
                                    <Hand key={i} cards={[c]} />
                                ))}
                            </div>
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
                            <span className="text-[10px] text-gray-500">HIGHER</span>
                        </div>
                        <div className="flex flex-col items-center border border-terminal-accent/50 rounded bg-black/50 px-3 py-1">
                            <span className="text-terminal-accent font-bold text-sm">L</span>
                            <span className="text-[10px] text-gray-500">LOWER</span>
                        </div>
                        <div className="flex flex-col items-center border border-terminal-gold/50 rounded bg-black/50 px-3 py-1">
                            <span className="text-terminal-gold font-bold text-sm">C</span>
                            <span className="text-[10px] text-gray-500">CASHOUT</span>
                        </div>
                    </div>
                )}
            </div>
        </>
    );
};
