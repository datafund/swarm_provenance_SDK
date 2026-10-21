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
  GatewayPriceQuote,
  GatewayPricingResponse,
  Pricing,
  PricingOptions,
  PriceQuote,
  ProvenanceMetadata,
  NotarySignature,
  OwnerSigner,
} from './types.js';
import {
  ProvenanceError,
  GatewayConnectionError,
  StampError,
  NotaryError,
  PaymentRateLimitError,
  PaymentError,
  PaymentOutcomeError,
  type PaymentAttempt,
} from './errors.js';
import { buildMetadata, buildDocumentMetadata, extractContent, verifyContentHash, verifyDocumentHash } from './metadata.js';
import { verifyAllSignatures } from './notary.js';
import { canonicalizeJsonText } from './canonical-json.js';
import { toBytes, isAddress, ownerProofMessage } from './utils.js';
import {
  base64Decode,
  untilAborted,
  createX402Transport,
  resolvePaymentPolicy,
  type PaymentAttemptState,
  type PaymentPolicy,
} from './payment.js';

const DEFAULT_GATEWAY_URL = 'https://provenance-gateway.datafund.io';
const DEFAULT_TIMEOUT = 30000;
/** Default timeout for an attempt that may pay: settlement is on-chain (#102) */
const DEFAULT_PAID_TIMEOUT = 120000;
/**
 * Retries with the same Idempotency-Key while the gateway says to (IN_PROGRESS /
 * UNAVAILABLE). Each signs a new authorization: at most 3 signatures per request.
 */
const MAX_IDEMPOTENT_RETRIES = 2;
/** Longest Retry-After honoured for IDEMPOTENCY_KEY_IN_PROGRESS, in seconds */
const MAX_IN_PROGRESS_WAIT_S = 30;

/**
 * Main client for interacting with the Swarm Provenance Gateway
 */
export class ProvenanceClient {
  private readonly gatewayUrl: string;
  private readonly timeout: number;
  private readonly paidTimeout: number;
  private readonly paymentMode: PaymentMode;
  private readonly retryConfig: Required<GatewayRetryConfig>;
  /** Notary address reported by /notary/info (see gatewayNotaryAddress) */
  private cachedNotaryAddress: string | undefined;
  /** In-flight /notary/info lookup, shared by concurrent downloads */
  private notaryLookup: Promise<string | undefined> | undefined;
  /** When a cached address was last re-checked after a failed verification */
  private notaryRecheckedAt = 0;
  private x402Transport: { fetchFor(state: PaymentAttemptState): typeof fetch } | undefined;
  private paymentPolicy: PaymentPolicy | undefined;
  /** Responses to attempts that sent a payment, with their Idempotency-Key (see fetch, handleError) */
  private readonly paidResponses = new WeakMap<Response, string | undefined>();
  private x402TransportPromise: Promise<{ fetchFor(state: PaymentAttemptState): typeof fetch }> | undefined;

  constructor(config: ProvenanceClientConfig = {}) {
    this.gatewayUrl = (config.gatewayUrl ?? DEFAULT_GATEWAY_URL).replace(/\/$/, '');
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.paidTimeout = config.paidTimeout ?? Math.max(this.timeout, DEFAULT_PAID_TIMEOUT);
    this.paymentMode = config.payment ?? 'free';
    // Resolve (and reject a bad) payment policy now, not on the first paid request
    if (typeof this.paymentMode === 'object') this.paymentPolicy = resolvePaymentPolicy(this.paymentMode);
    this.retryConfig = {
      maxRetries: config.retry?.maxRetries ?? 2,
      baseDelayMs: config.retry?.baseDelayMs ?? 1000,
    };
  }

