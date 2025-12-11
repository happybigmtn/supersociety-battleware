/**
 * Utility functions for normalizing JSON casing between Rust (snake_case) and TypeScript (camelCase)
 *
 * The Rust WASM bindings serialize data with snake_case field names, while TypeScript
 * expects camelCase. This utility provides conversion functions to normalize the data.
 *
 * Common conversions:
 * - session_id -> sessionId
 * - game_type -> gameType
 * - initial_state -> initialState
 * - new_state -> newState
 * - move_number -> moveNumber
 * - active_shield -> activeShield
 * - active_double -> activeDouble
 * - active_session -> activeSession
 * - was_shielded -> wasShielded
 * - was_doubled -> wasDoubled
 * - final_chips -> finalChips
 * - state_blob -> stateBlob
 * - move_count -> moveCount
 * - is_complete -> isComplete
 */

/**
 * Convert snake_case to camelCase for a single key
 */
function snakeToCamelKey(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Recursively convert all keys in an object from snake_case to camelCase
 * @param obj - Any value (object, array, primitive)
 * @returns The same value with all object keys converted to camelCase
 */
export function snakeToCamel(obj: any): any {
  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(snakeToCamel);
  }

  // Handle objects
  if (obj !== null && typeof obj === 'object') {
    // Special handling for Uint8Array and other typed arrays
    if (obj instanceof Uint8Array || ArrayBuffer.isView(obj)) {
      return obj;
    }

    // Convert all keys from snake_case to camelCase
    return Object.keys(obj).reduce((acc, key) => {
      const camelKey = snakeToCamelKey(key);
      acc[camelKey] = snakeToCamel(obj[key]);
      return acc;
    }, {} as any);
  }

  // Return primitives as-is
  return obj;
}

/**
 * Convert camelCase to snake_case for a single key
 */
function camelToSnakeKey(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Recursively convert all keys in an object from camelCase to snake_case
 * @param obj - Any value (object, array, primitive)
 * @returns The same value with all object keys converted to snake_case
 */
export function camelToSnake(obj: any): any {
  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(camelToSnake);
  }

  // Handle objects
  if (obj !== null && typeof obj === 'object') {
    // Special handling for Uint8Array and other typed arrays
    if (obj instanceof Uint8Array || ArrayBuffer.isView(obj)) {
      return obj;
    }

    // Convert all keys from camelCase to snake_case
    return Object.keys(obj).reduce((acc, key) => {
      const snakeKey = camelToSnakeKey(key);
      acc[snakeKey] = camelToSnake(obj[key]);
      return acc;
    }, {} as any);
  }

  // Return primitives as-is
  return obj;
}
