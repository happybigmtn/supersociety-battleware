/**
 * Manages transaction nonces and pending transactions for a Casino account.
 * Handles automatic nonce synchronization, transaction resubmission, and cleanup.
 */
export class NonceManager {
  constructor(client, wasm) {
    this.client = client;
    this.wasm = wasm;
    this.publicKeyHex = null;
    this.publicKeyBytes = null;
    this.resubmitInterval = null;
    this.resubmitInProgress = false; // Prevent concurrent resubmissions
    this.transactionQueue = Promise.resolve(); // Queue for sequential transaction submission

    // Configuration constants
    this.TX_STORAGE_PREFIX = 'casino_tx_';
    this.RESUBMIT_INTERVAL_MS = 10000; // Try to resubmit transactions every 10 seconds
  }

  /**
   * Initialize the nonce manager for a specific account.
   * @param {string} publicKeyHex - Hex-encoded public key
   * @param {Uint8Array} publicKeyBytes - Raw public key bytes
   * @param {Object|null} account - Account data (null if account doesn't exist yet)
   */
  async init(publicKeyHex, publicKeyBytes, account) {
    if (!publicKeyHex || !publicKeyBytes) {
      throw new Error('Public key is required for initialization');
    }

    this.publicKeyHex = publicKeyHex;
    this.publicKeyBytes = publicKeyBytes;

    // Check if network identity has changed (indicates network reset)
    const currentIdentity = this.wasm.identityHex;
    const identityKey = 'casino_identity';
    const storedIdentity = localStorage.getItem(identityKey);

    if (storedIdentity && storedIdentity !== currentIdentity) {
      console.log('Network identity changed - resetting nonce and clearing pending transactions');
      console.log('Previous identity:', storedIdentity);
      console.log('Current identity:', currentIdentity);

      // Reset nonce and clear pending transactions
      this.resetNonce();
      this.cleanupAllTransactions();
    }

    // Store the current identity
    localStorage.setItem(identityKey, currentIdentity);

    // Log initial state
    const pendingTxs = this.getPendingTransactions();
    if (pendingTxs.length > 0) {
      console.log(`Found ${pendingTxs.length} pending transactions`);
    }

    // Do initial sync with provided account
    this.syncWithAccountState(account);

    // Start periodic resubmission only (no more polling for nonce)
    this.startPeriodicResubmission();
  }

  /**
   * Clean up intervals and resources.
   */
  destroy() {
    if (this.resubmitInterval) {
      clearInterval(this.resubmitInterval);
      this.resubmitInterval = null;
    }
    this.resubmitInProgress = false;
  }

  /**
   * Start periodic resubmission of pending transactions.
   * @private
   */
  startPeriodicResubmission() {
    // Periodic transaction resubmission only
    this.resubmitInterval = setInterval(async () => {
      if (this.resubmitInProgress) {
        return;
      }
      try {
        await this.resubmitPendingTransactions();
      } catch (error) {
        console.error('Periodic resubmit failed:', error.message);
      }
    }, this.RESUBMIT_INTERVAL_MS);
  }

  /**
   * Synchronize local nonce with server account state.
   * @param {Object|null} account - Account data (null if account doesn't exist)
   * @private
   */
  syncWithAccountState(account) {
    if (!this.publicKeyBytes) {
      console.warn('Cannot sync - no public key set');
      return;
    }

    if (!account) {
      // Account doesn't exist on chain - always ensure clean state
      const localNonce = this.getCurrentNonce();
      const pendingTxs = this.getPendingTransactions();

      if (localNonce > 0 || pendingTxs.length > 0) {
        console.log(`Account not found on chain - resetting state (localNonce=${localNonce}, pendingTxs=${pendingTxs.length})`);
        this.resetNonce();
        this.cleanupAllTransactions();
      }
      return;
    }

    const serverNonce = account.nonce;
    const localNonce = this.getCurrentNonce();
    const pendingTxs = this.getPendingTransactions();

    // Check for gap between server nonce and first pending transaction
    if (pendingTxs.length > 0) {
      const firstPendingNonce = pendingTxs[0].nonce;

      if (firstPendingNonce > serverNonce) {
        console.log(`Gap detected during account load: server nonce ${serverNonce}, first pending nonce ${firstPendingNonce}`);
        console.log('Resetting nonce and clearing pending transactions');

        // Reset local nonce to server nonce
        this.setNonce(serverNonce);

        // Clear all pending transactions
        this.cleanupAllTransactions();

        return; // Exit early since we've reset everything
      }
    }

    // Always clean up confirmed transactions
    // serverNonce is the next expected nonce, so anything < serverNonce is confirmed
    if (serverNonce > 0) {
      this.cleanupConfirmedTransactions(serverNonce - 1);
    }

    // Always sync local nonce to match server - chain is source of truth
    if (serverNonce !== localNonce) {
      if (localNonce > serverNonce) {
        console.log(`Local nonce (${localNonce}) is ahead of server (${serverNonce}) - resetting to server nonce`);
        // Also clear stale pending transactions when resetting backwards
        this.cleanupAllTransactions();
      } else {
        console.log(`Advancing local nonce from ${localNonce} to ${serverNonce}`);
      }
      this.setNonce(serverNonce);
    }
  }

