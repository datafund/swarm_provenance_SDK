import type { Hex } from './types.js';
import { ChainValidationError } from './errors.js';

/** Regex for a 0x-prefixed hex string of exactly 64 hex chars (bytes32) */
const BYTES32_REGEX = /^0x[0-9a-fA-F]{64}$/;

/** Regex for a hex string of exactly 64 hex chars (no 0x prefix) */
const HASH_NO_PREFIX_REGEX = /^[0-9a-fA-F]{64}$/;

/**
 * Normalize a data hash to 0x-prefixed bytes32.
 * Accepts both "0xabc..." and bare "abc..." formats.
 */
export function normalizeHash(hash: string): Hex {
  if (BYTES32_REGEX.test(hash)) {
    return hash as Hex;
  }

  if (HASH_NO_PREFIX_REGEX.test(hash)) {
    return `0x${hash}`;
  }

  throw new ChainValidationError(
    `Invalid data hash: expected 64 hex characters (with or without 0x prefix), got "${hash}"`
  );
}

/**
 * Validate that a string is a valid Ethereum address (0x + 40 hex chars).
 */
export function validateAddress(address: string): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new ChainValidationError(`Invalid Ethereum address: "${address}"`);
  }
}

/**
 * Validate a data type string is non-empty.
 */
export function validateDataType(dataType: string): void {
  if (!dataType || dataType.trim().length === 0) {
    throw new ChainValidationError('Data type must not be empty');
  }
}
