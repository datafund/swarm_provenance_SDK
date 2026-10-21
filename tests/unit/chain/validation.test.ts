import { describe, it, expect } from 'vitest';
import {
  normalizeHash,
  validateAddress,
  validateDataType,
  validateDescription,
  normalizeRegisteredHash,
  normalizeStorageRef,
  validateStatus,
  validateCount,
} from '../../../src/chain/validation.js';
import { ChainValidationError } from '../../../src/chain/errors.js';

describe('normalizeHash', () => {
  const validHash64 = 'a'.repeat(64);
  const validHash0x = `0x${'a'.repeat(64)}`;

  it('should accept 0x-prefixed bytes32 hash', () => {
    expect(normalizeHash(validHash0x)).toBe(validHash0x);
  });

  it('should add 0x prefix to bare 64-char hex hash', () => {
    expect(normalizeHash(validHash64)).toBe(`0x${validHash64}`);
  });

  it('should accept mixed case hex', () => {
    const mixed = `0x${'aAbBcCdDeEfF'.repeat(5)}aAbB`;
    expect(normalizeHash(mixed)).toBe(mixed);
  });

  it('should throw for too-short hash', () => {
    expect(() => normalizeHash('0xabc')).toThrow(ChainValidationError);
  });

  it('should throw for too-long hash', () => {
    expect(() => normalizeHash(`0x${'a'.repeat(66)}`)).toThrow(ChainValidationError);
  });

  it('should throw for non-hex characters', () => {
    expect(() => normalizeHash(`0x${'g'.repeat(64)}`)).toThrow(ChainValidationError);
  });

  it('should throw for empty string', () => {
    expect(() => normalizeHash('')).toThrow(ChainValidationError);
  });
});

describe('validateAddress', () => {
  it('should accept valid address', () => {
    expect(() => validateAddress('0x' + 'a'.repeat(40))).not.toThrow();
  });

  it('should throw for short address', () => {
    expect(() => validateAddress('0x' + 'a'.repeat(39))).toThrow(ChainValidationError);
  });

  it('should throw for no prefix', () => {
    expect(() => validateAddress('a'.repeat(40))).toThrow(ChainValidationError);
  });
});

describe('validateDataType', () => {
  it('should accept non-empty string', () => {
    expect(() => validateDataType('dataset')).not.toThrow();
  });

  it('should throw for empty string', () => {
    expect(() => validateDataType('')).toThrow(ChainValidationError);
  });

  it('should throw for whitespace-only string', () => {
    expect(() => validateDataType('   ')).toThrow(ChainValidationError);
  });
});

describe('contract limits (#123)', () => {
  it('validateDataType accepts exactly 64 UTF-8 bytes and refuses 65', () => {
    expect(() => validateDataType('a'.repeat(64))).not.toThrow();
    expect(() => validateDataType('a'.repeat(65))).toThrow(ChainValidationError);
    expect(() => validateDataType('é'.repeat(32))).not.toThrow(); // 64 bytes
    expect(() => validateDataType('é'.repeat(33))).toThrow(/66 bytes/);
  });

  it('validateDescription accepts 1 to 256 UTF-8 bytes', () => {
    expect(() => validateDescription('d')).not.toThrow();
    expect(() => validateDescription('d'.repeat(256))).not.toThrow();
    expect(() => validateDescription('')).toThrow(ChainValidationError);
    expect(() => validateDescription('d'.repeat(257))).toThrow(ChainValidationError);
  });

  it('normalizeRegisteredHash refuses the zero hash; normalizeHash still accepts it', () => {
    expect(() => normalizeRegisteredHash('0'.repeat(64))).toThrow(/zero hash/);
    expect(normalizeHash('0'.repeat(64))).toBe(`0x${'0'.repeat(64)}`);
  });

  it('normalizeStorageRef explains why an encrypted reference is refused', () => {
    expect(() => normalizeStorageRef('a'.repeat(128))).toThrow(/encrypted/);
    expect(() => normalizeStorageRef('not-a-hash')).toThrow(/Invalid data hash/);
    expect(normalizeStorageRef('a'.repeat(64))).toBe(`0x${'a'.repeat(64)}`);
  });

  it('validateStatus accepts 0, 1 and 2 only', () => {
    [0, 1, 2].forEach((s) => expect(() => validateStatus(s)).not.toThrow());
    [3, -1, 0.5, '1', undefined].forEach((s) => expect(() => validateStatus(s)).toThrow(ChainValidationError));
  });

  it('validateCount accepts non-negative safe integers only', () => {
    expect(() => validateCount(0, 'offset')).not.toThrow();
    expect(() => validateCount(Number.MAX_SAFE_INTEGER, 'offset')).not.toThrow();
    [-1, 1.5, Number.NaN, Infinity, 2 ** 60, '3'].forEach((v) => expect(() => validateCount(v, 'offset')).toThrow(ChainValidationError));
  });
});