  /**
   * Get the current nonce from local storage.
   * @returns {number} The current nonce value
   */
  getCurrentNonce() {
    const key = 'casino_nonce';
    const stored = localStorage.getItem(key);
    return stored ? parseInt(stored) : 0;
  }

  /**
   * Set the nonce in local storage.
   * @param {number} nonce - The nonce value to set
   * @private
   */
  setNonce(nonce) {
    const key = 'casino_nonce';
    localStorage.setItem(key, nonce.toString());
  }

  /**
   * Reset the nonce to 0 (used when network identity changes).
   * @private
   */
  resetNonce() {
    const key = 'casino_nonce';
    localStorage.setItem(key, '0');
  }

  /**
   * Get the next nonce to use for a transaction.
   * @returns {number} The next nonce value
   */
  getNextNonce() {
    return this.getCurrentNonce();
  }

  /**
   * Increment the nonce after successfully submitting a transaction.
   * @returns {number} The new nonce value
   * @private
   */
  incrementNonce() {
    const current = this.getCurrentNonce();
    this.setNonce(current + 1);
    return current + 1;
  }

  /**
   * Store a submitted transaction for tracking and potential resubmission.
   * @param {number} nonce - The transaction nonce
   * @param {Uint8Array} txData - The raw transaction data
   * @private
   */
  storeTransaction(nonce, txData) {
    const key = `${this.TX_STORAGE_PREFIX}${nonce}`;
    const txRecord = {
      nonce,
      txData: Array.from(txData), // Store as array for JSON serialization
      timestamp: Date.now(),
      retryCount: 0
    };
    localStorage.setItem(key, JSON.stringify(txRecord));
  }


