import type { ProvenanceMetadata, DocumentMetadata } from './types.js';
import { sha256Hex, bytesToBase64, base64ToBytes, toBytes } from './utils.js';
import { canonicalizeJsonValue, notJsonError } from './canonical-json.js';
import { ProvenanceError, withCause } from './errors.js';

/**
 * Options for building provenance metadata
 */
export interface MetadataBuilderOptions {
  /** Postage stamp ID */
  stampId: string;
  /** Optional provenance standard identifier */
  standard?: string;
  /** Optional encryption method */
  encryption?: string;
}

/**
 * Build provenance metadata from file content
 */
export function buildMetadata(
  content: Uint8Array | ArrayBuffer | string,
  options: MetadataBuilderOptions
): ProvenanceMetadata {
  const bytes = toBytes(content);
  const contentHash = sha256Hex(bytes);
  const base64Data = bytesToBase64(bytes);

  const metadata: ProvenanceMetadata = {
    data: base64Data,
    content_hash: contentHash,
    stamp_id: options.stampId,
  };

  if (options.standard) {
    metadata.provenance_standard = options.standard;
  }

  if (options.encryption) {
    metadata.encryption = options.encryption;
  }

  return metadata;
}

/**
 * Extract the original file content from provenance metadata.
 * Without Buffer (browsers), `data` that is not valid base64 throws
 * ProvenanceError INVALID_INPUT (#202).
 */
export function extractContent(metadata: ProvenanceMetadata): Uint8Array {
  return base64ToBytes(metadata.data);
}

/**
 * Verify that the content hash in metadata matches the actual content.
 *
 * Self-consistency only: `content_hash` and `data` come from the same
 * document, so this detects corruption, not substitution. It does not bind the
 * data to the Swarm reference it was fetched by, nor to its author.
 */
export function verifyContentHash(metadata: ProvenanceMetadata): boolean {
  let content: Uint8Array;
  try {
    content = extractContent(metadata);
  } catch {
    // Invalid base64 for atob (browsers): no match, as a Buffer decode gives (#202)
    return false;
  }
  const computedHash = sha256Hex(content);
  return computedHash === metadata.content_hash;
}

/**
 * Serialize metadata to JSON string for upload
 */
export function serializeMetadata(metadata: ProvenanceMetadata): string {
  return JSON.stringify(metadata);
}

/**
 * Options for building document metadata (raw JSON, no base64)
 */
export interface DocumentMetadataOptions {
  /** Postage stamp ID */
  stampId: string;
  /** Optional provenance standard identifier */
  standard?: string;
}

/**
 * Build document metadata from a raw JSON object (no base64 wrapping).
 * The `data` field contains the object directly; `content_hash` is SHA-256 of
 * its canonical JSON, the convention shared with the gateway and the Python
 * tools: json.dumps(data, sort_keys=True, separators=(',', ':')).
 *
 * A document JSON cannot represent (a circular reference, a BigInt, nesting
 * over 1000 levels, a toJSON() or getter that throws) throws ProvenanceError
 * INVALID_INPUT with the original error as `cause` (#202).
 */
export function buildDocumentMetadata(
  document: Record<string, unknown>,
  options: DocumentMetadataOptions
): DocumentMetadata {
  let canonical: string;
  try {
    canonical = canonicalizeJsonValue(document);
  } catch (error) {
    throw notJsonError('Document', error);
  }
  const contentHash = sha256Hex(canonical);

  const metadata: DocumentMetadata = {
    data: document,
    content_hash: contentHash,
    stamp_id: options.stampId,
  };

  if (options.standard) {
    metadata.provenance_standard = options.standard;
  }

  return metadata;
}

/**
 * Verify the content hash of a document metadata (raw JSON).
 *
 * Accepts SHA-256 of the canonical JSON of `data` (the cross-tool convention;
 * pass `canonicalData` from canonicalizeJsonText on the response text for an
 * exact result with floats and large integers), or of JSON.stringify(data),
 * which SDK versions up to 0.6.x wrote. This is a self-consistency check only:
 * anyone can compute it, so it does not bind the data to its author or to the
 * Swarm reference it was fetched by.
 */
export function verifyDocumentHash(metadata: DocumentMetadata, canonicalData?: string): boolean {
  if (metadata.data === undefined && canonicalData === undefined) return false;
  try {
    const canonical = canonicalData ?? canonicalizeJsonValue(metadata.data);
    if (sha256Hex(canonical) === metadata.content_hash) return true;
    return sha256Hex(toBytes(JSON.stringify(metadata.data))) === metadata.content_hash;
  } catch {
    return false; // data not representable as JSON, or nested too deep
  }
}

/**
 * Parse metadata from JSON string.
 * Throws ProvenanceError INVALID_INPUT for text that is not JSON (the parse
 * error is the `cause`), or JSON that is not metadata (#202).
 */
export function parseMetadata(json: string): ProvenanceMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (error) {
    throw withCause(new ProvenanceError('Invalid metadata: not valid JSON', 'INVALID_INPUT'), error);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ProvenanceError('Invalid metadata: expected object', 'INVALID_INPUT');
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj['data'] !== 'string') {
    throw new ProvenanceError('Invalid metadata: missing or invalid data field', 'INVALID_INPUT');
  }
  if (typeof obj['content_hash'] !== 'string') {
    throw new ProvenanceError('Invalid metadata: missing or invalid content_hash field', 'INVALID_INPUT');
  }
  if (typeof obj['stamp_id'] !== 'string') {
    throw new ProvenanceError('Invalid metadata: missing or invalid stamp_id field', 'INVALID_INPUT');
  }

  const result: ProvenanceMetadata = {
    data: obj['data'],
    content_hash: obj['content_hash'],
    stamp_id: obj['stamp_id'],
  };
  if (typeof obj['provenance_standard'] === 'string') {
    result.provenance_standard = obj['provenance_standard'];
  }
  if (typeof obj['encryption'] === 'string') {
    result.encryption = obj['encryption'];
  }
  return result;
}
