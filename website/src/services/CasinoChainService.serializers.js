/**
 * CasinoChainService - Serialization/Deserialization Functions
 * Pure JavaScript version for testing (extracted from TypeScript)
 */

// ============================================================================
// Instruction Serialization (Big Endian)
// ============================================================================

/**
 * Tag 10: CasinoRegister
 * Binary: [10] [nameLen:u32 BE] [nameBytes...]
 */
export function serializeCasinoRegister(name) {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(name);
  const buf = new Uint8Array(1 + 4 + nameBytes.length);
  buf[0] = 10; // Tag
  new DataView(buf.buffer).setUint32(1, nameBytes.length, false); // Big Endian
  buf.set(nameBytes, 5);
  return buf;
}

/**
 * Tag 11: CasinoDeposit
 * Binary: [11] [amount:u64 BE]
 */
export function serializeCasinoDeposit(amount) {
  const buf = new Uint8Array(1 + 8);
  buf[0] = 11;
  new DataView(buf.buffer).setBigUint64(1, amount, false); // Big Endian
  return buf;
}

/**
 * Tag 12: CasinoStartGame
 * Binary: [12] [gameType:u8] [bet:u64 BE] [sessionId:u64 BE]
 */
export function serializeCasinoStartGame(gameType, bet, sessionId) {
  const buf = new Uint8Array(1 + 1 + 8 + 8);
  buf[0] = 12;
  buf[1] = gameType;
  const view = new DataView(buf.buffer);
  view.setBigUint64(2, bet, false); // Big Endian
  view.setBigUint64(10, sessionId, false); // Big Endian
  return buf;
}

/**
 * Tag 13: CasinoGameMove
 * Binary: [13] [sessionId:u64 BE] [payloadLen:u32 BE] [payload...]
 */
export function serializeCasinoGameMove(sessionId, payload) {
  const buf = new Uint8Array(1 + 8 + 4 + payload.length);
  buf[0] = 13;
  const view = new DataView(buf.buffer);
  view.setBigUint64(1, sessionId, false); // Big Endian
  view.setUint32(9, payload.length, false); // Big Endian
  buf.set(payload, 13);
  return buf;
}

/**
 * Tag 14: CasinoToggleShield
 * Binary: [14]
 */
export function serializeCasinoToggleShield() {
  return new Uint8Array([14]);
}

/**
 * Tag 15: CasinoToggleDouble
 * Binary: [15]
 */
export function serializeCasinoToggleDouble() {
  return new Uint8Array([15]);
}

/**
 * Tag 30: CasinoToggleSuper
 * Binary: [30]
 */
export function serializeCasinoToggleSuper() {
  return new Uint8Array([30]);
}

/**
 * Tag 16: CasinoJoinTournament
 * Binary: [16] [tournamentId:u64 BE]
 */
export function serializeCasinoJoinTournament(tournamentId) {
  const buf = new Uint8Array(1 + 8);
  buf[0] = 16;
  new DataView(buf.buffer).setBigUint64(1, tournamentId, false); // Big Endian
  return buf;
}

// ============================================================================
// Event Deserialization (Big Endian)
// ============================================================================

/**
 * Deserialize CasinoGameStarted event (tag 21)
 * Binary: [21] [sessionId:u64 BE] [player:32 bytes] [gameType:u8] [bet:u64 BE] [stateLen:varint] [state...]
 */
export function deserializeCasinoGameStarted(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  // Tag (already consumed by event dispatcher)
  const tag = data[offset++];
  if (tag !== 21) {
    throw new Error(`Expected CasinoGameStarted tag 21, got ${tag}`);
  }

  // Session ID (u64 BE)
  const sessionId = view.getBigUint64(offset, false);
  offset += 8;

  // Player (32 bytes public key)
  const player = data.slice(offset, offset + 32);
  offset += 32;

  // Game Type (u8)
  const gameType = data[offset++];

  // Bet (u64 BE)
  const bet = view.getBigUint64(offset, false);
  offset += 8;

  // Initial State (varint length + bytes)
  const { value: stateLen, bytesRead } = readVarint(data, offset);
  offset += bytesRead;
  const initialState = data.slice(offset, offset + stateLen);

  return {
    type: 'CasinoGameStarted',
    sessionId,
    player,
    gameType,
    bet,
    initialState,
  };
}

/**
 * Deserialize CasinoGameMoved event (tag 22)
 * Binary: [22] [sessionId:u64 BE] [moveNumber:u32 BE] [stateLen:varint] [state...]
 */
export function deserializeCasinoGameMoved(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  // Tag
  const tag = data[offset++];
  if (tag !== 22) {
    throw new Error(`Expected CasinoGameMoved tag 22, got ${tag}`);
  }

  // Session ID (u64 BE)
  const sessionId = view.getBigUint64(offset, false);
  offset += 8;

  // Move Number (u32 BE)
  const moveNumber = view.getUint32(offset, false);
  offset += 4;

  // New State (varint length + bytes)
  const { value: stateLen, bytesRead } = readVarint(data, offset);
  offset += bytesRead;
  const newState = data.slice(offset, offset + stateLen);

  return {
    type: 'CasinoGameMoved',
    sessionId,
    moveNumber,
    newState,
  };
}

/**
 * Deserialize CasinoGameCompleted event (tag 23)
 * Binary: [23] [sessionId:u64 BE] [player:32 bytes] [gameType:u8] [payout:i64 BE] [finalChips:u64 BE] [wasShielded:bool] [wasDoubled:bool]
 */
export function deserializeCasinoGameCompleted(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  // Tag
  const tag = data[offset++];
  if (tag !== 23) {
    throw new Error(`Expected CasinoGameCompleted tag 23, got ${tag}`);
  }

  // Session ID (u64 BE)
  const sessionId = view.getBigUint64(offset, false);
  offset += 8;

  // Player (32 bytes public key)
  const player = data.slice(offset, offset + 32);
  offset += 32;

  // Game Type (u8)
  const gameType = data[offset++];

  // Payout (i64 BE)
  const payout = view.getBigInt64(offset, false);
  offset += 8;

  // Final Chips (u64 BE)
  const finalChips = view.getBigUint64(offset, false);
  offset += 8;

  // Was Shielded (bool)
  const wasShielded = data[offset++] === 1;

  // Was Doubled (bool)
  const wasDoubled = data[offset++] === 1;

  return {
    type: 'CasinoGameCompleted',
    sessionId,
    player,
    gameType,
    payout,
    finalChips,
    wasShielded,
    wasDoubled,
  };
}

/**
 * Read a varint from a buffer (commonware-codec style)
 * Returns the decoded value and number of bytes read
 */
function readVarint(data, offset) {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;

  while (bytesRead < 9) {
    if (offset + bytesRead >= data.length) {
      throw new Error('Varint extends beyond buffer');
    }

    const byte = data[offset + bytesRead];
    bytesRead++;

    value |= (byte & 0x7f) << shift;

    if ((byte & 0x80) === 0) {
      return { value, bytesRead };
    }

    shift += 7;
  }

  throw new Error('Varint too long');
}
