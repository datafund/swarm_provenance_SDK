import type {
  ProvenanceClientConfig,
  PaymentMode,
  X402PaymentConfig,
  GatewayRetryConfig,
  UploadOptions,
  DownloadOptions,
  UploadResult,
  DownloadResult,
  DocumentUploadResult,
  DocumentDownloadResult,
  DocumentMetadata,
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
  PaymentRateLimitError,
} from './errors.js';
import { buildMetadata, buildDocumentMetadata, extractContent, verifyContentHash, verifyDocumentHash } from './metadata.js';
import { verifyAllSignatures } from './notary.js';
import { toBytes } from './utils.js';
import { createX402Fetch } from './payment.js';

const DEFAULT_GATEWAY_URL = 'https://provenance-gateway.datafund.io';
const DEFAULT_TIMEOUT = 30000;

/**
 * Main client for interacting with the Swarm Provenance Gateway
 */
export class ProvenanceClient {
  private readonly gatewayUrl: string;
  private readonly timeout: number;
  private readonly paymentMode: PaymentMode;
  private readonly retryConfig: Required<GatewayRetryConfig>;
  private x402Fetch: typeof fetch | undefined;
  private x402FetchPromise: Promise<typeof fetch> | undefined;

  constructor(config: ProvenanceClientConfig = {}) {
    this.gatewayUrl = (config.gatewayUrl ?? DEFAULT_GATEWAY_URL).replace(/\/$/, '');
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.paymentMode = config.payment ?? 'free';
    this.retryConfig = {
      maxRetries: config.retry?.maxRetries ?? 2,
      baseDelayMs: config.retry?.baseDelayMs ?? 1000,
    };
  }

