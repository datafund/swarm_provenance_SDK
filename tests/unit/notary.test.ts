import { describe, it, expect } from 'vitest';
import {
  verifyDataHash,
  verifySignature,
  verifyAllSignatures,
  reconstructSignedMessage,
} from '../../src/notary.js';
import { buildMetadata } from '../../src/metadata.js';
import { sha256Hex } from '../../src/utils.js';
import type { NotarySignature, ProvenanceMetadata } from '../../src/types.js';

/**
 * Compute the expected data_hash as the gateway does:
 * SHA-256 of canonical JSON (sorted keys, no whitespace)
 */
function computeDataHash(value: unknown): string {
  const canonicalJson = toCanonicalJson(value);
  return sha256Hex(canonicalJson);
}

function toCanonicalJson(value: unknown): string {
  if (value === null || value === undefined) {
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(toCanonicalJson).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const pairs = keys.map(
    (k) => JSON.stringify(k) + ':' + toCanonicalJson((value as Record<string, unknown>)[k])
  );
  return '{' + pairs.join(',') + '}';
}

describe('verifyDataHash', () => {
  it('should return true when hash matches data field (gateway format)', () => {
    const content = 'Hello, World!';
    const metadata = buildMetadata(content, { stampId: 'stamp123' });

    // Gateway uses hashed_fields: ['data'] and hashes canonical JSON of the data field
    const signature: NotarySignature = {
      type: 'notary',
      signer: '0x1234567890123456789012345678901234567890',
      timestamp: '2024-01-01T00:00:00Z',
      data_hash: computeDataHash(metadata.data),
      signature: '0xsignature',
      hashed_fields: ['data'],
      signed_message_format: '{data_hash}|{timestamp}',
    };

    expect(verifyDataHash(signature, metadata)).toBe(true);
  });

  it('should return false when hash does not match', () => {
    const metadata = buildMetadata('Hello', { stampId: 'stamp123' });

    const signature: NotarySignature = {
      type: 'notary',
      signer: '0x1234567890123456789012345678901234567890',
      timestamp: '2024-01-01T00:00:00Z',
      data_hash: 'wrong_hash_value',
      signature: '0xsignature',
      hashed_fields: ['data'],
      signed_message_format: '{data_hash}|{timestamp}',
    };

    expect(verifyDataHash(signature, metadata)).toBe(false);
  });

  it('should handle multiple hashed fields', () => {
    const metadata = buildMetadata('test', { stampId: 'stamp123', standard: 'v1' });

    // When multiple fields, hash canonical JSON of object with those fields
    const expectedHash = computeDataHash({
      content_hash: metadata.content_hash,
      stamp_id: metadata.stamp_id,
    });

    const signature: NotarySignature = {
      type: 'notary',
      signer: '0x1234567890123456789012345678901234567890',
      timestamp: '2024-01-01T00:00:00Z',
      data_hash: expectedHash,
      signature: '0xsignature',
      hashed_fields: ['content_hash', 'stamp_id'],
      signed_message_format: '{data_hash}|{timestamp}',
    };

    expect(verifyDataHash(signature, metadata)).toBe(true);
  });
});

describe('reconstructSignedMessage', () => {
  it('should reconstruct message with timestamp and hash', () => {
    const metadata = buildMetadata('test', { stampId: 'stamp123' });

    const signature: NotarySignature = {
      type: 'notary',
      signer: '0x1234567890123456789012345678901234567890',
      timestamp: '2024-01-15T10:30:00Z',
      data_hash: 'abc123',
      signature: '0xsig',
      hashed_fields: ['data'],
      signed_message_format: '{data_hash}|{timestamp}',
    };

    const message = reconstructSignedMessage(signature, metadata);

    expect(message).toBe('abc123|2024-01-15T10:30:00Z');
  });
});

describe('verifySignature', () => {
  const createValidSignature = (metadata: ProvenanceMetadata): NotarySignature => ({
    type: 'notary',
    signer: '0xNotaryAddress123',
    timestamp: '2024-01-01T00:00:00Z',
    data_hash: computeDataHash(metadata.data),
    signature: '0xvalidSignature',
    hashed_fields: ['data'],
    signed_message_format: '{data_hash}|{timestamp}',
  });

  it('should return valid=true when data hash matches', () => {
    const metadata = buildMetadata('test content', { stampId: 'stamp123' });
    const signature = createValidSignature(metadata);

    const result = verifySignature(signature, metadata);

    expect(result.valid).toBe(true);
    expect(result.dataHashValid).toBe(true);
  });

  it('should return valid=false when data hash does not match', () => {
    const metadata = buildMetadata('test content', { stampId: 'stamp123' });
    const signature = createValidSignature(metadata);
    signature.data_hash = 'tampered_hash';

    const result = verifySignature(signature, metadata);

    expect(result.valid).toBe(false);
    expect(result.dataHashValid).toBe(false);
    expect(result.error).toBe('Data hash mismatch');
  });

  it('should verify signer when expectedSigner is provided', () => {
    const metadata = buildMetadata('test', { stampId: 'stamp123' });
    const signature = createValidSignature(metadata);
    signature.signer = '0xCorrectSigner';

    const result = verifySignature(signature, metadata, '0xCorrectSigner');

    expect(result.valid).toBe(true);
    expect(result.signerValid).toBe(true);
  });

  it('should fail when signer does not match expected', () => {
    const metadata = buildMetadata('test', { stampId: 'stamp123' });
    const signature = createValidSignature(metadata);
    signature.signer = '0xWrongSigner';

    const result = verifySignature(signature, metadata, '0xExpectedSigner');

    expect(result.valid).toBe(false);
    expect(result.signerValid).toBe(false);
    expect(result.error).toContain('Signer mismatch');
  });

  it('should be case-insensitive for signer comparison', () => {
    const metadata = buildMetadata('test', { stampId: 'stamp123' });
    const signature = createValidSignature(metadata);
    signature.signer = '0xABCDEF';

    const result = verifySignature(signature, metadata, '0xabcdef');

    expect(result.valid).toBe(true);
    expect(result.signerValid).toBe(true);
  });
});

describe('verifyAllSignatures', () => {
  const createSignature = (
    metadata: ProvenanceMetadata,
    signer: string,
    valid: boolean
  ): NotarySignature => ({
    type: 'notary',
    signer,
    timestamp: '2024-01-01T00:00:00Z',
    data_hash: valid ? computeDataHash(metadata.data) : 'invalid_hash',
    signature: '0xsig',
    hashed_fields: ['data'],
    signed_message_format: '{data_hash}|{timestamp}',
  });

  it('should return allValid=true when all signatures are valid', () => {
    const metadata = buildMetadata('test', { stampId: 'stamp123' });
    const signatures = [
      createSignature(metadata, '0xSigner1', true),
      createSignature(metadata, '0xSigner2', true),
    ];

    const result = verifyAllSignatures(signatures, metadata);

    expect(result.allValid).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.valid).toBe(true);
    expect(result.results[1]?.valid).toBe(true);
  });

  it('should return allValid=false when any signature is invalid', () => {
    const metadata = buildMetadata('test', { stampId: 'stamp123' });
    const signatures = [
      createSignature(metadata, '0xSigner1', true),
      createSignature(metadata, '0xSigner2', false),
    ];

    const result = verifyAllSignatures(signatures, metadata);

    expect(result.allValid).toBe(false);
    expect(result.results[0]?.valid).toBe(true);
    expect(result.results[1]?.valid).toBe(false);
  });

  it('should handle empty signatures array', () => {
    const metadata = buildMetadata('test', { stampId: 'stamp123' });

    const result = verifyAllSignatures([], metadata);

    expect(result.allValid).toBe(true);
    expect(result.results).toHaveLength(0);
  });

  it('should verify against expected signer', () => {
    const metadata = buildMetadata('test', { stampId: 'stamp123' });
    const signatures = [createSignature(metadata, '0xExpectedSigner', true)];

    const result = verifyAllSignatures(signatures, metadata, '0xExpectedSigner');

    expect(result.allValid).toBe(true);
  });

  it('should fail if signer does not match expected', () => {
    const metadata = buildMetadata('test', { stampId: 'stamp123' });
    const signatures = [createSignature(metadata, '0xWrongSigner', true)];

    const result = verifyAllSignatures(signatures, metadata, '0xExpectedSigner');

    expect(result.allValid).toBe(false);
    expect(result.results[0]?.error).toContain('Signer mismatch');
  });
});
