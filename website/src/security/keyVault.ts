import { WasmWrapper } from '../api/wasm.js';
import { base64UrlToBytes, bytesToBase64Url } from './base64url';
import { clearUnlockedVault, getUnlockedVault, setUnlockedVault, type UnlockedVault } from './vaultRuntime';

type VaultId = 'default';

type VaultRecordV1 = {
  id: VaultId;
  version: 1;
  credentialId: string; // base64url
  prfSalt: string; // base64url (32 bytes)
  cipher: {
    iv: string; // base64url (12 bytes)
    ciphertext: string; // base64url
  };
  nullspacePublicKeyHex: string;
  createdAtMs: number;
  updatedAtMs: number;
};

type VaultSecretsV1 = {
  version: 1;
  nullspaceEd25519PrivateKey: string; // base64url (32 bytes)
  chatEvmPrivateKey: string; // base64url (32 bytes)
};

const DB_NAME = 'nullspace';
const DB_VERSION = 1;
const STORE_NAME = 'vaults';

const LS_VAULT_ENABLED = 'nullspace_vault_enabled';
const LS_VAULT_ID = 'nullspace_vault_id';
const LS_VAULT_CREDENTIAL_ID = 'nullspace_vault_credential_id';
const LS_CASINO_PUBLIC_KEY_HEX = 'casino_public_key_hex';

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

export function isPasskeyVaultSupported(): boolean {
  if (!isBrowser()) return false;
  if (typeof crypto === 'undefined' || !crypto.subtle || !crypto.getRandomValues) return false;
  if (typeof indexedDB === 'undefined') return false;
  // Basic WebAuthn availability check
  return typeof window.PublicKeyCredential !== 'undefined' && !!navigator?.credentials;
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

function hexToBytes(hex: string): Uint8Array | null {
  const normalized = hex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length % 2 !== 0) return null;
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function coerceToBytes(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
  });
}

async function idbGetVault(id: VaultId): Promise<VaultRecordV1 | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);
    req.onsuccess = () => resolve((req.result as VaultRecordV1) ?? null);
    req.onerror = () => reject(req.error ?? new Error('Failed to read vault'));
  });
}

async function idbPutVault(record: VaultRecordV1): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('Failed to write vault'));
  });
}

export async function deleteVault(): Promise<void> {
  if (!isPasskeyVaultSupported()) throw new Error('passkey-vault-unsupported');
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete('default');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('Failed to delete vault'));
  });
  clearUnlockedVault();
  localStorage.removeItem(LS_VAULT_ENABLED);
  localStorage.removeItem(LS_VAULT_ID);
  localStorage.removeItem(LS_VAULT_CREDENTIAL_ID);
  localStorage.removeItem(LS_CASINO_PUBLIC_KEY_HEX);
}

export async function getVaultRecord(): Promise<VaultRecordV1 | null> {
  if (!isPasskeyVaultSupported()) return null;
  return idbGetVault('default');
}

export function isVaultEnabled(): boolean {
  if (!isBrowser()) return false;
  return localStorage.getItem(LS_VAULT_ENABLED) === 'true';
}

export function getVaultPublicKeyHex(): string | null {
  if (!isBrowser()) return null;
  return localStorage.getItem(LS_CASINO_PUBLIC_KEY_HEX);
}

function normalizeRpId(hostname: string): string {
  // Use the current hostname as rpId. (For custom domains, this should be reviewed.)
  return hostname;
}

async function createPasskeyCredential(): Promise<{ credentialId: string }> {
  if (!isPasskeyVaultSupported()) throw new Error('passkey-vault-unsupported');

  const rpId = normalizeRpId(window.location.hostname);
  const challenge = randomBytes(32);
  const userId = randomBytes(32);

  const publicKey: any = {
    rp: { name: 'null/space', id: rpId },
    user: { id: userId, name: 'nullspace', displayName: 'nullspace' },
    challenge,
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256 (P-256)
    timeout: 60_000,
    attestation: 'none',
    authenticatorSelection: {
      userVerification: 'required',
      residentKey: 'required',
    },
    extensions: {
      // Request PRF support where available.
      prf: {},
      // Best-effort fallback for older implementations.
      hmacCreateSecret: true,
      // Optional fallback for platforms that support storing small blobs on the authenticator.
      largeBlob: { support: 'preferred' },
    },
  };

  const cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error('passkey-create-failed');

  const credentialId = bytesToBase64Url(new Uint8Array(cred.rawId));
  return { credentialId };
}

