import type { ProvenanceMetadata } from './types.js';
import { sha256Hex, bytesToBase64, base64ToBytes, toBytes } from './utils.js';

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