  /**
   * Get all pending transactions sorted by nonce.
   * @returns {Array<{nonce: number, txData: Array<number>, timestamp: number, retryCount: number}>}
   */
  getPendingTransactions() {
    const prefix = this.TX_STORAGE_PREFIX;
    const transactions = [];
    const keysToCheck = [];

    // Collect all keys first to avoid iteration issues
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) {
        keysToCheck.push(key);
      }
    }

    // Now parse the transactions
    for (const key of keysToCheck) {
      try {
        const txRecord = JSON.parse(localStorage.getItem(key));
        if (txRecord) {
          transactions.push(txRecord);
        }
      } catch (error) {
        console.error(`Error parsing transaction record ${key}:`, error);
        // Remove corrupted record
        localStorage.removeItem(key);
      }
    }

    return transactions.sort((a, b) => a.nonce - b.nonce);
  }

  /**
   * Clean up all pending transactions from localStorage.
   * @private
   */
  cleanupAllTransactions() {
    if (!this.publicKeyHex) return;

    const prefix = this.TX_STORAGE_PREFIX;
    const keysToRemove = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) {
        keysToRemove.push(key);
      }
    }

    keysToRemove.forEach(key => {
      localStorage.removeItem(key);
    });

    if (keysToRemove.length > 0) {
      console.log(`Cleaned up ${keysToRemove.length} pending transactions`);
    }
  }

  /**
   * Remove transactions that have been confirmed onchain.
   * @param {number} confirmedNonce - The highest confirmed nonce
   * @private
   */
  cleanupConfirmedTransactions(confirmedNonce) {
    const prefix = this.TX_STORAGE_PREFIX;
    const toRemove = [];


    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) {
        try {
          const txRecord = JSON.parse(localStorage.getItem(key));
          if (txRecord.nonce <= confirmedNonce) {
            toRemove.push({ key, nonce: txRecord.nonce });
          }
        } catch (error) {
          console.error('Error parsing transaction record:', error);
        }
      }
    }

    toRemove.forEach(({ key, nonce }) => {
      localStorage.removeItem(key);
    });
  }

  /**
   * Attempt to resubmit all pending transactions.
   * @returns {Promise<void>}
   * @private
   */
  async resubmitPendingTransactions() {
    if (this.resubmitInProgress) {
      return;
    }

    this.resubmitInProgress = true;
    try {
      const pendingTxs = this.getPendingTransactions();

      if (pendingTxs.length === 0) {
        return;
      }

      const currentNonce = this.getCurrentNonce();

      // Check for stale transactions (nonces >= current nonce means they're from a previous session)
      // This can happen if the server was reset but the client still has old pending transactions
      const staleTxs = pendingTxs.filter(tx => tx.nonce >= currentNonce);
      if (staleTxs.length > 0) {
        console.log(`Found ${staleTxs.length} stale pending transactions with nonces >= ${currentNonce}, clearing them`);
        for (const tx of staleTxs) {
          const key = `${this.TX_STORAGE_PREFIX}${tx.nonce}`;
          localStorage.removeItem(key);
        }
        // Re-fetch pending transactions after cleanup
        const validTxs = this.getPendingTransactions();
        if (validTxs.length === 0) {
          return;
        }
      }

      // Try to resubmit valid pending transactions (those with nonces < currentNonce)
      const validPendingTxs = pendingTxs.filter(tx => tx.nonce < currentNonce);
      for (const txRecord of validPendingTxs) {
        // Convert array back to Uint8Array
        const txData = new Uint8Array(txRecord.txData);

        // Resubmit the transaction
        const result = await this.client.submitTransaction(txData);

        if (result.status === 'accepted') {
          // Update retry count
          txRecord.retryCount++;
          const key = `${this.TX_STORAGE_PREFIX}${txRecord.nonce}`;
          localStorage.setItem(key, JSON.stringify(txRecord));

        }
      }
    } catch (error) {
      console.error('Error in resubmitPendingTransactions:', error);
    } finally {
      this.resubmitInProgress = false;
    }
  }

  /**
   * Submit a transaction with automatic nonce management.
   * @param {Function} createTxFn - Function that creates transaction data given a nonce
   * @param {string} txType - Type of transaction for logging
   * @returns {Promise<{status: string, nonce: number, txHash: string}>} Transaction result
   * @throws {Error} If transaction submission fails
   * @private
   */
  async submitTransaction(createTxFn, txType) {
    // Queue transactions to ensure nonces are allocated sequentially
    return this.transactionQueue = this.transactionQueue.then(async () => {
      const nonce = this.getNextNonce();

      try {
        console.log('[NonceManager] submit', { txType, nonce, publicKey: this.publicKeyHex });
        // Create the transaction with the nonce
        const txData = createTxFn(nonce);

        // Compute a short hash of the tx data for display
        const txHash = this.computeTxHash(txData);

        // Store the transaction before submitting
        this.storeTransaction(nonce, txData);

        // Submit the transaction
        const result = await this.client.submitTransaction(txData);

        if (result.status === 'accepted') {
          console.log('[NonceManager] accepted', { txType, nonce, publicKey: this.publicKeyHex });
          // Increment nonce for next transaction
          this.incrementNonce();
        } else {
          // Remove the stored transaction if it was rejected
          const key = `${this.TX_STORAGE_PREFIX}${nonce}`;
          localStorage.removeItem(key);
        }

        return { ...result, nonce, txHash };
      } catch (error) {
        // Continue trying to submit transactions until confirmed
        console.error(`Error submitting ${txType} transaction with nonce ${nonce}:`, error.message);
        throw error;
      }
    }).catch(error => {
      // Reset queue on error to prevent blocking
      this.transactionQueue = Promise.resolve();
      throw error;
    });
  }

  /**
   * Compute a short hash of transaction data for display.
   * @param {Uint8Array} txData - The transaction data
   * @returns {string} Short hex hash (first 8 chars)
   * @private
   */
  computeTxHash(txData) {
    // Simple hash: XOR all bytes and combine with length
    let hash = txData.length;
    for (let i = 0; i < txData.length; i++) {
      hash = ((hash << 5) - hash + txData[i]) | 0;
    }
    // Convert to hex and take first 8 chars
    return Math.abs(hash).toString(16).toUpperCase().padStart(8, '0').slice(0, 8);
  }

  /**
   * Update nonce based on executed transaction from event stream.
   * This replaces polling - we now track executed transactions directly.
   * @param {number} executedNonce - The nonce of the executed transaction
   */
  updateNonceFromTransaction(executedNonce) {
    const currentNonce = this.getCurrentNonce();
    const nextExpectedNonce = executedNonce + 1;

    // Clean up the confirmed transaction
    this.cleanupConfirmedTransactions(executedNonce);

    // Update our nonce if the executed transaction advances it
    if (nextExpectedNonce > currentNonce) {
      this.setNonce(nextExpectedNonce);
    } else {
    }
  }

  /**
   * Submit a casino register transaction.
   * @param {string} name - The player name
   * @returns {Promise<{status: string}>} Transaction result
   */
  async submitCasinoRegister(name) {
    return this.submitTransaction(
      (nonce) => this.wasm.createCasinoRegisterTransaction(nonce, name),
      'casinoRegister'
    );
  }

  /**
   * Submit a casino start game transaction.
   * @param {number} gameType - The game type (0-9)
   * @param {bigint} bet - The bet amount
   * @param {bigint} sessionId - The session ID
   * @returns {Promise<{status: string}>} Transaction result
   */
  async submitCasinoStartGame(gameType, bet, sessionId) {
    return this.submitTransaction(
      (nonce) => this.wasm.createCasinoStartGameTransaction(nonce, gameType, bet, sessionId),
      'casinoStartGame'
    );
  }

  /**
   * Submit a casino game move transaction.
   * @param {bigint} sessionId - The session ID
   * @param {Uint8Array} payload - The move payload
   * @returns {Promise<{status: string}>} Transaction result
   */
  async submitCasinoGameMove(sessionId, payload) {
    return this.submitTransaction(
      (nonce) => this.wasm.createCasinoGameMoveTransaction(nonce, sessionId, payload),
      'casinoGameMove'
    );
  }

  /**
   * Submit a casino toggle shield transaction.
   * @returns {Promise<{status: string}>} Transaction result
   */
  async submitCasinoToggleShield() {
    return this.submitTransaction(
      (nonce) => this.wasm.createCasinoToggleShieldTransaction(nonce),
      'casinoToggleShield'
    );
  }

  /**
   * Submit a casino toggle double transaction.
   * @returns {Promise<{status: string}>} Transaction result
   */
  async submitCasinoToggleDouble() {
    return this.submitTransaction(
      (nonce) => this.wasm.createCasinoToggleDoubleTransaction(nonce),
      'casinoToggleDouble'
    );
  }

  /**
   * Submit a casino toggle super transaction.
   * @returns {Promise<{status: string}>} Transaction result
   */
  async submitCasinoToggleSuper() {
    return this.submitTransaction(
      (nonce) => this.wasm.createCasinoToggleSuperTransaction(nonce),
      'casinoToggleSuper'
    );
  }

  /**
   * Submit a casino deposit transaction (dev faucet / testing).
   * @param {bigint|number} amount - Amount to deposit
   * @returns {Promise<{status: string, txHash?: string}>} Transaction result
   */
  async submitCasinoDeposit(amount) {
    return this.submitTransaction(
      (nonce) => this.wasm.createCasinoDepositTransaction(nonce, amount),
      'casinoDeposit'
    );
  }

  /**
   * Submit a casino join tournament transaction.
   * @param {bigint|number} tournamentId - Tournament ID
   * @returns {Promise<{status: string, txHash?: string}>} Transaction result
   */
  async submitCasinoJoinTournament(tournamentId) {
    return this.submitTransaction(
      (nonce) => this.wasm.createCasinoJoinTournamentTransaction(nonce, tournamentId),
      'casinoJoinTournament'
    );
  }

  /**
   * Submit a casino start tournament transaction.
   * @param {bigint|number} tournamentId - Tournament ID
   * @param {bigint|number} startTimeMs - Start time in milliseconds
   * @param {bigint|number} endTimeMs - End time in milliseconds
   * @returns {Promise<{status: string, txHash?: string}>} Transaction result
   */
  async submitCasinoStartTournament(tournamentId, startTimeMs, endTimeMs) {
    return this.submitTransaction(
      (nonce) => this.wasm.createCasinoStartTournamentTransaction(nonce, tournamentId, startTimeMs, endTimeMs),
      'casinoStartTournament'
    );
  }

  /**
   * Submit a casino end tournament transaction.
   * @param {bigint|number} tournamentId - Tournament ID
   * @returns {Promise<{status: string, txHash?: string}>} Transaction result
   */
  async submitCasinoEndTournament(tournamentId) {
    return this.submitTransaction(
      (nonce) => this.wasm.createCasinoEndTournamentTransaction(nonce, tournamentId),
      'casinoEndTournament'
    );
  }

  /**
   * Submit a create vault transaction.
   * @returns {Promise<{status: string, txHash?: string}>} Transaction result
   */
  async submitCreateVault() {
    return this.submitTransaction(
      (nonce) => this.wasm.createCreateVaultTransaction(nonce),
      'createVault'
    );
  }

  /**
   * Submit a deposit collateral transaction.
   * @param {bigint|number} amount - Amount of RNG to lock as collateral
   * @returns {Promise<{status: string, txHash?: string}>} Transaction result
   */
  async submitDepositCollateral(amount) {
    return this.submitTransaction(
      (nonce) => this.wasm.createDepositCollateralTransaction(nonce, amount),
      'depositCollateral'
    );
  }

  /**
   * Submit a borrow vUSDT transaction.
   * @param {bigint|number} amount - Amount of vUSDT to borrow
   * @returns {Promise<{status: string, txHash?: string}>} Transaction result
   */
  async submitBorrowUsdt(amount) {
    return this.submitTransaction(
      (nonce) => this.wasm.createBorrowUsdtTransaction(nonce, amount),
      'borrowUsdt'
    );
  }

  /**
   * Submit a repay vUSDT transaction.
   * @param {bigint|number} amount - Amount of vUSDT to repay
   * @returns {Promise<{status: string, txHash?: string}>} Transaction result
   */
  async submitRepayUsdt(amount) {
    return this.submitTransaction(
      (nonce) => this.wasm.createRepayUsdtTransaction(nonce, amount),
      'repayUsdt'
    );
  }

  /**
   * Submit an AMM swap transaction.
   * @param {bigint|number} amountIn - Amount of input token
   * @param {bigint|number} minAmountOut - Minimum amount out (slippage protection)
   * @param {boolean} isBuyingRng - True to swap vUSDT->RNG, false to swap RNG->vUSDT
   * @returns {Promise<{status: string, txHash?: string}>} Transaction result
   */
  async submitSwap(amountIn, minAmountOut, isBuyingRng) {
    return this.submitTransaction(
      (nonce) => this.wasm.createSwapTransaction(nonce, amountIn, minAmountOut, isBuyingRng),
      'swap'
    );
  }

  /**
   * Submit an add liquidity transaction.
   * @param {bigint|number} rngAmount - RNG amount
   * @param {bigint|number} usdtAmount - vUSDT amount
   * @returns {Promise<{status: string, txHash?: string}>} Transaction result
   */
  async submitAddLiquidity(rngAmount, usdtAmount) {
    return this.submitTransaction(
      (nonce) => this.wasm.createAddLiquidityTransaction(nonce, rngAmount, usdtAmount),
      'addLiquidity'
    );
  }

  /**
   * Submit a remove liquidity transaction.
   * @param {bigint|number} shares - LP shares to burn
   * @returns {Promise<{status: string, txHash?: string}>} Transaction result
   */
  async submitRemoveLiquidity(shares) {
    return this.submitTransaction(
      (nonce) => this.wasm.createRemoveLiquidityTransaction(nonce, shares),
      'removeLiquidity'
    );
  }

  /**
   * Submit a stake transaction.
   * @param {bigint|number} amount - Amount of RNG to stake
   * @param {bigint|number} duration - Lock duration (in blocks/views)
   * @returns {Promise<{status: string, txHash?: string}>} Transaction result
   */
  async submitStake(amount, duration) {
    return this.submitTransaction(
      (nonce) => this.wasm.createStakeTransaction(nonce, amount, duration),
      'stake'
    );
  }

  /**
   * Submit an unstake transaction.
   * @returns {Promise<{status: string, txHash?: string}>} Transaction result
   */
  async submitUnstake() {
    return this.submitTransaction(
      (nonce) => this.wasm.createUnstakeTransaction(nonce),
      'unstake'
    );
  }

  /**
   * Submit a claim rewards transaction.
   * @returns {Promise<{status: string, txHash?: string}>} Transaction result
   */
  async submitClaimRewards() {
    return this.submitTransaction(
      (nonce) => this.wasm.createClaimRewardsTransaction(nonce),
      'claimRewards'
    );
  }

  /**
   * Submit an epoch processing transaction.
   * @returns {Promise<{status: string, txHash?: string}>} Transaction result
   */
  async submitProcessEpoch() {
    return this.submitTransaction(
      (nonce) => this.wasm.createProcessEpochTransaction(nonce),
      'processEpoch'
    );
  }
}
