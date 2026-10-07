import type {
  ProvenanceClientConfig,
  PaymentMode,
  X402PaymentConfig,
  GatewayRetryConfig,
  UploadOptions,
  DownloadOptions,
  SignatureVerification,
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
  PaymentError,
  type PaymentAttempt,
} from './errors.js';
import { buildMetadata, buildDocumentMetadata, extractContent, verifyContentHash, verifyDocumentHash } from './metadata.js';
import { verifyAllSignatures } from './notary.js';
import { canonicalizeJsonText } from './canonical-json.js';
import { toBytes, isAddress } from './utils.js';
import { createX402Fetch, isPaidFailure, isPaidResponse, resolvePaymentPolicy } from './payment.js';

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
  /** Notary address reported by /notary/info (see gatewayNotaryAddress) */
  private cachedNotaryAddress: string | undefined;
  /** In-flight /notary/info lookup, shared by concurrent downloads */
  private notaryLookup: Promise<string | undefined> | undefined;
  /** When a cached address was last re-checked after a failed verification */
  private notaryRecheckedAt = 0;
  private x402Fetch: typeof fetch | undefined;
  private x402FetchPromise: Promise<typeof fetch> | undefined;

  constructor(config: ProvenanceClientConfig = {}) {
    this.gatewayUrl = (config.gatewayUrl ?? DEFAULT_GATEWAY_URL).replace(/\/$/, '');
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.paymentMode = config.payment ?? 'free';
    // Reject a bad payment policy now, not on the first paid request
    if (typeof this.paymentMode === 'object') resolvePaymentPolicy(this.paymentMode);
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
      throw withPayment(
        new StampError(error.suggestion ? `${error.message}. ${error.suggestion}` : error.message, error.code),
        error,
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
    assertNotaryAddress(options);
    const response = await this.fetch(`/api/v1/data/${reference}`);

    if (!response.ok) {
      throw await this.handleError(response);
    }

    const text = await response.text();
    const raw = JSON.parse(text) as Record<string, unknown>;
    const wrapped = Boolean(raw['metadata'] && typeof raw['metadata'] === 'object');
    const canonicalData = canonicalDataOf(text, wrapped);

    let documentData: Record<string, unknown>;
    let contentHash: string;
    let stampId: string;
    let provenanceStandard: string | undefined;
    let signatures: NotarySignature[] | undefined;

    if (wrapped) {
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
    if (!verifyDocumentHash(metadata, canonicalData)) {
      throw new ProvenanceError('Content hash verification failed', 'CONTENT_HASH_MISMATCH');
    }

    const result: DocumentDownloadResult = {
      document: documentData,
      metadata,
    };
    if (signatures !== undefined) {
      result.signatures = signatures;
    }

    // Verify signatures if present and requested. The notary hashes the data
    // object itself (#114: this used to pass JSON.stringify(data), a string).
    if (signatures && signatures.length > 0 && options.verify !== false) {
      Object.assign(result, await this.verifySignatures(signatures, metadata, canonicalData, options));
    }

    return result;
  }

  /**
   * Check notary signatures against the expected signer: `options.notaryAddress`
   * if given, else the address the gateway reports. Fails closed: with no
   * usable address, or if the lookup fails, `verified` is false and the
   * downloaded data is still returned.
   */
  private async verifySignatures(
    signatures: NotarySignature[],
    metadata: ProvenanceMetadata | DocumentMetadata,
    canonicalData: string | undefined,
    options: DownloadOptions
  ): Promise<{ verified: boolean; verification: SignatureVerification }> {
    const check = (expectedSigner: string | undefined, source: SignatureVerification['expectedSignerSource']) => {
      // verified = at least one signature by the expected notary over this exact
      // data (see verifyAllSignatures); every signature's result is reported.
      const { anyValid, results } = verifyAllSignatures(signatures, metadata, expectedSigner, canonicalData);
      const verification: SignatureVerification = { expectedSignerSource: source, results };
      if (expectedSigner !== undefined) verification.expectedSigner = expectedSigner;
      return { verified: anyValid, verification };
    };

    if (options.notaryAddress !== undefined) return check(options.notaryAddress, 'option');

    const wasCached = this.cachedNotaryAddress !== undefined;
    let address: string | undefined;
    try {
      address = await this.gatewayNotaryAddress();
    } catch (error) {
      const outcome = check(undefined, 'none');
      outcome.verification.error = `Could not get the gateway notary address: ${error instanceof Error ? error.message : String(error)}`;
      return outcome;
    }
    let outcome = check(address, address === undefined ? 'none' : 'gateway');

    // A cached address may be stale (the notary key rotated): look it up again,
    // at most once a minute, so unverifiable documents don't each cost a request
    if (!outcome.verified && wasCached && Date.now() - this.notaryRecheckedAt > NOTARY_RECHECK_MS) {
      this.notaryRecheckedAt = Date.now();
      const previous = this.cachedNotaryAddress;
      this.cachedNotaryAddress = undefined;
      try {
        const fresh = await this.gatewayNotaryAddress();
        if (fresh !== address) outcome = check(fresh, fresh === undefined ? 'none' : 'gateway');
      } catch {
        // keep the first outcome (it already fails closed) and the address that
        // was valid: a passing outage must not drop it
      } finally {
        this.cachedNotaryAddress ??= previous;
      }
    }
    return outcome;
  }

  /**
   * The gateway's notary address. Only a reported address is cached (per
   * client): "no address" may be a passing outage, so it is asked again.
   */
  private gatewayNotaryAddress(): Promise<string | undefined> {
    if (this.cachedNotaryAddress !== undefined) return Promise.resolve(this.cachedNotaryAddress);
    this.notaryLookup ??= this.notaryInfo()
      .then((notary) => {
        // address may be null or absent when the notary is disabled. A malformed
        // one is returned (so the error names it) but not cached.
        const address = typeof notary.address === 'string' && notary.address ? notary.address : undefined;
        if (address !== undefined && isAddress(address)) this.cachedNotaryAddress = address;
        return address;
      })
      .finally(() => {
        this.notaryLookup = undefined;
      });
    return this.notaryLookup;
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
        throw withPayment(new NotaryError(error.message, error.code), error);
      }
      throw error;
    }

    return (await response.json()) as GatewayUploadResponse;
  }

  /**
   * Download and optionally verify provenance data from Swarm
   */
  async download(reference: string, options: DownloadOptions = {}): Promise<DownloadResult> {
    assertNotaryAddress(options);
    const response = await this.fetch(`/api/v1/data/${reference}`);

    if (!response.ok) {
      throw await this.handleError(response);
    }

    let metadata: ProvenanceMetadata;
    let signatures: NotarySignature[] | undefined;

    // Parse response - gateway may return:
    // 1. Wrapped format: {metadata: {...}, signatures: [...]}
    // 2. Direct format: {data: "...", content_hash: "...", stamp_id: "...", signatures?: [...]}
    const text = await response.text();
    const data = JSON.parse(text) as
      | { metadata: ProvenanceMetadata; signatures?: NotarySignature[] }
      | (ProvenanceMetadata & { signatures?: NotarySignature[] });
    const wrapped = Boolean('metadata' in data && data.metadata && typeof data.metadata === 'object');

    if ('metadata' in data && wrapped) {
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

    // Verify signatures if present and requested. Base64 `data` is a string,
    // whose canonical form needs no lossless parse of the (possibly large) body.
    if (signatures && signatures.length > 0 && options.verify !== false) {
      const canonicalData = typeof metadata.data === 'string' ? undefined : canonicalDataOf(text, wrapped);
      Object.assign(result, await this.verifySignatures(signatures, metadata, canonicalData, options));
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
    const method = (init?.method ?? 'GET').toUpperCase();
    const isRead = method === 'GET' || method === 'HEAD';

    // Only writes go through the paying fetch: reads are never paid (#106)
    const paying = isX402 && !isRead;
    const fetchFn: typeof fetch = paying ? await this.getX402Fetch() : fetch;
    // A paid request is never retried automatically: the gateway may already
    // have settled the payment, and a retry would sign and pay again (#107)
    const maxRetries = paying ? 0 : this.retryConfig.maxRetries;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
        if (attempt < maxRetries && this.isRetryableStatus(response.status)) {
          const delay = this.getRetryDelay(response, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        return response;
      } catch (error) {
        // Rate limits and payment refusals/configuration errors pass through as-is
        if (error instanceof PaymentError) {
          throw error;
        }
        if (paying && error instanceof Error && /payment/i.test(error.message)) {
          // The x402 library failed to build or sign the payment; nothing was sent
          throw new PaymentError(`Payment could not be created: ${error.message}`, 'PAYMENT_FAILED');
        }
        const failure =
          error instanceof Error && error.name === 'AbortError'
            ? new GatewayConnectionError('Request timed out', undefined, 'TIMEOUT')
            : new GatewayConnectionError(
                error instanceof Error ? error.message : 'Failed to connect to gateway',
                undefined,
                'CONNECTION_FAILED'
              );
        if (isPaidFailure(error)) {
          // No response, but the request carried a payment: the gateway may have settled it
          failure.payment = { paymentSent: true };
          failure.message += ' (a payment was sent with this request and may have been charged)';
        }
        throw failure;
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

    const error = new GatewayConnectionError(message, response.status, code, suggestion);
    if (isPaidResponse(response)) {
      // The request carried a signed payment: say so, with whatever the gateway reported
      const payment = paymentAttempt(response);
      error.payment = payment;
      error.message += ` (a payment was sent with this request and may have been charged${
        payment.transaction ? `; transaction ${payment.transaction}` : ''
      })`;
    }
    return error;
  }
}

/**
 * Exact canonical JSON of the document's `data` field, taken from the response
 * text so floats and large integers keep the form the notary hashed.
 * Undefined if it cannot be extracted; callers then canonicalise the parsed value.
 */
function canonicalDataOf(text: string, wrapped: boolean): string | undefined {
  try {
    return canonicalizeJsonText(text, wrapped ? ['metadata', 'data'] : ['data']);
  } catch {
    return undefined;
  }
}

/** Minimum interval between re-checks of a cached notary address (see verifySignatures) */
const NOTARY_RECHECK_MS = 60_000;

/** A pinned notaryAddress must be an address: a typo must not read as "unverified". */
function assertNotaryAddress(options: DownloadOptions): void {
  // Only checked when it will be used
  if (options.verify !== false && options.notaryAddress !== undefined && !isAddress(options.notaryAddress)) {
    throw new ProvenanceError(
      `Invalid notaryAddress: expected 0x followed by 40 hex characters, got ${JSON.stringify(options.notaryAddress)}`,
      'INVALID_INPUT'
    );
  }
}

/** Payment details the gateway attached to a response for a paid request */
function paymentAttempt(response: Response): PaymentAttempt {
  const attempt: PaymentAttempt = { paymentSent: true };
  let transaction = response.headers.get('X-Payment-Transaction') ?? undefined;
  const encoded = response.headers.get('PAYMENT-RESPONSE') ?? response.headers.get('X-PAYMENT-RESPONSE');
  if (!transaction && encoded) {
    try {
      const decoded = JSON.parse(atob(encoded)) as { transaction?: unknown };
      if (typeof decoded.transaction === 'string' && decoded.transaction) transaction = decoded.transaction;
    } catch {
      // not decodable: leave the transaction unknown
    }
  }
  if (transaction) attempt.transaction = transaction;
  const status = response.headers.get('X-Payment-Status');
  if (status) attempt.status = status;
  return attempt;
}

/** Carry the payment flag over when a gateway error is re-thrown as another error type. */
function withPayment<E extends ProvenanceError>(target: E, source: ProvenanceError): E {
  if (source.payment) target.payment = source.payment;
  return target;
}
