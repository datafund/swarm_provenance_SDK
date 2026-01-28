import type {
  ProvenanceClientConfig,
  UploadOptions,
  DownloadOptions,
  UploadResult,
  DownloadResult,
  NotaryInfo,
  PoolStatus,
  AcquiredStamp,
  GatewayUploadResponse,
  GatewayNotaryInfoResponse,
  GatewayPoolStatusResponse,
  GatewayAcquireStampResponse,
  GatewayErrorResponse,
  ProvenanceMetadata,
  NotarySignature,
} from './types.js';
import {
  ProvenanceError,
  GatewayConnectionError,
  StampError,
  NotaryError,
} from './errors.js';
import { buildMetadata, extractContent, verifyContentHash } from './metadata.js';
import { verifyAllSignatures } from './notary.js';
import { toBytes } from './utils.js';

const DEFAULT_GATEWAY_URL = 'https://provenance-gateway.dev.datafund.io';
const DEFAULT_TIMEOUT = 30000;

/**
 * Main client for interacting with the Swarm Provenance Gateway
 */
export class ProvenanceClient {
  private readonly gatewayUrl: string;
  private readonly timeout: number;

  constructor(config: ProvenanceClientConfig = {}) {
    this.gatewayUrl = (config.gatewayUrl ?? DEFAULT_GATEWAY_URL).replace(/\/$/, '');
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
  }

  /**
   * Check if the gateway is healthy and reachable
   */
  async health(): Promise<boolean> {
    try {
      const response = await this.fetch('/health');
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get notary service information
   */
  async notaryInfo(): Promise<NotaryInfo> {
    const response = await this.fetch('/api/v1/notary/info');

    if (!response.ok) {
      if (response.status === 404) {
        return { enabled: false, available: false };
      }
      throw await this.handleError(response);
    }

    const data = (await response.json()) as GatewayNotaryInfoResponse;
    const info: NotaryInfo = {
      enabled: data.enabled,
      available: data.available,
    };
    if (data.address !== undefined) {
      info.address = data.address;
    }
    if (data.message !== undefined) {
      info.message = data.message;
    }
    return info;
  }

  /**
   * Get stamp pool status
   */
  async poolStatus(): Promise<PoolStatus> {
    const response = await this.fetch('/api/v1/pool/status');

    if (!response.ok) {
      if (response.status === 404) {
        return { enabled: false, available: {}, reserve: {} };
      }
      throw await this.handleError(response);
    }

    const data = (await response.json()) as GatewayPoolStatusResponse;
    return {
      enabled: data.enabled,
      available: data.available,
      reserve: data.reserve,
    };
  }

  /**
   * Acquire a stamp from the pool
   */
  async acquireStamp(size: 'small' | 'medium' | 'large' = 'small'): Promise<AcquiredStamp> {
    const response = await this.fetch('/api/v1/pool/acquire', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ size }),
    });

    if (!response.ok) {
      const error = await this.handleError(response);
      throw new StampError(error.message, error.code);
    }

