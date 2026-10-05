import type { ProvenanceMetadata, DocumentMetadata } from './types.js';
import { sha256Hex, bytesToBase64, base64ToBytes, toBytes } from './utils.js';
import { canonicalizeJsonValue } from './canonical-json.js';

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
 * Extract the original file content from provenance metadata
 */
export function extractContent(metadata: ProvenanceMetadata): Uint8Array {
  return base64ToBytes(metadata.data);
}

/**
 * Verify that the content hash in metadata matches the actual content
 */
export function verifyContentHash(metadata: ProvenanceMetadata): boolean {
  const content = extractContent(metadata);
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
 */
export function buildDocumentMetadata(
  document: Record<string, unknown>,
  options: DocumentMetadataOptions
): DocumentMetadata {
  const contentHash = sha256Hex(canonicalizeJsonValue(document));

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
 * anyone can compute it, so it does not bind the data to its author.
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
 * Parse metadata from JSON string
 */
export function parseMetadata(json: string): ProvenanceMetadata {
  const parsed = JSON.parse(json) as unknown;

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Invalid metadata: expected object');
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj['data'] !== 'string') {
    throw new Error('Invalid metadata: missing or invalid data field');
  }
  if (typeof obj['content_hash'] !== 'string') {
    throw new Error('Invalid metadata: missing or invalid content_hash field');
  }
  if (typeof obj['stamp_id'] !== 'string') {
    throw new Error('Invalid metadata: missing or invalid stamp_id field');
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
