import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  serializeCasinoRegister,
  serializeCasinoDeposit,
  serializeCasinoStartGame,
  serializeCasinoGameMove,
  serializeCasinoToggleShield,
  serializeCasinoToggleDouble,
  serializeCasinoToggleSuper,
  serializeCasinoJoinTournament,
  deserializeCasinoGameStarted,
  deserializeCasinoGameMoved,
  deserializeCasinoGameCompleted,
} from '../src/services/CasinoChainService.serializers.js';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Helper to create a varint-encoded length prefix
 * Returns array of bytes representing the varint
 */
function encodeVarint(value) {
  const bytes = [];
  let remaining = value;

  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  bytes.push(remaining & 0x7f);

  return bytes;
}

/**
 * Helper to compare Uint8Arrays
 */
function assertBytesEqual(actual, expected, message) {
  assert.strictEqual(actual.length, expected.length, `${message} - length mismatch`);
  for (let i = 0; i < actual.length; i++) {
    assert.strictEqual(
      actual[i],
      expected[i],
      `${message} - byte mismatch at index ${i}: expected ${expected[i]}, got ${actual[i]}`
    );
  }
}

// ============================================================================
// Instruction Serialization Tests
// ============================================================================

describe('Instruction Serialization', () => {
  describe('serializeCasinoRegister', () => {
    test('should serialize with tag 10, length prefix, and name bytes', () => {
      const name = 'Alice';
      const result = serializeCasinoRegister(name);

      // Expected: [10] [0x00, 0x00, 0x00, 0x05] (u32 BE = 5) ['A', 'l', 'i', 'c', 'e']
      const expected = new Uint8Array([
        10, // Tag
        0x00, 0x00, 0x00, 0x05, // u32 BE length = 5
        0x41, 0x6c, 0x69, 0x63, 0x65 // "Alice" in UTF-8
      ]);

      assertBytesEqual(result, expected, 'CasinoRegister serialization');
    });

    test('should handle empty name', () => {
      const name = '';
      const result = serializeCasinoRegister(name);

      const expected = new Uint8Array([
        10, // Tag
        0x00, 0x00, 0x00, 0x00, // u32 BE length = 0
      ]);

      assertBytesEqual(result, expected, 'CasinoRegister with empty name');
    });

    test('should handle multi-byte UTF-8 characters', () => {
      const name = '🎰'; // Slot machine emoji - 4 bytes in UTF-8
      const result = serializeCasinoRegister(name);

      const expected = new Uint8Array([
        10, // Tag
        0x00, 0x00, 0x00, 0x04, // u32 BE length = 4
        0xf0, 0x9f, 0x8e, 0xb0 // UTF-8 encoding of slot machine emoji
      ]);

      assertBytesEqual(result, expected, 'CasinoRegister with emoji');
    });
  });

  describe('serializeCasinoDeposit', () => {
    test('should serialize with tag 11 and u64 BE amount', () => {
      const amount = 1000n;
      const result = serializeCasinoDeposit(amount);

      // Expected: [11] [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0xe8] (u64 BE = 1000)
      const expected = new Uint8Array([
        11, // Tag
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0xe8 // u64 BE = 1000
      ]);

      assertBytesEqual(result, expected, 'CasinoDeposit serialization');
    });

    test('should handle zero amount', () => {
      const amount = 0n;
      const result = serializeCasinoDeposit(amount);

      const expected = new Uint8Array([
        11, // Tag
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 // u64 BE = 0
      ]);

      assertBytesEqual(result, expected, 'CasinoDeposit with zero');
    });

    test('should handle large amount', () => {
      const amount = 0xFFFFFFFFFFFFFFFFn; // Max u64
      const result = serializeCasinoDeposit(amount);

      const expected = new Uint8Array([
        11, // Tag
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff // u64 BE = max
      ]);

      assertBytesEqual(result, expected, 'CasinoDeposit with max u64');
    });
  });

  describe('serializeCasinoStartGame', () => {
    test('should serialize with tag 12, gameType, bet, and sessionId', () => {
      const gameType = 1; // Blackjack
      const bet = 100n;
      const sessionId = 42n;
      const result = serializeCasinoStartGame(gameType, bet, sessionId);

      // Expected: [12] [1] [bet:u64 BE] [sessionId:u64 BE]
      const expected = new Uint8Array([
        12, // Tag
        1, // gameType
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x64, // bet = 100
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2a  // sessionId = 42
      ]);

      assertBytesEqual(result, expected, 'CasinoStartGame serialization');
    });

    test('should handle all game types', () => {
      for (let gameType = 0; gameType <= 9; gameType++) {
        const result = serializeCasinoStartGame(gameType, 50n, 1n);
        assert.strictEqual(result[0], 12, 'Tag should be 12');
        assert.strictEqual(result[1], gameType, `Game type should be ${gameType}`);
      }
    });

    test('should handle large bet and sessionId', () => {
      const gameType = 0;
      const bet = 999999999n;
      const sessionId = 123456789n;
      const result = serializeCasinoStartGame(gameType, bet, sessionId);

      const expected = new Uint8Array([
        12, // Tag
        0, // gameType
        0x00, 0x00, 0x00, 0x00, 0x3b, 0x9a, 0xc9, 0xff, // bet = 999999999
        0x00, 0x00, 0x00, 0x00, 0x07, 0x5b, 0xcd, 0x15  // sessionId = 123456789
      ]);

      assertBytesEqual(result, expected, 'CasinoStartGame with large values');
    });
  });

  describe('serializeCasinoGameMove', () => {
    test('should serialize with tag 13, sessionId, payload length, and payload', () => {
      const sessionId = 42n;
      const payload = new Uint8Array([0x01, 0x02, 0x03]);
      const result = serializeCasinoGameMove(sessionId, payload);

      // Expected: [13] [sessionId:u64 BE] [payloadLen:u32 BE] [payload...]
      const expected = new Uint8Array([
        13, // Tag
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2a, // sessionId = 42
        0x00, 0x00, 0x00, 0x03, // payloadLen = 3
        0x01, 0x02, 0x03 // payload
      ]);

      assertBytesEqual(result, expected, 'CasinoGameMove serialization');
    });

    test('should handle empty payload', () => {
      const sessionId = 1n;
      const payload = new Uint8Array([]);
      const result = serializeCasinoGameMove(sessionId, payload);

      const expected = new Uint8Array([
        13, // Tag
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, // sessionId = 1
        0x00, 0x00, 0x00, 0x00, // payloadLen = 0
      ]);

      assertBytesEqual(result, expected, 'CasinoGameMove with empty payload');
    });

    test('should handle large payload', () => {
      const sessionId = 100n;
      const payload = new Uint8Array(256).fill(0xaa);
      const result = serializeCasinoGameMove(sessionId, payload);

      assert.strictEqual(result[0], 13, 'Tag should be 13');

      // Check sessionId
      const view = new DataView(result.buffer);
      assert.strictEqual(view.getBigUint64(1, false), 100n, 'SessionId should be 100');

      // Check payload length
      assert.strictEqual(view.getUint32(9, false), 256, 'Payload length should be 256');

      // Check payload content
      for (let i = 0; i < 256; i++) {
        assert.strictEqual(result[13 + i], 0xaa, `Payload byte ${i} should be 0xaa`);
      }
    });
  });

  describe('serializeCasinoToggleShield', () => {
    test('should serialize with just tag 14', () => {
      const result = serializeCasinoToggleShield();

      const expected = new Uint8Array([14]);

      assertBytesEqual(result, expected, 'CasinoToggleShield serialization');
    });

    test('should always produce single byte', () => {
      const result = serializeCasinoToggleShield();
      assert.strictEqual(result.length, 1, 'Should be 1 byte');
      assert.strictEqual(result[0], 14, 'Should be tag 14');
    });
  });

  describe('serializeCasinoToggleDouble', () => {
    test('should serialize with just tag 15', () => {
      const result = serializeCasinoToggleDouble();

      const expected = new Uint8Array([15]);

      assertBytesEqual(result, expected, 'CasinoToggleDouble serialization');
    });

    test('should always produce single byte', () => {
      const result = serializeCasinoToggleDouble();
      assert.strictEqual(result.length, 1, 'Should be 1 byte');
      assert.strictEqual(result[0], 15, 'Should be tag 15');
    });
  });

  describe('serializeCasinoToggleSuper', () => {
    test('should serialize with just tag 30', () => {
      const result = serializeCasinoToggleSuper();

      const expected = new Uint8Array([30]);

      assertBytesEqual(result, expected, 'CasinoToggleSuper serialization');
    });

    test('should always produce single byte', () => {
      const result = serializeCasinoToggleSuper();
      assert.strictEqual(result.length, 1, 'Should be 1 byte');
      assert.strictEqual(result[0], 30, 'Should be tag 30');
    });
  });

  describe('serializeCasinoJoinTournament', () => {
    test('should serialize with tag 16 and tournamentId', () => {
      const tournamentId = 5n;
      const result = serializeCasinoJoinTournament(tournamentId);

      const expected = new Uint8Array([
        16, // Tag
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05 // tournamentId = 5
      ]);

      assertBytesEqual(result, expected, 'CasinoJoinTournament serialization');
    });

    test('should handle zero tournamentId', () => {
      const tournamentId = 0n;
      const result = serializeCasinoJoinTournament(tournamentId);

      const expected = new Uint8Array([
        16, // Tag
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 // tournamentId = 0
      ]);

      assertBytesEqual(result, expected, 'CasinoJoinTournament with zero');
    });

    test('should handle large tournamentId', () => {
      const tournamentId = 0x123456789ABCDEFn;
      const result = serializeCasinoJoinTournament(tournamentId);

      const expected = new Uint8Array([
        16, // Tag
        0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef
      ]);

      assertBytesEqual(result, expected, 'CasinoJoinTournament with large value');
    });
  });
});