  /**
   * Get or create the x402-wrapped fetch (lazy singleton with dedup)
   */
  private getX402Fetch(): Promise<typeof fetch> {
    if (this.x402Fetch) {
      return Promise.resolve(this.x402Fetch);
    }
    if (!this.x402FetchPromise) {
      this.x402FetchPromise = createX402Fetch(this.paymentMode as X402PaymentConfig).then(
        (wrappedFetch) => {
          this.x402Fetch = wrappedFetch;
          return wrappedFetch;
        }
      );
    }
    return this.x402FetchPromise;
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
        return { enabled: false, available: {}, reserve: {}, totalStamps: 0, lowReserveWarning: false };
      }
      throw await this.handleError(response);
    }

    const data = (await response.json()) as GatewayPoolStatusResponse;
    return {
      enabled: data.enabled,
      available: Object.fromEntries(
        Object.entries(data.current_levels).map(([k, v]) => [k, v])
      ),
      reserve: data.reserve_config,
      totalStamps: data.total_stamps,
      lowReserveWarning: data.low_reserve_warning,
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
      throw new StampError(
        error.suggestion ? `${error.message}. ${error.suggestion}` : error.message,
        error.code,
      );
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
   * Upload provenance data to Swarm.
   *
   * By default, content is base64-encoded and wrapped in ProvenanceMetadata.
   * With `options.raw = true`, content is uploaded as raw JSON without base64 wrapping.
   * In raw mode, content must be a JSON string or a plain object — the `data` field
   * will contain the structured document directly.
   */
  async upload(
    content: Uint8Array | ArrayBuffer | string | File | Blob | Record<string, unknown>,
    options: UploadOptions & { raw: true }
  ): Promise<DocumentUploadResult>;
  async upload(
    content: Uint8Array | ArrayBuffer | string | File | Blob,
    options?: UploadOptions
  ): Promise<UploadResult>;
  async upload(
    content: Uint8Array | ArrayBuffer | string | File | Blob | Record<string, unknown>,
    options: UploadOptions = {}
  ): Promise<UploadResult | DocumentUploadResult> {
    // Get stamp - either from options or acquire from pool
    const stampId = await this.resolveStampId(options);

    if (options.raw) {
      return this.uploadRawDocument(content as string | Record<string, unknown>, stampId, options);
    }

    // Convert content to bytes
    let bytes: Uint8Array;
    if (content instanceof Blob) {
      const buffer = await content.arrayBuffer();
      bytes = new Uint8Array(buffer);
    } else {
      bytes = toBytes(content as Uint8Array | ArrayBuffer | string);
    }

    // Build metadata
    const metadataOptions: { stampId: string; standard?: string } = { stampId };
    if (options.standard !== undefined) {
      metadataOptions.standard = options.standard;
    }
    const metadata = buildMetadata(bytes, metadataOptions);

    const data = await this.postMetadata(JSON.stringify(metadata), stampId, options);

    return {
      reference: data.reference,
      metadata,
    };
  }

  /**
   * Download a raw JSON document from Swarm.
   * Use this for documents uploaded with `raw: true` where the `data` field
   * contains structured JSON instead of base64-encoded content.
   */
  async downloadDocument(reference: string, options: DownloadOptions = {}): Promise<DocumentDownloadResult> {
    const response = await this.fetch(`/api/v1/data/${reference}`);

    if (!response.ok) {
      throw await this.handleError(response);
    }

    const raw = (await response.json()) as Record<string, unknown>;

    let documentData: Record<string, unknown>;
    let contentHash: string;
    let stampId: string;
    let provenanceStandard: string | undefined;
    let signatures: NotarySignature[] | undefined;

    if (raw['metadata'] && typeof raw['metadata'] === 'object') {
      // Wrapped format: {metadata: {...}, signatures: [...]}
      const meta = raw['metadata'] as Record<string, unknown>;
      documentData = meta['data'] as Record<string, unknown>;
      contentHash = meta['content_hash'] as string;
      stampId = meta['stamp_id'] as string;
      provenanceStandard = meta['provenance_standard'] as string | undefined;
      signatures = raw['signatures'] as NotarySignature[] | undefined;
    } else {
      // Direct format: {data: {...}, content_hash: "...", stamp_id: "...", ...}
      documentData = raw['data'] as Record<string, unknown>;
      contentHash = raw['content_hash'] as string;
      stampId = raw['stamp_id'] as string;
      provenanceStandard = raw['provenance_standard'] as string | undefined;
      if (raw['signatures'] && Array.isArray(raw['signatures'])) {
        signatures = raw['signatures'] as NotarySignature[];
      }
    }

    const metadata: DocumentMetadata = {
      data: documentData,
      content_hash: contentHash,
      stamp_id: stampId,
    };
    if (provenanceStandard !== undefined) {
      metadata.provenance_standard = provenanceStandard;
    }

    // Verify content hash
    if (!verifyDocumentHash(metadata)) {
      throw new ProvenanceError('Content hash verification failed', 'CONTENT_HASH_MISMATCH');
    }

    const result: DocumentDownloadResult = {
      document: documentData,
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
        // For document metadata, create a compatible metadata for signature verification
        const sigMetadata: ProvenanceMetadata = {
          data: JSON.stringify(documentData),
          content_hash: contentHash,
          stamp_id: stampId,
        };
        const verification = verifyAllSignatures(signatures, sigMetadata, notary.address);
        result.verified = verification.allValid;
      }
    }

    return result;
  }

  private async resolveStampId(options: UploadOptions): Promise<string> {
    if (options.stampId) {
      return options.stampId;
    }

    // Pre-check pool availability to fail fast
    try {
      const status = await this.poolStatus();
      if (status.enabled && status.totalStamps === 0) {
        throw new StampError(
          'Stamp pool is empty — no stamps available for any size',
          'POOL_EXHAUSTED',
        );
      }
    } catch (error) {
      if (error instanceof StampError) throw error;
      // Pool status check failed — proceed with acquire anyway
    }

    const stamp = await this.acquireStamp(options.poolSize ?? 'small');
    return stamp.batchId;
  }

  private async uploadRawDocument(
    content: string | Record<string, unknown>,
    stampId: string,
    options: UploadOptions,
  ): Promise<DocumentUploadResult> {
    let documentData: Record<string, unknown>;

    if (typeof content === 'string') {
      try {
        documentData = JSON.parse(content) as Record<string, unknown>;
      } catch {
        throw new ProvenanceError(
          'Raw mode requires valid JSON string or plain object',
          'INVALID_INPUT',
        );
      }
    } else if (typeof content === 'object' && content !== null && !ArrayBuffer.isView(content) && !(content instanceof ArrayBuffer) && !(content instanceof Blob)) {
      documentData = content;
    } else {
      throw new ProvenanceError(
        'Raw mode requires valid JSON string or plain object',
        'INVALID_INPUT',
      );
    }

    const metadataOptions: { stampId: string; standard?: string } = { stampId };
    if (options.standard !== undefined) {
      metadataOptions.standard = options.standard;
    }
    const metadata = buildDocumentMetadata(documentData, metadataOptions);

    const data = await this.postMetadata(JSON.stringify(metadata), stampId, options);

    return {
      reference: data.reference,
      metadata,
    };
  }

  private async postMetadata(
    metadataJson: string,
    stampId: string,
    options: UploadOptions,
  ): Promise<GatewayUploadResponse> {
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
    const metadataBlob = new Blob([metadataJson], { type: 'application/json' });
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

    return (await response.json()) as GatewayUploadResponse;
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

    // Parse response - gateway may return:
    // 1. Wrapped format: {metadata: {...}, signatures: [...]}
    // 2. Direct format: {data: "...", content_hash: "...", stamp_id: "...", signatures?: [...]}
    const data = (await response.json()) as
      | { metadata: ProvenanceMetadata; signatures?: NotarySignature[] }
      | (ProvenanceMetadata & { signatures?: NotarySignature[] });

    if ('metadata' in data && data.metadata && typeof data.metadata === 'object') {
      // Wrapped format
      metadata = data.metadata;
      signatures = data.signatures;
    } else {
      // Direct format - signatures at same level as metadata fields
      const directData = data as ProvenanceMetadata & { signatures?: NotarySignature[] };
      if (directData.signatures && Array.isArray(directData.signatures)) {
        signatures = directData.signatures;
      }
      metadata = {
        data: directData.data,
        content_hash: directData.content_hash,
        stamp_id: directData.stamp_id,
      };
      if (directData.provenance_standard !== undefined) {
        metadata.provenance_standard = directData.provenance_standard;
      }
      if (directData.encryption !== undefined) {
        metadata.encryption = directData.encryption;
      }
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

  private isRetryableStatus(status: number): boolean {
    // 429 is only retryable for non-free modes (free mode throws PaymentRateLimitError)
    if (status === 429 && this.paymentMode !== 'free') return true;
    return status === 502 || status === 503;
  }

  private getRetryDelay(response: Response, attempt: number): number {
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      if (retryAfter) return parseInt(retryAfter, 10) * 1000;
    }
    return this.retryConfig.baseDelayMs * Math.pow(2, attempt);
  }

  /**
   * Make a fetch request to the gateway
   */
  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.gatewayUrl}${path}`;

    const isX402 = typeof this.paymentMode === 'object';

    // Choose fetch implementation
    let fetchFn: typeof fetch;
    if (isX402) {
      fetchFn = await this.getX402Fetch();
    } else {
      fetchFn = fetch;
    }

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const headers = new Headers(init?.headers);

      // Set payment header based on mode
      if (this.paymentMode === 'free') {
        if (!headers.has('X-Payment-Mode')) {
          headers.set('X-Payment-Mode', 'free');
        }
      }
      // 'none' and x402: no X-Payment-Mode header

      try {
        const response = await fetchFn(url, {
          ...init,
          headers,
          signal: controller.signal,
        });

        // Detect free-tier rate limiting
        if (response.status === 429 && this.paymentMode === 'free') {
          const retryAfter = response.headers.get('Retry-After');
          const rateLimit = response.headers.get('X-RateLimit-Limit');
          const rateRemaining = response.headers.get('X-RateLimit-Remaining');

          throw new PaymentRateLimitError(
            'Free tier rate limit exceeded. Consider using x402 payment mode for higher limits.',
            retryAfter ? parseInt(retryAfter, 10) : undefined,
            rateLimit ? parseInt(rateLimit, 10) : undefined,
            rateRemaining ? parseInt(rateRemaining, 10) : undefined
          );
        }

        // Retry on transient HTTP errors
        if (attempt < this.retryConfig.maxRetries && this.isRetryableStatus(response.status)) {
          const delay = this.getRetryDelay(response, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        return response;
      } catch (error) {
        if (error instanceof PaymentRateLimitError) {
          throw error;
        }
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

    // This should be unreachable, but TypeScript needs it
    throw new GatewayConnectionError('Request failed after retries', undefined, 'CONNECTION_FAILED');
  }

  /**
   * Handle error responses from the gateway
   */
  private async handleError(response: Response): Promise<GatewayConnectionError> {
    let message = `Gateway error: ${response.status} ${response.statusText}`;
    let code: string | undefined;
    let suggestion: string | undefined;

    try {
      const data = (await response.json()) as GatewayErrorResponse;
      if (typeof data.detail === 'string') {
        message = data.detail;
      } else if (Array.isArray(data.detail)) {
        // FastAPI validation errors: [{msg, loc, type}, ...]
        message = data.detail.map((e) => e.msg).join('; ');
      } else if (data.detail && typeof data.detail === 'object' && 'message' in data.detail) {
        // Structured error: {message, suggestion?}
        const structured = data.detail as { message: string; suggestion?: string };
        message = structured.message;
        suggestion = structured.suggestion;
      }
      code = data.code;
    } catch {
      // Ignore JSON parse errors
    }

    return new GatewayConnectionError(message, response.status, code, suggestion);
  }
}
