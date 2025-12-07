
import React from 'react';
import { GameState, Card } from '../../types';
import { Hand } from '../GameComponents';
import { evaluateVideoPokerHand } from '../../utils/gameUtils';

interface VideoPokerViewProps {
    gameState: GameState;
    onToggleHold: (index: number) => void;
}

export const VideoPokerView: React.FC<VideoPokerViewProps> = ({ gameState, onToggleHold }) => {
    return (
        <>
            <div className="flex-1 w-full flex flex-col items-center justify-center gap-8 relative z-10 pb-20">
                <h1 className="absolute top-0 text-xl font-bold text-gray-500 tracking-widest uppercase">VIDEO POKER</h1>
                {/* Center Info */}
                <div className="text-center space-y-3 relative z-20">
                    <div className="text-2xl font-bold text-white tracking-widest animate-pulse">
                        {gameState.message}
                    </div>
                </div>

                {/* Hand Area */}
                <div className="min-h-[120px] flex gap-4 items-center justify-center">
                    {gameState.playerCards.length > 0 && gameState.playerCards.map((card, i) => (
                        <div key={i} className="flex flex-col gap-2 cursor-pointer transition-transform hover:-translate-y-2" onClick={() => onToggleHold(i)}>
                             <Hand cards={[card]} />
                             <div className={`text-center text-[10px] font-bold py-1 border rounded ${card.isHidden ? 'border-terminal-green text-terminal-green bg-terminal-green/10' : 'border-transparent text-transparent'}`}>
                                 HOLD
                             </div>
                             <div className="text-center text-[10px] text-gray-600">[{i+1}]</div>
                        </div>
                    ))}
                </div>
            </div>

            {/* CONTROLS */}
            <div className="absolute bottom-8 left-0 right-0 h-16 bg-terminal-black/90 border-t border-terminal-dim flex items-center justify-center gap-2 p-2 z-40">
                    <div className="flex gap-2">
                        {[1,2,3,4,5].map(n => (
                            <div key={n} className="flex flex-col items-center border border-terminal-dim rounded bg-black/50 px-3 py-1">
                                <span className="text-white font-bold text-sm">{n}</span>
                                <span className="text-[10px] text-gray-500">HOLD</span>
                            </div>
                        ))}
                    </div>
                    <div className="w-px h-8 bg-gray-800 mx-2"></div>
                    <div className="flex flex-col items-center border border-terminal-green/50 rounded bg-black/50 px-3 py-1 w-24">
                        <span className="text-terminal-green font-bold text-sm">D</span>
                        <span className="text-[10px] text-gray-500">DRAW</span>
                    </div>
            </div>
        </>
    );
};
