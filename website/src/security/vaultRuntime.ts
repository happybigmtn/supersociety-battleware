export type UnlockedVault = {
  vaultId: string;
  credentialId: string;
  unlockedAtMs: number;
  nullspaceEd25519PrivateKey: Uint8Array;
  chatEvmPrivateKey: Uint8Array;
  nullspacePublicKeyHex: string;
};

type Listener = (vault: UnlockedVault | null) => void;

let unlockedVault: UnlockedVault | null = null;
const listeners = new Set<Listener>();

function notify() {
  for (const listener of listeners) {
    try {
      listener(unlockedVault);
    } catch {
      // ignore listener errors
    }
  }
}

export function getUnlockedVault(): UnlockedVault | null {
  return unlockedVault;
}

export function setUnlockedVault(vault: UnlockedVault) {
  unlockedVault = vault;
  notify();
}

export function clearUnlockedVault() {
  unlockedVault = null;
  notify();
}

export function subscribeVault(listener: Listener): () => void {
  listeners.add(listener);
  // Initial emit
  try {
    listener(unlockedVault);
  } catch {
    // ignore
  }
  return () => listeners.delete(listener);
}

