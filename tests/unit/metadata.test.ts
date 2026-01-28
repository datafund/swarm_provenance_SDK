import { describe, it, expect } from 'vitest';
import {
  buildMetadata,
  extractContent,
  verifyContentHash,
  serializeMetadata,
  parseMetadata,
} from '../../src/metadata.js';
import { sha256Hex, bytesToBase64 } from '../../src/utils.js';

describe('buildMetadata', () => {
  it('should create metadata with correct hash', () => {
    const content = 'Hello, World!';
    const stampId = 'stamp123';

    const metadata = buildMetadata(content, { stampId });

    expect(metadata.stamp_id).toBe(stampId);
    expect(metadata.content_hash).toBe(sha256Hex(content));
  });

  it('should encode content as base64', () => {
    const content = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    const stampId = 'stamp123';

    const metadata = buildMetadata(content, { stampId });

    expect(metadata.data).toBe(bytesToBase64(content));
    expect(metadata.data).toBe('SGVsbG8=');
  });

  it('should include optional standard', () => {
    const content = 'test';
    const stampId = 'stamp123';
    const standard = 'provenance-v1';

    const metadata = buildMetadata(content, { stampId, standard });

    expect(metadata.provenance_standard).toBe(standard);
  });

  it('should include optional encryption', () => {
    const content = 'test';
    const stampId = 'stamp123';
    const encryption = 'aes-256-gcm';

    const metadata = buildMetadata(content, { stampId, encryption });

    expect(metadata.encryption).toBe(encryption);
  });

  it('should not include undefined optional fields', () => {
    const content = 'test';
    const stampId = 'stamp123';

    const metadata = buildMetadata(content, { stampId });

    expect('provenance_standard' in metadata).toBe(false);
    expect('encryption' in metadata).toBe(false);
  });

  it('should handle empty content', () => {
    const content = '';
    const stampId = 'stamp123';

    const metadata = buildMetadata(content, { stampId });

    expect(metadata.data).toBe('');
    expect(metadata.content_hash).toBe(sha256Hex(''));
  });

  it('should handle binary content', () => {
    const content = new Uint8Array([0, 128, 255, 1, 2, 3]);
    const stampId = 'stamp123';

    const metadata = buildMetadata(content, { stampId });

    expect(metadata.content_hash).toBe(sha256Hex(content));
  });
});

describe('extractContent', () => {
  it('should decode base64 content', () => {
    const metadata = {
      data: 'SGVsbG8=',
      content_hash: 'ignored',
      stamp_id: 'stamp123',
    };

    const content = extractContent(metadata);

    expect(Array.from(content)).toEqual([72, 101, 108, 108, 111]);
  });

  it('should handle empty content', () => {
    const metadata = {
      data: '',
      content_hash: sha256Hex(''),
      stamp_id: 'stamp123',
    };

    const content = extractContent(metadata);

    expect(content.length).toBe(0);
  });
});

describe('verifyContentHash', () => {
  it('should return true for valid hash', () => {
    const originalContent = 'Hello, World!';
    const metadata = buildMetadata(originalContent, { stampId: 'stamp123' });

    expect(verifyContentHash(metadata)).toBe(true);
  });

  it('should return false for tampered content', () => {
    const metadata = {
      data: bytesToBase64(new TextEncoder().encode('Hello, World!')),
      content_hash: 'wrong_hash_here',
      stamp_id: 'stamp123',
    };

    expect(verifyContentHash(metadata)).toBe(false);
  });

  it('should return false for modified data', () => {
    const originalContent = 'Hello, World!';
    const metadata = buildMetadata(originalContent, { stampId: 'stamp123' });

    // Tamper with the data
    metadata.data = bytesToBase64(new TextEncoder().encode('Goodbye, World!'));

    expect(verifyContentHash(metadata)).toBe(false);
  });
});

describe('serializeMetadata', () => {
  it('should produce valid JSON', () => {
    const metadata = buildMetadata('test', { stampId: 'stamp123' });

    const json = serializeMetadata(metadata);
    const parsed: unknown = JSON.parse(json);

    expect(parsed).toBeDefined();
  });

  it('should include all fields', () => {
    const metadata = buildMetadata('test', {
      stampId: 'stamp123',
      standard: 'v1',
      encryption: 'aes',
    });

    const json = serializeMetadata(metadata);
    const parsed = JSON.parse(json) as Record<string, unknown>;

    expect(parsed['data']).toBe(metadata.data);
    expect(parsed['content_hash']).toBe(metadata.content_hash);
    expect(parsed['stamp_id']).toBe(metadata.stamp_id);
    expect(parsed['provenance_standard']).toBe(metadata.provenance_standard);
    expect(parsed['encryption']).toBe(metadata.encryption);
  });
});

describe('parseMetadata', () => {
  it('should parse valid metadata', () => {
    const original = buildMetadata('test', { stampId: 'stamp123' });
    const json = serializeMetadata(original);

    const parsed = parseMetadata(json);

    expect(parsed.data).toBe(original.data);
    expect(parsed.content_hash).toBe(original.content_hash);
    expect(parsed.stamp_id).toBe(original.stamp_id);
  });

  it('should parse metadata with optional fields', () => {
    const original = buildMetadata('test', {
      stampId: 'stamp123',
      standard: 'v1',
      encryption: 'aes',
    });
    const json = serializeMetadata(original);

    const parsed = parseMetadata(json);

    expect(parsed.provenance_standard).toBe('v1');
    expect(parsed.encryption).toBe('aes');
  });

  it('should throw on invalid JSON', () => {
    expect(() => parseMetadata('not json')).toThrow();
  });

  it('should throw on missing data field', () => {
    const json = JSON.stringify({ content_hash: 'abc', stamp_id: 'x' });
    expect(() => parseMetadata(json)).toThrow('missing or invalid data field');
  });

  it('should throw on missing content_hash field', () => {
    const json = JSON.stringify({ data: 'abc', stamp_id: 'x' });
    expect(() => parseMetadata(json)).toThrow('missing or invalid content_hash field');
  });

  it('should throw on missing stamp_id field', () => {
    const json = JSON.stringify({ data: 'abc', content_hash: 'x' });
    expect(() => parseMetadata(json)).toThrow('missing or invalid stamp_id field');
  });
});

describe('round-trip', () => {
  it('should preserve content through metadata round-trip', () => {
    const originalContent = 'Hello, World! This is test content.';
    const stampId = 'test-stamp-id-12345';

    const metadata = buildMetadata(originalContent, { stampId, standard: 'v1' });
    const json = serializeMetadata(metadata);
    const parsed = parseMetadata(json);
    const extracted = extractContent(parsed);

    expect(new TextDecoder().decode(extracted)).toBe(originalContent);
    expect(verifyContentHash(parsed)).toBe(true);
  });

  it('should preserve binary content through round-trip', () => {
    const originalContent = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
    const stampId = 'stamp';

    const metadata = buildMetadata(originalContent, { stampId });
    const json = serializeMetadata(metadata);
    const parsed = parseMetadata(json);
    const extracted = extractContent(parsed);

    expect(Array.from(extracted)).toEqual(Array.from(originalContent));
    expect(verifyContentHash(parsed)).toBe(true);
  });
});
