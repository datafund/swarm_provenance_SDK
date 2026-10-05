import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import type { NotarySignature, ProvenanceMetadata, DocumentMetadata, SignatureCheck } from './types.js';
import { sha256Hex, isAddress } from './utils.js';
import { VerificationError } from './errors.js';
import { canonicalizeJsonValue } from './canonical-json.js';

/**
 * Notary signature scheme, as produced by the gateway (swarm_connect
 * app/services/provenance.py + signing.py):
 *
 *   data_hash = sha256(canonical JSON of the document's `data` field)
 *   message   = `${data_hash}|${timestamp}`
 *   signature = EIP-191 personal_sign(message) by the notary key
 *
 * Verification fails closed: anything not exactly this scheme, any signature
 * that does not recover, and any check without an expected signer is invalid.
 */
export const NOTARY_SIGNATURE_TYPE = 'notary';
export const NOTARY_HASHED_FIELDS: readonly string[] = ['data'];
export const NOTARY_MESSAGE_FORMAT = '{data_hash}|{timestamp}';


const SIGNATURE = /^(?:0x)?([0-9a-fA-F]{128})([0-9a-fA-F]{2})$/;

/**
 * Reconstruct the message the notary signed. Only the gateway's format is
 * accepted: the format string comes from the document, and honouring an
 * arbitrary one would let a forger point it at any other message the notary
 * key ever signed (with no placeholders, data_hash would not be bound at all).
 */
export function reconstructSignedMessage(signature: NotarySignature): string {
  if (signature.signed_message_format !== NOTARY_MESSAGE_FORMAT) {
    throw new VerificationError(
      `Unsupported signed_message_format: ${JSON.stringify(signature.signed_message_format)}`,
      'UNSUPPORTED_SIGNATURE'
    );
  }
  return `${signature.data_hash}|${signature.timestamp}`;
}

/**
 * SHA-256 of the canonical JSON of the document's `data` field, as the notary
 * computes it. Pass `canonicalData` (from canonicalizeJsonText on the response
 * text) when available: it is exact for floats and large integers, which a
 * parsed value can no longer reproduce.
 */
export function computeNotaryDataHash(
  metadata: Pick<ProvenanceMetadata | DocumentMetadata, 'data'>,
  canonicalData?: string
): string {
  return sha256Hex(canonicalData ?? canonicalizeJsonValue(metadata.data));
}

/** SHA-256 of the canonical data, or undefined (never throws) if `data` cannot be hashed. */
function safeDataHash(
  metadata: Pick<ProvenanceMetadata | DocumentMetadata, 'data'> | undefined,
  canonicalData?: string
): string | undefined {
  try {
    if (canonicalData !== undefined) return sha256Hex(canonicalData);
    return metadata?.data === undefined ? undefined : sha256Hex(canonicalizeJsonValue(metadata.data));
  } catch {
    return undefined; // data not representable as JSON, or nested too deep
  }
}

/**
 * Verify that the signature's data_hash matches the document's `data` field.
 * Only `hashed_fields: ['data']` (the gateway's scheme) is supported.
 */
export function verifyDataHash(
  signature: NotarySignature,
  metadata: Pick<ProvenanceMetadata | DocumentMetadata, 'data'>,
  canonicalData?: string
): boolean {
  const dataHash = safeDataHash(metadata, canonicalData);
  return isNotaryScheme(signature) && dataHash !== undefined && signature.data_hash === dataHash;
}

/**
 * Recover the signer address from an EIP-191 personal_sign signature.
 *
 * @param message - The message that was signed (before the EIP-191 prefix)
 * @param signature - 65-byte r || s || v hex, with or without 0x; v is 27/28 or 0/1
 * @returns Lowercase 0x-prefixed address
 * @throws VerificationError (INVALID_SIGNATURE) if the signature is malformed,
 *   uses a high s value (EIP-2), or does not recover
 */
