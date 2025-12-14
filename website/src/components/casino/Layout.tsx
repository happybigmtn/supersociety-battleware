
import React from 'react';
import { NavLink } from 'react-router-dom';
import { LeaderboardEntry, PlayerStats, GameType } from '../../types';
import { formatTime, HELP_CONTENT } from '../../utils/gameUtils';

interface HeaderProps {
    phase: string;
    tournamentTime: number;
    stats: PlayerStats;
    lastTxSig?: string;
    focusMode: boolean;
    setFocusMode: (mode: boolean) => void;
    showTimer?: boolean;
}

export const Header: React.FC<HeaderProps> = ({ phase, tournamentTime, stats, lastTxSig, focusMode, setFocusMode, showTimer = true }) => (
    <header className="h-12 border-b-2 border-gray-700 flex items-center justify-between px-2 sm:px-4 z-10 bg-terminal-black/90 backdrop-blur">
    <div className="flex items-center gap-2 sm:gap-4">
        <span className="font-bold tracking-tighter text-white text-sm sm:text-base">null<span className="text-terminal-green">/</span>space</span>
        <div className="hidden sm:flex items-center gap-2">
            <button 
                onClick={() => setFocusMode(!focusMode)}
                className={`text-[10px] border px-1.5 py-0.5 rounded transition-colors ${focusMode ? 'bg-terminal-green text-black border-terminal-green' : 'text-gray-600 bg-gray-900 border-gray-800 hover:border-gray-600'}`}
            >
                {focusMode ? 'FOCUS ON' : 'FOCUS OFF'}
            </button>
            <NavLink
                to="/security"
                className="text-[10px] border px-1.5 py-0.5 rounded transition-colors text-gray-300 bg-gray-900 border-gray-800 hover:border-gray-600 hover:text-white"
            >
                PASSKEY
            </NavLink>
            <span className="text-[10px] text-gray-600 bg-gray-900 border border-gray-800 px-1.5 py-0.5 rounded">[?] HELP</span>
        </div>
    </div>
    <div className="flex items-center gap-2 sm:gap-4 md:gap-6 text-xs sm:text-sm">
            {showTimer && (
                <div className="flex items-center gap-1 sm:gap-2">
                    <span className="text-gray-500 hidden sm:inline">TIMER</span>
                    <span className={`font-bold ${tournamentTime < 60 ? 'text-terminal-accent animate-pulse' : 'text-white'}`}>{formatTime(tournamentTime)}</span>
                </div>
            )}
            <div className="hidden sm:flex items-center gap-2">
                <span className="text-gray-500">SHIELDS</span>
                <div className="flex gap-1">
                    {[...Array(3)].map((_, i) => (
                        <div key={i} className={`w-2 h-2 rounded-full ${i < stats.shields ? 'bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.8)]' : 'bg-gray-800'}`} />
                    ))}
                </div>
            </div>
            <div className="hidden sm:flex items-center gap-2">
                <span className="text-gray-500">DOUBLES</span>
                <div className="flex gap-1">
                    {[...Array(3)].map((_, i) => (
                        <div key={i} className={`w-2 h-2 rounded-full ${i < stats.doubles ? 'bg-purple-400 shadow-[0_0_8px_rgba(192,132,252,0.8)]' : 'bg-gray-800'}`} />
                    ))}
                </div>
            </div>
            <div className="hidden sm:flex items-center gap-2">
                <span className="text-gray-500">AURA</span>
                <div className="flex gap-1">
                    {[...Array(5)].map((_, i) => (
                        <div
                            key={i}
                            className={`w-2 h-2 rounded-full ${
                                i < (stats.auraMeter ?? 0)
                                    ? 'bg-terminal-gold shadow-[0_0_8px_rgba(255,215,0,0.7)]'
                                    : 'bg-gray-800'
                            }`}
                        />
                    ))}
                </div>
            </div>
            {/* Mobile: Compact shields/doubles indicator */}
            <div className="flex sm:hidden items-center gap-1">
                <div className="flex gap-0.5">
                    {[...Array(3)].map((_, i) => (
                        <div key={i} className={`w-1.5 h-1.5 rounded-full ${i < stats.shields ? 'bg-cyan-400' : 'bg-gray-800'}`} />
                    ))}
                </div>
                <div className="flex gap-0.5">
                    {[...Array(3)].map((_, i) => (
                        <div key={i} className={`w-1.5 h-1.5 rounded-full ${i < stats.doubles ? 'bg-purple-400' : 'bg-gray-800'}`} />
                    ))}
                </div>
                <div className="flex gap-0.5">
                    {[...Array(5)].map((_, i) => (
                        <div
                            key={i}
                            className={`w-1.5 h-1.5 rounded-full ${
                                i < (stats.auraMeter ?? 0) ? 'bg-terminal-gold' : 'bg-gray-800'
                            }`}
                        />
                    ))}
                </div>
            </div>
            <div className="flex items-center gap-1 sm:gap-2">
                <span className="text-gray-500 hidden sm:inline">CHIPS</span>
                <span className="text-white font-bold text-sm sm:text-lg">${stats.chips.toLocaleString()}</span>
            </div>
    </div>
    </header>
);

