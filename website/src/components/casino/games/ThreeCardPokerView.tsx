
import React, { useMemo } from 'react';
import { GameState } from '../../../types';
import { Hand } from '../GameComponents';
import { getVisibleHandValue } from '../../../utils/gameUtils';
import { MobileDrawer } from '../MobileDrawer';

interface ThreeCardPokerViewProps {
    gameState: GameState;
    actions: any;
}

const getHandRankName = (cards: { rank: string }[]): string => {
    if (cards.length !== 3) return '';

    const getRankValue = (r: string) => {
        if (r === 'A') return 12;
        if (r === 'K') return 11;
        if (r === 'Q') return 10;
        if (r === 'J') return 9;
        return parseInt(r) - 2;
    };

    const ranks = cards.map(c => getRankValue(c.rank)).sort((a, b) => b - a);
    const suits = cards.map(c => c.suit);

    const isFlush = suits[0] === suits[1] && suits[1] === suits[2];
    const isStraight = (ranks[0] - ranks[1] === 1 && ranks[1] - ranks[2] === 1) ||
                       (ranks[0] === 12 && ranks[1] === 1 && ranks[2] === 0);
    const isTrips = ranks[0] === ranks[1] && ranks[1] === ranks[2];
    const isPair = ranks[0] === ranks[1] || ranks[1] === ranks[2] || ranks[0] === ranks[2];

    if (isStraight && isFlush) return 'STRAIGHT FLUSH';
    if (isTrips) return 'THREE OF A KIND';
    if (isStraight) return 'STRAIGHT';
    if (isFlush) return 'FLUSH';
    if (isPair) return 'PAIR';
    return 'HIGH CARD';
};

