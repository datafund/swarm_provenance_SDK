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

describe('verifyDataHash', () => {
  it('should return true when hash matches content_hash', () => {
    const content = 'Hello, World!';
    const metadata = buildMetadata(content, { stampId: 'stamp123' });

    const signature: NotarySignature = {
      type: 'eip191',
      signer: '0x1234567890123456789012345678901234567890',
      timestamp: '2024-01-01T00:00:00Z',
      data_hash: sha256Hex(metadata.content_hash),
      signature: '0xsignature',
      hashed_fields: ['content_hash'],
      signed_message_format: 'Provenance Notary\nTimestamp: {timestamp}\nData Hash: {data_hash}',
    };

    expect(verifyDataHash(signature, metadata)).toBe(true);
  });

  it('should return false when hash does not match', () => {
    const metadata = buildMetadata('Hello', { stampId: 'stamp123' });

    const signature: NotarySignature = {
      type: 'eip191',
      signer: '0x1234567890123456789012345678901234567890',
      timestamp: '2024-01-01T00:00:00Z',
      data_hash: 'wrong_hash_value',
      signature: '0xsignature',
      hashed_fields: ['content_hash'],
      signed_message_format: 'Provenance Notary\nTimestamp: {timestamp}\nData Hash: {data_hash}',
    };

    expect(verifyDataHash(signature, metadata)).toBe(false);
  });

  it('should handle multiple hashed fields', () => {
    const metadata = buildMetadata('test', { stampId: 'stamp123', standard: 'v1' });

    // Hash of content_hash + stamp_id concatenated
    const expectedHash = sha256Hex(metadata.content_hash + metadata.stamp_id);

    const signature: NotarySignature = {
      type: 'eip191',
      signer: '0x1234567890123456789012345678901234567890',
      timestamp: '2024-01-01T00:00:00Z',
      data_hash: expectedHash,
      signature: '0xsignature',
      hashed_fields: ['content_hash', 'stamp_id'],
      signed_message_format: 'Provenance Notary\nTimestamp: {timestamp}\nData Hash: {data_hash}',
    };

    expect(verifyDataHash(signature, metadata)).toBe(true);
  });
});

describe('reconstructSignedMessage', () => {
  it('should reconstruct message with timestamp and hash', () => {
    const metadata = buildMetadata('test', { stampId: 'stamp123' });

    const signature: NotarySignature = {
      type: 'eip191',
      signer: '0x1234567890123456789012345678901234567890',
      timestamp: '2024-01-15T10:30:00Z',
      data_hash: 'abc123',
      signature: '0xsig',
      hashed_fields: ['content_hash'],
      signed_message_format: 'Provenance Notary\nTimestamp: {timestamp}\nData Hash: {data_hash}',
    };

    const message = reconstructSignedMessage(signature, metadata);

    expect(message).toBe('Provenance Notary\nTimestamp: 2024-01-15T10:30:00Z\nData Hash: abc123');
  });
});

describe('verifySignature', () => {
  const createValidSignature = (metadata: ProvenanceMetadata): NotarySignature => ({
    type: 'eip191',
    signer: '0xNotaryAddress123',
    timestamp: '2024-01-01T00:00:00Z',
    data_hash: sha256Hex(metadata.content_hash),
    signature: '0xvalidSignature',
    hashed_fields: ['content_hash'],
    signed_message_format: 'Provenance Notary\nTimestamp: {timestamp}\nData Hash: {data_hash}',
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
    type: 'eip191',
    signer,
    timestamp: '2024-01-01T00:00:00Z',
    data_hash: valid ? sha256Hex(metadata.content_hash) : 'invalid_hash',
    signature: '0xsig',
    hashed_fields: ['content_hash'],
    signed_message_format: 'Provenance Notary\nTimestamp: {timestamp}\nData Hash: {data_hash}',
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
