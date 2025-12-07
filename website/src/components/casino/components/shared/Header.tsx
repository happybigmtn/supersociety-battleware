import React from 'react';
import { PlayerStats, TournamentPhase } from '../../types';

interface HeaderProps {
    phase: TournamentPhase;
    tournamentTime: number;
    stats: PlayerStats;
}

export const Header: React.FC<HeaderProps> = ({ phase, tournamentTime, stats }) => {
    const formatTime = (seconds: number) => {
        const m = Math.floor(seconds / 60).toString().padStart(2, '0');
        const s = (seconds % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
    };

    return (
        <header className="h-12 border-b border-terminal-dim flex items-center justify-between px-4 z-10 bg-terminal-black/90 backdrop-blur">
            <div className="flex items-center gap-4">
                <span className="font-bold tracking-tighter text-white">SUPERHUMAN CASINO</span>
                <span className="text-xs px-2 py-1 bg-terminal-dim rounded text-gray-400">{phase} PHASE</span>
            </div>
            <div className="flex items-center gap-6 text-sm">
                <div className="flex items-center gap-2">
                    <span className="text-gray-500">TIMER</span>
                    <span className={`font-bold ${tournamentTime < 60 ? 'text-terminal-accent animate-pulse' : 'text-white'}`}>{formatTime(tournamentTime)}</span>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-gray-500">SHIELDS</span>
                    <div className="flex gap-1">
                        {[...Array(3)].map((_, i) => (
                            <div key={i} className={`w-2 h-2 rounded-full ${i < stats.shields ? 'bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.8)]' : 'bg-gray-800'}`} />
                        ))}
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-gray-500">DOUBLES</span>
                    <div className="flex gap-1">
                        {[...Array(3)].map((_, i) => (
                            <div key={i} className={`w-2 h-2 rounded-full ${i < stats.doubles ? 'bg-purple-400 shadow-[0_0_8px_rgba(192,132,252,0.8)]' : 'bg-gray-800'}`} />
                        ))}
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-gray-500">CHIPS</span>
                    <span className="text-terminal-gold font-bold text-lg">${stats.chips.toLocaleString()}</span>
                </div>
            </div>
        </header>
    );
};
