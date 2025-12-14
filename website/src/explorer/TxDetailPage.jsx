import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchTransaction } from '../api/explorerClient';

function getInstructionDescriptionFallback(instruction) {
  if (typeof instruction !== 'string') return '';
  const trimmed = instruction.trim();
  if (!trimmed) return '';

  if (trimmed === 'CasinoToggleShield') return 'Toggle shield modifier';
  if (trimmed === 'CasinoToggleDouble') return 'Toggle double modifier';
  if (trimmed === 'CasinoToggleSuper') return 'Toggle super mode';
  if (trimmed === 'Unstake') return 'Unstake';
  if (trimmed === 'ClaimRewards') return 'Claim staking rewards';
  if (trimmed === 'ProcessEpoch') return 'Process epoch';
  if (trimmed === 'CreateVault') return 'Create vault';

  let match = trimmed.match(/^CasinoRegister\s*\{\s*name:\s*"(.*)"\s*\}$/);
  if (match) return `Register casino player "${match[1]}"`;

  match = trimmed.match(/^CasinoDeposit\s*\{\s*amount:\s*(\d+)\s*\}$/);
  if (match) return `Deposit ${match[1]} RNG (faucet)`;

  match = trimmed.match(
    /^CasinoStartGame\s*\{\s*game_type:\s*([A-Za-z]+)\s*,\s*bet:\s*(\d+)\s*,\s*session_id:\s*(\d+)\s*\}$/
  );
  if (match) return `Start ${match[1]} game (bet ${match[2]} RNG, session ${match[3]})`;

  match = trimmed.match(
    /^CasinoGameMove\s*\{\s*session_id:\s*(\d+)\s*,\s*payload:\s*\[([\s\S]*?)\]\s*,?\s*\}$/
  );
  if (match) {
    const bytes = match[2].trim() ? match[2].split(',').filter((v) => v.trim() !== '').length : 0;
    return bytes
      ? `Casino game move (session ${match[1]}, ${bytes} bytes)`
      : `Casino game move (session ${match[1]})`;
  }

  match = trimmed.match(/^CasinoJoinTournament\s*\{\s*tournament_id:\s*(\d+)\s*\}$/);
  if (match) return `Join tournament ${match[1]}`;

  match = trimmed.match(
    /^CasinoStartTournament\s*\{\s*tournament_id:\s*(\d+)\s*,\s*start_time_ms:\s*(\d+)\s*,\s*end_time_ms:\s*(\d+)\s*\}$/
  );
  if (match) return `Start tournament ${match[1]} (start ${match[2]}, end ${match[3]})`;

  match = trimmed.match(/^CasinoEndTournament\s*\{\s*tournament_id:\s*(\d+)\s*\}$/);
  if (match) return `End tournament ${match[1]}`;

  match = trimmed.match(/^Stake\s*\{\s*amount:\s*(\d+)\s*,\s*duration:\s*(\d+)\s*\}$/);
  if (match) return `Stake ${match[1]} RNG for ${match[2]} blocks`;

  match = trimmed.match(/^DepositCollateral\s*\{\s*amount:\s*(\d+)\s*\}$/);
  if (match) return `Deposit ${match[1]} RNG as collateral`;

  match = trimmed.match(/^BorrowUSDT\s*\{\s*amount:\s*(\d+)\s*\}$/);
  if (match) return `Borrow ${match[1]} vUSDT`;

  match = trimmed.match(/^RepayUSDT\s*\{\s*amount:\s*(\d+)\s*\}$/);
  if (match) return `Repay ${match[1]} vUSDT`;

  match = trimmed.match(
    /^Swap\s*\{\s*amount_in:\s*(\d+)\s*,\s*min_amount_out:\s*(\d+)\s*,\s*is_buying_rng:\s*(true|false)\s*\}$/
  );
  if (match) {
    const isBuyingRng = match[3] === 'true';
    return isBuyingRng
      ? `Swap ${match[1]} vUSDT for ≥ ${match[2]} RNG`
      : `Swap ${match[1]} RNG for ≥ ${match[2]} vUSDT`;
  }

  match = trimmed.match(/^AddLiquidity\s*\{\s*rng_amount:\s*(\d+)\s*,\s*usdt_amount:\s*(\d+)\s*\}$/);
  if (match) return `Add liquidity (${match[1]} RNG + ${match[2]} vUSDT)`;

  match = trimmed.match(/^RemoveLiquidity\s*\{\s*shares:\s*(\d+)\s*\}$/);
  if (match) return `Remove liquidity (${match[1]} LP shares)`;

  return '';
}

export default function TxDetailPage() {
  const { hash } = useParams();
  const [tx, setTx] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let mounted = true;
    fetchTransaction(hash)
      .then((data) => {
        if (mounted) setTx(data);
      })
      .catch(() => setError('Transaction not found'));
    return () => {
      mounted = false;
    };
  }, [hash]);

  if (error) return <div className="text-red-400">{error}</div>;
  if (!tx) return <div className="text-gray-300">Loading transaction...</div>;

  const description = tx.description || getInstructionDescriptionFallback(tx.instruction);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold break-all">Tx {tx.hash}</h1>
        <p className="text-gray-400 text-sm">
          Block:{' '}
          <Link to={`/explorer/blocks/${tx.block_height}`} className="text-terminal-green hover:underline">
            #{tx.block_height}
          </Link>
        </p>
        <p className="text-gray-400 text-sm">Position: {tx.position}</p>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded p-3 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-400">Public Key</span>
          <span className="font-mono break-all">{tx.public_key}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">Nonce</span>
          <span>{tx.nonce}</span>
        </div>
        <div className="mt-2">
          <div className="text-gray-400">Description</div>
          <div className="break-words">{description || '—'}</div>
        </div>
        <div className="mt-2">
          <div className="text-gray-400">Instruction</div>
          <div className="font-mono break-words text-xs">{tx.instruction}</div>
        </div>
      </div>
    </div>
  );
}