// ============================================================================
// Event Deserialization Tests
// ============================================================================

describe('Event Deserialization', () => {
  describe('deserializeCasinoGameStarted', () => {
    test('should deserialize valid CasinoGameStarted event', () => {
      // Create mock player public key (32 bytes)
      const player = new Uint8Array(32).fill(0xaa);

      // Create mock initial state
      const initialState = new Uint8Array([0x01, 0x02, 0x03]);
      const stateVarint = encodeVarint(initialState.length);

      // Build the event binary
      // [21] [sessionId:u64 BE] [player:32] [gameType:u8] [bet:u64 BE] [stateLen:varint] [state...]
      const event = new Uint8Array([
        21, // Tag
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2a, // sessionId = 42
        ...player, // 32 bytes player pubkey
        1, // gameType = Blackjack
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x64, // bet = 100
        ...stateVarint, // state length varint
        ...initialState // state bytes
      ]);

      const result = deserializeCasinoGameStarted(event);

      assert.strictEqual(result.type, 'CasinoGameStarted');
      assert.strictEqual(result.sessionId, 42n);
      assertBytesEqual(result.player, player, 'Player pubkey');
      assert.strictEqual(result.gameType, 1);
      assert.strictEqual(result.bet, 100n);
      assertBytesEqual(result.initialState, initialState, 'Initial state');
    });

    test('should handle empty initial state', () => {
      const player = new Uint8Array(32).fill(0xff);
      const initialState = new Uint8Array([]);
      const stateVarint = encodeVarint(0);

      const event = new Uint8Array([
        21, // Tag
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, // sessionId = 1
        ...player,
        0, // gameType = Baccarat
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0a, // bet = 10
        ...stateVarint,
        ...initialState
      ]);

      const result = deserializeCasinoGameStarted(event);

      assert.strictEqual(result.sessionId, 1n);
      assert.strictEqual(result.gameType, 0);
      assert.strictEqual(result.initialState.length, 0);
    });

    test('should handle large initial state with multi-byte varint', () => {
      const player = new Uint8Array(32).fill(0x11);
      // Create a 200-byte state (requires 2-byte varint: 200 = 0xC8 = [0xC8, 0x01])
      const initialState = new Uint8Array(200).fill(0x42);
      const stateVarint = encodeVarint(200);

      const event = new Uint8Array([
        21, // Tag
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, // sessionId = 5
        ...player,
        6, // gameType = Roulette
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, // bet = 256
        ...stateVarint,
        ...initialState
      ]);

      const result = deserializeCasinoGameStarted(event);

      assert.strictEqual(result.sessionId, 5n);
      assert.strictEqual(result.gameType, 6);
      assert.strictEqual(result.bet, 256n);
      assert.strictEqual(result.initialState.length, 200);
      assert.strictEqual(result.initialState[0], 0x42);
    });

    test('should throw on wrong tag', () => {
      const player = new Uint8Array(32);
      const event = new Uint8Array([
        22, // Wrong tag
        ...new Uint8Array(8), // sessionId
        ...player,
        0, // gameType
        ...new Uint8Array(8), // bet
        0x00 // empty state
      ]);

      assert.throws(() => {
        deserializeCasinoGameStarted(event);
      }, /Expected CasinoGameStarted tag 21, got 22/);
    });
  });

  describe('deserializeCasinoGameMoved', () => {
    test('should deserialize valid CasinoGameMoved event', () => {
      const newState = new Uint8Array([0xaa, 0xbb, 0xcc]);
      const stateVarint = encodeVarint(newState.length);

      // [22] [sessionId:u64 BE] [moveNumber:u32 BE] [stateLen:varint] [state...]
      const event = new Uint8Array([
        22, // Tag
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2a, // sessionId = 42
        0x00, 0x00, 0x00, 0x05, // moveNumber = 5
        ...stateVarint,
        ...newState
      ]);

      const result = deserializeCasinoGameMoved(event);

      assert.strictEqual(result.type, 'CasinoGameMoved');
      assert.strictEqual(result.sessionId, 42n);
      assert.strictEqual(result.moveNumber, 5);
      assertBytesEqual(result.newState, newState, 'New state');
    });

    test('should handle first move (moveNumber = 0)', () => {
      const newState = new Uint8Array([0x01]);
      const stateVarint = encodeVarint(1);

      const event = new Uint8Array([
        22, // Tag
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, // sessionId = 1
        0x00, 0x00, 0x00, 0x00, // moveNumber = 0
        ...stateVarint,
        ...newState
      ]);

      const result = deserializeCasinoGameMoved(event);

      assert.strictEqual(result.moveNumber, 0);
      assert.strictEqual(result.newState.length, 1);
    });

    test('should handle large state and high move number', () => {
      const newState = new Uint8Array(500).fill(0x7f);
      const stateVarint = encodeVarint(500);

      const event = new Uint8Array([
        22, // Tag
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, // sessionId = 255
        0x00, 0x00, 0x03, 0xe8, // moveNumber = 1000
        ...stateVarint,
        ...newState
      ]);

      const result = deserializeCasinoGameMoved(event);

      assert.strictEqual(result.sessionId, 255n);
      assert.strictEqual(result.moveNumber, 1000);
      assert.strictEqual(result.newState.length, 500);
    });

    test('should throw on wrong tag', () => {
      const event = new Uint8Array([
        21, // Wrong tag
        ...new Uint8Array(8), // sessionId
        ...new Uint8Array(4), // moveNumber
        0x00 // empty state
      ]);

      assert.throws(() => {
        deserializeCasinoGameMoved(event);
      }, /Expected CasinoGameMoved tag 22, got 21/);
    });
  });

  describe('deserializeCasinoGameCompleted', () => {
    test('should deserialize valid CasinoGameCompleted event with positive payout', () => {
      const player = new Uint8Array(32).fill(0xcc);

      // [23] [sessionId:u64 BE] [player:32] [gameType:u8] [payout:i64 BE] [finalChips:u64 BE] [wasShielded:bool] [wasDoubled:bool]
      const event = new Uint8Array([
        23, // Tag
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2a, // sessionId = 42
        ...player,
        1, // gameType = Blackjack
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x64, // payout = +100 (i64 BE)
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0xe8, // finalChips = 1000
        0x00, // wasShielded = false
        0x01  // wasDoubled = true
      ]);

      const result = deserializeCasinoGameCompleted(event);

      assert.strictEqual(result.type, 'CasinoGameCompleted');
      assert.strictEqual(result.sessionId, 42n);
      assertBytesEqual(result.player, player, 'Player pubkey');
      assert.strictEqual(result.gameType, 1);
      assert.strictEqual(result.payout, 100n);
      assert.strictEqual(result.finalChips, 1000n);
      assert.strictEqual(result.wasShielded, false);
      assert.strictEqual(result.wasDoubled, true);
    });

    test('should deserialize event with negative payout (loss)', () => {
      const player = new Uint8Array(32).fill(0xdd);

      // Negative payout: -100 in i64 BE
      // -100 = 0xFFFFFFFFFFFFFF9C in two's complement
      const event = new Uint8Array([
        23, // Tag
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, // sessionId = 1
        ...player,
        0, // gameType = Baccarat
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x9c, // payout = -100 (i64 BE)
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0xf4, // finalChips = 500
        0x01, // wasShielded = true
        0x00  // wasDoubled = false
      ]);

      const result = deserializeCasinoGameCompleted(event);

      assert.strictEqual(result.payout, -100n);
      assert.strictEqual(result.finalChips, 500n);
      assert.strictEqual(result.wasShielded, true);
      assert.strictEqual(result.wasDoubled, false);
    });

    test('should handle zero payout (push)', () => {
      const player = new Uint8Array(32).fill(0xee);

      const event = new Uint8Array([
        23, // Tag
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0a, // sessionId = 10
        ...player,
        2, // gameType = CasinoWar
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // payout = 0
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, // finalChips = 512
        0x00, // wasShielded = false
        0x00  // wasDoubled = false
      ]);

      const result = deserializeCasinoGameCompleted(event);

      assert.strictEqual(result.payout, 0n);
      assert.strictEqual(result.finalChips, 512n);
      assert.strictEqual(result.wasShielded, false);
      assert.strictEqual(result.wasDoubled, false);
    });

    test('should handle large positive payout', () => {
      const player = new Uint8Array(32);

      const event = new Uint8Array([
        23, // Tag
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x64, // sessionId = 100
        ...player,
        9, // gameType = UltimateHoldem
        0x00, 0x00, 0x00, 0x00, 0x00, 0x0f, 0x42, 0x40, // payout = 1000000
        0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x42, 0x40, // finalChips = 1065536
        0x01, // wasShielded = true
        0x01  // wasDoubled = true
      ]);

      const result = deserializeCasinoGameCompleted(event);

      assert.strictEqual(result.payout, 1000000n);
      assert.strictEqual(result.finalChips, 1065536n);
      assert.strictEqual(result.wasShielded, true);
      assert.strictEqual(result.wasDoubled, true);
    });

    test('should throw on wrong tag', () => {
      const player = new Uint8Array(32);
      const event = new Uint8Array([
        24, // Wrong tag
        ...new Uint8Array(8), // sessionId
        ...player,
        0, // gameType
        ...new Uint8Array(8), // payout
        ...new Uint8Array(8), // finalChips
        0x00, // wasShielded
        0x00  // wasDoubled
      ]);

      assert.throws(() => {
        deserializeCasinoGameCompleted(event);
      }, /Expected CasinoGameCompleted tag 23, got 24/);
    });
  });
});

