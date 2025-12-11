/**
 * Tests for case normalization utilities
 */

import { snakeToCamel, camelToSnake } from '../caseNormalizer';

describe('caseNormalizer', () => {
  describe('snakeToCamel', () => {
    test('converts simple snake_case keys to camelCase', () => {
      const input = {
        session_id: 123,
        game_type: 'Blackjack',
        initial_state: 'abc',
      };

      const expected = {
        sessionId: 123,
        gameType: 'Blackjack',
        initialState: 'abc',
      };

      expect(snakeToCamel(input)).toEqual(expected);
    });

    test('handles nested objects', () => {
      const input = {
        player_data: {
          active_shield: true,
          active_double: false,
          final_chips: 1000,
        },
      };

      const expected = {
        playerData: {
          activeShield: true,
          activeDouble: false,
          finalChips: 1000,
        },
      };

      expect(snakeToCamel(input)).toEqual(expected);
    });

    test('handles arrays', () => {
      const input = {
        events: [
          { session_id: 1, was_shielded: true },
          { session_id: 2, was_doubled: false },
        ],
      };

      const expected = {
        events: [
          { sessionId: 1, wasShielded: true },
          { sessionId: 2, wasDoubled: false },
        ],
      };

      expect(snakeToCamel(input)).toEqual(expected);
    });

    test('preserves Uint8Array', () => {
      const input = {
        player_key: new Uint8Array([1, 2, 3]),
        session_id: 456,
      };

      const result = snakeToCamel(input);
      expect(result.sessionId).toBe(456);
      expect(result.playerKey).toBeInstanceOf(Uint8Array);
      expect(Array.from(result.playerKey)).toEqual([1, 2, 3]);
    });

    test('handles primitives', () => {
      expect(snakeToCamel(123)).toBe(123);
      expect(snakeToCamel('test')).toBe('test');
      expect(snakeToCamel(true)).toBe(true);
      expect(snakeToCamel(null)).toBe(null);
    });

    test('handles complete Player state example', () => {
      const input = {
        type: 'CasinoPlayer',
        name: 'Alice',
        chips: 5000n,
        shields: 3,
        doubles: 2,
        active_shield: true,
        active_double: false,
        active_session: 789n,
      };

      const result = snakeToCamel(input);
      expect(result.activeShield).toBe(true);
      expect(result.activeDouble).toBe(false);
      expect(result.activeSession).toBe(789n);
    });

    test('handles CasinoGameCompleted event example', () => {
      const input = {
        type: 'CasinoGameCompleted',
        session_id: 123n,
        game_type: 'Blackjack',
        payout: 2000n,
        final_chips: 7000n,
        was_shielded: true,
        was_doubled: false,
      };

      const result = snakeToCamel(input);
      expect(result.sessionId).toBe(123n);
      expect(result.gameType).toBe('Blackjack');
      expect(result.finalChips).toBe(7000n);
      expect(result.wasShielded).toBe(true);
      expect(result.wasDoubled).toBe(false);
    });
  });

  describe('camelToSnake', () => {
    test('converts simple camelCase keys to snake_case', () => {
      const input = {
        sessionId: 123,
        gameType: 'Blackjack',
        initialState: 'abc',
      };

      const expected = {
        session_id: 123,
        game_type: 'Blackjack',
        initial_state: 'abc',
      };

      expect(camelToSnake(input)).toEqual(expected);
    });

    test('is inverse of snakeToCamel', () => {
      const original = {
        session_id: 123,
        active_shield: true,
        was_doubled: false,
      };

      const roundTrip = camelToSnake(snakeToCamel(original));
      expect(roundTrip).toEqual(original);
    });
  });
});
