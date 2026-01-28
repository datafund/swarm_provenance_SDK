/**
 * Configuration options for ProvenanceClient
 */
interface ProvenanceClientConfig {
    /** Gateway URL (default: https://provenance-gateway.datafund.io) */
    gatewayUrl?: string;
    /** Request timeout in milliseconds (default: 30000) */
    timeout?: number;
}
/**
 * Options for uploading provenance data
 */
interface UploadOptions {
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
interface DownloadOptions {
    /** Verify notary signature (default: true if document is signed) */
    verify?: boolean;
}
/**
 * Provenance metadata that wraps the file content
 */
interface ProvenanceMetadata {
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
interface NotarySignature {
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
interface SignedDocument {
    /** The provenance metadata */
    metadata: ProvenanceMetadata;
    /** Array of notary signatures */
    signatures: NotarySignature[];
}
/**
 * Result of an upload operation
 */
interface UploadResult {
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
interface DownloadResult {
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
interface NotaryInfo {
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
interface PoolStatus {
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
interface AcquiredStamp {
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
 * Main client for interacting with the Swarm Provenance Gateway
 */
declare class ProvenanceClient {
    private readonly gatewayUrl;
    private readonly timeout;
    constructor(config?: ProvenanceClientConfig);
    /**
     * Check if the gateway is healthy and reachable
     */
    health(): Promise<boolean>;
    /**
     * Get notary service information
     */
    notaryInfo(): Promise<NotaryInfo>;
    /**
     * Get stamp pool status
     */
    poolStatus(): Promise<PoolStatus>;
    /**
     * Acquire a stamp from the pool
     */
    acquireStamp(size?: 'small' | 'medium' | 'large'): Promise<AcquiredStamp>;
    /**
     * Upload provenance data to Swarm
     */
    upload(content: Uint8Array | ArrayBuffer | string | File | Blob, options?: UploadOptions): Promise<UploadResult>;
    /**
     * Download and optionally verify provenance data from Swarm
     */
    download(reference: string, options?: DownloadOptions): Promise<DownloadResult>;
    /**
     * Make a fetch request to the gateway
     */
    private fetch;
    /**
     * Handle error responses from the gateway
     */
    private handleError;
}

/**
 * Base error class for all SDK errors
 */
declare class ProvenanceError extends Error {
    readonly code?: string | undefined;
    constructor(message: string, code?: string | undefined);
}
/**
 * Error connecting to or communicating with the gateway
 */
declare class GatewayConnectionError extends ProvenanceError {
    readonly statusCode?: number | undefined;
    constructor(message: string, statusCode?: number | undefined, code?: string);
}
/**
 * Error related to postage stamps (acquisition, validation, etc.)
 */
declare class StampError extends ProvenanceError {
    constructor(message: string, code?: string);
}
/**
 * Error related to notary signing service
 */
declare class NotaryError extends ProvenanceError {
    constructor(message: string, code?: string);
}
/**
 * Error when signature verification fails
 */
declare class VerificationError extends ProvenanceError {
    constructor(message: string, code?: string);
}

/**
 * Options for building provenance metadata
 */
interface MetadataBuilderOptions {
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
declare function buildMetadata(content: Uint8Array | ArrayBuffer | string, options: MetadataBuilderOptions): ProvenanceMetadata;
/**
 * Extract the original file content from provenance metadata
 */
declare function extractContent(metadata: ProvenanceMetadata): Uint8Array;
/**
 * Verify that the content hash in metadata matches the actual content
 */
declare function verifyContentHash(metadata: ProvenanceMetadata): boolean;
/**
 * Serialize metadata to JSON string for upload
 */
declare function serializeMetadata(metadata: ProvenanceMetadata): string;
/**
 * Parse metadata from JSON string
 */
declare function parseMetadata(json: string): ProvenanceMetadata;

/**
 * Verify that the data hash in the signature matches the metadata
 */
declare function verifyDataHash(signature: NotarySignature, metadata: ProvenanceMetadata): boolean;
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
declare function verifySignature(signature: NotarySignature, metadata: ProvenanceMetadata, expectedSigner?: string): {
    valid: boolean;
    dataHashValid: boolean;
    signerValid?: boolean;
    error?: string;
};
/**
 * Verify all signatures on a document
 */
declare function verifyAllSignatures(signatures: NotarySignature[], metadata: ProvenanceMetadata, expectedSigner?: string): {
    allValid: boolean;
    results: Array<{
        index: number;
        valid: boolean;
        error?: string;
    }>;
};

/**
 * Convert various input types to Uint8Array
 */
declare function toBytes(input: Uint8Array | ArrayBuffer | string): Uint8Array;
/**
 * Compute SHA256 hash and return as hex string
 */
declare function sha256Hex(data: Uint8Array | ArrayBuffer | string): string;
/**
 * Encode bytes to base64 string
 */
declare function bytesToBase64(bytes: Uint8Array): string;
/**
 * Decode base64 string to bytes
 */
declare function base64ToBytes(base64: string): Uint8Array;
/**
 * Check if a string looks like a valid Swarm reference (64 hex chars)
 */
declare function isValidSwarmReference(ref: string): boolean;

export { type AcquiredStamp, type DownloadOptions, type DownloadResult, GatewayConnectionError, NotaryError, type NotaryInfo, type NotarySignature, type PoolStatus, ProvenanceClient, type ProvenanceClientConfig, ProvenanceError, type ProvenanceMetadata, type SignedDocument, StampError, type UploadOptions, type UploadResult, VerificationError, base64ToBytes, buildMetadata, bytesToBase64, extractContent, isValidSwarmReference, parseMetadata, serializeMetadata, sha256Hex, toBytes, verifyAllSignatures, verifyContentHash, verifyDataHash, verifySignature };