// ============================================================================
// Round-trip Tests
// ============================================================================

describe('Round-trip Tests', () => {
  test('serializeCasinoRegister → verify byte format', () => {
    const name = 'TestPlayer';
    const serialized = serializeCasinoRegister(name);

    // Manually verify the structure
    assert.strictEqual(serialized[0], 10, 'Tag should be 10');

    const view = new DataView(serialized.buffer);
    const nameLen = view.getUint32(1, false);
    assert.strictEqual(nameLen, 10, 'Name length should be 10');

    const decoder = new TextDecoder();
    const decodedName = decoder.decode(serialized.slice(5));
    assert.strictEqual(decodedName, name, 'Name should match');
  });

  test('serializeCasinoDeposit → verify byte format', () => {
    const amount = 12345n;
    const serialized = serializeCasinoDeposit(amount);

    assert.strictEqual(serialized[0], 11, 'Tag should be 11');

    const view = new DataView(serialized.buffer);
    const decodedAmount = view.getBigUint64(1, false);
    assert.strictEqual(decodedAmount, amount, 'Amount should match');
  });

  test('serializeCasinoStartGame → verify byte format', () => {
    const gameType = 5; // HiLo
    const bet = 250n;
    const sessionId = 99n;
    const serialized = serializeCasinoStartGame(gameType, bet, sessionId);

    assert.strictEqual(serialized[0], 12, 'Tag should be 12');
    assert.strictEqual(serialized[1], gameType, 'Game type should match');

    const view = new DataView(serialized.buffer);
    const decodedBet = view.getBigUint64(2, false);
    const decodedSessionId = view.getBigUint64(10, false);

    assert.strictEqual(decodedBet, bet, 'Bet should match');
    assert.strictEqual(decodedSessionId, sessionId, 'SessionId should match');
  });

  test('serializeCasinoGameMove → verify byte format', () => {
    const sessionId = 777n;
    const payload = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
    const serialized = serializeCasinoGameMove(sessionId, payload);

    assert.strictEqual(serialized[0], 13, 'Tag should be 13');

    const view = new DataView(serialized.buffer);
    const decodedSessionId = view.getBigUint64(1, false);
    const payloadLen = view.getUint32(9, false);

    assert.strictEqual(decodedSessionId, sessionId, 'SessionId should match');
    assert.strictEqual(payloadLen, 4, 'Payload length should be 4');

    assertBytesEqual(serialized.slice(13), payload, 'Payload should match');
  });

  test('Create mock CasinoGameStarted → deserialize → verify fields', () => {
    const expectedSessionId = 123n;
    const expectedPlayer = new Uint8Array(32).fill(0x55);
    const expectedGameType = 3; // Craps
    const expectedBet = 500n;
    const expectedState = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

    // Manually construct the event
    const stateVarint = encodeVarint(expectedState.length);
    const event = new Uint8Array([
      21, // Tag
      ...new Uint8Array(new BigUint64Array([expectedSessionId]).buffer).reverse(), // u64 BE
      ...expectedPlayer,
      expectedGameType,
      ...new Uint8Array(new BigUint64Array([expectedBet]).buffer).reverse(), // u64 BE
      ...stateVarint,
      ...expectedState
    ]);

    const result = deserializeCasinoGameStarted(event);

    assert.strictEqual(result.sessionId, expectedSessionId);
    assertBytesEqual(result.player, expectedPlayer, 'Player');
    assert.strictEqual(result.gameType, expectedGameType);
    assert.strictEqual(result.bet, expectedBet);
    assertBytesEqual(result.initialState, expectedState, 'Initial state');
  });

  test('Create mock CasinoGameMoved → deserialize → verify fields', () => {
    const expectedSessionId = 456n;
    const expectedMoveNumber = 7;
    const expectedState = new Uint8Array([0xca, 0xfe]);

    const stateVarint = encodeVarint(expectedState.length);
    const event = new Uint8Array([
      22, // Tag
      ...new Uint8Array(new BigUint64Array([expectedSessionId]).buffer).reverse(), // u64 BE
      0x00, 0x00, 0x00, 0x07, // moveNumber = 7 (u32 BE)
      ...stateVarint,
      ...expectedState
    ]);

    const result = deserializeCasinoGameMoved(event);

    assert.strictEqual(result.sessionId, expectedSessionId);
    assert.strictEqual(result.moveNumber, expectedMoveNumber);
    assertBytesEqual(result.newState, expectedState, 'New state');
  });

  test('Create mock CasinoGameCompleted → deserialize → verify fields', () => {
    const expectedSessionId = 789n;
    const expectedPlayer = new Uint8Array(32).fill(0x99);
    const expectedGameType = 8; // ThreeCard
    const expectedPayout = -50n; // Loss
    const expectedFinalChips = 950n;
    const expectedWasShielded = true;
    const expectedWasDoubled = false;

    // Convert negative payout to i64 BE bytes
    const payoutView = new DataView(new ArrayBuffer(8));
    payoutView.setBigInt64(0, expectedPayout, false); // Big Endian
    const payoutBytes = new Uint8Array(payoutView.buffer);

    const event = new Uint8Array([
      23, // Tag
      ...new Uint8Array(new BigUint64Array([expectedSessionId]).buffer).reverse(), // u64 BE
      ...expectedPlayer,
      expectedGameType,
      ...payoutBytes,
      ...new Uint8Array(new BigUint64Array([expectedFinalChips]).buffer).reverse(), // u64 BE
      expectedWasShielded ? 0x01 : 0x00,
      expectedWasDoubled ? 0x01 : 0x00
    ]);

    const result = deserializeCasinoGameCompleted(event);

    assert.strictEqual(result.sessionId, expectedSessionId);
    assertBytesEqual(result.player, expectedPlayer, 'Player');
    assert.strictEqual(result.gameType, expectedGameType);
    assert.strictEqual(result.payout, expectedPayout);
    assert.strictEqual(result.finalChips, expectedFinalChips);
    assert.strictEqual(result.wasShielded, expectedWasShielded);
    assert.strictEqual(result.wasDoubled, expectedWasDoubled);
  });
});