export function recoverSigner(message: string, signature: string): string {
  const match = SIGNATURE.exec(typeof signature === 'string' ? signature : '');
  if (!match) {
    throw new VerificationError('Invalid signature: expected 65 bytes of hex (r || s || v)', 'INVALID_SIGNATURE');
  }
  const v = parseInt(match[2]!, 16);
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) {
    throw new VerificationError(`Invalid signature: v must be 27, 28, 0 or 1, got ${v}`, 'INVALID_SIGNATURE');
  }

  const body = utf8ToBytes(message);
  const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${body.length}`);
  const prefixed = new Uint8Array(prefix.length + body.length);
  prefixed.set(prefix);
  prefixed.set(body, prefix.length);
  const digest = keccak_256(prefixed);

  try {
    const sig = secp256k1.Signature.fromCompact(match[1]!);
    if (sig.hasHighS()) {
      throw new Error('high s value (non-canonical, EIP-2)');
    }
    const publicKey = sig.addRecoveryBit(recovery).recoverPublicKey(digest).toRawBytes(false);
    return '0x' + bytesToHex(keccak_256(publicKey.subarray(1)).subarray(12));
  } catch (e) {
    throw new VerificationError(
      `Invalid signature: ${e instanceof Error ? e.message : String(e)}`,
      'INVALID_SIGNATURE'
    );
  }
}

function isNotaryScheme(signature: NotarySignature): boolean {
  return (
    typeof signature === 'object' &&
    signature !== null &&
    signature.type === NOTARY_SIGNATURE_TYPE &&
    Array.isArray(signature.hashed_fields) &&
    signature.hashed_fields.length === NOTARY_HASHED_FIELDS.length &&
    signature.hashed_fields.every((field, i) => field === NOTARY_HASHED_FIELDS[i]) &&
    signature.signed_message_format === NOTARY_MESSAGE_FORMAT &&
    typeof signature.data_hash === 'string' &&
    typeof signature.timestamp === 'string' &&
    signature.timestamp.length > 0 &&
    typeof signature.signer === 'string' &&
    typeof signature.signature === 'string'
  );
}

/**
 * Verify one notary signature against an expected signer. Fails closed:
 * valid only if the scheme is the gateway's, the data hash matches, the
 * signature recovers to `expectedSigner`, and the declared signer is the same.
 *
 * @param expectedSigner - The notary address to trust. Without one the result
 *   is always invalid: a signature can only prove who signed, not whether that
 *   signer should be trusted.
 * @param canonicalData - Exact canonical JSON of `data` (see computeNotaryDataHash)
 */
export function verifySignature(
  signature: NotarySignature,
  metadata: Pick<ProvenanceMetadata | DocumentMetadata, 'data'>,
  expectedSigner?: string,
  canonicalData?: string
): SignatureResult {
  return checkSignature(signature, safeDataHash(metadata, canonicalData), expectedSigner);
}

type SignatureResult = {
  valid: boolean;
  dataHashValid: boolean;
  signerValid?: boolean;
  recoveredAddress?: string;
  error?: string;
};

/** verifySignature against an already computed data hash (undefined: data could not be hashed). */
function checkSignature(signature: NotarySignature, dataHash: string | undefined, expectedSigner?: string): SignatureResult {
  // Compared regardless of scheme, so an unsupported signature over the right
  // data is not reported as tampered data
  const dataHashValid =
    dataHash !== undefined && typeof signature === 'object' && signature !== null && signature.data_hash === dataHash;

  if (!isNotaryScheme(signature)) {
    return { valid: false, dataHashValid, error: 'Unsupported or malformed signature (expected the gateway notary scheme)' };
  }
  if (!dataHashValid) {
    return { valid: false, dataHashValid: false, error: 'Data hash mismatch' };
  }
  if (expectedSigner === undefined || expectedSigner === '') {
    return { valid: false, dataHashValid: true, error: 'No expected signer address to verify against' };
  }
  if (!isAddress(expectedSigner)) {
    return { valid: false, dataHashValid: true, error: `Expected signer is not a valid address: ${JSON.stringify(expectedSigner)}` };
  }

  let recoveredAddress: string;
  try {
    recoveredAddress = recoverSigner(reconstructSignedMessage(signature), signature.signature);
  } catch (e) {
    return { valid: false, dataHashValid: true, signerValid: false, error: e instanceof Error ? e.message : String(e) };
  }

  const expected = expectedSigner.toLowerCase();
  if (recoveredAddress !== expected) {
    return {
      valid: false,
      dataHashValid: true,
      signerValid: false,
      recoveredAddress,
      error: `Signature recovers to ${recoveredAddress}, expected ${expected}`,
    };
  }
  if (signature.signer.toLowerCase() !== expected) {
    return {
      valid: false,
      dataHashValid: true,
      signerValid: false,
      recoveredAddress,
      error: `Declared signer ${signature.signer} does not match the signature`,
    };
  }
  return { valid: true, dataHashValid: true, signerValid: true, recoveredAddress };
}

/**
 * Verify every signature on a document against `expectedSigner`.
 *
 * - `anyValid`: at least one signature by the expected signer covers this exact
 *   data. This is what download() reports as `verified`: each valid signature
 *   binds the data on its own, and the gateway appends its signature to any the
 *   uploader supplied (other types, or an earlier notary key), which cannot be
 *   checked against the same signer.
 * - `allValid`: at least one signature, and every one valid.
 */
export function verifyAllSignatures(
  signatures: NotarySignature[],
  metadata: Pick<ProvenanceMetadata | DocumentMetadata, 'data'>,
  expectedSigner?: string,
  canonicalData?: string
): { allValid: boolean; anyValid: boolean; results: SignatureCheck[] } {
  // Canonicalise and hash the data once, not once per signature
  const dataHash = safeDataHash(metadata, canonicalData);
  const results = (Array.isArray(signatures) ? signatures : []).map((sig, index) => {
    const result = checkSignature(sig, dataHash, expectedSigner);
    const item: SignatureCheck = { index, valid: result.valid, dataHashValid: result.dataHashValid };
    if (result.recoveredAddress !== undefined) item.recoveredAddress = result.recoveredAddress;
    if (result.error !== undefined) item.error = result.error;
    return item;
  });

  return {
    allValid: results.length > 0 && results.every((r) => r.valid),
    anyValid: results.some((r) => r.valid),
    results,
  };
}
