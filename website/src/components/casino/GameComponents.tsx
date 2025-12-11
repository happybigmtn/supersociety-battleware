
import React from 'react';
import { Card, Suit } from '../../types';

export const CardRender: React.FC<{ card: Card; small?: boolean; forcedColor?: string }> = ({ card, small, forcedColor }) => {
  // Defensive check for missing card data
  if (!card) {
    return (
      <div className={`${small ? 'w-8 h-12' : 'w-16 h-24'} bg-terminal-dim border border-gray-600 rounded flex items-center justify-center`}>
        <span className="text-gray-500 opacity-50 text-xs">?</span>
      </div>
    );
  }

  if (card.isHidden) {
    return (
      <div className={`${small ? 'w-8 h-12' : 'w-16 h-24'} bg-terminal-dim border border-gray-600 rounded flex items-center justify-center`}>
        <span className="text-gray-500 opacity-50 text-xs">///</span>
      </div>
    );
  }

  const isRed = card.suit === '♥' || card.suit === '♦';
  let colorClass = isRed ? 'text-terminal-accent' : 'text-terminal-green';
  if (forcedColor) colorClass = forcedColor;

  return (
    <div className={`${small ? 'w-8 h-12 text-sm' : 'w-16 h-24 text-xl'} bg-terminal-black border border-current rounded flex flex-col items-center justify-between p-1 ${colorClass} shadow-[0_0_10px_rgba(0,255,65,0.1)]`}>
      <div className="self-start leading-none">{card.rank || '?'}</div>
      <div className="text-2xl">{card.suit || '?'}</div>
      <div className="self-end leading-none rotate-180">{card.rank || '?'}</div>
    </div>
  );
};

export const Hand: React.FC<{ cards: Card[]; title?: string; forcedColor?: string }> = ({ cards, title, forcedColor }) => (
  <div className="flex flex-col gap-2 items-center">
    {title && <span className={`text-xs uppercase tracking-widest ${forcedColor ? forcedColor : 'text-gray-500'}`}>{title}</span>}
    <div className="flex gap-2">
      {cards.map((c, i) => <CardRender key={i} card={c} forcedColor={forcedColor} />)}
      {cards.length === 0 && <div className={`w-16 h-24 border border-dashed rounded ${forcedColor ? `border-${forcedColor.replace('text-', '')}` : 'border-gray-800'}`} />}
    </div>
  </div>
);

export const Chip: React.FC<{ value: number }> = ({ value }) => (
  <div className="w-6 h-6 rounded-full border border-terminal-gold text-terminal-gold flex items-center justify-center text-[10px] font-bold">
    {value >= 1000 ? 'K' : value}
  </div>
);

export const DiceRender: React.FC<{ value: number }> = ({ value }) => {
  return (
    <div className="w-16 h-16 bg-terminal-black border border-terminal-green rounded flex items-center justify-center shadow-[0_0_10px_rgba(0,255,65,0.1)]">
        <span className="text-3xl font-bold text-terminal-green">{value}</span>
    </div>
  );
};