export const ThreeCardPokerView = React.memo<ThreeCardPokerViewProps>(({ gameState, actions }) => {
    const playerRank = useMemo(() =>
        gameState.playerCards.length === 3 ? getHandRankName(gameState.playerCards) : '',
        [gameState.playerCards]
    );

    const dealerRank = useMemo(() =>
        gameState.dealerCards.length === 3 && !gameState.dealerCards.some(c => c && c.isHidden)
            ? getHandRankName(gameState.dealerCards) : '',
        [gameState.dealerCards]
    );

    const dealerQualifies = useMemo(() =>
        gameState.dealerCards.every(c => c && !c.isHidden) &&
        getVisibleHandValue(gameState.dealerCards.slice(0, 1)) >= 10,
        [gameState.dealerCards]
    );

    return (
        <>
            <div className="flex-1 w-full flex flex-col items-center justify-center gap-8 relative z-10 pb-20">
                <h1 className="absolute top-0 text-xl font-bold text-gray-500 tracking-widest uppercase">THREE CARD POKER</h1>
                <div className="absolute top-2 right-2 z-40">
                    <MobileDrawer label="INFO" title="THREE CARD POKER">
                        <div className="space-y-3">
                            <div className="border border-gray-800 rounded bg-black/40 p-2">
                                <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-2 border-b border-gray-800 pb-1 text-center">
                                    Pair Plus
                                </div>
                                <div className="space-y-2 text-[10px]">
                                    <div className="flex justify-between"><span className="text-gray-400">Straight Flush</span><span className="text-terminal-gold">40:1</span></div>
                                    <div className="flex justify-between"><span className="text-gray-400">Three of Kind</span><span className="text-terminal-gold">30:1</span></div>
                                    <div className="flex justify-between"><span className="text-gray-400">Straight</span><span className="text-terminal-gold">6:1</span></div>
                                    <div className="flex justify-between"><span className="text-gray-400">Flush</span><span className="text-terminal-gold">3:1</span></div>
                                    <div className="flex justify-between"><span className="text-gray-400">Pair</span><span className="text-terminal-gold">1:1</span></div>
                                </div>
                            </div>
                            <div className="border border-gray-800 rounded bg-black/40 p-2">
                                <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-2 border-b border-gray-800 pb-1 text-center">
                                    Rules
                                </div>
                                <div className="space-y-2 text-[10px] text-gray-400">
                                    <div>• Dealer qualifies with Queen-high or better</div>
                                    <div>• If dealer doesn't qualify: Ante pays 1:1, Play pushes</div>
                                    <div>• If dealer qualifies and you win: Ante and Play pay 1:1</div>
                                    <div>• Pair Plus pays regardless of dealer hand</div>
                                </div>
                            </div>
                        </div>
                    </MobileDrawer>
                </div>

                {/* Dealer Area */}
                <div className="min-h-[120px] flex items-center justify-center opacity-75">
                    {gameState.dealerCards.length > 0 ? (
                        <div className="flex flex-col items-center gap-2">
                            <span className="text-lg font-bold tracking-widest text-terminal-accent">DEALER</span>
                            <Hand
                                cards={gameState.dealerCards}
                                title={dealerRank ? `(${dealerRank})` : ''}
                                forcedColor="text-terminal-accent"
                            />
                            {dealerRank && (
                                <span className="text-xs text-gray-500 mt-1">
                                    {gameState.dealerCards.every(c => c && !c.isHidden) ?
                                        (dealerQualifies ? 'QUALIFIES' : 'DOES NOT QUALIFY') : ''}
                                </span>
                            )}
                        </div>
                    ) : (
                        <div className="flex flex-col items-center gap-2">
                            <span className="text-lg font-bold tracking-widest text-terminal-accent">DEALER</span>
                            <div className="flex gap-2">
                                {[0, 1, 2].map(i => (
                                    <div key={i} className="w-14 h-20 border border-dashed border-terminal-accent/50 rounded" />
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                {/* Center Info */}
                <div className="text-center space-y-3 relative z-20">
                    <div className="text-2xl font-bold text-terminal-gold tracking-widest animate-pulse">
                        {gameState.message}
                    </div>
                    <div className="text-sm text-gray-500 flex flex-col items-center gap-1">
                        <span>ANTE: ${gameState.bet.toLocaleString()}</span>
                        {gameState.threeCardPairPlusBet > 0 && (
                            <span>PAIR+: ${gameState.threeCardPairPlusBet.toLocaleString()}</span>
                        )}
                        {gameState.threeCardSixCardBonusBet > 0 && (
                            <span>6-CARD: ${gameState.threeCardSixCardBonusBet.toLocaleString()}</span>
                        )}
                        {gameState.threeCardProgressiveBet > 0 && (
                            <span>PROG: ${gameState.threeCardProgressiveBet.toLocaleString()}</span>
                        )}
                        <div
                            className={`mt-1 inline-flex items-center gap-2 px-3 py-1 rounded border bg-black/40 text-[10px] tracking-widest ${
                                gameState.threeCardProgressiveBet > 0 ? 'border-terminal-green/40 text-terminal-gold' : 'border-gray-800 text-gray-600'
                            }`}
                        >
                            <span>PROG JACKPOT</span>
                            <span key={gameState.threeCardProgressiveJackpot} className="font-bold tabular-nums">
                                ${gameState.threeCardProgressiveJackpot.toLocaleString()}
                            </span>
                        </div>
                    </div>
                </div>

                {/* Player Area */}
                <div className="min-h-[120px] flex gap-8 items-center justify-center">
                    {gameState.playerCards.length > 0 ? (
                        <div className="flex flex-col items-center gap-2 scale-110">
                            <span className="text-lg font-bold tracking-widest text-terminal-green">YOU</span>
                            <Hand
                                cards={gameState.playerCards}
                                title={playerRank ? `(${playerRank})` : ''}
                                forcedColor="text-terminal-green"
                            />
                        </div>
                    ) : (
                        <div className="flex flex-col items-center gap-2 scale-110">
                            <span className="text-lg font-bold tracking-widest text-terminal-green">YOU</span>
                            <div className="flex gap-2">
                                {[0, 1, 2].map(i => (
                                    <div key={i} className="w-14 h-20 border border-dashed border-terminal-green/50 rounded" />
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Pair Plus Info Sidebar */}
            <div className="hidden md:flex absolute top-0 left-0 bottom-24 w-36 bg-terminal-black/80 border-r-2 border-gray-700 p-2 overflow-y-auto backdrop-blur-sm z-30 flex-col">
                <h3 className="text-[10px] font-bold text-gray-500 mb-2 tracking-widest text-center border-b border-gray-800 pb-1 flex-none">PAIR PLUS</h3>
                <div className="flex-1 flex flex-col justify-center space-y-2 text-[10px]">
                    <div className="flex justify-between"><span className="text-gray-400">Straight Flush</span><span className="text-terminal-gold">40:1</span></div>
                    <div className="flex justify-between"><span className="text-gray-400">Three of Kind</span><span className="text-terminal-gold">30:1</span></div>
                    <div className="flex justify-between"><span className="text-gray-400">Straight</span><span className="text-terminal-gold">6:1</span></div>
                    <div className="flex justify-between"><span className="text-gray-400">Flush</span><span className="text-terminal-gold">3:1</span></div>
                    <div className="flex justify-between"><span className="text-gray-400">Pair</span><span className="text-terminal-gold">1:1</span></div>
                </div>
            </div>

            {/* Game Rules Sidebar */}
            <div className="hidden md:flex absolute top-0 right-0 bottom-24 w-36 bg-terminal-black/80 border-l-2 border-gray-700 p-2 backdrop-blur-sm z-30 flex-col">
                <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-2 border-b border-gray-800 pb-1 flex-none text-center">Rules</div>
                <div className="flex-1 overflow-y-auto flex flex-col justify-center space-y-2 text-[9px] text-gray-400">
                    <div>• Dealer qualifies with Queen-high or better</div>
                    <div>• If dealer doesn't qualify: Ante pays 1:1, Play pushes</div>
                    <div>• If dealer qualifies and you win: Ante and Play pay 1:1</div>
                    <div>• Pair Plus pays regardless of dealer hand</div>
                </div>
            </div>

            {/* Controls */}
            <div className="absolute bottom-8 left-0 right-0 h-16 bg-terminal-black/90 border-t-2 border-gray-700 flex items-center justify-start md:justify-center gap-2 p-2 z-40 overflow-x-auto">
                {gameState.stage === 'BETTING' && (
                    <>
	                        <button
	                            type="button"
	                            onClick={actions?.threeCardTogglePairPlus}
	                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
	                                (gameState.threeCardPairPlusBet || 0) > 0
	                                    ? 'border-terminal-green bg-terminal-green/10 text-terminal-green'
	                                    : 'border-gray-700 text-gray-500'
	                            }`}
	                        >
                            <span className="font-bold text-sm">P</span>
                            <span className="text-[10px]">PAIR+</span>
                        </button>
	                        <button
	                            type="button"
	                            onClick={actions?.threeCardToggleSixCardBonus}
	                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
	                                (gameState.threeCardSixCardBonusBet || 0) > 0
	                                    ? 'border-terminal-green bg-terminal-green/10 text-terminal-green'
	                                    : 'border-gray-700 text-gray-500'
	                            }`}
	                        >
                            <span className="font-bold text-sm">6</span>
                            <span className="text-[10px]">6-CARD</span>
                        </button>
	                        <button
	                            type="button"
	                            onClick={actions?.threeCardToggleProgressive}
	                            className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
	                                (gameState.threeCardProgressiveBet || 0) > 0
	                                    ? 'border-terminal-green bg-terminal-green/10 text-terminal-green'
	                                    : 'border-gray-700 text-gray-500'
	                            }`}
	                        >
                            <span className="font-bold text-sm">J</span>
                            <span className="text-[10px]">PROG</span>
                        </button>
                        <div className="w-px h-8 bg-gray-800 mx-2"></div>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={actions?.toggleShield}
                                className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
                                    gameState.activeModifiers.shield
                                        ? 'border-cyan-400 text-cyan-400'
                                        : 'border-gray-700 text-gray-500'
                                }`}
                            >
                                <span className="font-bold text-sm">Z</span>
                                <span className="text-[10px]">SHIELD</span>
                            </button>
                            <button
                                type="button"
                                onClick={actions?.toggleDouble}
                                className={`flex flex-col items-center border rounded bg-black/50 px-3 py-1 ${
                                    gameState.activeModifiers.double
                                        ? 'border-purple-400 text-purple-400'
                                        : 'border-gray-700 text-gray-500'
                                }`}
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
                            <span className="text-[10px] text-gray-500">DEAL</span>
                        </button>
                    </>
                )}
                {gameState.stage === 'PLAYING' && gameState.message.includes('REVEAL') && (
                    <button
                        type="button"
                        onClick={actions?.deal}
                        className="flex flex-col items-center border border-terminal-green/50 rounded bg-black/50 px-3 py-1 w-24"
                    >
                        <span className="text-terminal-green font-bold text-sm">SPACE</span>
                        <span className="text-[10px] text-gray-500">REVEAL</span>
                    </button>
                )}
                {gameState.stage === 'PLAYING' && !gameState.message.includes('REVEAL') && (
                    <>
                        <button
                            type="button"
                            onClick={actions?.threeCardPlay}
                            className="flex flex-col items-center border border-terminal-green rounded bg-black/50 px-3 py-1"
                        >
                            <span className="text-terminal-green font-bold text-sm">P</span>
                            <span className="text-[10px] text-gray-500">PLAY</span>
                        </button>
                        <button
                            type="button"
                            onClick={actions?.threeCardFold}
                            className="flex flex-col items-center border border-terminal-accent rounded bg-black/50 px-3 py-1"
                        >
                            <span className="text-terminal-accent font-bold text-sm">F</span>
                            <span className="text-[10px] text-gray-500">FOLD</span>
                        </button>
                    </>
                )}
                {gameState.stage === 'RESULT' && (
                    <button
                        type="button"
                        onClick={actions?.deal}
                        className="flex flex-col items-center border border-terminal-green/50 rounded bg-black/50 px-3 py-1 w-24"
                    >
                        <span className="text-terminal-green font-bold text-sm">SPACE</span>
                        <span className="text-[10px] text-gray-500">NEW HAND</span>
                    </button>
                )}
            </div>
        </>
    );
});
