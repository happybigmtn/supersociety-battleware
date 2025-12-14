import React, { useEffect, useMemo, useRef, useState } from 'react';
import { WasmWrapper } from './api/wasm.js';
import { CasinoClient } from './api/client.js';
import { PlaySwapStakeTabs } from './components/PlaySwapStakeTabs';

type ActivityItem = { ts: number; message: string };

function parseAmount(input: string): bigint | null {
  const trimmed = input.trim();
  if (!trimmed) return 0n;
  try {
    const n = BigInt(trimmed);
    if (n < 0n) return null;
    return n;
  } catch {
    return null;
  }
}

function formatApproxTimeFromBlocks(blocks: number, secondsPerBlock = 3): string {
  if (!Number.isFinite(blocks) || blocks <= 0) return '0s';
  const totalSeconds = Math.floor(blocks * secondsPerBlock);
  const minutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `~${days}d`;
  if (hours > 0) return `~${hours}h`;
  if (minutes > 0) return `~${minutes}m`;
  return `~${totalSeconds}s`;
}

export default function StakingApp() {
  const [status, setStatus] = useState<string>('Initializing…');
  const [lastTxSig, setLastTxSig] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);

  const clientRef = useRef<CasinoClient | null>(null);
  const publicKeyBytesRef = useRef<Uint8Array | null>(null);
  const publicKeyHexRef = useRef<string | null>(null);

  const [isRegistered, setIsRegistered] = useState(false);
  const [player, setPlayer] = useState<any | null>(null);
  const [staker, setStaker] = useState<any | null>(null);
  const [house, setHouse] = useState<any | null>(null);
  const [currentView, setCurrentView] = useState<number | null>(null);

  const [registerName, setRegisterName] = useState('Staker');
  const [stakeAmount, setStakeAmount] = useState('0');
  const [stakeDuration, setStakeDuration] = useState('100');

  const pushActivity = (message: string) => {
    setActivity(prev => [{ ts: Date.now(), message }, ...prev].slice(0, 12));
  };

  useEffect(() => {
    const init = async () => {
      try {
        const identityHex = import.meta.env.VITE_IDENTITY as string | undefined;
        if (!identityHex) {
          setStatus('Missing VITE_IDENTITY (see website/README.md).');
          return;
        }

        const wasm = new WasmWrapper(identityHex);
        await wasm.init();

        const client = new CasinoClient('/api', wasm);
        await client.init();

        const keypair = client.getOrCreateKeypair();
        if (!keypair) {
          setStatus('Unlock passkey vault (see Vault tab).');
          pushActivity('Vault locked — unlock to continue');
          return;
        }
        publicKeyBytesRef.current = keypair.publicKey;
        publicKeyHexRef.current = keypair.publicKeyHex;
        clientRef.current = client;

        await client.connectUpdates(keypair.publicKey);

        const account = await client.getAccount(keypair.publicKey);
        await client.initNonceManager(keypair.publicKeyHex, keypair.publicKey, account);

        const pkHexLower = keypair.publicKeyHex.toLowerCase();
        client.onEvent('CasinoError', (e: any) => {
          if (e?.player?.toLowerCase?.() !== pkHexLower) return;
          pushActivity(`ERROR: ${e.message ?? 'Unknown error'}`);
        });
        client.onEvent('Staked', (e: any) => {
          if (e?.player?.toLowerCase?.() !== pkHexLower) return;
          pushActivity(`Staked: +${e.amount} (unlock @ ${e.unlockTs ?? e.unlock_ts ?? '—'})`);
        });
        client.onEvent('Unstaked', (e: any) => {
          if (e?.player?.toLowerCase?.() !== pkHexLower) return;
          pushActivity(`Unstaked: ${e.amount}`);
        });
        client.onEvent('RewardsClaimed', (e: any) => {
          if (e?.player?.toLowerCase?.() !== pkHexLower) return;
          pushActivity(`Rewards claimed: ${e.amount}`);
        });
        client.onEvent('EpochProcessed', (e: any) => {
          pushActivity(`Epoch processed: ${e.epoch}`);
        });

        setStatus('Connected');
        pushActivity('Connected');
      } catch (e) {
        console.error('[StakingApp] init failed:', e);
        setStatus('Failed to connect. Check simulator + dev-executor.');
      }
    };

    init();

    return () => {
      const client = clientRef.current;
      try {
        client?.destroy?.();
      } catch {
        // ignore
      }
      clientRef.current = null;
      publicKeyBytesRef.current = null;
      publicKeyHexRef.current = null;
    };
  }, []);

  // Poll state
  useEffect(() => {
    const interval = setInterval(async () => {
      const client = clientRef.current as any;
      const pk = publicKeyBytesRef.current;
      if (!client || !pk) return;

      try {
        const [p, s, h] = await Promise.all([
          client.getCasinoPlayer(pk),
          client.getStaker(pk),
          client.getHouse(),
        ]);
        setPlayer(p);
        setIsRegistered(!!p);
        setStaker(s);
        setHouse(h);
        setCurrentView(client.getCurrentView?.() ?? null);
      } catch {
        // ignore transient errors
      }
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const derived = useMemo(() => {
    const staked = BigInt(staker?.balance ?? 0);
    const unlockTs = Number(staker?.unlockTs ?? 0);
    const vp = BigInt(staker?.votingPower ?? 0);
    const totalVp = BigInt(house?.totalVotingPower ?? 0);
    const totalStaked = BigInt(house?.totalStakedAmount ?? 0);

    const view = currentView ?? 0;
    const locked = unlockTs > 0 && view < unlockTs;
    const remainingBlocks = locked ? unlockTs - view : 0;

    const shareBps = totalVp > 0n ? Number((vp * 10_000n) / totalVp) : 0;
    const stakedShareBps = totalStaked > 0n ? Number((staked * 10_000n) / totalStaked) : 0;

    return {
      staked,
      unlockTs,
      vp,
      totalVp,
      totalStaked,
      locked,
      remainingBlocks,
      shareBps,
      stakedShareBps,
    };
  }, [staker, house, currentView]);

  const ensureRegistered = async () => {
    const client = clientRef.current as any;
    if (!client?.nonceManager) throw new Error('Client not ready');
    if (isRegistered) return;
    const name = registerName.trim() || `Staker_${Date.now().toString(36)}`;
    const result = await client.nonceManager.submitCasinoRegister(name);
    if (result?.txHash) setLastTxSig(result.txHash);
    pushActivity(`Submitted register (${name})`);
  };

  const claimFaucet = async () => {
    const client = clientRef.current as any;
    if (!client?.nonceManager) throw new Error('Client not ready');
    await ensureRegistered();
    const result = await client.nonceManager.submitCasinoDeposit(1000);
    if (result?.txHash) setLastTxSig(result.txHash);
    pushActivity('Submitted faucet claim (1000 RNG)');
  };

  const stake = async () => {
    const client = clientRef.current as any;
    if (!client?.nonceManager) throw new Error('Client not ready');
    await ensureRegistered();

    const amount = parseAmount(stakeAmount);
    const duration = parseAmount(stakeDuration);
    if (amount === null || duration === null) {
      pushActivity('Invalid stake amount/duration');
      return;
    }
    const result = await client.nonceManager.submitStake(amount.toString(), duration.toString());
    if (result?.txHash) setLastTxSig(result.txHash);
    pushActivity(`Submitted stake (amount=${amount}, duration=${duration})`);
  };

  const unstake = async () => {
    const client = clientRef.current as any;
    if (!client?.nonceManager) throw new Error('Client not ready');
    await ensureRegistered();
    const result = await client.nonceManager.submitUnstake();
    if (result?.txHash) setLastTxSig(result.txHash);
    pushActivity('Submitted unstake');
  };

  const claimRewards = async () => {
    const client = clientRef.current as any;
    if (!client?.nonceManager) throw new Error('Client not ready');
    await ensureRegistered();
    const result = await client.nonceManager.submitClaimRewards();
    if (result?.txHash) setLastTxSig(result.txHash);
    pushActivity('Submitted claim rewards (MVP placeholder)');
  };

  const processEpoch = async () => {
    const client = clientRef.current as any;
    if (!client?.nonceManager) throw new Error('Client not ready');
    await ensureRegistered();
    const result = await client.nonceManager.submitProcessEpoch();
    if (result?.txHash) setLastTxSig(result.txHash);
    pushActivity('Submitted process epoch');
  };

  return (
    <div className="min-h-screen bg-terminal-black text-white font-mono p-4">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-800 pb-3 mb-4">
        <div className="flex items-center gap-3 flex-wrap">
          <PlaySwapStakeTabs />
          <div className="text-lg font-bold tracking-widest">Staking</div>
          <div className="text-[10px] text-gray-500 tracking-widest">{status}</div>
        </div>
        <div className="text-[10px] text-gray-500 tracking-widest">
          {lastTxSig ? `LAST TX: ${lastTxSig}` : null}
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Wallet */}
        <section className="border border-gray-800 rounded p-4 bg-gray-900/30">
          <div className="text-xs text-gray-400 tracking-widest mb-3">WALLET</div>
          <div className="space-y-2 text-sm">
            <div>
              Registered:{' '}
              <span className={isRegistered ? 'text-terminal-green' : 'text-terminal-accent'}>
                {isRegistered ? 'YES' : 'NO'}
              </span>
            </div>
            <div>
              RNG: <span className="text-white">{player?.chips ?? 0}</span>
            </div>
            <div>
              vUSDT: <span className="text-white">{player?.vusdtBalance ?? 0}</span>
            </div>
            <div className="text-[10px] text-gray-600 break-all">PK: {publicKeyHexRef.current ?? '—'}</div>
          </div>

          <div className="mt-4 space-y-2">
            <div className="flex items-center gap-2">
              <input
                className="flex-1 bg-gray-950 border border-gray-800 rounded px-2 py-1 text-xs"
                value={registerName}
                onChange={(e) => setRegisterName(e.target.value)}
                placeholder="Name"
              />
              <button
                className="text-xs px-3 py-1 rounded border border-terminal-green text-terminal-green hover:bg-terminal-green/10"
                onClick={ensureRegistered}
              >
                Register
              </button>
            </div>
            <button
              className="w-full text-xs px-3 py-2 rounded border border-terminal-green text-terminal-green hover:bg-terminal-green/10"
              onClick={claimFaucet}
            >
              Daily Faucet (1000 RNG)
            </button>
          </div>
        </section>

        {/* Stake */}
        <section className="border border-gray-800 rounded p-4 bg-gray-900/30">
          <div className="text-xs text-gray-400 tracking-widest mb-3">STAKE RNG</div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="border border-gray-800 rounded p-3 bg-black/30">
              <div className="text-[10px] text-gray-500 tracking-widest">YOUR STAKE</div>
              <div className="text-white mt-1">{staker?.balance ?? 0}</div>
              <div className="text-[10px] text-gray-600">unlock @ {derived.unlockTs || '—'}</div>
            </div>
            <div className="border border-gray-800 rounded p-3 bg-black/30">
              <div className="text-[10px] text-gray-500 tracking-widest">VOTING POWER</div>
              <div className="text-white mt-1">{derived.vp.toString()}</div>
              <div className="text-[10px] text-gray-600">share ~ {(derived.shareBps / 100).toFixed(2)}%</div>
            </div>
          </div>

          <div className="mt-4 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <input
                className="bg-gray-950 border border-gray-800 rounded px-2 py-1 text-xs"
                value={stakeAmount}
                onChange={(e) => setStakeAmount(e.target.value)}
                placeholder="Amount (RNG)"
              />
              <input
                className="bg-gray-950 border border-gray-800 rounded px-2 py-1 text-xs"
                value={stakeDuration}
                onChange={(e) => setStakeDuration(e.target.value)}
                placeholder="Duration (blocks)"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                className="flex-1 text-xs px-3 py-2 rounded border border-terminal-green text-terminal-green hover:bg-terminal-green/10"
                onClick={stake}
              >
                Stake
              </button>
              <button
                className={`text-xs px-3 py-2 rounded border ${
                  derived.locked
                    ? 'border-gray-800 text-gray-600 cursor-not-allowed'
                    : 'border-gray-700 text-gray-300 hover:border-gray-500'
                }`}
                onClick={unstake}
                disabled={derived.locked}
                title={derived.locked ? `Locked for ${derived.remainingBlocks} blocks` : 'Unstake'}
              >
                Unstake
              </button>
              <button
                className="text-xs px-3 py-2 rounded border border-gray-700 text-gray-300 hover:border-gray-500"
                onClick={claimRewards}
              >
                Claim
              </button>
            </div>

            {derived.locked && (
              <div className="text-[10px] text-gray-500">
                Locked: {derived.remainingBlocks} blocks ({formatApproxTimeFromBlocks(derived.remainingBlocks)})
              </div>
            )}

            <div className="text-[10px] text-gray-600 leading-relaxed">
              Rewards distribution is an MVP placeholder (see `liquidity.md`); staking currently tracks lockups + voting
              power and will later receive house-edge + fee flow.
            </div>
          </div>
        </section>

        {/* House */}
        <section className="border border-gray-800 rounded p-4 bg-gray-900/30">
          <div className="text-xs text-gray-400 tracking-widest mb-3">HOUSE / REWARDS</div>
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-gray-500">Epoch</span>
              <span className="text-white">{house?.currentEpoch ?? 0}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-500">Net PnL</span>
              <span className="text-white">{house?.netPnl ?? '0'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-500">Total Staked</span>
              <span className="text-white">{house?.totalStakedAmount ?? 0}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-500">Total Voting Power</span>
              <span className="text-white">{house?.totalVotingPower ?? '0'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-500">AMM Fees</span>
              <span className="text-white">{house?.accumulatedFees ?? 0}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-500">Total Burned</span>
              <span className="text-white">{house?.totalBurned ?? 0}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-500">Total Issuance</span>
              <span className="text-white">{house?.totalIssuance ?? 0}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-500">View</span>
              <span className="text-white">{currentView ?? '—'}</span>
            </div>
          </div>

          <div className="mt-4 border-t border-gray-800 pt-4 space-y-2">
            <button
              className="w-full text-xs px-3 py-2 rounded border border-gray-700 text-gray-300 hover:border-gray-500"
              onClick={processEpoch}
            >
              Process Epoch (dev)
            </button>
            <div className="text-[10px] text-gray-600">
              Anyone can call this in dev; later it’s a keeper/admin action.
            </div>
          </div>
        </section>
      </div>

      {/* Activity */}
      <section className="mt-4 border border-gray-800 rounded p-4 bg-gray-900/20">
        <div className="text-xs text-gray-400 tracking-widest mb-3">ACTIVITY</div>
        {activity.length === 0 ? (
          <div className="text-[10px] text-gray-600">No activity yet.</div>
        ) : (
          <ul className="space-y-1 text-[10px] text-gray-400">
            {activity.map((a) => (
              <li key={a.ts} className="flex items-start gap-2">
                <span className="text-gray-600">{new Date(a.ts).toLocaleTimeString()}</span>
                <span className="text-gray-300">{a.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