async function getPrfOutput(
  credentialId: string,
  prfSalt: Uint8Array,
  options?: { largeBlobRead?: boolean; largeBlobWrite?: Uint8Array },
): Promise<Uint8Array> {
  if (!isPasskeyVaultSupported()) throw new Error('passkey-vault-unsupported');

  const challenge = randomBytes(32);
  const allowCredentials: any[] = [{ type: 'public-key', id: base64UrlToBytes(credentialId) }];

  const largeBlobRead = options?.largeBlobRead === true;
  const largeBlobWrite = options?.largeBlobWrite;

  const publicKey: any = {
    challenge,
    allowCredentials,
    timeout: 60_000,
    userVerification: 'required',
    extensions: {
      prf: {
        eval: {
          first: prfSalt,
        },
      },
      // Best-effort fallback for older implementations.
      hmacGetSecret: {
        salt1: prfSalt,
      },
      ...(largeBlobRead ? { largeBlob: { read: true } } : {}),
      ...(largeBlobWrite ? { largeBlob: { write: largeBlobWrite } } : {}),
    },
  };

  const assertion = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!assertion) throw new Error('passkey-get-failed');

  const ext: any = (assertion as any).getClientExtensionResults?.() ?? {};

  const prfFirst = coerceToBytes(ext?.prf?.results?.first);
  if (prfFirst) return prfFirst;

  const hmac1 = coerceToBytes(ext?.hmacGetSecret?.output1);
  if (hmac1) return hmac1;

  if (largeBlobRead) {
    const blob = coerceToBytes(ext?.largeBlob?.blob);
    if (blob) return blob;
  }

  if (largeBlobWrite) {
    if (ext?.largeBlob?.written === true) return largeBlobWrite;
  }

  throw new Error('passkey-prf-unsupported');
}

async function deriveAesKeyFromPrf(prfOutput: Uint8Array, prfSalt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  const info = new TextEncoder().encode('nullspace-vault-v1');
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: prfSalt, info },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptVaultSecrets(aesKey: CryptoKey, vaultId: VaultId, secrets: VaultSecretsV1): Promise<VaultRecordV1['cipher']> {
  const iv = randomBytes(12);
  const aad = new TextEncoder().encode(`nullspace:${vaultId}:v1`);
  const plaintext = new TextEncoder().encode(JSON.stringify(secrets));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, aesKey, plaintext);
  return {
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
}

async function decryptVaultSecrets(aesKey: CryptoKey, vault: VaultRecordV1): Promise<VaultSecretsV1> {
  const iv = base64UrlToBytes(vault.cipher.iv);
  const aad = new TextEncoder().encode(`nullspace:${vault.id}:v1`);
  const ciphertext = base64UrlToBytes(vault.cipher.ciphertext);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, aesKey, ciphertext);
  const decoded = JSON.parse(new TextDecoder().decode(new Uint8Array(plaintext))) as VaultSecretsV1;
  if (decoded?.version !== 1) throw new Error('vault-version-unsupported');
  return decoded;
}

function migrateRegistrationFlag(oldPrivateKeyHex: string, publicKeyHex: string) {
  const oldKey = `casino_registered_${oldPrivateKeyHex}`;
  const newKey = `casino_registered_${publicKeyHex}`;
  const oldVal = localStorage.getItem(oldKey);
  if (oldVal === 'true') {
    localStorage.setItem(newKey, 'true');
  }
  localStorage.removeItem(oldKey);
}

function clearPendingNonceAndTxs() {
  // Reset nonce
  localStorage.setItem('casino_nonce', '0');
  // Remove any stored tx records
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('casino_tx_')) keysToRemove.push(key);
  }
  for (const k of keysToRemove) localStorage.removeItem(k);
}

