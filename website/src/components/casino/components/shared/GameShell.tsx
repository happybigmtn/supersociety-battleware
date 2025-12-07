import React from 'react';
import { GameState } from '../../types';

interface GameShellProps {
    gameState: GameState;
    aiAdvice: string | null;
    children: React.ReactNode;
}

export const GameShell: React.FC<GameShellProps> = ({ gameState, aiAdvice, children }) => {
    return (
        <div className="flex-1 flex flex-col items-center justify-center p-8 pb-20 relative">
            {aiAdvice && (
                <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-terminal-dim/90 border border-terminal-green p-3 rounded max-w-md text-center text-sm shadow-xl animate-pulse z-20">
                    <span className="text-terminal-green font-bold">WIZARD: </span> {aiAdvice}
                </div>
            )}

            <div className="w-full max-w-4xl h-[65vh] border border-terminal-dim rounded-lg relative flex flex-col items-center justify-center bg-[#0d0d0d] overflow-hidden">
                <div className="absolute top-4 left-4 text-xs text-gray-600 tracking-[0.2em]">{gameState.type}</div>
                
                {/* Powerup Status Overlay */}
                <div className="absolute top-4 right-4 flex gap-4">
                  {gameState.activeModifiers.shield && <div className="text-xs text-cyan-400 border border-cyan-400 px-2 py-1 rounded shadow-[0_0_10px_rgba(34,211,238,0.3)]">SHIELD ACTIVE</div>}
                  {gameState.activeModifiers.double && <div className="text-xs text-purple-400 border border-purple-400 px-2 py-1 rounded shadow-[0_0_10px_rgba(192,132,252,0.3)]">DOUBLE ACTIVE</div>}
                </div>

                {children}
            </div>
        </div>
    );
};
