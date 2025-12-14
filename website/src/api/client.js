import { WasmWrapper } from './wasm.js';
import { NonceManager } from './nonceManager.js';
import { snakeToCamel } from '../utils/caseNormalizer.js';
import { getUnlockedVault } from '../security/vaultRuntime';

// Delay between fetch retries
const FETCH_RETRY_DELAY_MS = 1000;

/**
 * Client for communicating with the Casino chain.
 * Handles WebSocket connections, transaction submission, and state queries.
 */
export class CasinoClient {
  constructor(baseUrl = '/api', wasm) {
    if (!wasm) {
      throw new Error('WasmWrapper is required for CasinoClient');
    }
    this.baseUrl = baseUrl;
    this.wasm = wasm;
    this.updatesWs = null;
    this.eventHandlers = new Map();
    this.nonceManager = new NonceManager(this, wasm);
    this.masterPublic = wasm.identityBytes;
    this.latestSeed = null;

    // Reconnection configuration
    this.reconnectConfig = {
      attempts: 0,
      baseDelay: 1000,
      maxDelay: 30000, // Cap at 30 seconds
      reconnecting: false,
      timer: null
    };
  }

  async init() {
    await this.wasm.init();
    // Set master public key after wasm is initialized
    this.masterPublic = this.wasm.identityBytes;
    return this;
  }

  /**
   * Initialize the nonce manager with a keypair.
   * @param {string} publicKeyHex - Hex-encoded public key
   * @param {Uint8Array} publicKeyBytes - Raw public key bytes
   * @param {Object|null} account - Account data (null if account doesn't exist)
   */
  async initNonceManager(publicKeyHex, publicKeyBytes, account) {
    await this.nonceManager.init(publicKeyHex, publicKeyBytes, account);
  }

  /**
   * Clean up the nonce manager and WebSocket connections.
   */
  destroy() {
    this.nonceManager.destroy();

    // Stop any pending reconnection attempts
    this.reconnectConfig.reconnecting = false;
    this.reconnectConfig.attempts = 0;

    // Clear any pending reconnection timers
    if (this.reconnectConfig.timer) {
      clearTimeout(this.reconnectConfig.timer);
      this.reconnectConfig.timer = null;
    }

    // Close WebSocket connections without triggering reconnect
    if (this.updatesWs) {
      // Remove the close handler to prevent reconnection
      this.updatesWs.onclose = null;
      this.updatesWs.close();
      this.updatesWs = null;
    }

    // Clear event handlers to prevent memory leaks
    this.eventHandlers.clear();
  }

  /**
   * Connect to a different updates stream.
   * @param {Uint8Array|null} publicKey - Public key bytes for account filter, or null for all events
   * @returns {Promise<void>}
   */
  async switchUpdates(publicKey = null) {
    // Stop any pending reconnection attempts
    this.reconnectConfig.reconnecting = false;
    this.reconnectConfig.attempts = 0;
    if (this.reconnectConfig.timer) {
      clearTimeout(this.reconnectConfig.timer);
      this.reconnectConfig.timer = null;
    }

    // Close existing connection if any
    if (this.updatesWs) {
      // Remove the close handler to prevent reconnection
      this.updatesWs.onclose = null;
      this.updatesWs.close();
      this.updatesWs = null;
    }

    // Connect with new filter
    await this.connectUpdates(publicKey);
  }


