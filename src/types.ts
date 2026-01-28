/**
 * Configuration options for ProvenanceClient
 */
export interface ProvenanceClientConfig {
  /** Gateway URL (default: https://provenance-gateway.datafund.io) */
  gatewayUrl?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/**
 * Options for uploading provenance data
 */
export interface UploadOptions {
  /** Enable notary signing */
  sign?: 'notary';
  /** Provenance standard identifier */
  standard?: string;
  /** Use existing stamp ID (skip pool acquisition) */
  stampId?: string;
  /** Pool size preset (default: 'small') */
  poolSize?: 'small' | 'medium' | 'large';
  /** Content type of the file */
  contentType?: string;
}

/**
 * Options for downloading provenance data
 */
export interface DownloadOptions {
  /** Verify notary signature (default: true if document is signed) */
  verify?: boolean;
}

/**
 * Provenance metadata that wraps the file content
 */
export interface ProvenanceMetadata {
  /** Base64 encoded file content */
  data: string;
  /** SHA256 hash of original file content */
  content_hash: string;
  /** Postage stamp ID used for upload */
  stamp_id: string;
  /** Optional provenance standard identifier */
  provenance_standard?: string;
  /** Optional encryption method */
  encryption?: string;
}

/**
 * Notary signature attached to a signed document
 */
export interface NotarySignature {
  /** Signature type (e.g., 'eip191') */
  type: string;
  /** Signer's Ethereum address */
  signer: string;
  /** ISO 8601 timestamp of when the signature was created */
  timestamp: string;
  /** SHA256 hash of the data that was signed */
  data_hash: string;
  /** The actual signature */
  signature: string;
  /** Fields that were included in the hash */
  hashed_fields: string[];
  /** Format of the signed message */
  signed_message_format: string;
}

/**
 * A document that has been signed by the notary
 */
export interface SignedDocument {
  /** The provenance metadata */
  metadata: ProvenanceMetadata;
  /** Array of notary signatures */
  signatures: NotarySignature[];
}

/**
 * Result of an upload operation
 */
export interface UploadResult {
  /** Swarm reference hash */
  reference: string;
  /** The provenance metadata that was uploaded */
  metadata: ProvenanceMetadata;
  /** Signed document if notary signing was requested */
  signedDocument?: SignedDocument;
}

/**
 * Result of a download operation
 */
export interface DownloadResult {
  /** Decoded original file content */
  file: Uint8Array;
  /** The provenance metadata from the document */
  metadata: ProvenanceMetadata;
  /** Whether the notary signature was verified (if present) */
  verified?: boolean;
  /** Notary signatures if present */
  signatures?: NotarySignature[];
}

/**
 * Notary service information
 */
export interface NotaryInfo {
  /** Whether notary service is enabled on the gateway */
  enabled: boolean;
  /** Whether notary service is available and configured */
  available: boolean;
  /** Notary signer's Ethereum address (if available) */
  address?: string;
  /** Optional status message */
  message?: string;
}

/**
 * Stamp pool status information
 */
export interface PoolStatus {
  /** Whether the stamp pool is enabled */
  enabled: boolean;
  /** Available stamps by depth */
  available: Record<string, number>;
  /** Reserve levels */
  reserve: Record<string, number>;
}

/**
 * Result of acquiring a stamp from the pool
 */
export interface AcquiredStamp {
  /** The stamp batch ID */
  batchId: string;
  /** Stamp depth */
  depth: number;
  /** Size name (small, medium, large) */
  sizeName: string;
  /** Whether a larger stamp was used as fallback */
  fallbackUsed: boolean;
}

/**
 * Gateway API response types (internal use)
 */
export interface GatewayHealthResponse {
  status: string;
}

export interface GatewayUploadResponse {
  reference: string;
  signed_document?: {
    metadata: ProvenanceMetadata;
    signatures: NotarySignature[];
  };
}

export interface GatewayDownloadResponse {
  metadata: ProvenanceMetadata;
  signatures?: NotarySignature[];
}

export interface GatewayNotaryInfoResponse {
  enabled: boolean;
  available: boolean;
  address?: string;
  message?: string;
}

export interface GatewayPoolStatusResponse {
  enabled: boolean;
  available: Record<string, number>;
  reserve: Record<string, number>;
}

export interface GatewayAcquireStampResponse {
  batch_id: string;
  depth: number;
  size_name: string;
  fallback_used: boolean;
}

export interface GatewayErrorResponse {
  code?: string;
  detail: string;
}
