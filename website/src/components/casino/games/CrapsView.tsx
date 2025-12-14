
import React, { useMemo } from 'react';
import { GameState } from '../../../types';
import { DiceRender } from '../GameComponents';
import { MobileDrawer } from '../MobileDrawer';
import { calculateCrapsExposure } from '../../../utils/gameUtils';

export const CrapsView = React.memo<{ gameState: GameState; actions: any }>(({ gameState, actions }) => {
    // Get current roll (last dice sum)
    const currentRoll = useMemo(() =>
        gameState.dice.length === 2 ? gameState.dice[0] + gameState.dice[1] : null,
        [gameState.dice]
    );

    // Get established come/don't come bets (status 'ON' with a target)
    const establishedComeBets = useMemo(() =>
        gameState.crapsBets.filter(b =>
            (b.type === 'COME' || b.type === 'DONT_COME') && b.status === 'ON' && b.target
        ),
        [gameState.crapsBets]
    );

    // Determine point circle color based on pass/don't pass bet
    const pointColor = useMemo(() => {
        const hasPassBet = gameState.crapsBets.some(b => b.type === 'PASS');
        const hasDontPassBet = gameState.crapsBets.some(b => b.type === 'DONT_PASS');
        if (hasPassBet) return 'border-terminal-green text-terminal-green';
        if (hasDontPassBet) return 'border-terminal-accent text-terminal-accent';
        return 'border-gray-700 text-gray-700';
    }, [gameState.crapsBets]);

    const canPlaceAts = useMemo(
        () =>
            !gameState.crapsEpochPointEstablished &&
            (currentRoll === null || currentRoll === 7),
        [gameState.crapsEpochPointEstablished, currentRoll]
    );

    const atsSelected = useMemo(() => ({
        small: gameState.crapsBets.some(b => b.type === 'ATS_SMALL'),
        tall: gameState.crapsBets.some(b => b.type === 'ATS_TALL'),
        all: gameState.crapsBets.some(b => b.type === 'ATS_ALL'),
    }), [gameState.crapsBets]);

    const betTypes = useMemo(() => new Set(gameState.crapsBets.map((b) => b.type)), [gameState.crapsBets]);

    return (
        <>
            <div className="flex-1 w-full flex flex-col items-center justify-center gap-6 relative z-10 pb-20">
                <h1 className="absolute top-0 text-xl font-bold text-gray-500 tracking-widest uppercase">CRAPS</h1>
                <div className="absolute top-2 right-2 z-40">
                    <MobileDrawer label="INFO" title="CRAPS">
                        <div className="space-y-3">
                            <div className="border border-gray-800 rounded bg-black/40 p-2">
                                <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-2 border-b border-gray-800 pb-1 text-center">
                                    Exposure
                                </div>
                                <div className="flex flex-col space-y-1">
                                    {(() => {
                                        const hardwayTargets = [4, 6, 8, 10];
                                        const activeHardways = gameState.crapsBets
                                            .filter(b => b.type === 'HARDWAY')
                                            .map(b => b.target!);

                                        const rows: { num: number; label: string; isHard?: boolean }[] = [];

                                        [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].forEach(num => {
                                            if (hardwayTargets.includes(num) && activeHardways.includes(num)) {
                                                rows.push({ num, label: `${num}H`, isHard: true });
                                                rows.push({ num, label: `${num}E`, isHard: false });
                                            } else {
                                                rows.push({ num, label: num.toString() });
                                            }
                                        });

                                        return rows.map((row, idx) => {
                                            const pnl = row.isHard !== undefined
                                                ? calculateCrapsExposure(row.num, gameState.crapsPoint, gameState.crapsBets, row.isHard)
                                                : calculateCrapsExposure(row.num, gameState.crapsPoint, gameState.crapsBets);

                                            const pnlRounded = Math.round(pnl);
                                            const isHighlight = row.num === currentRoll;

                                            return (
                                                <div key={idx} className="flex items-center h-6 text-sm">
                                                    <div className="flex-1 flex justify-end items-center pr-2">
                                                        {pnlRounded < 0 && (
                                                            <span className="text-terminal-accent font-mono text-[10px]">
                                                                -{Math.abs(pnlRounded).toLocaleString()}
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className={`w-9 text-center font-bold ${
                                                        isHighlight ? 'text-yellow-400 bg-yellow-400/20 rounded' :
                                                        row.num === 7 ? 'text-terminal-accent' :
                                                        row.isHard === true ? 'text-terminal-gold' :
                                                        row.isHard === false ? 'text-gray-400' : 'text-white'
                                                    }`}>
                                                        {row.label}
                                                    </div>
                                                    <div className="flex-1 flex justify-start items-center pl-2">
                                                        {pnlRounded > 0 && (
                                                            <span className="text-terminal-green font-mono text-[10px]">
                                                                +{pnlRounded.toLocaleString()}
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        });
                                    })()}
                                </div>
                            </div>

                            <div className="border border-gray-800 rounded bg-black/40 p-2">
                                <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-2 border-b border-gray-800 pb-1 text-center">
                                    Table Bets
                                </div>
                                <div className="flex flex-col space-y-1">
                                    {gameState.crapsBets.length > 0 ? (
                                        gameState.crapsBets.map((b, i) => (
                                            <div key={i} className="flex justify-between items-center text-xs border border-gray-800 p-1 rounded bg-black/50">
                                                <div className="flex flex-col">
                                                    <span className="text-terminal-green font-bold text-[10px]">
                                                        {b.type}{b.target !== undefined ? ` ${b.target}` : ''}
                                                    </span>
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
                        </div>
                    </MobileDrawer>
                </div>

                {/* Established Come/Don't Come Bets - Above Point, Horizontally Centered */}
                {establishedComeBets.length > 0 && (
                    <div className="flex items-center justify-center gap-4">
                        {establishedComeBets.map((bet, i) => (
                            <div key={i} className="flex flex-col items-center gap-1">
                                <span className={`text-[10px] uppercase tracking-widest ${bet.type === 'COME' ? 'text-terminal-green' : 'text-terminal-accent'}`}>
                                    {bet.type === 'COME' ? 'COME' : "DON'T"}
                                </span>
                                <div className={`w-12 h-12 border-2 flex items-center justify-center text-lg font-bold rounded-full shadow-[0_0_10px_rgba(0,0,0,0.5)] ${
                                    bet.type === 'COME' ? 'border-terminal-green text-terminal-green' : 'border-terminal-accent text-terminal-accent'
                                }`}>
                                    {bet.target}
                                </div>
                                <span className="text-[9px] text-gray-500">${bet.amount}{bet.oddsAmount ? `+${bet.oddsAmount}` : ''}</span>
                            </div>
                        ))}
                    </div>
                )}

                {/* Point Indicator - Centered */}
                <div className="flex flex-col items-center gap-2">
                    <span className="text-xs uppercase tracking-widest text-gray-500">POINT</span>
                    <div className={`w-20 h-20 border-2 flex items-center justify-center text-2xl font-bold rounded-full shadow-[0_0_15px_rgba(0,0,0,0.5)] ${gameState.crapsPoint ? pointColor : 'border-gray-700 text-gray-700'}`}>
                        {gameState.crapsPoint || "OFF"}
                    </div>
                </div>

                {/* Center Info */}
                <div className="text-center space-y-3 relative z-20">
                    <div className="text-2xl font-bold text-terminal-gold tracking-widest animate-pulse">
                        {gameState.message}
                    </div>
                    {gameState.crapsRollHistory.length > 0 && (
                        <div className="text-[10px] tracking-widest mt-1 flex items-center justify-center gap-1">
                            <span className="text-gray-600">LAST:</span>
                            {gameState.crapsRollHistory.slice(-10).map((roll, i, arr) => (
                                <span key={i} className={`${i === arr.length - 1 ? 'text-yellow-400 font-bold' : roll === 7 ? 'text-terminal-accent' : 'text-gray-600'}`}>
                                    {roll}{i < arr.length - 1 ? ' -' : ''}
                                </span>
                            ))}
                        </div>
                    )}
                </div>

                {/* Dice Area */}
                <div className="min-h-[120px] flex gap-8 items-center justify-center">
                    {gameState.dice.length > 0 && (
                        <div className="flex flex-col gap-2 items-center">
                            <span className="text-xs uppercase tracking-widest text-gray-500">ROLL</span>
                            <div className="flex gap-4">
                                {gameState.dice.map((d, i) => <DiceRender key={i} value={d} delayMs={i * 60} />)}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* EXPOSURE SIDEBAR */}
            <div className="hidden md:flex absolute top-0 left-0 bottom-24 w-48 bg-terminal-black/80 border-r-2 border-gray-700 p-2 overflow-y-auto backdrop-blur-sm z-30 flex-col">
                <h3 className="text-[10px] font-bold text-gray-500 mb-2 tracking-widest text-center border-b border-gray-800 pb-1 flex-none">EXPOSURE</h3>
                <div className="flex-1 flex flex-col justify-center space-y-1">
                    {(() => {
                        // Build list of rows to display
                        const hardwayTargets = [4, 6, 8, 10];
                        const activeHardways = gameState.crapsBets
                            .filter(b => b.type === 'HARDWAY')
                            .map(b => b.target!);

                        const rows: { num: number; label: string; isHard?: boolean }[] = [];

                        [2,3,4,5,6,7,8,9,10,11,12].forEach(num => {
                            if (hardwayTargets.includes(num) && activeHardways.includes(num)) {
                                // Add both hard and easy variants
                                rows.push({ num, label: `${num}H`, isHard: true });
                                rows.push({ num, label: `${num}E`, isHard: false });
                            } else {
                                rows.push({ num, label: num.toString() });
                            }
                        });

                        return rows.map((row, idx) => {
                            const pnl = row.isHard !== undefined
                                ? calculateCrapsExposure(row.num, gameState.crapsPoint, gameState.crapsBets, row.isHard)
                                : calculateCrapsExposure(row.num, gameState.crapsPoint, gameState.crapsBets);

                            const pnlRounded = Math.round(pnl);
                            const isHighlight = row.num === currentRoll;

                            return (
                                <div key={idx} className="flex items-center h-7 text-base">
                                    {/* PnL Value - Left side for negative */}
                                    <div className="flex-1 flex justify-end items-center pr-2">
                                        {pnlRounded < 0 && (
                                            <span className="text-terminal-accent font-mono text-sm">
                                                -{Math.abs(pnlRounded).toLocaleString()}
                                            </span>
                                        )}
                                    </div>

                                    {/* Number Label */}
                                    <div className={`w-10 text-center font-bold relative ${
                                        isHighlight ? 'text-yellow-400 bg-yellow-400/20 rounded' :
                                        row.num === 7 ? 'text-terminal-accent' :
                                        row.isHard === true ? 'text-terminal-gold' :
                                        row.isHard === false ? 'text-gray-400' : 'text-white'
                                    }`}>
                                        {row.label}
                                    </div>

                                    {/* PnL Value - Right side for positive */}
                                    <div className="flex-1 flex justify-start items-center pl-2">
                                        {pnlRounded > 0 && (
                                            <span className="text-terminal-green font-mono text-sm">
                                                +{pnlRounded.toLocaleString()}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            );
                        });
                    })()}
                </div>
            </div>

            {/* ACTIVE BETS SIDEBAR */}
            <div className="hidden md:flex absolute top-0 right-0 bottom-24 w-36 bg-terminal-black/80 border-l-2 border-gray-700 p-2 backdrop-blur-sm z-30 flex-col">
                <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-2 border-b border-gray-800 pb-1 flex-none text-center">Table Bets</div>
                <div className="flex-1 overflow-y-auto flex flex-col justify-center space-y-1">
                    {gameState.crapsBets.length > 0 ? (
                        gameState.crapsBets.map((b, i) => (
                            <div key={i} className="flex justify-between items-center text-xs border border-gray-800 p-1 rounded bg-black/50">
                                <div className="flex flex-col">
                                    <span className="text-terminal-green font-bold text-[10px]">
                                        {b.type}{b.target !== undefined ? ` ${b.target}` : ''}
                                    </span>
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
            <div className="absolute bottom-8 left-0 right-0 h-16 bg-terminal-black/90 border-t-2 border-gray-700 flex items-center justify-start md:justify-center gap-2 p-2 z-40 overflow-x-auto">
	                    <div className="flex gap-2">
	                        <button
	                            type="button"
	                            onClick={() => actions?.placeCrapsBet?.(gameState.crapsPoint ? 'COME' : 'PASS')}
	                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
	                                betTypes.has('PASS') || betTypes.has('COME')
	                                    ? 'border-terminal-green bg-terminal-green/10'
	                                    : 'border-terminal-dim'
	                            }`}
	                        >
	                            <span className="text-white font-bold text-sm">P</span>
	                            <span className="text-[10px] text-gray-500">{gameState.crapsPoint ? 'COME' : 'PASS'}</span>
	                        </button>
	                        <button
	                            type="button"
	                            onClick={() => actions?.placeCrapsBet?.(gameState.crapsPoint ? 'DONT_COME' : 'DONT_PASS')}
	                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
	                                betTypes.has('DONT_PASS') || betTypes.has('DONT_COME')
	                                    ? 'border-terminal-green bg-terminal-green/10'
	                                    : 'border-terminal-dim'
	                            }`}
	                        >
	                            <span className="text-white font-bold text-sm">D</span>
	                            <span className="text-[10px] text-gray-500">DONT</span>
	                        </button>
	                        <button
	                            type="button"
	                            onClick={() => actions?.placeCrapsBet?.('FIELD')}
	                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
	                                betTypes.has('FIELD') ? 'border-terminal-green bg-terminal-green/10' : 'border-terminal-dim'
	                            }`}
	                        >
	                            <span className="text-white font-bold text-sm">F</span>
	                            <span className="text-[10px] text-gray-500">FIELD</span>
	                        </button>
	                        <button
	                            type="button"
	                            onClick={() => actions?.placeCrapsBet?.('FIRE')}
	                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
	                                betTypes.has('FIRE') ? 'border-terminal-green bg-terminal-green/10' : 'border-terminal-dim'
	                            }`}
	                        >
	                            <span className="text-white font-bold text-sm">B</span>
	                            <span className="text-[10px] text-gray-500">FIRE</span>
	                        </button>
	                        <button
	                            type="button"
	                            onClick={() => actions?.addCrapsOdds?.()}
	                            className="flex flex-col items-center border border-terminal-dim rounded bg-black/50 px-3 py-1"
	                        >
	                            <span className="text-white font-bold text-sm">O</span>
	                            <span className="text-[10px] text-gray-500">ODDS</span>
	                        </button>
	                        <button
	                            type="button"
	                            onClick={() => actions?.setGameState?.((prev: any) => ({ ...prev, crapsInputMode: 'HARDWAY' }))}
	                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
	                                gameState.crapsInputMode === 'HARDWAY' || betTypes.has('HARDWAY')
	                                    ? 'border-terminal-green bg-terminal-green/10'
	                                    : 'border-terminal-dim'
	                            }`}
	                        >
	                            <span className="text-white font-bold text-sm">H</span>
	                            <span className="text-[10px] text-gray-500">HARD</span>
	                        </button>
	                        <button
	                            type="button"
	                            onClick={() => actions?.setGameState?.((prev: any) => ({ ...prev, crapsInputMode: 'BUY' }))}
	                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
	                                gameState.crapsInputMode === 'BUY' || betTypes.has('BUY')
	                                    ? 'border-terminal-green bg-terminal-green/10'
	                                    : 'border-terminal-dim'
	                            }`}
	                        >
	                            <span className="text-white font-bold text-sm">I</span>
	                            <span className="text-[10px] text-gray-500">BUY</span>
	                        </button>
	                    </div>
	                    <div className="w-px h-8 bg-gray-800 mx-2"></div>
	                    <div className="flex gap-2">
	                        <button
	                            type="button"
	                            onClick={() => actions?.setGameState?.((prev: any) => ({ ...prev, crapsInputMode: 'YES' }))}
	                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
	                                gameState.crapsInputMode === 'YES' || betTypes.has('YES')
	                                    ? 'border-terminal-green bg-terminal-green/10'
	                                    : 'border-gray-700'
	                            }`}
	                        >
	                            <span className="text-white font-bold text-sm">Y</span>
	                            <span className="text-[10px] text-gray-500">YES</span>
	                        </button>
	                        <button
	                            type="button"
	                            onClick={() => actions?.setGameState?.((prev: any) => ({ ...prev, crapsInputMode: 'NO' }))}
	                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
	                                gameState.crapsInputMode === 'NO' || betTypes.has('NO')
	                                    ? 'border-terminal-green bg-terminal-green/10'
	                                    : 'border-gray-700'
	                            }`}
	                        >
	                            <span className="text-white font-bold text-sm">N</span>
	                            <span className="text-[10px] text-gray-500">NO</span>
	                        </button>
	                        <button
	                            type="button"
	                            onClick={() => actions?.setGameState?.((prev: any) => ({ ...prev, crapsInputMode: 'NEXT' }))}
	                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
	                                gameState.crapsInputMode === 'NEXT' || betTypes.has('NEXT')
	                                    ? 'border-terminal-green bg-terminal-green/10'
	                                    : 'border-gray-700'
	                            }`}
	                        >
	                            <span className="text-white font-bold text-sm">X</span>
	                            <span className="text-[10px] text-gray-500">NEXT</span>
	                        </button>
	                    </div>
	                    <div className="w-px h-8 bg-gray-800 mx-2"></div>
		                    {canPlaceAts && (
		                        <>
		                            <div className="flex gap-2">
		                                <button
		                                    type="button"
		                                    onClick={() => actions?.placeCrapsBet?.('ATS_SMALL')}
		                                    className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
		                                        atsSelected.small ? 'border-terminal-green bg-terminal-green/10' : 'border-gray-700'
		                                    }`}
		                                >
		                                    <span className="text-white font-bold text-sm">S</span>
		                                    <span className="text-[10px] text-gray-500">ATS S</span>
		                                </button>
		                                <button
		                                    type="button"
		                                    onClick={() => actions?.placeCrapsBet?.('ATS_TALL')}
		                                    className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
		                                        atsSelected.tall ? 'border-terminal-green bg-terminal-green/10' : 'border-gray-700'
		                                    }`}
		                                >
		                                    <span className="text-white font-bold text-sm">L</span>
		                                    <span className="text-[10px] text-gray-500">ATS T</span>
		                                </button>
		                                <button
		                                    type="button"
		                                    onClick={() => actions?.placeCrapsBet?.('ATS_ALL')}
		                                    className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
		                                        atsSelected.all ? 'border-terminal-green bg-terminal-green/10' : 'border-gray-700'
		                                    }`}
		                                >
		                                    <span className="text-white font-bold text-sm">A</span>
		                                    <span className="text-[10px] text-gray-500">ATS A</span>
		                                </button>
		                            </div>
		                            <div className="w-px h-8 bg-gray-800 mx-2"></div>
		                        </>
		                    )}
	                    <div className="flex gap-2">
	                        <button
	                            type="button"
	                            onClick={actions?.rebetCraps}
	                            className="flex flex-col items-center border border-gray-700 rounded bg-black/50 px-3 py-1"
	                        >
	                            <span className="text-gray-500 font-bold text-sm">T</span>
	                            <span className="text-[10px] text-gray-600">REBET</span>
	                        </button>
	                        <button
	                            type="button"
	                            onClick={actions?.undoCrapsBet}
	                            className="flex flex-col items-center border border-terminal-accent/50 rounded bg-black/50 px-3 py-1"
	                        >
	                            <span className="text-terminal-accent font-bold text-sm">U</span>
	                            <span className="text-[10px] text-gray-500">UNDO</span>
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
	                            <span className="font-bold text-sm">⇧X</span>
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
                                    
                                     if (gameState.crapsInputMode === 'YES' || gameState.crapsInputMode === 'NO' || gameState.crapsInputMode === 'BUY') {
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
});