export const TournamentAlert: React.FC<{ tournamentTime: number }> = ({ tournamentTime }) => {
    // 60s warning (display for 3s), 30s warning (display for 3s), 5s countdown
    if (tournamentTime === 60 || tournamentTime === 59 || tournamentTime === 58) {
        return (
            <div className="absolute top-12 left-0 right-0 bg-terminal-accent/20 border-b border-terminal-accent/50 text-terminal-accent text-center font-bold py-1 z-50 animate-pulse">
                WARNING: 1 MINUTE REMAINING
            </div>
        );
    }
    if (tournamentTime === 30 || tournamentTime === 29 || tournamentTime === 28) {
        return (
            <div className="absolute top-12 left-0 right-0 bg-terminal-accent/20 border-b border-terminal-accent/50 text-terminal-accent text-center font-bold py-1 z-50 animate-pulse">
                WARNING: 30 SECONDS REMAINING
            </div>
        );
    }
    if (tournamentTime <= 5 && tournamentTime > 0) {
        return (
             <div className="absolute inset-0 z-50 flex items-center justify-center pointer-events-none">
                 <div className="text-[10rem] font-bold text-terminal-accent opacity-50 animate-ping">
                     {tournamentTime}
                 </div>
             </div>
        );
    }
    return null;
};

interface SidebarProps {
    leaderboard: LeaderboardEntry[];
    history: string[];
    viewMode?: 'RANK' | 'PAYOUT';
    currentChips?: number;
    prizePool?: number;
    totalPlayers?: number;
    winnersPct?: number;
}

