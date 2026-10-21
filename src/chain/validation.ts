import { getAddress } from 'viem';
import type { Address, Hex } from './types.js';
import { ChainValidationError } from './errors.js';
import { isAddress } from '../utils.js';

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
 * Validate an Ethereum address (0x + 40 hex characters) and return the form to
 * pass to viem (#123). All-lowercase is returned as is; all-uppercase (EIP-55:
 * no checksum) is returned in lowercase, because viem's encoder rejects it; a
 * mixed-case address must carry a valid EIP-55 checksum, as viem requires.
 */
export function normalizeAddress(address: string): Address {
  if (!isAddress(address)) {
    throw new ChainValidationError(`Invalid Ethereum address: "${address}"`);
  }
  const hex = address.slice(2);
  if (hex === hex.toLowerCase()) return address as Address;
  if (hex === hex.toUpperCase()) return `0x${hex.toLowerCase()}`;
  let checksummed: string | undefined;
  try {
    checksummed = getAddress(address);
  } catch {
    checksummed = undefined;
  }
  if (checksummed !== address) {
    throw new ChainValidationError(
      `Invalid Ethereum address: "${address}" is mixed case but its EIP-55 checksum is wrong. Use the checksummed form or all lowercase.`
    );
  }
  return address as Address;
}

/**
 * Validate that a string is a valid Ethereum address (0x + 40 hex chars; a
 * mixed-case address must have a valid EIP-55 checksum).
 */
export function validateAddress(address: string): void {
  normalizeAddress(address);
}

/** Longest data type the contract accepts, in UTF-8 bytes ("Data type too long") */
export const MAX_DATA_TYPE_BYTES = 64;
/** Longest transformation description the contract accepts, in UTF-8 bytes ("Transformation too long") */
export const MAX_DESCRIPTION_BYTES = 256;

const ZERO_HASH = `0x${'0'.repeat(64)}`;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Validate a data type string: non-empty and at most 64 UTF-8 bytes (the
 * contract's limit, confirmed on Base Sepolia).
 */
export function validateDataType(dataType: string): void {
  if (typeof dataType !== 'string' || dataType.trim().length === 0) {
    throw new ChainValidationError('Data type must not be empty');
  }
  const bytes = utf8Length(dataType);
  if (bytes > MAX_DATA_TYPE_BYTES) {
    throw new ChainValidationError(`Data type is ${bytes} bytes (UTF-8); the contract accepts at most ${MAX_DATA_TYPE_BYTES} bytes`);
  }
}

/** Validate a transformation description: non-empty and at most 256 UTF-8 bytes (the contract's limits) */
export function validateDescription(description: string): void {
  if (typeof description !== 'string' || description.length === 0) {
    throw new ChainValidationError('Transformation description must not be empty');
  }
  const bytes = utf8Length(description);
  if (bytes > MAX_DESCRIPTION_BYTES) {
    throw new ChainValidationError(
      `Transformation description is ${bytes} bytes (UTF-8); the contract accepts at most ${MAX_DESCRIPTION_BYTES} bytes`
    );
  }
}

/** normalizeHash, refusing the zero hash, which the contract does not register ("Invalid data hash") */
export function normalizeRegisteredHash(hash: string, what = 'data hash'): Hex {
  const normalized = normalizeHash(hash);
  if (normalized.toLowerCase() === ZERO_HASH) {
    throw new ChainValidationError(`Invalid ${what}: the zero hash cannot be registered`);
  }
  return normalized;
}

/**
 * Normalize a storage reference to bytes32. An encrypted Swarm reference (128
 * hex characters) gets its own message: the contract stores only 32 bytes.
 */
export function normalizeStorageRef(storageRef: string): Hex {
  if (typeof storageRef === 'string' && /^(?:0x)?[0-9a-fA-F]{128}$/.test(storageRef)) {
    throw new ChainValidationError(
      'Invalid storageRef: this is an encrypted Swarm reference (128 hex characters), which does not fit the contract\'s bytes32 storageRef. Use an unencrypted (64 hex) reference.'
    );
  }
  return normalizeHash(storageRef);
}

/** A storageRef must differ from the data hash it is linked to ("Storage ref cannot equal data hash") */
export function validateStorageRefFor(dataHash: Hex, storageRef: Hex | undefined): void {
  if (storageRef !== undefined && storageRef.toLowerCase() === dataHash.toLowerCase()) {
    throw new ChainValidationError(`Invalid storageRef: it must differ from the data hash ${dataHash}`);
  }
}

/** normalizeAddress, refusing the zero address (the contract reverts on it) */
export function normalizeNonZeroAddress(address: string, what: string): Address {
  const normalized = normalizeAddress(address);
  if (normalized.toLowerCase() === ZERO_ADDRESS) {
    throw new ChainValidationError(`Invalid ${what}: the zero address is not allowed`);
  }
  return normalized;
}

/** Throw if two hashes in the list are equal (case-insensitive) */
export function validateNoDuplicates(hashes: readonly string[], what: string): void {
  const seen = new Set<string>();
  for (const hash of hashes) {
    const key = hash.toLowerCase();
    if (seen.has(key)) throw new ChainValidationError(`Duplicate ${what}: ${hash}`);
    seen.add(key);
  }
}

/** A DataStatus value: the integers 0 (ACTIVE), 1 (RESTRICTED) or 2 (DELETED) */
export function validateStatus(status: unknown): void {
  if (status !== 0 && status !== 1 && status !== 2) {
    throw new ChainValidationError(`Invalid status ${String(status)}: expected 0 (ACTIVE), 1 (RESTRICTED) or 2 (DELETED)`);
  }
}

/** A non-negative safe integer (e.g. a pagination offset or limit) */
export function validateCount(value: unknown, what: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ChainValidationError(`Invalid ${what} ${String(value)}: expected a non-negative integer`);
  }
}
