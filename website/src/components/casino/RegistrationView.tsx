
import React from 'react';
import { PlayerStats, LeaderboardEntry } from '../types';
import { formatTime } from '../utils/gameUtils';

interface RegistrationViewProps {
  stats: PlayerStats;
  leaderboard: LeaderboardEntry[];
  isRegistered: boolean;
  timeLeft: number;
  onRegister: () => void;
}

export const RegistrationView: React.FC<RegistrationViewProps> = ({ 
  stats, 
  leaderboard, 
  isRegistered, 
  timeLeft, 
  onRegister 
}) => {
  const pnlData = stats.pnlHistory;
  const maxVal = Math.max(...pnlData, 100);
  const minVal = Math.min(...pnlData, -100);
  const range = maxVal - minVal;
  const height = 100;
  const width = 300;

  const points = pnlData.map((val, i) => {
       const x = (i / Math.max(pnlData.length - 1, 1)) * width;
       const y = height - ((val - minVal) / (range || 1)) * height;
       return `${x},${y}`;
  }).join(' ');

  return (
      <div className="flex flex-col h-screen w-screen bg-terminal-black text-white font-mono items-center justify-center p-8">
          <div className="max-w-4xl w-full border border-terminal-green rounded-lg p-8 shadow-2xl relative bg-black/80 backdrop-blur">
              <h1 className="text-3xl font-bold text-center mb-2 tracking-[0.5em] text-white">TOURNAMENT RESULTS</h1>
              
              {/* COUNTDOWN TIMER */}
              <div className="text-center mb-8">
                  <span className="text-xs text-gray-500 tracking-widest block mb-1">NEXT ROUND STARTS IN</span>
                  <span className="text-4xl font-bold text-terminal-accent animate-pulse font-mono">
                      {formatTime(timeLeft)}
                  </span>
              </div>
              
              <div className="grid grid-cols-2 gap-12">
                  {/* STATS */}
                  <div className="space-y-6">
                      <h2 className="text-xl font-bold text-gray-500 border-b border-gray-800 pb-2">YOUR PERFORMANCE</h2>
                      <div className="grid grid-cols-2 gap-4 text-sm">
                           <div className="bg-gray-900 p-4 rounded border border-gray-800">
                               <div className="text-gray-500 text-xs mb-1">FINAL CHIPS</div>
                               <div className="text-2xl text-terminal-gold font-bold">${stats.chips.toLocaleString()}</div>
                           </div>
                           <div className="bg-gray-900 p-4 rounded border border-gray-800">
                               <div className="text-gray-500 text-xs mb-1">FINAL RANK</div>
                               <div className="text-2xl text-terminal-green font-bold">#{stats.rank}</div>
                           </div>
                      </div>
                      
                      <div className="space-y-2">
                          <div className="text-xs text-gray-500 uppercase tracking-widest">PNL BY GAME</div>
                          {Object.entries(stats.pnlByGame).map(([game, pnl]) => {
                              const val = pnl as number;
                              return (
                              <div key={game} className="flex justify-between text-xs border-b border-gray-800 pb-1">
                                  <span>{game}</span>
                                  <span className={val >= 0 ? 'text-terminal-green' : 'text-terminal-accent'}>
                                      {val >= 0 ? '+' : ''}{val}
                                  </span>
                              </div>
                              );
                          })}
                      </div>
                  </div>

                  {/* CHART & REGISTRATION */}
                  <div className="space-y-8 flex flex-col">
                       <div>
                           <h2 className="text-xl font-bold text-gray-500 border-b border-gray-800 pb-2 mb-4">PNL EVOLUTION</h2>
                           <div className="w-full h-32 bg-gray-900 border border-gray-800 rounded relative overflow-hidden">
                               <svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
                                    <polyline 
                                        points={points} 
                                        fill="none" 
                                        stroke="#00ff41" 
                                        strokeWidth="2" 
                                    />
                               </svg>
                           </div>
                       </div>

                       <div className="flex-1 flex flex-col items-center justify-center gap-4">
                           {isRegistered ? (
                               <div className="flex flex-col items-center gap-2 animate-pulse">
                                   <span className="text-2xl font-bold text-terminal-green">REGISTERED</span>
                                   <span className="text-xs text-gray-500">WAITING FOR NEXT ROUND...</span>
                               </div>
                           ) : (
                               <button 
                                  className="px-8 py-4 bg-terminal-green text-black font-bold text-xl rounded hover:bg-green-400 transition-colors shadow-[0_0_20px_rgba(0,255,65,0.5)]"
                                  onClick={onRegister}
                               >
                                   PRESS [R] TO REGISTER
                               </button>
                           )}
                           
                           <div className="text-center">
                                <div className="text-[10px] text-gray-500 mb-1">REGISTERED PLAYERS</div>
                                <div className="text-xs text-gray-400 flex flex-wrap justify-center gap-2 max-w-xs">
                                    {leaderboard.slice(0, 8).map((p, i) => (
                                        <span key={i}>{p.name}</span>
                                    ))}
                                    <span>...</span>
                                </div>
                           </div>
                       </div>
                  </div>
              </div>
          </div>
      </div>
  );
};
