import React from 'react';
import { NavLink } from 'react-router-dom';

type TabsProps = {
  className?: string;
};

export const PlaySwapStakeTabs: React.FC<TabsProps> = ({ className }) => {
  const tabClass = ({ isActive }: { isActive: boolean }) =>
    [
      'px-3 py-1 rounded border text-[10px] tracking-widest uppercase transition-colors',
      isActive
        ? 'border-terminal-green text-terminal-green bg-terminal-green/10'
        : 'border-gray-800 text-gray-400 hover:border-gray-600 hover:text-white',
    ].join(' ');

  return (
    <nav className={['flex items-center gap-2', className ?? ''].join(' ').trim()}>
      <NavLink to="/" end className={tabClass}>
        Play
      </NavLink>
      <NavLink to="/swap" className={tabClass}>
        Swap
      </NavLink>
      <NavLink to="/stake" className={tabClass}>
        Stake
      </NavLink>
      <NavLink to="/security" className={tabClass}>
        Vault
      </NavLink>
    </nav>
  );
};
