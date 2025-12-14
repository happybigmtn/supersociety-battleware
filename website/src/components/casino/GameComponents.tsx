
import React, { useEffect, useMemo, useState } from 'react';
import { Card, Suit } from '../../types';

export const CardRender: React.FC<{ card: Card; small?: boolean; forcedColor?: string; dealDelayMs?: number }> = ({
  card,
  small,
  forcedColor,
  dealDelayMs,
}) => {
  const [animKey, setAnimKey] = useState(0);

  useEffect(() => {
    setAnimKey((k) => k + 1);
  }, [card?.value, card?.isHidden]);

  // Defensive check for missing card data
  if (!card) {
    return (
      <div
        className={`${
          small ? 'w-9 h-[3.25rem] sm:w-10 sm:h-14' : 'w-12 h-[4.5rem] sm:w-16 sm:h-24'
        } bg-terminal-dim border border-gray-600 rounded flex items-center justify-center`}
      >
        <span className="text-gray-500 opacity-50 text-xs">?</span>
      </div>
    );
  }

  const sizeClass = useMemo(
    () =>
      small ? 'w-9 h-[3.25rem] sm:w-10 sm:h-14 text-sm' : 'w-12 h-[4.5rem] sm:w-16 sm:h-24 text-base sm:text-xl',
    [small]
  );

  if (card.isHidden) {
    return (
      <div
        key={animKey}
        style={dealDelayMs !== undefined ? ({ animationDelay: `${dealDelayMs}ms` } as React.CSSProperties) : undefined}
        className={`${sizeClass} card-back border border-gray-700 rounded flex items-center justify-center relative overflow-hidden animate-card-deal`}
      >
        <div className="absolute inset-0 card-shimmer opacity-20" />
        <span className="relative text-gray-500/70 text-xs tracking-[0.35em]">///</span>
      </div>
    );
  }

  const isRed = card.suit === '♥' || card.suit === '♦';
  let colorClass = isRed ? 'text-terminal-accent' : 'text-terminal-green';
  if (forcedColor) colorClass = forcedColor;

  return (
    <div
      key={animKey}
      style={dealDelayMs !== undefined ? ({ animationDelay: `${dealDelayMs}ms` } as React.CSSProperties) : undefined}
      className={`${sizeClass} bg-terminal-black border border-current rounded flex flex-col items-center justify-between p-1 ${colorClass} shadow-[0_0_10px_rgba(0,0,0,0.5)] animate-card-deal ${
        card.isHeld ? 'ring-2 ring-[rgba(0,255,65,0.35)]' : ''
      }`}
    >
      <div className="self-start leading-none font-bold">{card.rank || '?'}</div>
      <div className={`${small ? 'text-lg' : 'text-xl sm:text-2xl'} leading-none`}>{card.suit || '?'}</div>
      <div className="self-end leading-none rotate-180 font-bold">{card.rank || '?'}</div>
    </div>
  );
};

export const Hand: React.FC<{ cards: Card[]; title?: string; forcedColor?: string }> = ({ cards, title, forcedColor }) => (
  <div className="flex flex-col gap-2 items-center">
    {title && <span className={`text-xs uppercase tracking-widest ${forcedColor ? forcedColor : 'text-gray-500'}`}>{title}</span>}
    <div className="flex flex-wrap justify-center gap-1 sm:gap-2">
      {cards.map((c, i) => (
        <CardRender
          key={`${i}-${c?.value ?? 'x'}-${c?.isHidden ? 1 : 0}`}
          card={c}
          forcedColor={forcedColor}
          dealDelayMs={i * 45}
        />
      ))}
      {cards.length === 0 && (
        <div
          className={`w-12 h-[4.5rem] sm:w-16 sm:h-24 border border-dashed rounded ${
            forcedColor ? `border-${forcedColor.replace('text-', '')}` : 'border-gray-800'
          }`}
        />
      )}
    </div>
  </div>
);

export const Chip: React.FC<{ value: number }> = ({ value }) => (
  <div className="w-6 h-6 rounded-full border border-terminal-gold text-terminal-gold flex items-center justify-center text-[10px] font-bold">
    {value >= 1000 ? 'K' : value}
  </div>
);

export const DiceRender: React.FC<{ value: number; delayMs?: number }> = ({ value, delayMs }) => {
  const [animKey, setAnimKey] = useState(0);

  useEffect(() => {
    setAnimKey((k) => k + 1);
  }, [value]);

  return (
    <div
      key={animKey}
      style={delayMs !== undefined ? ({ animationDelay: `${delayMs}ms` } as React.CSSProperties) : undefined}
      className="w-14 h-14 sm:w-16 sm:h-16 bg-terminal-black border border-terminal-green rounded flex items-center justify-center shadow-[0_0_12px_rgba(0,0,0,0.6)] animate-dice-roll"
    >
        <span className="text-2xl sm:text-3xl font-black text-terminal-green tabular-nums">{value}</span>
    </div>
  );
};