export const Sidebar: React.FC<SidebarProps> = ({ leaderboard, history, viewMode = 'RANK', currentChips, prizePool, totalPlayers, winnersPct = 0.15 }) => {
    const effectivePlayerCount = totalPlayers ?? leaderboard.length;
    const bubbleIndex = Math.max(1, Math.min(effectivePlayerCount, Math.ceil(effectivePlayerCount * winnersPct))); // Top 15% by default
    const userEntry = leaderboard.find(e => e.name === 'YOU' || e.name.includes('(YOU)'));

    const getPayout = (rank: number) => {
        if (!prizePool || effectivePlayerCount <= 0) return "$0";
        if (rank > bubbleIndex) return "$0";

        let totalWeight = 0;
        for (let i = 1; i <= bubbleIndex; i++) {
            totalWeight += 1 / i;
        }
        const payout = Math.floor(((1 / rank) / totalWeight) * prizePool);
        return `$${payout.toLocaleString()}`;
    };

    const renderEntry = (entry: LeaderboardEntry, i: number, isSticky = false) => {
        let rank = i + 1;
        if (isSticky) {
            rank = leaderboard.findIndex(e => e.name === entry.name) + 1;
        }

        const isUser = entry.name === 'YOU' || entry.name.includes('(YOU)');
        const isMoneyCutoff = rank === bubbleIndex;
        // Use real-time chips for the user to update instantly
        const displayChips = isUser && currentChips !== undefined ? currentChips : entry.chips;

        return (
            <React.Fragment key={isSticky ? 'sticky-you' : i}>
                <div className={`flex justify-between items-center text-sm ${isSticky ? 'bg-terminal-dim/50 -mx-2 px-2 py-1 rounded border-l-2 border-terminal-green' : ''}`}>
                    <div className="flex gap-2">
                        <span className="text-gray-600 font-mono w-6 text-right">{rank}</span>
                        <span className={isUser ? 'text-white font-bold' : 'text-gray-400'}>{entry.name}</span>
                    </div>
                    <span className={viewMode === 'PAYOUT' && rank <= bubbleIndex ? 'text-terminal-gold' : 'text-terminal-green text-xs'}>
                        {viewMode === 'RANK' ? `$${Math.floor(displayChips).toLocaleString()}` : getPayout(rank)}
                    </span>
                </div>
                {!isSticky && isMoneyCutoff && (
                    <div className="border-b border-dashed border-terminal-accent my-2 py-1 text-[10px] text-terminal-accent text-center tracking-widest opacity-75">
                        IN THE MONEY // CUTOFF
                    </div>
                )}
            </React.Fragment>
        );
    };

    return (
        <aside className="w-64 border-l-2 border-gray-700 bg-terminal-black/50 hidden md:flex flex-col">
            {/* Live Feed Header */}
            <div className="p-4 pb-2 flex-none">
                <div className="flex justify-between items-center mb-2">
                    <h3 className="text-xs font-bold text-gray-500 tracking-widest">{viewMode === 'RANK' ? 'LIVE FEED' : 'PAYOUT PROJECTION'}</h3>
                    <span className="text-[9px] text-gray-600 border border-gray-800 px-1 rounded">[L] TOGGLE</span>
                </div>
            </div>

            {/* Fixed User Row (Pinned to Top) */}
            {userEntry && (
                <div className="flex-none px-4 py-2 border-b border-terminal-dim bg-terminal-black/80 z-10 shadow-[0_5px_15px_rgba(0,0,0,0.5)]">
                     {renderEntry(userEntry, 0, true)}
                </div>
            )}

            {/* Scrollable Leaderboard */}
            <div className="flex-1 overflow-y-auto px-4 py-2 space-y-2 min-h-0">
                {leaderboard.map((entry, i) => renderEntry(entry, i, false))}
            </div>
            
            {/* Logs Area */}
            <div className="flex-none h-48 border-t-2 border-gray-700 p-4 bg-terminal-black/30">
                <h3 className="text-sm font-bold text-gray-500 mb-2 tracking-widest">LOG</h3>
                <div className="h-full overflow-y-auto flex flex-col gap-1 text-sm text-gray-400 font-mono scrollbar-thin">
                    {history.slice(-15).reverse().map((log, i) => (
                        <div key={i} className="text-gray-300">&gt; {log}</div>
                    ))}
                </div>
            </div>
        </aside>
    );
};

export const Footer: React.FC<{ currentBet?: number }> = ({ currentBet }) => {
    const bets = [1, 5, 25, 100, 500, 1000, 5000, 10000, 50000];
    const isCustom = currentBet && !bets.includes(currentBet);

    return (
        <footer className="fixed bottom-0 left-0 right-0 md:right-64 border-t-2 border-gray-700 bg-terminal-black/95 text-[10px] sm:text-xs text-gray-600 py-1 px-2 sm:px-4 flex flex-wrap justify-center gap-2 sm:gap-4 md:gap-6 z-20">
            {bets.map((bet, i) => {
                const label = bet >= 1000 ? `${bet/1000}K` : `$${bet}`;
                const isSelected = currentBet === bet;
                return (
                    <span key={i} className={`whitespace-nowrap ${isSelected ? 'text-terminal-green font-bold' : ''}`}>
                        ^{i + 1} {label}
                    </span>
                );
            })}
            <span className={`whitespace-nowrap ${isCustom ? 'text-terminal-green font-bold' : ''}`}>^0 CUSTOM</span>
        </footer>
    );
};

