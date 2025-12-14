import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PlaySwapStakeTabs } from './components/PlaySwapStakeTabs';
import { createPasskeyVault, deleteVault, getVaultRecord, getVaultStatusSync, lockPasskeyVault, unlockPasskeyVault } from './security/keyVault';
import { getUnlockedVault, subscribeVault } from './security/vaultRuntime';
import { VaultBetBot } from './security/VaultBetBot';

export default function SecurityApp() {
  const [status, setStatus] = useState<string>('Loading…');
  const [error, setError] = useState<string | null>(null);
  const [hasVault, setHasVault] = useState<boolean>(false);
  const [supported, setSupported] = useState<boolean>(false);
  const [enabled, setEnabled] = useState<boolean>(false);
  const [unlocked, setUnlocked] = useState<boolean>(!!getUnlockedVault());
  const [publicKeyHex, setPublicKeyHex] = useState<string | null>(getVaultStatusSync().nullspacePublicKeyHex);

  const [botRunning, setBotRunning] = useState(false);
  const [botLogs, setBotLogs] = useState<string[]>([]);
  const botRef = useRef<VaultBetBot | null>(null);

  const identityHex = import.meta.env.VITE_IDENTITY as string | undefined;
  const identityOk = !!identityHex;

  const formatError = (e: any): string => {
    const msg = e?.message ?? String(e);
    if (msg === 'passkey-prf-unsupported') {
      return 'This passkey/authenticator does not support the PRF/hmac-secret/largeBlob extensions required to derive a local vault key. Try creating the passkey on this device (platform passkey), or use a different authenticator (Android Chrome / hardware security key).';
    }
    return msg;
  };

  const sync = async () => {
    setError(null);
    const s = getVaultStatusSync();
    setSupported(s.supported);
    setEnabled(s.enabled);
    setUnlocked(s.unlocked);
    setPublicKeyHex(s.nullspacePublicKeyHex);

    if (!s.supported) {
      setStatus('Passkeys unavailable (requires secure context + WebAuthn).');
      setHasVault(false);
      return;
    }

    try {
      const record = await getVaultRecord();
      setHasVault(!!record);
      setStatus(record ? 'Vault found' : 'No vault yet');
    } catch (e: any) {
      setHasVault(false);
      setStatus('Failed to read vault');
      setError(formatError(e));
    }
  };

  useEffect(() => {
    void sync();
  }, []);

  useEffect(() => {
    return subscribeVault((v) => {
      setUnlocked(!!v);
      setPublicKeyHex(v?.nullspacePublicKeyHex ?? getVaultStatusSync().nullspacePublicKeyHex);
    });
  }, []);

  const vaultLabel = useMemo(() => {
    if (!supported) return 'UNSUPPORTED';
    if (!hasVault) return 'NONE';
    if (unlocked) return 'UNLOCKED';
    return 'LOCKED';
  }, [supported, hasVault, unlocked]);

  const pushBotLog = (msg: string) => {
    setBotLogs(prev => [`${new Date().toLocaleTimeString()} ${msg}`, ...prev].slice(0, 20));
  };

  const onCreateVault = async () => {
    setError(null);
    setStatus('Creating passkey + vault…');
    try {
      await createPasskeyVault({ migrateExistingCasinoKey: true });
      setStatus('Vault created and unlocked');
      await sync();
    } catch (e: any) {
      setStatus('Create failed');
      setError(formatError(e));
    }
  };

  const onUnlockVault = async () => {
    setError(null);
    setStatus('Unlocking…');
    try {
      await unlockPasskeyVault();
      setStatus('Unlocked');
      await sync();
    } catch (e: any) {
      setStatus('Unlock failed');
      setError(formatError(e));
    }
  };

  const onLockVault = () => {
    lockPasskeyVault();
    setStatus('Locked');
  };

  const onDeleteVault = async () => {
    setError(null);
    setStatus('Deleting vault…');
    try {
      await deleteVault();
      setStatus('Vault deleted');
      setHasVault(false);
      setUnlocked(false);
      setEnabled(false);
      setPublicKeyHex(null);
      botRef.current?.stop();
      botRef.current = null;
      setBotRunning(false);
    } catch (e: any) {
      setStatus('Delete failed');
      setError(formatError(e));
    }
  };

  const startBot = async () => {
    setError(null);
    if (!identityHex) {
      setError('Missing VITE_IDENTITY (see website/README.md).');
      return;
    }
    const vault = getUnlockedVault();
    if (!vault) {
      setError('Unlock your vault before starting the bot.');
      return;
    }

    if (!botRef.current) {
      botRef.current = new VaultBetBot({
        baseUrl: '/api',
        identityHex,
        privateKeyBytes: vault.nullspaceEd25519PrivateKey,
        onLog: pushBotLog,
      });
    }

    botRef.current.start();
    setBotRunning(true);
    pushBotLog('Vault bot started');
  };

  const stopBot = () => {
    botRef.current?.stop();
    setBotRunning(false);
    pushBotLog('Vault bot stopped');
  };

  return (
    <div className="min-h-screen w-screen bg-terminal-black text-white font-mono">
      <div className="border-b border-gray-800 bg-terminal-black/90 backdrop-blur px-4 py-2 flex items-center justify-center">
        <PlaySwapStakeTabs />
      </div>

      <div className="max-w-4xl mx-auto p-4 space-y-4">
        <div className="border border-gray-800 rounded bg-gray-900/30 p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-[10px] text-gray-500 tracking-widest">SECURITY</div>
              <div className="text-lg font-bold mt-1">Passkey Vault</div>
              <div className="text-xs text-gray-400 mt-1">{status}</div>
              <div className="text-xs text-gray-500 mt-2">
                Vault: <span className="text-terminal-green">{vaultLabel}</span>
                {publicKeyHex ? (
                  <>
                    {' '}
                    · Casino pubkey: <span className="text-terminal-green">{publicKeyHex.slice(0, 12)}…</span>
                  </>
                ) : null}
              </div>
              {!identityOk && (
                <div className="text-xs text-terminal-accent mt-2">Missing `VITE_IDENTITY` (required to verify chain state).</div>
              )}
            </div>

            <div className="flex flex-col gap-2 items-end">
              {!hasVault && supported && (
                <button
                  className="text-[10px] border px-3 py-2 rounded bg-terminal-green/20 border-terminal-green text-terminal-green hover:bg-terminal-green/30"
                  onClick={onCreateVault}
                >
                  CREATE PASSKEY VAULT
                </button>
              )}

              {hasVault && !unlocked && (
                <button
                  className="text-[10px] border px-3 py-2 rounded bg-gray-900 border-gray-700 text-gray-200 hover:border-gray-500"
                  onClick={onUnlockVault}
                >
                  UNLOCK WITH PASSKEY
                </button>
              )}

              {hasVault && unlocked && (
                <button
                  className="text-[10px] border px-3 py-2 rounded bg-gray-900 border-gray-700 text-gray-200 hover:border-gray-500"
                  onClick={onLockVault}
                >
                  LOCK VAULT
                </button>
              )}

              {hasVault && (
                <button
                  className="text-[10px] border px-3 py-2 rounded bg-gray-900 border-gray-800 text-gray-400 hover:border-terminal-accent hover:text-terminal-accent"
                  onClick={onDeleteVault}
                >
                  DELETE VAULT
                </button>
              )}
            </div>
          </div>

          {error && (
            <div className="mt-3 text-xs text-terminal-accent border border-terminal-accent/40 rounded bg-terminal-accent/10 p-2">
              {error}
            </div>
          )}

          <div className="mt-4 text-[10px] text-gray-500 leading-relaxed">
            Passkeys unlock a local encrypted vault (stored in IndexedDB). The vault stores:
            <ul className="list-disc ml-5 mt-2 space-y-1 text-gray-500">
              <li>Casino betting key (ed25519) for onchain transactions</li>
              <li>Chat key material (placeholder until XMTP integration)</li>
            </ul>
            <div className="mt-2">
              After unlocking, reload the app to ensure all pages pick up the vault-held keys.
              <button
                className="ml-2 text-[10px] border px-2 py-1 rounded bg-gray-900 border-gray-800 text-gray-300 hover:border-gray-600"
                onClick={() => window.location.reload()}
              >
                RELOAD
              </button>
            </div>
          </div>
        </div>

        <div className="border border-gray-800 rounded bg-gray-900/30 p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-[10px] text-gray-500 tracking-widest">POC</div>
              <div className="text-sm font-bold mt-1">Vault Bot Bets</div>
              <div className="text-xs text-gray-400 mt-1">Uses the vault-held betting key to submit randomized casino games.</div>
            </div>
            <div className="flex items-center gap-2">
              {!botRunning ? (
                <button
                  className={`text-[10px] border px-3 py-2 rounded ${
                    unlocked
                      ? 'bg-terminal-green/20 border-terminal-green text-terminal-green hover:bg-terminal-green/30'
                      : 'bg-gray-900 border-gray-800 text-gray-500 cursor-not-allowed'
                  }`}
                  onClick={startBot}
                  disabled={!unlocked}
                >
                  START BOT
                </button>
              ) : (
                <button
                  className="text-[10px] border px-3 py-2 rounded bg-gray-900 border-gray-700 text-gray-200 hover:border-gray-500"
                  onClick={stopBot}
                >
                  STOP BOT
                </button>
              )}
            </div>
          </div>

          <div className="mt-3">
            <div className="text-[10px] text-gray-500 tracking-widest mb-2">LOGS</div>
            <div className="border border-gray-800 rounded bg-terminal-black/60 p-2 h-40 overflow-y-auto text-xs text-gray-300">
              {botLogs.length === 0 ? (
                <div className="text-gray-600">No bot activity yet.</div>
              ) : (
                botLogs.map((l, idx) => (
                  <div key={idx} className="whitespace-pre-wrap break-words">
                    {l}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