  /**
   * Get or create the x402 transport (lazy singleton with dedup)
   */
  private getX402Transport(): Promise<{ fetchFor(state: PaymentAttemptState): typeof fetch }> {
    if (this.x402Transport) {
      return Promise.resolve(this.x402Transport);
    }
    if (!this.x402TransportPromise) {
      this.x402TransportPromise = createX402Transport(this.paymentMode as X402PaymentConfig, this.paymentPolicy).then(
        (transport) => {
          this.x402Transport = transport;
          return transport;
        },
        (error: unknown) => {
          this.x402TransportPromise = undefined; // e.g. @x402 installed later: try again
          throw error;
        }
      );
    }
    return this.x402TransportPromise;
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
   * Price quotes for the gateway's paid operations, without paying
   * (`GET /api/v1/pricing`). Only the options you set are sent; the gateway
   * applies its defaults. `payTo` can seed `payment.payTo`.
   */
  async pricing(options: PricingOptions = {}): Promise<Pricing> {
    const params = new URLSearchParams();
    if (options.size !== undefined) params.set('size', options.size);
    if (options.depth !== undefined) params.set('depth', String(options.depth));
    if (options.durationHours !== undefined) params.set('duration_hours', String(options.durationHours));
    if (options.uploadBytes !== undefined) params.set('upload_bytes', String(options.uploadBytes));
    if (options.mb !== undefined) params.set('mb', String(options.mb));
    const query = params.toString();
    const response = await this.fetch(`/api/v1/pricing${query ? `?${query}` : ''}`);

    if (!response.ok) {
      throw await this.handleError(response);
    }

    const data = await this.readJson<GatewayPricingResponse>(response);
    const pricing: Pricing = { x402Enabled: data.x402_enabled === true, quotes: {} };
    if (data.currency !== undefined) pricing.currency = data.currency;
    if (data.network !== undefined) pricing.network = data.network;
    if (data.asset !== undefined) pricing.asset = data.asset;
    if (data.pay_to !== undefined) pricing.payTo = data.pay_to;
    if (data.min_price_usd !== undefined) pricing.minPriceUsd = data.min_price_usd;
    if (data.free_tier !== undefined) pricing.freeTier = { enabled: data.free_tier.enabled, header: data.free_tier.header };
    const quotes = data.quotes ?? {};
    if (quotes.stamp_purchase) pricing.quotes.stampPurchase = toPriceQuote(quotes.stamp_purchase);
    if (quotes.pool_acquire) pricing.quotes.poolAcquire = toPriceQuote(quotes.pool_acquire);
    if (quotes.data_upload) pricing.quotes.dataUpload = toPriceQuote(quotes.data_upload);
    if (quotes.bandwidth_credit) pricing.quotes.bandwidthCredit = toPriceQuote(quotes.bandwidth_credit);
    return pricing;
  }

  /**
   * Acquire a stamp from the pool.
   *
   * `options.idempotencyKey` (x402 mode): see `UploadOptions.idempotencyKey`.
   */
  async acquireStamp(
    size: 'small' | 'medium' | 'large' = 'small',
    options: { idempotencyKey?: string } = {}
  ): Promise<AcquiredStamp> {
    const idempotencyKey = this.operationKey(options.idempotencyKey);
    try {
      return await this.acquireWithKey(size, idempotencyKey);
    } catch (error) {
      throw withRetryHint(error, 'acquireStamp()', idempotencyKey);
    }
  }

  private async acquireWithKey(size: 'small' | 'medium' | 'large', idempotencyKey: string | undefined): Promise<AcquiredStamp> {
    const response = await this.fetch(
      '/api/v1/pool/acquire',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ size }),
      },
      { idempotencyKey }
    );

    if (!response.ok) {
      const error = await this.handleError(response);
      if (error instanceof PaymentOutcomeError) throw error;
      throw withPayment(
        new StampError(error.suggestion ? `${error.message}. ${error.suggestion}` : error.message, error.code),
        error,
      );
    }

    const data = await this.readJson<GatewayAcquireStampResponse>(response);
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
    // One key for the whole operation: the pool acquisition and the upload are
    // different paths, so the gateway keeps them apart (#102)
    assertOwnerProofOptions(options);
    // An owner-proof upload is unpaid: no key (#124)
    const idempotencyKey = options.ownerSigner ? undefined : this.operationKey(options.idempotencyKey);
    // Get stamp - either from options or acquire from pool
    let stampId: string;
    try {
      stampId = await this.resolveStampId(options, idempotencyKey);
    } catch (error) {
      // Nothing uploaded yet: the same key acquires the same (paid) stamp again
      throw withRetryHint(error, 'upload()', idempotencyKey);
    }

    try {
      const withKey: UploadOptions = { ...options };
      if (idempotencyKey !== undefined) withKey.idempotencyKey = idempotencyKey;
      return await this.uploadWithStamp(content, stampId, withKey);
    } catch (error) {
      // The gateway hashes the query, stamp_id included: a retry with the same key
      // must reuse the stamp, or it is a different request (IDEMPOTENCY_KEY_REUSED)
      if (error instanceof ProvenanceError && error.payment) error.payment.stampId = stampId;
      throw withRetryHint(error, 'upload()', idempotencyKey, stampId);
    }
  }

  private async uploadWithStamp(
    content: Uint8Array | ArrayBuffer | string | File | Blob | Record<string, unknown>,
    stampId: string,
    options: UploadOptions
  ): Promise<UploadResult | DocumentUploadResult> {
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

  private async resolveStampId(options: UploadOptions, idempotencyKey: string | undefined): Promise<string> {
    if (options.stampId) {
      return options.stampId;
    }

    // Pre-check pool availability to fail fast. Not on a caller's retry with a
    // key: the first attempt may have taken the last stamp, which the gateway
    // replays for that key even though the pool now looks empty.
    if (options.idempotencyKey !== undefined) {
      return (await this.acquireWithKey(options.poolSize ?? 'small', idempotencyKey)).batchId;
    }
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

    const stamp = await this.acquireWithKey(options.poolSize ?? 'small', idempotencyKey);
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

    // Owner proof (#124): free tier, never paid, a new proof per attempt
    const ownerSigner = options.ownerSigner;
    const response = await this.fetch(
      `/api/v1/data/?${params.toString()}`,
      ownerSigner
        ? { method: 'POST', body: formData, headers: { 'X-Payment-Mode': 'free' } }
        : { method: 'POST', body: formData },
      ownerSigner
        ? { unpaid: true, attemptHeaders: ownerProofHeaders(ownerSigner, stampId) }
        : { idempotencyKey: options.idempotencyKey }
    );

    if (!response.ok) {
      const error = await this.handleError(response);
      if (options.sign === 'notary' && !(error instanceof PaymentOutcomeError)) {
        throw withPayment(new NotaryError(error.message, error.code), error);
      }
      throw error;
    }

    return this.readJson<GatewayUploadResponse>(response);
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

  private getRetryDelay(response: Response, attempt: number): number {
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      if (retryAfter) return parseInt(retryAfter, 10) * 1000;
    }
    return this.retryConfig.baseDelayMs * Math.pow(2, attempt);
  }

  /**
   * The Idempotency-Key for one logical operation (#102): the caller's, checked,
   * or a new random one in x402 mode. Undefined when nothing is paid.
   */
  private operationKey(given: string | undefined): string | undefined {
    if (given !== undefined && !IDEMPOTENCY_KEY.test(given)) {
      throw new ProvenanceError(
        `Invalid idempotencyKey: expected 1-255 printable ASCII characters, got ${JSON.stringify(given)}`,
        'INVALID_INPUT'
      );
    }
    if (given !== undefined || typeof this.paymentMode !== 'object') return given;
    return newIdempotencyKey();
  }

  /**
   * Make a fetch request to the gateway.
   *
   * x402 mode: writes go through the paying fetch; reads use the free tier
   * unless `payForReads`. Each attempt gets its own paying fetch and state, so
   * the SDK knows whether it sent a payment: a paid attempt is never retried
   * (the gateway may already have settled, #107) and its errors carry `payment`.
   *
   * Paid writes carry `idempotencyKey` (#102). The only paid attempts retried
   * are those the gateway answers with IDEMPOTENCY_KEY_IN_PROGRESS or
   * IDEMPOTENCY_UNAVAILABLE: with the same key and a new authorization, which
   * the gateway verifies but never settles.
   */
  private async fetch(
    path: string,
    init?: RequestInit,
    options: {
      idempotencyKey?: string | undefined;
      /** Never pay, even in x402 mode: the request uses the free tier */
      unpaid?: boolean;
      /** Headers made anew for each attempt (owner proofs are single use) */
      attemptHeaders?: () => Promise<Record<string, string>>;
    } = {}
  ): Promise<Response> {
    const url = `${this.gatewayUrl}${path}`;

    const x402 = typeof this.paymentMode === 'object' ? this.paymentMode : undefined;
    const method = (init?.method ?? 'GET').toUpperCase();
    const isRead = method === 'GET' || method === 'HEAD';
    const paying = x402 !== undefined && !options.unpaid && (!isRead || x402.payForReads === true);
    // Unpaid requests in x402 mode use the free tier, as in 'free' mode
    const freeTier = this.paymentMode === 'free' || (x402 !== undefined && !paying);
    const transport = paying ? await this.getX402Transport() : undefined;
    const idempotencyKey = paying && !isRead ? options.idempotencyKey : undefined;
    // An owner proof may wait for a person to approve a wallet prompt, as a payment does
    const timeout = transport || options.attemptHeaders ? this.paidTimeout : this.timeout;

    let idempotentRetries = 0;
    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      let extraHeaders: Record<string, string> | undefined;
      if (options.attemptHeaders) {
        // Bounded by the timeout, like payment signing
        try {
          extraHeaders = await untilAborted(options.attemptHeaders(), controller.signal);
        } catch (error) {
          clearTimeout(timeoutId);
          if (controller.signal.aborted) {
            throw new GatewayConnectionError('Request timed out waiting for the owner-proof signature', undefined, 'TIMEOUT');
          }
          throw error;
        }
      }

      const headers = new Headers(init?.headers);
      if (freeTier && !headers.has('X-Payment-Mode')) {
        headers.set('X-Payment-Mode', 'free');
      }
      if (idempotencyKey !== undefined) headers.set('Idempotency-Key', idempotencyKey);
      if (extraHeaders) for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
      // Each attempt gets its own paying fetch, which records whether it paid
      const state: PaymentAttemptState = { paid: false };
      const fetchFn: typeof fetch = transport ? transport.fetchFor(state) : fetch;

      try {
        // Bounded by the timeout even while a payment waits for approval or signing
        const response = await untilAborted(
          fetchFn(url, {
            ...init,
            headers,
            signal: controller.signal,
          }),
          controller.signal
        );
        const paid = state.paid;
        if (paid) this.paidResponses.set(response, idempotencyKey);

        // Detect free-tier rate limiting
        if (response.status === 429 && freeTier) {
          const retryAfter = response.headers.get('Retry-After');
          const rateLimit = response.headers.get('X-RateLimit-Limit');
          const rateRemaining = response.headers.get('X-RateLimit-Remaining');

          throw new PaymentRateLimitError(
            options.attemptHeaders
              ? 'Free tier rate limit exceeded. Owner-proof uploads use the free tier and its rate limit: wait for Retry-After, or (in x402 mode) upload without ownerSigner to pay instead.'
              : x402 && !options.unpaid
                ? 'Free tier rate limit exceeded for reads. Set payment.payForReads to pay for reads in x402 mode.'
                : 'Free tier rate limit exceeded. Consider using x402 payment mode for higher limits.',
            retryAfter ? parseInt(retryAfter, 10) : undefined,
            rateLimit ? parseInt(rateLimit, 10) : undefined,
            rateRemaining ? parseInt(rateRemaining, 10) : undefined
          );
        }

        // The gateway asks for a retry with the same key: the first request is
        // still running, or its key store is briefly unreadable. Not charged.
        if (paid && idempotencyKey !== undefined && idempotentRetries < MAX_IDEMPOTENT_RETRIES) {
          const delay = await this.idempotentRetryDelay(response, idempotentRetries);
          if (delay !== undefined) {
            idempotentRetries++;
            attempt--; // not a transient-error retry
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
        }

        // Retry transient errors, but never an attempt that sent a payment
        const retryable = response.status === 502 || response.status === 503 || response.status === 429;
        if (!paid && attempt < this.retryConfig.maxRetries && retryable) {
          const delay = this.getRetryDelay(response, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        return response;
      } catch (error) {
        throw this.requestFailure(error, state, idempotencyKey);
      } finally {
        clearTimeout(timeoutId);
      }
    }

    // This should be unreachable, but TypeScript needs it
    throw new GatewayConnectionError('Request failed after retries', undefined, 'CONNECTION_FAILED');
  }

  /**
   * How long to wait before retrying a paid attempt with the same key, or
   * undefined if the response does not ask for that retry.
   */
  private async idempotentRetryDelay(response: Response, retry: number): Promise<number | undefined> {
    if (response.status !== 409 && response.status !== 503) return undefined;
    const code = await response
      .clone()
      .json()
      .then((body: GatewayErrorResponse) => errorCode(body))
      .catch(() => undefined);
    if (code === 'IDEMPOTENCY_KEY_IN_PROGRESS' && response.status === 409) {
      const seconds = Number(response.headers.get('Retry-After') ?? '5');
      return Math.min(Number.isFinite(seconds) && seconds >= 0 ? seconds : 5, MAX_IN_PROGRESS_WAIT_S) * 1000;
    }
    if (code === 'IDEMPOTENCY_UNAVAILABLE' && response.status === 503) {
      return this.retryConfig.baseDelayMs * Math.pow(2, retry);
    }
    return undefined;
  }

  /** Map a thrown fetch/x402 error to an SDK error, flagging a sent payment. */
  private requestFailure(error: unknown, state: PaymentAttemptState, idempotencyKey?: string): ProvenanceError {
    const flag = <E extends ProvenanceError>(e: E): E => {
      if (state.paid) {
        e.payment = { paymentSent: true };
        if (idempotencyKey !== undefined) e.payment.idempotencyKey = idempotencyKey;
        e.message += ' (a payment was sent with this request and may have been charged)';
      }
      return e;
    };
    // Our own refusals, configuration errors and rate limits pass through
    if (error instanceof PaymentError) return error;
    // A refusal recorded inside the library (its hook aborted signing): nothing signed
    if (state.refusal) return state.refusal;
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && error.name === 'AbortError') {
      return flag(new GatewayConnectionError('Request timed out', undefined, 'TIMEOUT'));
    }
    if (state.paid) {
      // The paid request went out; the library failed afterwards
      return flag(new PaymentError(`Payment sent, but the response could not be processed: ${message}`, 'PAYMENT_UNCONFIRMED'));
    }
    if (state.creationFailure !== undefined || state.handedToLibrary) {
      // The x402 library failed after taking the approved 402 (selection,
      // spend controls, signing) and before sending: nothing was paid
      return new PaymentError(`Payment could not be created: ${message}`, 'PAYMENT_FAILED');
    }
    return new GatewayConnectionError(message || 'Failed to connect to gateway', undefined, 'CONNECTION_FAILED');
  }

  /**
   * Parse a successful response body. If it is not valid JSON and the request
   * was paid, the error says so: the payment may have been taken (#107).
   */
  private async readJson<T>(response: Response): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch (error) {
      const failure = new GatewayConnectionError(
        `Invalid response from gateway: ${error instanceof Error ? error.message : String(error)}`,
        response.status,
        'INVALID_RESPONSE'
      );
      if (this.paidResponses.has(response)) {
        failure.payment = paymentAttempt(response, this.paidResponses.get(response));
        failure.message += ' (a payment was sent with this request and may have been charged)';
      }
      throw failure;
    }
  }

  /**
   * Handle error responses from the gateway
   */
  private async handleError(response: Response): Promise<GatewayConnectionError | PaymentOutcomeError> {
    let message = `Gateway error: ${response.status} ${response.statusText}`;
    let code: string | undefined;
    let suggestion: string | undefined;
    let fields: Record<string, unknown> = {};

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
      } else if (typeof data.message === 'string' && data.message) {
        // The gateway's error envelope: top-level {code, message}
        message = data.message;
      }
      code = errorCode(data);
      if (data.detail && typeof data.detail === 'object' && !Array.isArray(data.detail)) {
        fields = data.detail as Record<string, unknown>;
      }
    } catch {
      // Ignore JSON parse errors
    }

    const paid = this.paidResponses.has(response);
    const payment = paid ? paymentAttempt(response, this.paidResponses.get(response)) : undefined;
    if (payment && typeof fields['nonce'] === 'string' && fields['nonce']) payment.nonce = fields['nonce'];
    if (payment && !payment.transaction && typeof fields['transaction'] === 'string' && fields['transaction'] !== 'unknown') {
      payment.transaction = fields['transaction'];
    }

    const outcome = code === undefined ? undefined : PAYMENT_OUTCOMES[code];
    if (payment && outcome) {
      const error = new PaymentOutcomeError(`${outcomeMessage(outcome, payment)} Gateway: ${message}`, code!, outcome);
      error.payment = payment;
      return error;
    }

    const error = new GatewayConnectionError(message, response.status, code, suggestion);
    if (payment) {
      // The request carried a signed payment: say so, with whatever the gateway reported
      error.payment = payment;
      error.message +=
        code !== undefined && NOT_CHARGED.has(code)
          ? ' (the gateway did not charge the payment sent with this request)'
          : ` (a payment was sent with this request and may have been charged${
              payment.transaction ? `; transaction ${payment.transaction}` : ''
            })`;
    }
    return error;
  }
}

