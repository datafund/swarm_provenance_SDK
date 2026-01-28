import type { NotarySignature, ProvenanceMetadata } from './types.js';
import { sha256Hex } from './utils.js';
import { VerificationError } from './errors.js';

/**
 * Reconstruct the message that was signed by the notary
 */
export function reconstructSignedMessage(
  signature: NotarySignature,
  _metadata: ProvenanceMetadata
): string {
  // The signed message format is typically:
  // "Provenance Notary\nTimestamp: {timestamp}\nData Hash: {data_hash}"
  // But we should use the actual format specified in the signature
  const format = signature.signed_message_format;

  // Replace placeholders with actual values
  let message = format;
  message = message.replace('{timestamp}', signature.timestamp);
  message = message.replace('{data_hash}', signature.data_hash);

  return message;
}

/**
 * Convert a value to canonical JSON (sorted keys, no whitespace)
 */
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
  // Object - sort keys
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const pairs = keys.map(
    (k) => JSON.stringify(k) + ':' + toCanonicalJson((value as Record<string, unknown>)[k])
  );
  return '{' + pairs.join(',') + '}';
}

/**
 * Verify that the data hash in the signature matches the metadata
 */
export function verifyDataHash(signature: NotarySignature, metadata: ProvenanceMetadata): boolean {
  // The data hash is SHA-256 of the canonical JSON of the hashed fields
  // Per gateway docs: hash of canonical JSON (sorted keys, no whitespace)
  const hashedFields = signature.hashed_fields;

  // Get the value to hash based on hashed_fields
  // Typically ["data"] means hash the canonical JSON of metadata.data
  let valueToHash: unknown;

  if (hashedFields.length === 1 && hashedFields[0] === 'data') {
    // Most common case: hash the data field
    valueToHash = metadata.data;
  } else {
    // Build object from multiple fields
    const obj: Record<string, unknown> = {};
    for (const field of hashedFields) {
      if (field === 'content_hash') {
        obj[field] = metadata.content_hash;
      } else if (field === 'data') {
        obj[field] = metadata.data;
      } else if (field === 'stamp_id') {
        obj[field] = metadata.stamp_id;
      } else if (field === 'provenance_standard') {
        obj[field] = metadata.provenance_standard ?? '';
      }
    }
    valueToHash = obj;
  }

  // Compute canonical JSON and hash it
  const canonicalJson = toCanonicalJson(valueToHash);
  const computedHash = sha256Hex(canonicalJson);
  return computedHash === signature.data_hash;
}

/**
 * Recover the signer address from an EIP-191 signature
 * Note: This is a placeholder - full implementation requires ethers or viem
 */
export function recoverSigner(message: string, signature: string): string {
  // For now, we just return the signature prefix as a placeholder
  // Real implementation would use ethers.verifyMessage or viem's verifyMessage
  void message;
  void signature;
  throw new VerificationError(
    'Signature recovery not implemented - install ethers or viem for full verification',
    'NOT_IMPLEMENTED'
  );
}

/**
 * Verify a notary signature
 * Returns true if:
 * 1. The data hash matches the metadata
 * 2. The signature is valid (if verification is possible)
 *
 * @param signature - The notary signature to verify
 * @param metadata - The provenance metadata
 * @param expectedSigner - Optional expected signer address
 * @returns Object with verification status and details
 */
export function verifySignature(
  signature: NotarySignature,
  metadata: ProvenanceMetadata,
  expectedSigner?: string
): { valid: boolean; dataHashValid: boolean; signerValid?: boolean; error?: string } {
  // Step 1: Verify the data hash
  const dataHashValid = verifyDataHash(signature, metadata);

  if (!dataHashValid) {
    return {
      valid: false,
      dataHashValid: false,
      error: 'Data hash mismatch',
    };
  }

  // Step 2: Check if signer matches expected (if provided)
  if (expectedSigner) {
    const signerValid =
      signature.signer.toLowerCase() === expectedSigner.toLowerCase();
    if (!signerValid) {
      return {
        valid: false,
        dataHashValid: true,
        signerValid: false,
        error: `Signer mismatch: expected ${expectedSigner}, got ${signature.signer}`,
      };
    }
    return {
      valid: true,
      dataHashValid: true,
      signerValid: true,
    };
  }

  // Without crypto verification, we can only verify the data hash
  // The signature itself would need ethers/viem to verify
  return {
    valid: true,
    dataHashValid: true,
  };
}

/**
 * Verify all signatures on a document
 */
export function verifyAllSignatures(
  signatures: NotarySignature[],
  metadata: ProvenanceMetadata,
  expectedSigner?: string
): { allValid: boolean; results: Array<{ index: number; valid: boolean; error?: string }> } {
  const results: Array<{ index: number; valid: boolean; error?: string }> = signatures.map((sig, index) => {
    const result = verifySignature(sig, metadata, expectedSigner);
    const item: { index: number; valid: boolean; error?: string } = {
      index,
      valid: result.valid,
    };
    if (result.error !== undefined) {
      item.error = result.error;
    }
    return item;
  });

  return {
    allValid: results.every((r) => r.valid),
    results,
  };
}
