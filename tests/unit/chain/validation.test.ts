import { describe, it, expect } from 'vitest';
import { normalizeHash, validateAddress, validateDataType } from '../../../src/chain/validation.js';
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
