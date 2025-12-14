export interface ExplorerBlock {
  height: number;
  view: number;
  block_digest: string;
  parent?: string | null;
  tx_hashes: string[];
  tx_count: number;
  indexed_at_ms: number;
}

export interface ExplorerTransaction {
  hash: string;
  block_height: number;
  block_digest: string;
  position: number;
  public_key: string;
  nonce: number;
  description?: string | null;
  instruction: string;
}

export interface AccountActivity {
  public_key: string;
  txs: string[];
  events: string[];
  last_nonce?: number | null;
  last_updated_height?: number | null;
}

const API_BASE = '/api';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchBlocks(offset = 0, limit = 20): Promise<{
  blocks: ExplorerBlock[];
  next_offset?: number | null;
  total: number;
}> {
  return getJson(`/explorer/blocks?offset=${offset}&limit=${limit}`);
}

export async function fetchBlock(id: string | number): Promise<ExplorerBlock> {
  return getJson(`/explorer/blocks/${id}`);
}

export async function fetchTransaction(hash: string): Promise<ExplorerTransaction> {
  return getJson(`/explorer/tx/${hash}`);
}

export async function fetchAccount(pubkey: string): Promise<AccountActivity> {
  return getJson(`/explorer/account/${pubkey}`);
}

export async function searchExplorer(
  query: string
): Promise<
  | { type: 'block'; block: ExplorerBlock }
  | { type: 'transaction'; transaction: ExplorerTransaction }
  | { type: 'account'; account: AccountActivity }
> {
  return getJson(`/explorer/search?q=${encodeURIComponent(query)}`);
}