export async function createPasskeyVault(options?: { migrateExistingCasinoKey?: boolean }): Promise<VaultRecordV1> {
  if (!isPasskeyVaultSupported()) throw new Error('passkey-vault-unsupported');
  const vaultId: VaultId = 'default';

  const { credentialId } = await createPasskeyCredential();
  const prfSalt = randomBytes(32);
  let prfOutput: Uint8Array;
  try {
    prfOutput = await getPrfOutput(credentialId, prfSalt);
  } catch (e: any) {
    if ((e?.message ?? String(e)) !== 'passkey-prf-unsupported') throw e;
    const largeBlobSeed = randomBytes(32);
    prfOutput = await getPrfOutput(credentialId, prfSalt, { largeBlobWrite: largeBlobSeed });
  }
  const aesKey = await deriveAesKeyFromPrf(prfOutput, prfSalt);

  // Determine nullspace betting key (ed25519)
  const shouldMigrate = options?.migrateExistingCasinoKey !== false;
  const existingPrivateKeyHex = localStorage.getItem('casino_private_key');
  const canMigrate = shouldMigrate && typeof existingPrivateKeyHex === 'string' && existingPrivateKeyHex.length === 64;

  const wasm = new WasmWrapper(undefined);
  await wasm.init();

  let bettingPrivateKeyBytes: Uint8Array;
  let migrated = false;

  if (canMigrate) {
    const bytes = hexToBytes(existingPrivateKeyHex);
    if (!bytes || bytes.length !== 32) throw new Error('invalid-casino-private-key');
    wasm.createKeypair(bytes);
    bettingPrivateKeyBytes = bytes;
    migrated = true;
  } else {
    wasm.createKeypair();
    const pkHex = wasm.getPrivateKeyHex();
    const bytes = hexToBytes(pkHex);
    if (!bytes || bytes.length !== 32) throw new Error('failed-to-generate-ed25519');
    bettingPrivateKeyBytes = bytes;
  }

  const nullspacePublicKeyHex = wasm.getPublicKeyHex();

  // Generate chat key material (32 bytes). XMTP integration will define exact signer type later.
  const chatEvmPrivateKey = randomBytes(32);

  const secrets: VaultSecretsV1 = {
    version: 1,
    nullspaceEd25519PrivateKey: bytesToBase64Url(bettingPrivateKeyBytes),
    chatEvmPrivateKey: bytesToBase64Url(chatEvmPrivateKey),
  };

  const cipher = await encryptVaultSecrets(aesKey, vaultId, secrets);
  const now = Date.now();

  const record: VaultRecordV1 = {
    id: vaultId,
    version: 1,
    credentialId,
    prfSalt: bytesToBase64Url(prfSalt),
    cipher,
    nullspacePublicKeyHex,
    createdAtMs: now,
    updatedAtMs: now,
  };

  await idbPutVault(record);

  // Mark vault enabled and store non-secret metadata in localStorage for sync access.
  localStorage.setItem(LS_VAULT_ENABLED, 'true');
  localStorage.setItem(LS_VAULT_ID, vaultId);
  localStorage.setItem(LS_VAULT_CREDENTIAL_ID, credentialId);
  localStorage.setItem(LS_CASINO_PUBLIC_KEY_HEX, nullspacePublicKeyHex);

  if (migrated && existingPrivateKeyHex) {
    migrateRegistrationFlag(existingPrivateKeyHex, nullspacePublicKeyHex);
    // Remove the raw secret from localStorage after successful migration.
    localStorage.removeItem('casino_private_key');
  } else {
    // New identity → clear local nonce/tx cache to avoid nonce mismatches.
    clearPendingNonceAndTxs();
  }

  // Set in-memory unlocked state immediately (we already have the prfOutput and secrets).
  const unlocked: UnlockedVault = {
    vaultId,
    credentialId,
    unlockedAtMs: now,
    nullspaceEd25519PrivateKey: bettingPrivateKeyBytes,
    chatEvmPrivateKey,
    nullspacePublicKeyHex,
  };
  setUnlockedVault(unlocked);

  return record;
}

export async function unlockPasskeyVault(): Promise<UnlockedVault> {
  if (!isPasskeyVaultSupported()) throw new Error('passkey-vault-unsupported');

  const existing = getUnlockedVault();
  if (existing) return existing;

  const record = await idbGetVault('default');
  if (!record) throw new Error('vault-not-found');

  const prfSalt = base64UrlToBytes(record.prfSalt);
  const prfOutput = await getPrfOutput(record.credentialId, prfSalt, { largeBlobRead: true });
  const aesKey = await deriveAesKeyFromPrf(prfOutput, prfSalt);
  const secrets = await decryptVaultSecrets(aesKey, record);

  const now = Date.now();
  const unlocked: UnlockedVault = {
    vaultId: record.id,
    credentialId: record.credentialId,
    unlockedAtMs: now,
    nullspaceEd25519PrivateKey: base64UrlToBytes(secrets.nullspaceEd25519PrivateKey),
    chatEvmPrivateKey: base64UrlToBytes(secrets.chatEvmPrivateKey),
    nullspacePublicKeyHex: record.nullspacePublicKeyHex,
  };

  // Persist non-secret metadata for app flows.
  localStorage.setItem(LS_VAULT_ENABLED, 'true');
  localStorage.setItem(LS_VAULT_ID, record.id);
  localStorage.setItem(LS_VAULT_CREDENTIAL_ID, record.credentialId);
  localStorage.setItem(LS_CASINO_PUBLIC_KEY_HEX, record.nullspacePublicKeyHex);

  setUnlockedVault(unlocked);
  return unlocked;
}

export function lockPasskeyVault() {
  clearUnlockedVault();
}

export function getVaultStatusSync(): {
  supported: boolean;
  enabled: boolean;
  unlocked: boolean;
  nullspacePublicKeyHex: string | null;
} {
  const supported = isPasskeyVaultSupported();
  const enabled = supported && isVaultEnabled();
  const unlocked = !!getUnlockedVault();
  const nullspacePublicKeyHex = getVaultPublicKeyHex();
  return { supported, enabled, unlocked, nullspacePublicKeyHex };
}