interface CommandPaletteProps {
    isOpen: boolean;
    searchQuery: string;
    onSearchChange: (q: string) => void;
    sortedGames: string[];
    onSelectGame: (g: string) => void;
    inputRef: React.RefObject<HTMLInputElement>;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({ isOpen, searchQuery, onSearchChange, sortedGames, onSelectGame, inputRef }) => {
    if (!isOpen) return null;

    const filtered = sortedGames.filter(g => g.toLowerCase().includes(searchQuery.toLowerCase()));

    return (
        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-start justify-center pt-16 sm:pt-32 px-4">
            <div className="w-full max-w-[600px] bg-terminal-black border border-terminal-dim rounded shadow-2xl overflow-hidden flex flex-col max-h-[70vh] sm:max-h-[500px]">
                <div className="p-3 sm:p-4 border-b border-terminal-dim flex items-center gap-2">
                    <span className="text-terminal-green font-bold">&gt;</span>
                    <input
                        ref={inputRef}
                        type="text"
                        value={searchQuery}
                        onChange={(e) => onSearchChange(e.target.value)}
                        className="flex-1 bg-transparent outline-none text-white placeholder-gray-700 uppercase text-sm sm:text-base"
                        placeholder="TYPE COMMAND OR GAME NAME..."
                        autoFocus
                    />
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                    {filtered.map((game, i) => (
                        <div
                            key={game}
                            onClick={() => onSelectGame(game)}
                            className="flex items-center gap-3 p-2 hover:bg-terminal-dim cursor-pointer rounded group text-sm sm:text-base"
                        >
                            <span className="text-gray-600 font-mono w-6 text-right group-hover:text-terminal-green">{i < 9 ? i + 1 : i === 9 ? 0 : ''}</span>
                            <span className="text-gray-400 group-hover:text-white">{game}</span>
                        </div>
                    ))}
                    {filtered.length === 0 && (
                        <div className="p-4 text-gray-600 text-center italic">NO RESULTS FOUND</div>
                    )}
                </div>
                <div className="p-2 border-t border-terminal-dim bg-terminal-black/50 text-[10px] text-gray-600 flex justify-between">
                     <span>[ENTER] SELECT</span>
                     <span>[ESC] CLOSE</span>
                </div>
            </div>
        </div>
    );
};

export const CustomBetOverlay: React.FC<{ isOpen: boolean; betString: string; inputRef: React.RefObject<HTMLInputElement> }> = ({ isOpen, betString, inputRef }) => {
    if (!isOpen) return null;

    return (
         <div className="absolute inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center px-4">
             <div className="bg-terminal-black border border-terminal-green p-4 sm:p-8 rounded shadow-xl flex flex-col items-center gap-3 sm:gap-4 w-full max-w-sm">
                 <div className="text-xs sm:text-sm tracking-widest text-gray-400">ENTER CUSTOM BET AMOUNT</div>
                 <div className="flex items-center gap-1 text-2xl sm:text-4xl text-terminal-gold font-bold">
                     <span>$</span>
                     <input
                        ref={inputRef}
                        type="text"
                        value={betString}
                        readOnly
                        className="bg-transparent outline-none w-32 sm:w-48 text-center"
                     />
                     <span className="animate-pulse bg-terminal-green w-2 sm:w-3 h-6 sm:h-8 block"></span>
                 </div>
                 <div className="text-[10px] sm:text-xs text-gray-600 mt-2 sm:mt-4 flex flex-wrap justify-center gap-2 sm:gap-4">
                     <span>[0-9] TYPE</span>
                     <span>[ENTER] CONFIRM</span>
                     <span>[ESC] CANCEL</span>
                 </div>
             </div>
         </div>
    );
};

interface HelpOverlayProps { 
    isOpen: boolean; 
    onClose: () => void; 
    gameType: GameType; 
    detail?: string | null; 
}

export const HelpOverlay: React.FC<HelpOverlayProps> = ({ isOpen, onClose, gameType, detail }) => {
    if (!isOpen) return null;
    
    // Check if we have detailed content to show
    if (detail) {
        const gameHelp = HELP_CONTENT[gameType];
        const detailInfo = gameHelp ? gameHelp[detail] : null;

        if (detailInfo) {
             return (
                <div className="absolute inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 sm:p-8">
                    <div className="bg-terminal-black border border-terminal-accent rounded-lg shadow-2xl max-w-lg w-full flex flex-col max-h-[90vh] overflow-y-auto">
                        <div className="p-4 sm:p-6 border-b border-terminal-dim bg-terminal-dim/20">
                             <div className="text-[10px] sm:text-xs text-terminal-green mb-2 font-bold">[ {detail.toUpperCase()} ] COMMAND DETAIL</div>
                             <h2 className="text-lg sm:text-xl font-bold text-white tracking-widest">{detailInfo.title}</h2>
                        </div>
                        <div className="p-4 sm:p-6 space-y-4 sm:space-y-6">
                            <div>
                                <h4 className="text-terminal-green font-bold text-[10px] sm:text-xs mb-1">WIN CONDITION</h4>
                                <p className="text-xs sm:text-sm text-gray-300">{detailInfo.win}</p>
                            </div>
                            <div>
                                <h4 className="text-terminal-accent font-bold text-[10px] sm:text-xs mb-1">LOSS CONDITION</h4>
                                <p className="text-xs sm:text-sm text-gray-300">{detailInfo.loss}</p>
                            </div>
                            <div className="bg-gray-900 p-2 sm:p-3 rounded border border-gray-800">
                                <h4 className="text-gray-500 font-bold text-[10px] mb-1">EXAMPLE</h4>
                                <p className="text-[10px] sm:text-xs text-gray-400 font-mono">{detailInfo.example}</p>
                            </div>
                        </div>
                        <div className="p-3 sm:p-4 border-t border-terminal-dim text-center">
                            <span className="text-[10px] sm:text-xs text-gray-500">[ESC] BACK</span>
                        </div>
                    </div>
                </div>
             );
        }
    }

    // Help content based on GameType
    const renderHelpContent = () => {
        switch(gameType) {
            case GameType.BLACKJACK:
                return (
                    <div className="space-y-4">
                        <h3 className="text-terminal-green font-bold border-b border-terminal-dim pb-1">BLACKJACK CONTROLS</h3>
                        <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm text-gray-300">
                            <div><span className="text-white font-bold w-6 inline-block">[H]</span> HIT</div>
                            <div><span className="text-white font-bold w-6 inline-block">[S]</span> STAND</div>
                            <div><span className="text-white font-bold w-6 inline-block">[D]</span> DOUBLE</div>
                            <div><span className="text-white font-bold w-6 inline-block">[P]</span> SPLIT</div>
                            <div><span className="text-white font-bold w-6 inline-block">[I]</span> INSURANCE</div>
                        </div>
                    </div>
                );
            case GameType.CRAPS:
                return (
                    <div className="space-y-4">
                        <h3 className="text-terminal-green font-bold border-b border-terminal-dim pb-1">CRAPS CONTROLS</h3>
                        <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm text-gray-300">
                            <div><span className="text-white font-bold w-6 inline-block">[P]</span> PASS / COME</div>
                            <div><span className="text-white font-bold w-6 inline-block">[D]</span> DONT PASS / DONT COME</div>
                            <div><span className="text-white font-bold w-6 inline-block">[F]</span> FIELD BET</div>
                            <div><span className="text-white font-bold w-6 inline-block">[O]</span> ADD ODDS</div>
                            <div><span className="text-white font-bold w-6 inline-block">[H]</span> HARDWAYS MENU</div>
                            <div><span className="text-white font-bold w-6 inline-block">[Y]</span> YES MENU</div>
                            <div><span className="text-white font-bold w-6 inline-block">[N]</span> NO MENU</div>
                            <div><span className="text-white font-bold w-6 inline-block">[X]</span> NEXT ROLL MENU</div>
                            <div><span className="text-white font-bold w-6 inline-block">[U]</span> UNDO BET</div>
                            <div><span className="text-white font-bold w-20 inline-block">[SPACE]</span> ROLL DICE</div>
                        </div>
                    </div>
                );
            case GameType.ROULETTE:
                return (
                    <div className="space-y-4">
                        <h3 className="text-terminal-green font-bold border-b border-terminal-dim pb-1">ROULETTE CONTROLS</h3>
                        <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm text-gray-300">
                            <div><span className="text-white font-bold w-6 inline-block">[R]</span> RED</div>
                            <div><span className="text-white font-bold w-6 inline-block">[B]</span> BLACK</div>
                            <div><span className="text-white font-bold w-6 inline-block">[E]</span> EVEN</div>
                            <div><span className="text-white font-bold w-6 inline-block">[O]</span> ODD</div>
                            <div><span className="text-white font-bold w-6 inline-block">[L]</span> LOW (1-18)</div>
                            <div><span className="text-white font-bold w-6 inline-block">[H]</span> HIGH (19-36)</div>
                            <div><span className="text-white font-bold w-6 inline-block">[0]</span> ZERO</div>
                            <div><span className="text-white font-bold w-6 inline-block">[N]</span> SPECIFIC NUMBER</div>
                            <div><span className="text-white font-bold w-6 inline-block">[T]</span> REBET</div>
                            <div><span className="text-white font-bold w-6 inline-block">[U]</span> UNDO BET</div>
                            <div><span className="text-white font-bold w-20 inline-block">[SPACE]</span> SPIN WHEEL</div>
                        </div>
                    </div>
                );
             case GameType.SIC_BO:
                return (
                    <div className="space-y-4">
                        <h3 className="text-terminal-green font-bold border-b border-terminal-dim pb-1">SIC BO CONTROLS</h3>
                        <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm text-gray-300">
                            <div><span className="text-white font-bold w-6 inline-block">[S]</span> SMALL (4-10)</div>
                            <div><span className="text-white font-bold w-6 inline-block">[B]</span> BIG (11-17)</div>
                            <div><span className="text-white font-bold w-6 inline-block">[A]</span> ANY TRIPLE</div>
                            <div><span className="text-white font-bold w-6 inline-block">[N]</span> SINGLE DIE BET</div>
                            <div><span className="text-white font-bold w-6 inline-block">[D]</span> DOUBLE BET</div>
                            <div><span className="text-white font-bold w-6 inline-block">[M]</span> SUM (TOTAL) BET</div>
                            <div><span className="text-white font-bold w-6 inline-block">[T]</span> REBET</div>
                            <div><span className="text-white font-bold w-6 inline-block">[U]</span> UNDO BET</div>
                            <div><span className="text-white font-bold w-20 inline-block">[SPACE]</span> ROLL DICE</div>
                        </div>
                    </div>
                );
             case GameType.BACCARAT:
                return (
                    <div className="space-y-4">
                        <h3 className="text-terminal-green font-bold border-b border-terminal-dim pb-1">BACCARAT CONTROLS</h3>
                        <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm text-gray-300">
                            <div><span className="text-white font-bold w-6 inline-block">[P]</span> SELECT PLAYER</div>
                            <div><span className="text-white font-bold w-6 inline-block">[B]</span> SELECT BANKER</div>
                            <div><span className="text-white font-bold w-6 inline-block">[E]</span> TIE BET</div>
                            <div><span className="text-white font-bold w-6 inline-block">[Q]</span> PLAYER PAIR</div>
                            <div><span className="text-white font-bold w-6 inline-block">[W]</span> BANKER PAIR</div>
                            <div><span className="text-white font-bold w-6 inline-block">[T]</span> REBET</div>
                            <div><span className="text-white font-bold w-6 inline-block">[U]</span> UNDO BET</div>
                            <div><span className="text-white font-bold w-20 inline-block">[SPACE]</span> DEAL</div>
                        </div>
                    </div>
                );
             case GameType.HILO:
                return (
                    <div className="space-y-4">
                        <h3 className="text-terminal-green font-bold border-b border-terminal-dim pb-1">HILO CONTROLS</h3>
                        <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm text-gray-300">
                            <div><span className="text-white font-bold w-6 inline-block">[H]</span> HIGHER</div>
                            <div><span className="text-white font-bold w-6 inline-block">[L]</span> LOWER</div>
                            <div><span className="text-white font-bold w-6 inline-block">[C]</span> CASHOUT</div>
                        </div>
                    </div>
                );
             case GameType.VIDEO_POKER:
                return (
                    <div className="space-y-4">
                        <h3 className="text-terminal-green font-bold border-b border-terminal-dim pb-1">VIDEO POKER CONTROLS</h3>
                        <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm text-gray-300">
                            <div><span className="text-white font-bold w-12 inline-block">[1-5]</span> TOGGLE HOLD</div>
                            <div><span className="text-white font-bold w-12 inline-block">[D]</span> DRAW</div>
                        </div>
                    </div>
                );
            case GameType.NONE:
                return (
                     <div className="text-center text-gray-400 py-4">
                         PRESS <span className="text-white font-bold">[/]</span> TO SELECT A GAME
                     </div>
                );
            default:
                return (
                    <div className="text-center text-gray-400 py-4">
                        STANDARD CONTROLS: [SPACE] TO DEAL
                    </div>
                );
        }
    };

    return (
        <div className="absolute inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 sm:p-8" onClick={onClose}>
            <div className="bg-terminal-black border border-terminal-dim rounded-lg shadow-2xl max-w-2xl w-full flex flex-col max-h-[90vh]" onClick={e => e.stopPropagation()}>
                <div className="p-4 sm:p-6 border-b border-terminal-dim flex justify-between items-center bg-terminal-dim/20 gap-2">
                    <div className="flex flex-col min-w-0">
                        <h2 className="text-base sm:text-xl font-bold text-white tracking-widest">HELP & COMMANDS</h2>
                        <span className="text-[10px] sm:text-xs text-terminal-green mt-1 hidden sm:block">TYPE ANY COMMAND KEY BELOW FOR DETAILS</span>
                    </div>
                    <span className="text-[10px] sm:text-xs text-gray-500 whitespace-nowrap">[ESC] CLOSE</span>
                </div>

                <div className="p-4 sm:p-6 overflow-y-auto space-y-6 sm:space-y-8">
                    {/* General Shortcuts */}
                    <div className="space-y-3 sm:space-y-4">
                        <h3 className="text-terminal-gold font-bold border-b border-terminal-dim pb-1 text-sm sm:text-base">GLOBAL COMMANDS</h3>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-4 text-xs sm:text-sm text-gray-300">
                            <div><span className="text-white font-bold">[/]</span> GAME MENU</div>
                            <div><span className="text-white font-bold">[?]</span> TOGGLE HELP</div>
                            <div><span className="text-white font-bold">[Z]</span> USE SHIELD</div>
                            <div><span className="text-white font-bold">[X]</span> USE DOUBLE</div>
                            <div><span className="text-white font-bold">[G]</span> SUPER MODE</div>
                            <div><span className="text-white font-bold">[L]</span> LEADERBOARD VIEW</div>
                        </div>
                        <div className="text-[10px] sm:text-xs text-gray-500 mt-2">
                             BET SIZING: [1] $1, [2] $5, [3] $25, ... [0] CUSTOM
                        </div>
                    </div>

                    {/* Specific Game Help */}
                    {renderHelpContent()}
                </div>
            </div>
        </div>
    );
};
