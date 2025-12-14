import React, { useEffect, useState } from 'react';

interface BigWinEffectProps {
    amount: number;
    show: boolean;
    durationMs?: number;
}

export const BigWinEffect: React.FC<BigWinEffectProps> = ({ amount, show, durationMs }) => {
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        if (show && amount > 0) {
            setVisible(true);
            const timer = setTimeout(() => setVisible(false), durationMs ?? 3000);
            return () => clearTimeout(timer);
        } else {
            setVisible(false);
        }
    }, [show, amount, durationMs]);

    if (!visible) return null;

    return (
        <div className="absolute inset-0 z-[100] flex items-center justify-center pointer-events-none overflow-hidden">
            {/* Opaque overlay so the win text never blends with the underlying UI */}
            <div className="absolute inset-0 bg-black/85"></div>
            <div className="absolute inset-0 bg-terminal-green/20 animate-pulse"></div>

            {/* Particles (CSS generated for simplicity) */}
            <div className="absolute inset-0 flex items-center justify-center">
                 {[...Array(20)].map((_, i) => (
                     <div 
                        key={i}
                        className="absolute w-2 h-2 bg-terminal-gold rounded-full animate-explosion"
                        style={{
                            '--dir-x': Math.random() * 2 - 1,
                            '--dir-y': Math.random() * 2 - 1,
                            '--delay': `${Math.random() * 0.5}s`,
                            '--speed': `${0.5 + Math.random()}s`
                        } as React.CSSProperties}
                     ></div>
                 ))}
            </div>

            {/* Text Overlay */}
            <div className="relative flex flex-col items-center gap-2 animate-bounce-in">
                <div className="bg-black/90 border border-terminal-green/40 rounded-xl px-6 py-2 shadow-[0_0_30px_rgba(0,0,0,0.9)]">
                    <div
                        className="text-6xl font-black text-terminal-gold tracking-tighter drop-shadow-[0_0_15px_rgba(255,215,0,0.8)]"
                        style={{ textShadow: '4px 4px 0px #000' }}
                    >
                        WINNER
                    </div>
                </div>
                <div className="text-4xl font-bold text-white bg-black/90 px-5 py-1.5 rounded border border-terminal-green/50 shadow-[0_0_20px_rgba(0,0,0,0.9)]">
                    +${amount.toLocaleString()}
                </div>
            </div>
        </div>
    );
};