/** Idempotency-Key the gateway accepts: 1-255 printable ASCII characters */
const IDEMPOTENCY_KEY = /^[\x20-\x7e]{1,255}$/;

/**
 * A random key for one logical operation. Undefined without Web Crypto: x402
 * mode then fails with its own configuration error before anything is paid.
 */
function newIdempotencyKey(): string | undefined {
  const c = globalThis.crypto as Crypto | undefined;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  if (typeof c?.getRandomValues !== 'function') return undefined;
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The gateway's error code: top level (error envelope) or inside `detail` */
function errorCode(body: GatewayErrorResponse | undefined): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  if (typeof body.code === 'string') return body.code;
  const detail = body.detail as unknown;
  if (detail && typeof detail === 'object' && typeof (detail as { code?: unknown }).code === 'string') {
    return (detail as { code: string }).code;
  }
  return undefined;
}

/** Idempotency answers that need a person, never a retry (#102) */
const PAYMENT_OUTCOMES: Record<string, PaymentOutcomeError['outcome']> = {
  IDEMPOTENCY_KEY_SETTLEMENT_UNKNOWN: 'unknown',
  IDEMPOTENCY_KEY_SETTLED_PENDING: 'settled_not_delivered',
  IDEMPOTENCY_KEY_DELIVERED_NOT_STORED: 'delivered',
};