    const data = (await response.json()) as GatewayAcquireStampResponse;
    return {
      batchId: data.batch_id,
      depth: data.depth,
      sizeName: data.size_name,
      fallbackUsed: data.fallback_used,
    };
  }

  /**
   * Upload provenance data to Swarm
   */
  async upload(
    content: Uint8Array | ArrayBuffer | string | File | Blob,
    options: UploadOptions = {}
  ): Promise<UploadResult> {
    // Get stamp - either from options or acquire from pool
    let stampId = options.stampId;
    if (!stampId) {
      const stamp = await this.acquireStamp(options.poolSize ?? 'small');
      stampId = stamp.batchId;
    }

    // Convert content to bytes
    let bytes: Uint8Array;
    if (content instanceof Blob) {
      const buffer = await content.arrayBuffer();
      bytes = new Uint8Array(buffer);
    } else {
      bytes = toBytes(content);
    }

    // Build metadata
    const metadataOptions: { stampId: string; standard?: string } = { stampId };
    if (options.standard !== undefined) {
      metadataOptions.standard = options.standard;
    }
    const metadata = buildMetadata(bytes, metadataOptions);

    // Build query params
    const params = new URLSearchParams();
    params.set('stamp_id', stampId);
    if (options.contentType) {
      params.set('content_type', options.contentType);
    }
    if (options.sign === 'notary') {
      params.set('sign', 'notary');
    }

    // Create form data with the metadata JSON as file content
    const formData = new FormData();
    const metadataBlob = new Blob([JSON.stringify(metadata)], { type: 'application/json' });
    formData.append('file', metadataBlob, 'provenance.json');

    const response = await this.fetch(`/api/v1/data/?${params.toString()}`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const error = await this.handleError(response);
      if (options.sign === 'notary') {
        throw new NotaryError(error.message, error.code);
      }
      throw error;
    }

    const data = (await response.json()) as GatewayUploadResponse;

    const result: UploadResult = {
      reference: data.reference,
      metadata,
    };

    if (data.signed_document) {
      result.signedDocument = {
        metadata: data.signed_document.metadata,
        signatures: data.signed_document.signatures,
      };
    }

    return result;
  }

  /**
   * Download and optionally verify provenance data from Swarm
   */
  async download(reference: string, options: DownloadOptions = {}): Promise<DownloadResult> {
    const response = await this.fetch(`/api/v1/data/${reference}`);

    if (!response.ok) {
      throw await this.handleError(response);
    }

    let metadata: ProvenanceMetadata;
    let signatures: NotarySignature[] | undefined;

    // Parse response - gateway may return metadata directly or wrapped in {metadata: ...}
    const data = (await response.json()) as
      | ProvenanceMetadata
      | { metadata: ProvenanceMetadata; signatures?: NotarySignature[] };

    if ('metadata' in data && data.metadata) {
      // Wrapped format: {metadata: {...}, signatures: [...]}
      metadata = data.metadata;
      signatures = data.signatures;
    } else {
      // Direct format: {data: "...", content_hash: "...", stamp_id: "..."}
      metadata = data as ProvenanceMetadata;
    }

    // Extract file content
    const file = extractContent(metadata);

    // Verify content hash
    const contentHashValid = verifyContentHash(metadata);
    if (!contentHashValid) {
      throw new ProvenanceError('Content hash verification failed', 'CONTENT_HASH_MISMATCH');
    }

    const result: DownloadResult = {
      file,
      metadata,
    };
    if (signatures !== undefined) {
      result.signatures = signatures;
    }

    // Verify signatures if present and requested
    if (signatures && signatures.length > 0) {
      const shouldVerify = options.verify !== false;
      if (shouldVerify) {
        const notary = await this.notaryInfo();
        const verification = verifyAllSignatures(signatures, metadata, notary.address);
        result.verified = verification.allValid;
      }
    }

    return result;
  }

  /**
   * Make a fetch request to the gateway
   */
  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.gatewayUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    // Merge headers, adding X-Payment-Mode: free for x402 compatibility
    const headers = new Headers(init?.headers);
    if (!headers.has('X-Payment-Mode')) {
      headers.set('X-Payment-Mode', 'free');
    }

    try {
      const response = await fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      });
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new GatewayConnectionError('Request timed out', undefined, 'TIMEOUT');
      }
      throw new GatewayConnectionError(
        error instanceof Error ? error.message : 'Failed to connect to gateway',
        undefined,
        'CONNECTION_FAILED'
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Handle error responses from the gateway
   */
  private async handleError(response: Response): Promise<GatewayConnectionError> {
    let message = `Gateway error: ${response.status} ${response.statusText}`;
    let code: string | undefined;

    try {
      const data = (await response.json()) as GatewayErrorResponse;
      message = data.detail || message;
      code = data.code;
    } catch {
      // Ignore JSON parse errors
    }

    return new GatewayConnectionError(message, response.status, code);
  }
}
