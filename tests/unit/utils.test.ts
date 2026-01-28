import { describe, it, expect } from 'vitest';
import {
  toBytes,
  sha256Hex,
  bytesToBase64,
  base64ToBytes,
  isValidHex,
  isValidSwarmReference,
  normalizeReference,
} from '../../src/utils.js';

describe('toBytes', () => {
  it('should pass through Uint8Array unchanged', () => {
    const input = new Uint8Array([1, 2, 3, 4]);
    const result = toBytes(input);
    expect(result).toBe(input);
  });

  it('should convert ArrayBuffer to Uint8Array', () => {
    const buffer = new ArrayBuffer(4);
    const view = new Uint8Array(buffer);
    view[0] = 1;
    view[1] = 2;
    view[2] = 3;
    view[3] = 4;

    const result = toBytes(buffer);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([1, 2, 3, 4]);
  });

  it('should encode string as UTF-8', () => {
    const result = toBytes('hello');
    expect(Array.from(result)).toEqual([104, 101, 108, 108, 111]);
  });

  it('should handle unicode strings', () => {
    const result = toBytes('café');
    expect(result.length).toBe(5); // 4 ASCII + 2 bytes for é
  });

  it('should handle empty input', () => {
    expect(toBytes('').length).toBe(0);
    expect(toBytes(new Uint8Array(0)).length).toBe(0);
  });
});

describe('sha256Hex', () => {
  it('should compute correct hash for empty string', () => {
    // SHA256 of empty string is well-known
    const result = sha256Hex('');
    expect(result).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('should compute correct hash for "hello"', () => {
    const result = sha256Hex('hello');
    expect(result).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('should compute correct hash for "Hello, World!"', () => {
    const result = sha256Hex('Hello, World!');
    expect(result).toBe('dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f');
  });

  it('should handle Uint8Array input', () => {
    const bytes = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
    const result = sha256Hex(bytes);
    expect(result).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('should produce 64 character hex string', () => {
    const result = sha256Hex('test');
    expect(result.length).toBe(64);
    expect(/^[0-9a-f]+$/.test(result)).toBe(true);
  });
});

describe('bytesToBase64', () => {
  it('should encode empty array', () => {
    const result = bytesToBase64(new Uint8Array(0));
    expect(result).toBe('');
  });

  it('should encode simple bytes', () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    const result = bytesToBase64(bytes);
    expect(result).toBe('SGVsbG8=');
  });

  it('should encode binary data', () => {
    const bytes = new Uint8Array([0, 128, 255]);
    const result = bytesToBase64(bytes);
    expect(result).toBe('AID/');
  });
});

describe('base64ToBytes', () => {
  it('should decode empty string', () => {
    const result = base64ToBytes('');
    expect(result.length).toBe(0);
  });

  it('should decode simple string', () => {
    const result = base64ToBytes('SGVsbG8=');
    expect(Array.from(result)).toEqual([72, 101, 108, 108, 111]);
  });

  it('should decode binary data', () => {
    const result = base64ToBytes('AID/');
    expect(Array.from(result)).toEqual([0, 128, 255]);
  });
});

describe('base64 round-trip', () => {
  it('should round-trip text content', () => {
    const original = new Uint8Array([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100]);
    const encoded = bytesToBase64(original);
    const decoded = base64ToBytes(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it('should round-trip binary content', () => {
    const original = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      original[i] = i;
    }
    const encoded = bytesToBase64(original);
    const decoded = base64ToBytes(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });
});

describe('isValidHex', () => {
  it('should accept valid lowercase hex', () => {
    expect(isValidHex('abcdef0123456789')).toBe(true);
  });

  it('should accept valid uppercase hex', () => {
    expect(isValidHex('ABCDEF0123456789')).toBe(true);
  });

  it('should accept mixed case hex', () => {
    expect(isValidHex('AbCdEf')).toBe(true);
  });

  it('should reject non-hex characters', () => {
    expect(isValidHex('xyz')).toBe(false);
    expect(isValidHex('ghij')).toBe(false);
  });

  it('should reject empty string', () => {
    expect(isValidHex('')).toBe(false);
  });
});

describe('isValidSwarmReference', () => {
  it('should accept valid 64-char hex reference', () => {
    const ref = 'a'.repeat(64);
    expect(isValidSwarmReference(ref)).toBe(true);
  });

  it('should accept real swarm reference format', () => {
    const ref = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
    expect(isValidSwarmReference(ref)).toBe(true);
  });

  it('should reject too short reference', () => {
    const ref = 'a'.repeat(63);
    expect(isValidSwarmReference(ref)).toBe(false);
  });

  it('should reject too long reference', () => {
    const ref = 'a'.repeat(65);
    expect(isValidSwarmReference(ref)).toBe(false);
  });

  it('should reject non-hex reference', () => {
    const ref = 'g'.repeat(64);
    expect(isValidSwarmReference(ref)).toBe(false);
  });
});

describe('normalizeReference', () => {
  it('should lowercase uppercase reference', () => {
    const ref = 'A'.repeat(64);
    expect(normalizeReference(ref)).toBe('a'.repeat(64));
  });

  it('should trim whitespace', () => {
    const ref = '  ' + 'a'.repeat(64) + '  ';
    expect(normalizeReference(ref)).toBe('a'.repeat(64));
  });

  it('should handle mixed case with whitespace', () => {
    const ref = '  AbCdEf123456789AbCdEf123456789AbCdEf123456789AbCdEf123456789AbCd  ';
    expect(normalizeReference(ref)).toBe('abcdef123456789abcdef123456789abcdef123456789abcdef123456789abcd');
  });
});