  /**
   * Submit a transaction to the simulator.
   * @param {Uint8Array} transaction - Raw transaction bytes
   * @returns {Promise<{status: string}>} Transaction result
   * @throws {Error} If submission fails
   */
  async submitTransaction(transaction) {
    // Wrap transaction in Submission enum
    const submission = this.wasm.wrapTransactionSubmission(transaction);

    const response = await fetch(`${this.baseUrl}/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream'
      },
      body: submission
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Server error response:', errorText);
      throw new Error(`Server error: ${response.status} ${response.statusText}`);
    }

    // The simulator returns 200 OK with no body for successful submissions
    // Transaction results come through the events WebSocket
    return { status: 'accepted' };
  }

  /**
   * Get the current view number from the latest seed we've seen.
   * @returns {number|null} Current view number or null if no seed seen yet
   */
  getCurrentView() {
    return this.latestSeed ? this.latestSeed.view : null;
  }

  /**
   * Wait for the first seed to arrive.
   * First tries to fetch existing seed via REST API, then falls back to WebSocket.
   * @returns {Promise<void>} Resolves when first seed is received
   */
  async waitForFirstSeed() {
    if (this.latestSeed) {
      return;
    }

    // First, try to fetch an existing seed via REST API
    console.log('Checking for existing seed via REST API...');
    const result = await this.queryLatestSeed();
    if (result.found) {
      console.log('Found existing seed via REST API, view:', result.seed.view);
      this.latestSeed = result.seed;
      return;
    }

    console.log('No existing seed found, waiting for WebSocket event...');
    // Fall back to waiting for WebSocket event
    return new Promise((resolve) => {
      // Set up a one-time handler for the first seed
      const unsubscribe = this.onEvent('Seed', () => {
        unsubscribe();
        resolve();
      });
    });
  }


  /**
   * Query state by key.
   * @param {Uint8Array} keyBytes - State key bytes
   * @returns {Promise<{found: boolean, value: any}>} Query result
   */
  async queryState(keyBytes) {
    // Hash the key before querying (matching upstream changes)
    const hashedKey = this.wasm.hashKey(keyBytes);
    const hexKey = this.wasm.bytesToHex(hashedKey);

    let response;
    while (true) {
      response = await fetch(`${this.baseUrl}/state/${hexKey}`);

      if (response.status === 404) {
        return { found: false, value: null };
      }

      if (response.status === 200) {
        break;
      }

      // Retry on any other status
      console.log(`State query returned ${response.status}, retrying...`);
      await new Promise(resolve => setTimeout(resolve, FETCH_RETRY_DELAY_MS));
    }

    // Get binary response
    const buffer = await response.arrayBuffer();
    const valueBytes = new Uint8Array(buffer);

    if (valueBytes.length === 0) {
      return { found: false, value: null };
    }

    try {
      // Decode value using WASM - returns plain JSON object
      const value = this.wasm.decodeLookup(valueBytes);
      // Normalize snake_case to camelCase
      const normalized = snakeToCamel(value);
      return { found: true, value: normalized };
    } catch (error) {
      console.error('Failed to decode value:', error);
      return { found: false, value: null };
    }
  }

  /**
   * Query seed by view number.
   * @param {number} view - View number to query
   * @returns {Promise<{found: boolean, seed?: any, seedBytes?: Uint8Array}>} Query result
   */
  async querySeed(view) {
    // Encode the query for specific view index
    const queryBytes = this.wasm.encodeQuery('index', view);
    const hexQuery = this.wasm.bytesToHex(queryBytes);

    let response;
    while (true) {
      response = await fetch(`${this.baseUrl}/seed/${hexQuery}`);

      if (response.status === 404) {
        return { found: false };
      }

      if (response.status === 200) {
        break;
      }

      // Retry on any other status
      console.log(`Seed query returned ${response.status}, retrying...`);
      await new Promise(resolve => setTimeout(resolve, FETCH_RETRY_DELAY_MS));
    }

    const seedBytes = await response.arrayBuffer();
    const seedBytesArray = new Uint8Array(seedBytes);
    const seed = this.wasm.decodeSeed(seedBytesArray);
    return { found: true, seed, seedBytes: seedBytesArray };
  }

  /**
   * Query the latest seed via REST API.
   * @returns {Promise<{found: boolean, seed?: any, seedBytes?: Uint8Array}>} Query result
   */
  async queryLatestSeed() {
    // Encode the query for latest seed
    const queryBytes = this.wasm.encodeQuery('latest');
    const hexQuery = this.wasm.bytesToHex(queryBytes);

    const response = await fetch(`${this.baseUrl}/seed/${hexQuery}`);

    if (response.status === 404) {
      return { found: false };
    }

    if (response.status !== 200) {
      console.log(`Latest seed query returned ${response.status}`);
      return { found: false };
    }

    const seedBytes = await response.arrayBuffer();
    const seedBytesArray = new Uint8Array(seedBytes);
    try {
      const seed = this.wasm.decodeSeed(seedBytesArray);
      return { found: true, seed, seedBytes: seedBytesArray };
    } catch (error) {
      console.error('Failed to decode latest seed:', error);
      return { found: false };
    }
  }

  /**
   * Connect to the updates WebSocket stream with exponential backoff.
   * @param {Uint8Array|null} publicKey - Public key bytes for account filter, or null for all events
   * @returns {Promise<void>}
   * @private
   */
  connectUpdates(publicKey = null) {
    return new Promise((resolve, reject) => {
      // Store the publicKey for reconnection
      this.currentUpdateFilter = publicKey;

      // Encode the filter based on whether we have a public key
      let filterBytes;
      if (publicKey === null) {
        // Connect to all events (firehose)
        filterBytes = this.wasm.encodeUpdatesFilterAll();
      } else {
        // Connect to account-specific events
        filterBytes = this.wasm.encodeUpdatesFilterAccount(publicKey);
      }
      const filterHex = this.wasm.bytesToHex(filterBytes);

      // Compute multiple candidate URLs:
      // - Prefer same-origin proxy (`/api`) so localhost setups and port-forwards work reliably.
      // - Fall back to VITE_URL direct connection if proxy isn't available.
      const candidates = [];

      if (typeof window !== 'undefined' && this.baseUrl && !this.baseUrl.startsWith('http://') && !this.baseUrl.startsWith('https://')) {
        const proxyWsUrl = window.location.protocol === 'https:'
          ? `wss://${window.location.host}${this.baseUrl}/updates/${filterHex}`
          : `ws://${window.location.host}${this.baseUrl}/updates/${filterHex}`;
        candidates.push(proxyWsUrl);
      }

      // Try to use VITE_URL directly for WebSocket (useful when no proxy is configured).
      const directUrl = import.meta.env.VITE_URL;
      if (directUrl) {
        try {
          const url = new URL(directUrl);
          const directWsUrl = url.protocol === 'https:'
            ? `wss://${url.host}/updates/${filterHex}`
            : `ws://${url.host}/updates/${filterHex}`;
          if (!candidates.includes(directWsUrl)) candidates.push(directWsUrl);
        } catch (e) {
          console.warn('Invalid VITE_URL for WebSocket:', directUrl, e);
        }
      } else if (this.baseUrl.startsWith('http://') || this.baseUrl.startsWith('https://')) {
        // Full URL provided, convert to WebSocket URL
        const url = new URL(this.baseUrl);
        const wsUrl = url.protocol === 'https:'
          ? `wss://${url.host}/updates/${filterHex}`
          : `ws://${url.host}/updates/${filterHex}`;
        if (!candidates.includes(wsUrl)) candidates.push(wsUrl);
      }

      if (candidates.length === 0) {
        reject(new Error('No WebSocket URL candidates available'));
        return;
      }

      const connectAt = (index) => {
        const wsUrl = candidates[index];
        console.log('Connecting to Updates WebSocket at:', wsUrl, 'with filter:', publicKey ? 'account' : 'all');
        const ws = new WebSocket(wsUrl);
        this.updatesWs = ws;

        ws.onopen = () => {
          console.log('Updates WebSocket connected successfully');
          resolve();
        };

        ws.onerror = (error) => {
          console.error('Updates WebSocket error:', error);
          console.error('WebSocket URL was:', wsUrl);
          console.error('WebSocket readyState:', ws.readyState);

          try {
            ws.onclose = null;
            ws.close();
          } catch {
            // ignore
          }

          // Fall back to next candidate if available.
          if (index + 1 < candidates.length) {
            console.warn('Falling back to next WebSocket candidate...');
            connectAt(index + 1);
            return;
          }

          reject(new Error(`WebSocket connection failed to ${wsUrl}`));
        };

      this.updatesWs.onmessage = async (event) => {
        console.log('[WebSocket] Received message, data type:', typeof event.data, event.data instanceof Blob ? 'Blob' : 'not Blob');
        try {
          let bytes;
          if (event.data instanceof Blob) {
            // Browser environment - convert blob to array buffer
            const arrayBuffer = await event.data.arrayBuffer();
            bytes = new Uint8Array(arrayBuffer);
          } else if (event.data instanceof ArrayBuffer) {
            // ArrayBuffer - convert directly
            bytes = new Uint8Array(event.data);
          } else if (Buffer.isBuffer(event.data)) {
            // Node.js environment - Buffer is already a Uint8Array
            bytes = new Uint8Array(event.data);
          } else {
            console.warn('Unknown WebSocket message type:', typeof event.data);
            return;
          }

          // Now we have binary data in bytes, decode it
          try {
            const decodedUpdate = this.wasm.decodeUpdate(bytes);
            console.log('[WebSocket] Decoded update type:', decodedUpdate.type, decodedUpdate.type === 'Events' ? `(${decodedUpdate.events?.length} events)` : '');

            // Check if it's a Seed or Events/FilteredEvents update
            if (decodedUpdate.type === 'Seed') {
              this.latestSeed = decodedUpdate;
              this.handleEvent(decodedUpdate);
            } else if (decodedUpdate.type === 'Events') {
              // Process each event from the array - treat FilteredEvents the same as Events
              for (const eventData of decodedUpdate.events) {
                console.log('[WebSocket] Event type:', eventData.type, 'data:', eventData);
                // Normalize snake_case to camelCase
                const normalizedEvent = snakeToCamel(eventData);
                // Check if this is a transaction from our account
                if (normalizedEvent.type === 'Transaction') {
                  if (this.nonceManager.publicKeyHex &&
                    normalizedEvent.public.toLowerCase() === this.nonceManager.publicKeyHex.toLowerCase()) {
                    this.nonceManager.updateNonceFromTransaction(normalizedEvent.nonce);
                  }
                }
                this.handleEvent(normalizedEvent);
              }
            }
          } catch (decodeError) {
            console.error('Failed to decode update:', decodeError);
            console.log('Full raw bytes:', this.wasm.bytesToHex(bytes).match(/.{2}/g).join(' '));
          }
        } catch (e) {
          console.error('Failed to process WebSocket message:', e);
        }
      };

      this.updatesWs.onclose = (event) => {
        console.log('Updates WebSocket disconnected, code:', event.code, 'reason:', event.reason);
        this.handleReconnect('updatesWs', () => this.connectUpdates(this.currentUpdateFilter));
      };
      };

      connectAt(0);
    });
  }


  /**
   * Subscribe to events of a specific type.
   * @param {string} eventType - Event type to subscribe to ('*' for all events)
   * @param {Function} handler - Event handler function
   * @returns {Function} Unsubscribe function
   */
  onEvent(eventType, handler) {
    if (!this.eventHandlers.has(eventType)) {
      this.eventHandlers.set(eventType, []);
    }
    this.eventHandlers.get(eventType).push(handler);

    // Return unsubscribe function to prevent memory leaks
    return () => {
      const handlers = this.eventHandlers.get(eventType);
      if (handlers) {
        const index = handlers.indexOf(handler);
        if (index !== -1) {
          handlers.splice(index, 1);
        }
        // Clean up empty handler arrays
        if (handlers.length === 0) {
          this.eventHandlers.delete(eventType);
        }
      }
    };
  }

  /**
   * Handle incoming events from WebSocket.
   * @param {Object} event - Event data object
   * @private
   */
  handleEvent(event) {
    const handlers = this.eventHandlers.get(event.type) || [];
    handlers.forEach(handler => handler(event));

    // Also call generic handlers
    const allHandlers = this.eventHandlers.get('*') || [];
    allHandlers.forEach(handler => handler(event));
  }

  /**
   * Handle WebSocket reconnection with exponential backoff.
   * @param {string} wsType - Type of WebSocket ('updatesWs')
   * @param {Function} connectFn - Function to call for reconnection
   * @private
   */
  handleReconnect(wsType, connectFn) {
    const config = this.reconnectConfig;

    if (config.reconnecting) {
      return;
    }

    config.reconnecting = true;
    config.attempts++;

    // Calculate delay with exponential backoff and jitter
    const baseDelay = Math.min(config.baseDelay * Math.pow(2, config.attempts - 1), config.maxDelay);
    const jitter = Math.random() * 0.3 * baseDelay; // 30% jitter
    const delay = baseDelay + jitter;

    console.log(`Reconnecting ${wsType} in ${Math.round(delay)}ms (attempt ${config.attempts})`);

    config.timer = setTimeout(async () => {
      // Check if we've been destroyed while waiting
      if (config.attempts === 0) {
        // attempts is reset to 0 in destroy()
        return;
      }

      try {
        await connectFn();
        // Reset on successful connection
        config.attempts = 0;
        console.log(`Successfully reconnected ${wsType}`);
      } catch (error) {
        console.error(`Failed to reconnect ${wsType}:`, error.message);
        config.reconnecting = false;
        // Try again unless destroyed
        if (config.attempts > 0) {
          this.handleReconnect(wsType, connectFn);
        }
      } finally {
        config.reconnecting = false;
        config.timer = null;
      }
    }, delay);
  }

  /**
   * Get account information by public key.
   * @param {Uint8Array} publicKeyBytes - Account public key
   * @returns {Promise<Object|null>} Account data or null if not found
   */
  async getAccount(publicKeyBytes) {
    const keyBytes = this.wasm.encodeAccountKey(publicKeyBytes);
    const result = await this.queryState(keyBytes);

    if (result.found && result.value) {
      // Value is already a plain object from WASM
      if (result.value.type === 'Account') {
        return result.value;
      } else {
        console.log('Value is not an Account type:', result.value.type);
        return null;
      }
    }

    return null;
  }

  /**
   * Get casino player information by public key.
   * @param {Uint8Array} publicKeyBytes - Player public key
   * @returns {Promise<Object|null>} CasinoPlayer data or null if not found
   */
  async getCasinoPlayer(publicKeyBytes) {
    console.log('[Client] getCasinoPlayer called with publicKeyBytes:', publicKeyBytes?.length, 'bytes');
    const keyBytes = this.wasm.encodeCasinoPlayerKey(publicKeyBytes);
    console.log('[Client] Encoded player key:', keyBytes?.length, 'bytes');
    const result = await this.queryState(keyBytes);
    console.log('[Client] queryState result:', result);

    if (result.found && result.value) {
      // Value is already a plain object from WASM
      if (result.value.type === 'CasinoPlayer') {
        // Normalize snake_case to camelCase for frontend consistency
        const normalized = snakeToCamel(result.value);
        console.log('[Client] Found CasinoPlayer:', normalized);
        return normalized;
      } else {
        console.log('[Client] Value is not a CasinoPlayer type:', result.value.type);
        return null;
      }
    }

    console.log('[Client] Player not found on-chain');
    return null;
  }

  /**
   * Get casino session information by session ID.
   * @param {bigint|number} sessionId - Session ID
   * @returns {Promise<Object|null>} CasinoSession data or null if not found
   */
  async getCasinoSession(sessionId) {
    const keyBytes = this.wasm.encodeCasinoSessionKey(sessionId);
    const result = await this.queryState(keyBytes);

    if (result.found && result.value) {
      if (result.value.type === 'CasinoSession') {
        return result.value;
      } else {
        console.log('Value is not a CasinoSession type:', result.value.type);
        return null;
      }
    }

    return null;
  }

  /**
   * Get casino leaderboard.
   * @returns {Promise<Object|null>} CasinoLeaderboard data or null if not found
   */
  async getCasinoLeaderboard() {
    const keyBytes = this.wasm.encodeCasinoLeaderboardKey();
    const result = await this.queryState(keyBytes);

    if (result.found && result.value) {
      if (result.value.type === 'CasinoLeaderboard') {
        return result.value;
      } else {
        console.log('Value is not a CasinoLeaderboard type:', result.value.type);
        return null;
      }
    }

    return null;
  }

  /**
   * Get casino tournament information by tournament ID.
   * @param {bigint|number} tournamentId - Tournament ID
   * @returns {Promise<Object|null>} Tournament data or null if not found
   */
  async getCasinoTournament(tournamentId) {
    const keyBytes = this.wasm.encodeCasinoTournamentKey(tournamentId);
    const result = await this.queryState(keyBytes);

    if (result.found && result.value) {
      if (result.value.type === 'Tournament') {
        // Normalize snake_case to camelCase for frontend consistency
        return snakeToCamel(result.value);
      } else {
        console.log('Value is not a Tournament type:', result.value.type);
        return null;
      }
    }

    return null;
  }

  /**
   * Get vault state for an account.
   * @param {Uint8Array} publicKeyBytes - Account public key
   * @returns {Promise<Object|null>} Vault data or null if not found
   */
  async getVault(publicKeyBytes) {
    const keyBytes = this.wasm.encodeVaultKey(publicKeyBytes);
    const result = await this.queryState(keyBytes);

    if (result.found && result.value) {
      if (result.value.type === 'Vault') {
        return snakeToCamel(result.value);
      }
      return null;
    }

    return null;
  }

  /**
   * Get AMM pool state.
   * @returns {Promise<Object|null>} AmmPool data or null if not found
   */
  async getAmmPool() {
    const keyBytes = this.wasm.encodeAmmPoolKey();
    const result = await this.queryState(keyBytes);

    if (result.found && result.value) {
      if (result.value.type === 'AmmPool') {
        return snakeToCamel(result.value);
      }
      return null;
    }

    return null;
  }

  /**
   * Get LP balance for an account.
   * @param {Uint8Array} publicKeyBytes - Account public key
   * @returns {Promise<Object|null>} LpBalance data or null if not found
   */
  async getLpBalance(publicKeyBytes) {
    const keyBytes = this.wasm.encodeLpBalanceKey(publicKeyBytes);
    const result = await this.queryState(keyBytes);

    if (result.found && result.value) {
      if (result.value.type === 'LpBalance') {
        return snakeToCamel(result.value);
      }
      return null;
    }

    return null;
  }

  /**
   * Get house state.
   * @returns {Promise<Object|null>} House data or null if not found
   */
  async getHouse() {
    const keyBytes = this.wasm.encodeHouseKey();
    const result = await this.queryState(keyBytes);

    if (result.found && result.value) {
      if (result.value.type === 'House') {
        return snakeToCamel(result.value);
      }
      return null;
    }

    return null;
  }

  /**
   * Get staker state for an account.
   * @param {Uint8Array} publicKeyBytes - Account public key
   * @returns {Promise<Object|null>} Staker data or null if not found
   */
  async getStaker(publicKeyBytes) {
    const keyBytes = this.wasm.encodeStakerKey(publicKeyBytes);
    const result = await this.queryState(keyBytes);

    if (result.found && result.value) {
      if (result.value.type === 'Staker') {
        return snakeToCamel(result.value);
      }
      return null;
    }

    return null;
  }

  /**
   * Get existing keypair from localStorage or create a new one.
   * @returns {{publicKey: Uint8Array, publicKeyHex: string}} Keypair information
   * @warning Private keys are stored in localStorage which is not secure.
   *          In production, consider using more secure storage methods.
   */
  getOrCreateKeypair() {
    const vaultEnabled =
      typeof window !== 'undefined' && localStorage.getItem('nullspace_vault_enabled') === 'true';
    const unlockedVault = (() => {
      try {
        return getUnlockedVault();
      } catch {
        return null;
      }
    })();

    // If the user has enabled a passkey vault, require it to be unlocked for signing.
    if (vaultEnabled && !unlockedVault) {
      console.warn('[CasinoClient] Passkey vault enabled but locked. Unlock via /security.');
      return null;
    }

    if (unlockedVault?.nullspaceEd25519PrivateKey) {
      this.wasm.createKeypair(unlockedVault.nullspaceEd25519PrivateKey);
      console.log('Loaded keypair from passkey vault');
    } else {
      // Security warning for development (legacy mode)
      if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
        console.warn('WARNING: Private keys are stored in localStorage. This is not secure for production use.');
      }

      // Check if we have a stored private key in localStorage
      const storedPrivateKeyHex = localStorage.getItem('casino_private_key');

      if (storedPrivateKeyHex) {
        // Convert hex string back to bytes
        const privateKeyBytes = new Uint8Array(storedPrivateKeyHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
        this.wasm.createKeypair(privateKeyBytes);
        console.log('Loaded keypair from storage');
      } else {
        // Let WASM generate a new keypair using the browser's crypto API
        this.wasm.createKeypair();

        // Store the private key for persistence (Note: In production, consider more secure storage)
        const privateKeyHex = this.wasm.getPrivateKeyHex();
        localStorage.setItem('casino_private_key', privateKeyHex);
        console.log('Generated new keypair using browser crypto API and saved to localStorage');
      }
    }

    const keypair = {
      publicKey: this.wasm.getPublicKeyBytes(),
      publicKeyHex: this.wasm.getPublicKeyHex()
    };

    // Store non-secret identifier for the current keypair.
    try {
      localStorage.setItem('casino_public_key_hex', keypair.publicKeyHex);
    } catch {
      // ignore
    }

    console.log('Using keypair with public key:', keypair.publicKeyHex);

    return keypair;
  }

}
