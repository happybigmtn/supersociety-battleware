
import React, { useMemo, useCallback } from 'react';
import { GameState, SicBoBet } from '../../../types';
import { DiceRender } from '../GameComponents';
import { MobileDrawer } from '../MobileDrawer';
import { getSicBoTotalItems, getSicBoCombinationItems, calculateSicBoTotalExposure, calculateSicBoCombinationExposure } from '../../../utils/gameUtils';

export const SicBoView = React.memo<{ gameState: GameState; numberInput?: string; actions: any }>(({ gameState, numberInput = "", actions }) => {

    const totalItems = useMemo(() => getSicBoTotalItems(), []);
    const combinationItems = useMemo(() => getSicBoCombinationItems(), []);
    const betTypes = useMemo(() => new Set(gameState.sicBoBets.map((b) => b.type)), [gameState.sicBoBets]);

    const renderBetItem = useCallback((bet: SicBoBet, i: number) => {
        const targetLabel = (() => {
            if (bet.type === 'DOMINO' && bet.target !== undefined) {
                const min = (bet.target >> 4) & 0x0f;
                const max = bet.target & 0x0f;
                return `${min}-${max}`;
            }
            if ((bet.type === 'HOP3_EASY' || bet.type === 'HOP4_EASY') && bet.target !== undefined) {
                const parts = [1, 2, 3, 4, 5, 6].filter((n) => (bet.target! & (1 << (n - 1))) !== 0);
                return parts.join('-');
            }
            if (bet.type === 'HOP3_HARD' && bet.target !== undefined) {
                const doubled = (bet.target >> 4) & 0x0f;
                const single = bet.target & 0x0f;
                return `${doubled}-${doubled}-${single}`;
            }
            return bet.target !== undefined ? String(bet.target) : '';
        })();

        return (
            <div key={i} className="flex justify-between items-center text-xs border border-gray-800 p-1 rounded bg-black/50">
                <div className="flex flex-col">
                    <span className="text-terminal-green font-bold text-[10px]">{bet.type} {targetLabel}</span>
                </div>
                <div className="text-white text-[10px]">${bet.amount}</div>
            </div>
        );
    }, []);

    // Render a single exposure row for TOTALS column
    const renderTotalRow = useCallback((entry: { total: number; isTriple: boolean; label: string }, idx: number) => {
        const pnl = calculateSicBoTotalExposure(entry.total, entry.isTriple, gameState.sicBoBets);
        const pnlRounded = Math.round(pnl);

        return (
            <div key={idx} className="flex items-center h-5 text-xs w-full">
                <div className="flex-1 flex justify-end items-center text-right pr-1 overflow-hidden">
                    {pnlRounded < 0 && <span className="text-terminal-accent font-mono text-[10px]">-{Math.abs(pnlRounded).toLocaleString()}</span>}
                </div>
                <div className="flex-none w-6 flex justify-center items-center relative">
                    <span className={`font-mono z-10 text-[10px] ${entry.isTriple ? 'text-terminal-gold font-bold' : 'text-gray-500'}`}>
                        {entry.label}
                    </span>
                    {pnlRounded < 0 && <div className="absolute right-0 top-0.5 bottom-0.5 w-0.5 bg-terminal-accent" />}
                    {pnlRounded > 0 && <div className="absolute left-0 top-0.5 bottom-0.5 w-0.5 bg-terminal-green" />}
                </div>
                <div className="flex-1 flex justify-start items-center pl-1 overflow-hidden">
                    {pnlRounded > 0 && <span className="text-terminal-green font-mono text-[10px]">+{pnlRounded.toLocaleString()}</span>}
                </div>
            </div>
        );
    }, [gameState.sicBoBets]);

    // Render a single exposure row for COMBINATIONS column
    const renderComboRow = useCallback((entry: { type: 'SINGLE' | 'SINGLE_2X' | 'SINGLE_3X' | 'DOUBLE' | 'TRIPLE' | 'ANY_TRIPLE'; target?: number; label: string }, idx: number) => {
        const pnl = calculateSicBoCombinationExposure(entry.type, entry.target, gameState.sicBoBets);
        const pnlRounded = Math.round(pnl);

        // Color code by type
        const typeColor = entry.type === 'SINGLE' ? 'text-cyan-400'
            : entry.type === 'SINGLE_2X' ? 'text-cyan-300'
            : entry.type === 'SINGLE_3X' ? 'text-cyan-200'
            : entry.type === 'DOUBLE' ? 'text-purple-400'
            : entry.type === 'TRIPLE' ? 'text-terminal-gold'
            : 'text-terminal-gold';

        return (
            <div key={idx} className="flex items-center h-5 text-xs w-full">
                <div className="flex-1 flex justify-end items-center text-right pr-1 overflow-hidden">
                    {pnlRounded < 0 && <span className="text-terminal-accent font-mono text-[10px]">-{Math.abs(pnlRounded).toLocaleString()}</span>}
                </div>
                <div className="flex-none w-10 flex justify-center items-center relative">
                    <span className={`font-mono z-10 text-[10px] ${typeColor}`}>
                        {entry.label}
                    </span>
                    {pnlRounded < 0 && <div className="absolute right-0 top-0.5 bottom-0.5 w-0.5 bg-terminal-accent" />}
                    {pnlRounded > 0 && <div className="absolute left-0 top-0.5 bottom-0.5 w-0.5 bg-terminal-green" />}
                </div>
                <div className="flex-1 flex justify-start items-center pl-1 overflow-hidden">
                    {pnlRounded > 0 && <span className="text-terminal-green font-mono text-[10px]">+{pnlRounded.toLocaleString()}</span>}
                </div>
            </div>
        );
    }, [gameState.sicBoBets]);

    return (
        <>
            <div className="flex-1 w-full flex flex-col items-center justify-center gap-8 relative z-10 pb-20 md:pl-64 md:pr-60">
                <h1 className="absolute top-0 text-xl font-bold text-gray-500 tracking-widest uppercase">SIC BO</h1>
                <div className="absolute top-2 right-2 z-40">
                    <MobileDrawer label="INFO" title="SIC BO">
                        <div className="space-y-3">
                            <div className="border border-gray-800 rounded bg-black/40 p-2">
                                <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-2 border-b border-gray-800 pb-1 text-center">
                                    Exposure
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                    <div className="space-y-0.5">
                                        <div className="text-[9px] text-gray-500 tracking-widest text-center mb-1">TOTALS</div>
                                        {totalItems.map((entry, idx) => renderTotalRow(entry, idx))}
                                    </div>
                                    <div className="space-y-0.5">
                                        <div className="text-[9px] text-gray-500 tracking-widest text-center mb-1">COMBOS</div>
                                        {combinationItems.map((entry, idx) => renderComboRow(entry, idx))}
                                    </div>
                                </div>
                            </div>
                            <div className="border border-gray-800 rounded bg-black/40 p-2">
                                <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-2 border-b border-gray-800 pb-1 text-center">
                                    Table Bets
                                </div>
                                <div className="flex flex-col space-y-1">
                                    {gameState.sicBoBets.length > 0 ? (
                                        gameState.sicBoBets.map((b, i) => renderBetItem(b, i))
                                    ) : (
                                        <div className="text-center text-[10px] text-gray-700 italic">NO BETS</div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </MobileDrawer>
                </div>
                {/* Dice Display */}
                <div className="min-h-[120px] flex items-center justify-center">
                    {gameState.dice.length === 3 ? (
                        <div className="flex flex-col gap-2 items-center">
                             <span className="text-xs uppercase tracking-widest text-gray-500">ROLL</span>
                             <div className="flex gap-4">
                                {gameState.dice.map((d, i) => <DiceRender key={i} value={d} delayMs={i * 60} />)}
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
                    <div className="text-2xl font-bold text-terminal-gold tracking-widest animate-pulse">
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

             {/* EXPOSURE SIDEBAR - Two Columns: Totals | Combinations */}
             <div className="hidden md:flex absolute top-0 left-0 bottom-24 w-64 bg-terminal-black/80 border-r-2 border-gray-700 p-2 overflow-hidden backdrop-blur-sm z-30 flex-col">
                {/* Two-column header */}
                <div className="flex-none flex border-b border-gray-800 pb-1 mb-1">
                    <div className="flex-1 text-center">
                        <span className="text-[9px] font-bold text-gray-500 tracking-widest">TOTALS</span>
                    </div>
                    <div className="flex-1 text-center">
                        <span className="text-[9px] font-bold text-gray-500 tracking-widest">COMBOS</span>
                    </div>
                </div>

                <div className="flex-1 flex flex-row relative overflow-hidden">
                    {/* Vertical Divider */}
                    <div className="absolute left-1/2 top-0 bottom-0 w-px bg-gray-800 -translate-x-1/2"></div>

                    {/* Left Column - Totals 3-18 */}
                    <div className="flex-1 flex flex-col gap-0 pr-1 border-r border-gray-800/50 overflow-y-auto">
                        {totalItems.map((entry, idx) => renderTotalRow(entry, idx))}
                    </div>

                    {/* Right Column - Singles (1x/2x/3x), Doubles, Triples */}
                    <div className="flex-1 flex flex-col gap-0 pl-1 overflow-y-auto">
                        <div className="text-[8px] text-cyan-400 text-center mb-0.5">1×</div>
                        {combinationItems.filter(c => c.type === 'SINGLE').map((entry, idx) => renderComboRow(entry, idx))}

                        <div className="text-[8px] text-cyan-300 text-center mt-0.5 mb-0.5">2×</div>
                        {combinationItems.filter(c => c.type === 'SINGLE_2X').map((entry, idx) => renderComboRow(entry, idx + 6))}

                        <div className="text-[8px] text-cyan-200 text-center mt-0.5 mb-0.5">3×</div>
                        {combinationItems.filter(c => c.type === 'SINGLE_3X').map((entry, idx) => renderComboRow(entry, idx + 12))}

                        <div className="text-[8px] text-purple-400 text-center mt-0.5 mb-0.5">DBL</div>
                        {combinationItems.filter(c => c.type === 'DOUBLE').map((entry, idx) => renderComboRow(entry, idx + 18))}

                        <div className="text-[8px] text-terminal-gold text-center mt-0.5 mb-0.5">TRP</div>
                        {combinationItems.filter(c => c.type === 'TRIPLE' || c.type === 'ANY_TRIPLE').map((entry, idx) => renderComboRow(entry, idx + 24))}
                    </div>
                </div>
            </div>

            {/* ACTIVE BETS SIDEBAR - Reduced to w-60 */}
            <div className="hidden md:flex absolute top-0 right-0 bottom-24 w-60 bg-terminal-black/80 border-l-2 border-gray-700 p-2 backdrop-blur-sm z-30 flex-col">
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
            <div className="absolute bottom-8 left-0 right-0 h-16 bg-terminal-black/90 border-t-2 border-gray-700 flex items-center justify-start md:justify-center gap-2 p-2 z-40 overflow-x-auto">
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={() => actions?.placeSicBoBet?.('SMALL')}
                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
                                betTypes.has('SMALL') ? 'border-terminal-green bg-terminal-green/10' : 'border-terminal-dim'
                            }`}
                        >
                            <span className="text-white font-bold text-sm">S</span>
                            <span className="text-[10px] text-gray-500">SMALL</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => actions?.placeSicBoBet?.('BIG')}
                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
                                betTypes.has('BIG') ? 'border-terminal-green bg-terminal-green/10' : 'border-terminal-dim'
                            }`}
                        >
                            <span className="text-white font-bold text-sm">B</span>
                            <span className="text-[10px] text-gray-500">BIG</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => actions?.placeSicBoBet?.('ODD')}
                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
                                betTypes.has('ODD') ? 'border-terminal-green bg-terminal-green/10' : 'border-terminal-dim'
                            }`}
                        >
                            <span className="text-white font-bold text-sm">O</span>
                            <span className="text-[10px] text-gray-500">ODD</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => actions?.placeSicBoBet?.('EVEN')}
                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
                                betTypes.has('EVEN') ? 'border-terminal-green bg-terminal-green/10' : 'border-terminal-dim'
                            }`}
                        >
                            <span className="text-white font-bold text-sm">V</span>
                            <span className="text-[10px] text-gray-500">EVEN</span>
                        </button>
                    </div>
                    <div className="w-px h-8 bg-gray-800 mx-2"></div>
                    <div className="flex gap-2">
                         <button
                            type="button"
                            onClick={() => actions?.setGameState?.((prev: any) => ({ ...prev, sicBoInputMode: 'SINGLE' }))}
                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
                                gameState.sicBoInputMode === 'SINGLE' || betTypes.has('SINGLE_DIE')
                                    ? 'border-terminal-green bg-terminal-green/10'
                                    : 'border-terminal-dim'
                            }`}
                         >
                            <span className="text-white font-bold text-sm">N</span>
                            <span className="text-[10px] text-gray-500">DIE</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => actions?.setGameState?.((prev: any) => ({ ...prev, sicBoInputMode: 'DOUBLE' }))}
                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
                                gameState.sicBoInputMode === 'DOUBLE' || betTypes.has('DOUBLE_SPECIFIC')
                                    ? 'border-terminal-green bg-terminal-green/10'
                                    : 'border-terminal-dim'
                            }`}
                        >
                            <span className="text-white font-bold text-sm">D</span>
                            <span className="text-[10px] text-gray-500">DOUBLE</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => actions?.setGameState?.((prev: any) => ({ ...prev, sicBoInputMode: 'TRIPLE' }))}
                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
                                gameState.sicBoInputMode === 'TRIPLE' || betTypes.has('TRIPLE_SPECIFIC')
                                    ? 'border-terminal-green bg-terminal-green/10'
                                    : 'border-terminal-dim'
                            }`}
                        >
                            <span className="text-white font-bold text-sm">T</span>
                            <span className="text-[10px] text-gray-500">TRIPLE</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => actions?.setGameState?.((prev: any) => ({ ...prev, sicBoInputMode: 'DOMINO' }))}
                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
                                gameState.sicBoInputMode === 'DOMINO' || betTypes.has('DOMINO')
                                    ? 'border-terminal-green bg-terminal-green/10'
                                    : 'border-terminal-dim'
                            }`}
                        >
                            <span className="text-white font-bold text-sm">C</span>
                            <span className="text-[10px] text-gray-500">DOMINO</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => actions?.setGameState?.((prev: any) => ({ ...prev, sicBoInputMode: 'HOP3_EASY' }))}
                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
                                gameState.sicBoInputMode === 'HOP3_EASY' || betTypes.has('HOP3_EASY')
                                    ? 'border-terminal-green bg-terminal-green/10'
                                    : 'border-terminal-dim'
                            }`}
                        >
                            <span className="text-white font-bold text-sm">E</span>
                            <span className="text-[10px] text-gray-500">3-HOP</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => actions?.setGameState?.((prev: any) => ({ ...prev, sicBoInputMode: 'HOP3_HARD' }))}
                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
                                gameState.sicBoInputMode === 'HOP3_HARD' || betTypes.has('HOP3_HARD')
                                    ? 'border-terminal-green bg-terminal-green/10'
                                    : 'border-terminal-dim'
                            }`}
                        >
                            <span className="text-white font-bold text-sm">H</span>
                            <span className="text-[10px] text-gray-500">HARD</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => actions?.setGameState?.((prev: any) => ({ ...prev, sicBoInputMode: 'HOP4_EASY' }))}
                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
                                gameState.sicBoInputMode === 'HOP4_EASY' || betTypes.has('HOP4_EASY')
                                    ? 'border-terminal-green bg-terminal-green/10'
                                    : 'border-terminal-dim'
                            }`}
                        >
                            <span className="text-white font-bold text-sm">F</span>
                            <span className="text-[10px] text-gray-500">4-HOP</span>
                        </button>
                         <button
                            type="button"
                            onClick={() => actions?.setGameState?.((prev: any) => ({ ...prev, sicBoInputMode: 'SUM' }))}
                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
                                gameState.sicBoInputMode === 'SUM' || betTypes.has('SUM')
                                    ? 'border-terminal-green bg-terminal-green/10'
                                    : 'border-terminal-dim'
                            }`}
                        >
                            <span className="text-white font-bold text-sm">M</span>
                            <span className="text-[10px] text-gray-500">SUM</span>
                        </button>
                    </div>
                    <div className="w-px h-8 bg-gray-800 mx-2"></div>
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={() => actions?.placeSicBoBet?.('TRIPLE_ANY')}
                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
                                betTypes.has('TRIPLE_ANY') ? 'border-terminal-green bg-terminal-green/10' : 'border-terminal-dim'
                            }`}
                        >
                            <span className="text-white font-bold text-sm">A</span>
                            <span className="text-[10px] text-gray-500">ANY 3</span>
                        </button>
                        <button
                            type="button"
                            onClick={actions?.rebetSicBo}
                            className="flex flex-col items-center border border-gray-700 rounded bg-black/50 px-3 py-1"
                        >
                            <span className="text-gray-500 font-bold text-sm">R</span>
                            <span className="text-[10px] text-gray-600">REBET</span>
                        </button>
                        <button
                            type="button"
                            onClick={actions?.undoSicBoBet}
                            className="flex flex-col items-center border border-gray-700 rounded bg-black/50 px-3 py-1"
                        >
                            <span className="text-gray-500 font-bold text-sm">U</span>
                            <span className="text-[10px] text-gray-600">UNDO</span>
                        </button>
                    </div>
                    <div className="w-px h-8 bg-gray-800 mx-2"></div>
                     <div className="flex gap-2">
                         <button
                            type="button"
                            onClick={actions?.toggleShield}
                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${gameState.activeModifiers.shield ? 'border-cyan-400 text-cyan-400' : 'border-gray-700 text-gray-500'}`}
                         >
                            <span className="font-bold text-sm">Z</span>
                            <span className="text-[10px]">SHIELD</span>
                        </button>
                         <button
                            type="button"
                            onClick={actions?.toggleDouble}
                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${gameState.activeModifiers.double ? 'border-purple-400 text-purple-400' : 'border-gray-700 text-gray-500'}`}
                         >
                            <span className="font-bold text-sm">X</span>
                            <span className="text-[10px]">DOUBLE</span>
                        </button>
                        <button
                            type="button"
                            onClick={actions?.toggleSuper}
                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
                                gameState.activeModifiers.super
                                    ? 'border-terminal-gold text-terminal-gold'
                                    : 'border-gray-700 text-gray-500'
                            }`}
                        >
                            <span className="font-bold text-sm">G</span>
                            <span className="text-[10px]">SUPER</span>
                        </button>
                    </div>
                    <div className="w-px h-8 bg-gray-800 mx-2"></div>
                    <button
                        type="button"
                        onClick={actions?.deal}
                        className="flex flex-col items-center border border-terminal-green/50 rounded bg-black/50 px-3 py-1 w-24"
                    >
                        <span className="text-terminal-green font-bold text-sm">SPACE</span>
                        <span className="text-[10px] text-gray-500">ROLL</span>
                    </button>
            </div>

            {/* SIC BO MODAL */}
            {gameState.sicBoInputMode !== 'NONE' && (
                 <div className="absolute inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center">
                     <div className="bg-terminal-black border border-terminal-green p-6 rounded-lg shadow-xl flex flex-col items-center gap-4">
                         <div className="text-sm tracking-widest text-gray-400 uppercase">
                             {gameState.sicBoInputMode === 'SINGLE' && "SELECT NUMBER (1-6)"}
                             {gameState.sicBoInputMode === 'DOUBLE' && "SELECT DOUBLE (1-6)"}
                             {gameState.sicBoInputMode === 'TRIPLE' && "SELECT TRIPLE (1-6)"}
                             {gameState.sicBoInputMode === 'DOMINO' && "SELECT 2 NUMBERS (1-6)"}
                             {gameState.sicBoInputMode === 'HOP3_EASY' && "SELECT 3 NUMBERS (1-6)"}
                             {gameState.sicBoInputMode === 'HOP3_HARD' && "SELECT DOUBLE THEN SINGLE (1-6)"}
                             {gameState.sicBoInputMode === 'HOP4_EASY' && "SELECT 4 NUMBERS (1-6)"}
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

                         {gameState.sicBoInputMode === 'DOMINO' && numberInput && (
                             <div className="text-xs text-gray-500">FIRST: {numberInput}</div>
                         )}

                         {gameState.sicBoInputMode === 'HOP3_HARD' && numberInput && (
                             <div className="text-xs text-gray-500">DOUBLE: {numberInput}</div>
                         )}

                         {(gameState.sicBoInputMode === 'HOP3_EASY' || gameState.sicBoInputMode === 'HOP4_EASY') && numberInput && (
                             <div className="text-xs text-gray-500">SELECTED: {numberInput.split('').join('-')}</div>
                         )}

                         <div className="text-xs text-gray-500 mt-2">
                             [ESC] CANCEL {gameState.sicBoInputMode === 'SUM' && "[ENTER] CONFIRM"}
                         </div>
                     </div>
                 </div>
            )}
        </>
    );
});