function outcomeMessage(outcome: PaymentOutcomeError['outcome'], payment: PaymentAttempt): string {
  switch (outcome) {
    case 'unknown':
      return `The first attempt's payment may or may not have been collected${
        payment.nonce ? ` (authorization nonce ${payment.nonce})` : ''
      }. Check it on-chain before paying again.`;
    case 'settled_not_delivered':
      return `The first attempt was paid${
        payment.transaction ? ` (transaction ${payment.transaction})` : ''
      } but its result is not available. Contact the gateway operator for the result or a refund.`;
    case 'delivered':
      return `The first attempt succeeded and was paid once${
        payment.transaction ? ` (transaction ${payment.transaction})` : ''
      }, but the gateway kept no copy of its response. Do not pay for it again.`;
  }
}

/** Idempotency answers for which the gateway verified the new payment but did not settle it */
const NOT_CHARGED = new Set([
  'IDEMPOTENCY_KEY_IN_PROGRESS',
  'IDEMPOTENCY_UNAVAILABLE',
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_KEY_INVALID',
]);

/**
 * Say how to retry an operation that failed after paying without paying twice,
 * where the same key does give the first result. Not for the answers that need
 * a person (PaymentOutcomeError) or a key the gateway refused.
 */
function withRetryHint(error: unknown, operation: string, idempotencyKey: string | undefined, stampId?: string): unknown {
  if (!(error instanceof ProvenanceError) || !error.payment || idempotencyKey === undefined) return error;
  if (error instanceof PaymentOutcomeError) return error;
  if (error.code === 'IDEMPOTENCY_KEY_REUSED' || error.code === 'IDEMPOTENCY_KEY_INVALID') return error;
  const args = stampId === undefined ? `idempotencyKey "${idempotencyKey}"` : `idempotencyKey "${idempotencyKey}" and stampId "${stampId}"`;
  error.message += `${/[.!?]$/.test(error.message) ? '' : '.'} To retry without paying twice, call ${operation} again with ${args}`;
  return error;
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
function paymentAttempt(response: Response, idempotencyKey?: string): PaymentAttempt {
  const attempt: PaymentAttempt = { paymentSent: true };
  if (idempotencyKey !== undefined) attempt.idempotencyKey = idempotencyKey;
  // The gateway sends "unknown" when it has no transaction to name
  const header = response.headers.get('X-Payment-Transaction');
  let transaction = header && header !== 'unknown' ? header : undefined;
  const encoded = response.headers.get('PAYMENT-RESPONSE') ?? response.headers.get('X-PAYMENT-RESPONSE');
  if (!transaction && encoded) {
    try {
      const decoded = JSON.parse(base64Decode(encoded)) as { transaction?: unknown };
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

/** A gateway price quote in the SDK's field names */
function toPriceQuote(quote: GatewayPriceQuote): PriceQuote {
  return {
    method: quote.method,
    path: quote.path,
    priceUsd: quote.price_usd,
    maxAmountRequired: quote.max_amount_required,
    description: quote.description,
  };
}

/** A signature as signMessage returns it: 0x-prefixed hex */
const SIGNATURE_HEX = /^0x[0-9a-fA-F]+$/;

/** Stamp id the gateway accepts: 64 hex characters, no 0x */
const STAMP_ID = /^[0-9a-fA-F]{64}$/;

/**
 * An owner proof needs the stamp it proves ownership of, and takes no
 * Idempotency-Key: the upload is unpaid, so the gateway would not use it.
 * Checked before anything is signed or sent.
 */
function assertOwnerProofOptions(options: UploadOptions): void {
  if (options.ownerSigner === undefined) return;
  if (options.stampId === undefined || !STAMP_ID.test(options.stampId)) {
    throw new ProvenanceError(
      `ownerSigner requires stampId: 64 hex characters without 0x, got ${JSON.stringify(options.stampId)}`,
      'INVALID_INPUT'
    );
  }
  if (options.idempotencyKey !== undefined) {
    throw new ProvenanceError(
      'ownerSigner cannot be combined with idempotencyKey: an owner-proof upload is not paid, so the gateway does not use the key',
      'INVALID_INPUT'
    );
  }
}

/**
 * Makes the owner-proof headers for one attempt (#124). The gateway accepts a
 * proof once, keyed on the signed message, so each attempt signs a strictly
 * later timestamp. The signature is a bearer credential for one upload: it is
 * never put in an error message.
 */
function ownerProofHeaders(signer: OwnerSigner, stampId: string): () => Promise<Record<string, string>> {
  let last = 0;
  return async () => {
    const timestamp = Math.max(Math.floor(Date.now() / 1000), last + 1);
    last = timestamp;
    let signature: unknown;
    try {
      signature = await signer.signMessage({ message: ownerProofMessage(stampId, timestamp) });
    } catch (error) {
      throw new ProvenanceError(
        `Owner proof could not be signed: ${error instanceof Error ? error.message : String(error)}`,
        'OWNER_PROOF_FAILED'
      );
    }
    // The value is not quoted: it may be a usable proof in some other encoding
    if (typeof signature !== 'string' || !SIGNATURE_HEX.test(signature)) {
      throw new ProvenanceError(
        'Owner proof could not be signed: signMessage did not return a 0x-prefixed hex string',
        'OWNER_PROOF_FAILED'
      );
    }
    return { 'X-Owner-Timestamp': String(timestamp), 'X-Owner-Signature': signature };
  };
}
