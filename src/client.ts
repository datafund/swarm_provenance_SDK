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
  PaymentReceipt,
  PaymentRequest,
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
  PaymentOutcomeError,
  PaymentRefusedError,
  type PaymentAttempt,
} from './errors.js';
import { buildMetadata, buildDocumentMetadata, extractContent, verifyContentHash, verifyDocumentHash } from './metadata.js';
import { verifyAllSignatures } from './notary.js';
import { canonicalizeJsonText } from './canonical-json.js';
import { toBytes, isAddress } from './utils.js';
import {
  base64Decode,
  formatAtomic,
  untilAborted,
  createX402Transport,
  resolvePaymentPolicy,
  toPaymentRequest,
  USDC_BY_NETWORK,
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
  private readonly maxUploadBytes: number;
  /** Notary address reported by /notary/info (see gatewayNotaryAddress) */
  private cachedNotaryAddress: string | undefined;
  /** In-flight /notary/info lookup, shared by concurrent downloads */
  private notaryLookup: Promise<string | undefined> | undefined;
  /** When a cached address was last re-checked after a failed verification */
  private notaryRecheckedAt = 0;
  private x402Transport: { fetchFor(state: PaymentAttemptState): typeof fetch } | undefined;
  private paymentPolicy: PaymentPolicy | undefined;
  /** Responses to attempts that sent a payment, with their Idempotency-Key and signed requirement (see fetch, handleError) */
  private readonly paidResponses = new WeakMap<Response, PaidAttempt>();
  private x402TransportPromise: Promise<{ fetchFor(state: PaymentAttemptState): typeof fetch }> | undefined;

  constructor(config: ProvenanceClientConfig = {}) {
    this.gatewayUrl = (config.gatewayUrl ?? DEFAULT_GATEWAY_URL).replace(/\/$/, '');
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.paidTimeout = config.paidTimeout ?? Math.max(this.timeout, DEFAULT_PAID_TIMEOUT);
    this.paymentMode = config.payment ?? 'free';
    // Resolve (and reject a bad) payment policy now, not on the first paid request
    if (typeof this.paymentMode === 'object') this.paymentPolicy = resolvePaymentPolicy(this.paymentMode);
    this.maxUploadBytes = config.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    if (!Number.isSafeInteger(this.maxUploadBytes) || this.maxUploadBytes <= 0) {
      throw new ProvenanceError(
        `maxUploadBytes must be a positive integer (bytes), got ${JSON.stringify(config.maxUploadBytes) ?? String(config.maxUploadBytes)}`,
        'INVALID_INPUT'
      );
    }
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
   * Check if the gateway is healthy and reachable. False when it reports
   * `status: 'critical'`: the gateway answers 200 even then, so that it stays
   * reachable. A `degraded` gateway is still healthy.
   */
  async health(): Promise<boolean> {
    try {
      const response = await this.fetch('/health');
      if (!response.ok) return false;
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return true; // no readable status: reachable is all it says
      }
      return !(body && typeof body === 'object' && (body as { status?: unknown }).status === 'critical');
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
        new StampError(
          error.suggestion ? `${error.message}${/[.!?]$/.test(error.message) ? '' : '.'} ${error.suggestion}` : error.message,
          error.code
        ),
        error,
      );
    }

    const data = await this.readJson<GatewayAcquireStampResponse>(response);
    const stamp: AcquiredStamp = {
      batchId: data.batch_id,
      depth: data.depth,
      sizeName: data.size_name,
      fallbackUsed: data.fallback_used,
    };
    if (typeof data.expires_at === 'string') stamp.expiresAt = data.expires_at;
    const payment = this.receiptOf(response);
    if (payment) stamp.payment = payment;
    return stamp;
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
    const idempotencyKey = this.operationKey(options.idempotencyKey);
    const metadata = await this.prepareMetadata(content, options);
    // Get stamp - either from options or acquire from pool
    let stampId: string;
    let stampPayment: PaymentReceipt | undefined;
    try {
      ({ stampId, payment: stampPayment } = await this.resolveStampId(options, idempotencyKey));
    } catch (error) {
      // Nothing uploaded yet: the same key acquires the same (paid) stamp again
      throw withRetryHint(error, 'upload()', idempotencyKey);
    }

    try {
      const withKey: UploadOptions = { ...options };
      if (idempotencyKey !== undefined) withKey.idempotencyKey = idempotencyKey;
      const result = await this.uploadPrepared(metadata, stampId, withKey);
      // Two requests, two payments: the upload's is `payment`, the stamp's this
      if (stampPayment) result.stampPayment = stampPayment;
      return result;
    } catch (error) {
      // The gateway hashes the query, stamp_id included: a retry with the same key
      // must reuse the stamp, or it is a different request (IDEMPOTENCY_KEY_REUSED)
      if (error instanceof ProvenanceError) {
        if (error.payment) error.payment.stampId = stampId;
        // A stamp taken from the pool (and maybe paid for) outlives the failed
        // upload: say which, even when the upload itself paid nothing
        if (options.stampId === undefined) error.stampId = stampId;
        if (stampPayment) error.stampPayment = stampPayment;
      }
      throw withRetryHint(error, 'upload()', idempotencyKey, stampId);
    }
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

  private async resolveStampId(
    options: UploadOptions,
    idempotencyKey: string | undefined
  ): Promise<{ stampId: string; payment: PaymentReceipt | undefined }> {
    const fromPool = (stamp: AcquiredStamp) => ({ stampId: stamp.batchId, payment: stamp.payment });
    if (options.stampId) {
      return { stampId: options.stampId, payment: undefined };
    }

    // Pre-check pool availability to fail fast. Not on a caller's retry with a
    // key: the first attempt may have taken the last stamp, which the gateway
    // replays for that key even though the pool now looks empty.
    if (options.idempotencyKey !== undefined) {
      return fromPool(await this.acquireWithKey(options.poolSize ?? 'small', idempotencyKey));
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

    return fromPool(await this.acquireWithKey(options.poolSize ?? 'small', idempotencyKey));
  }

  /**
   * Build and serialise the upload's metadata before a stamp is acquired, and
   * refuse it if it is larger than the gateway accepts (#112): a stamp (maybe
   * paid for) is not acquired for an upload that cannot succeed.
   *
   * The JSON is built once, here, so a raw document the caller changes later
   * is sent exactly as it was hashed. It is kept in two parts around the
   * stamp_id value, which uploadPrepared() fills in: nothing else in the body
   * can be replaced, and the bytes equal JSON.stringify(metadata) with that stamp.
   */
  private async prepareMetadata(
    content: Uint8Array | ArrayBuffer | string | File | Blob | Record<string, unknown>,
    options: UploadOptions
  ): Promise<PreparedUpload> {
    // The caller's stamp, or a placeholder of a batch ID's length: the size is exact
    const sizedStampId = options.stampId ?? STAMP_PLACEHOLDER;
    const metadataOptions: { stampId: string; standard?: string } = { stampId: sizedStampId };
    if (options.standard !== undefined) {
      metadataOptions.standard = options.standard;
    }

    let metadata: ProvenanceMetadata | DocumentMetadata;
    if (options.raw) {
      metadata = buildDocumentMetadata(rawDocument(content), metadataOptions);
    } else {
      const bytes =
        content instanceof Blob
          ? new Uint8Array(await content.arrayBuffer())
          : toBytes(content as Uint8Array | ArrayBuffer | string);
      metadata = buildMetadata(bytes, metadataOptions);
    }

    // {..fields before stamp_id.., "stamp_id": <value>, ..fields after..}
    const keys = Object.keys(metadata);
    const at = keys.indexOf('stamp_id');
    const record = metadata as unknown as Record<string, unknown>;
    const part = (names: string[]) => JSON.stringify(Object.fromEntries(names.map((k) => [k, record[k]])));
    const head = part(keys.slice(0, at)); // '{...}', or '{}' with no fields before
    const tail = part(keys.slice(at + 1));
    const prepared: PreparedUpload = {
      metadata,
      before: `${head.slice(0, -1)}${head === '{}' ? '' : ','}"stamp_id":`,
      after: tail === '{}' ? '}' : `,${tail.slice(1)}`,
    };

    const size = utf8Length(prepared.before) + utf8Length(JSON.stringify(sizedStampId)) + utf8Length(prepared.after);
    if (size > this.maxUploadBytes) {
      throw new ProvenanceError(
        options.raw
          ? `Upload too large: the document is ${size} bytes as uploaded (JSON metadata), over the limit of ${this.maxUploadBytes} bytes (maxUploadBytes)`
          : `Upload too large: ${size} bytes once base64-encoded into the metadata, over the limit of ${this.maxUploadBytes} bytes (maxUploadBytes). ` +
              `Content up to about ${(((this.maxUploadBytes - 512) * 3) / 4 / 1048576).toFixed(1)} MiB fits`,
        'FILE_TOO_LARGE'
      );
    }
    return prepared;
  }

  /** Upload metadata from prepareMetadata() with the stamp acquired for it. */
  private async uploadPrepared(
    prepared: PreparedUpload,
    stampId: string,
    options: UploadOptions
  ): Promise<UploadResult | DocumentUploadResult> {
    // Only the stamp_id value differs from the size-checked JSON: a retry with
    // this stamp sends the same body (the gateway hashes it for the Idempotency-Key)
    const { metadata } = prepared;
    metadata.stamp_id = stampId;
    const body = `${prepared.before}${JSON.stringify(stampId)}${prepared.after}`;
    const { data, payment } = await this.postMetadata(body, stampId, options);

    const result: { reference: string; metadata: ProvenanceMetadata | DocumentMetadata; expiresAt?: string; payment?: PaymentReceipt } = {
      reference: data.reference,
      metadata,
    };
    if (typeof data.expires_at === 'string') result.expiresAt = data.expires_at;
    if (payment) result.payment = payment;
    return result as UploadResult | DocumentUploadResult;
  }

  private async postMetadata(
    metadataJson: string,
    stampId: string,
    options: UploadOptions,
  ): Promise<{ data: GatewayUploadResponse; payment: PaymentReceipt | undefined }> {
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

    const response = await this.fetch(
      `/api/v1/data/?${params.toString()}`,
      { method: 'POST', body: formData },
      { idempotencyKey: options.idempotencyKey }
    );

    if (!response.ok) {
      const error = await this.handleError(response);
      if (options.sign === 'notary' && !(error instanceof PaymentOutcomeError)) {
        throw withPayment(new NotaryError(error.message, error.code), error);
      }
      throw error;
    }

    const data = await this.readJson<GatewayUploadResponse>(response);
    return { data, payment: this.receiptOf(response) };
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
  private async fetch(path: string, init?: RequestInit, options: { idempotencyKey?: string | undefined } = {}): Promise<Response> {
    const url = `${this.gatewayUrl}${path}`;

    const x402 = typeof this.paymentMode === 'object' ? this.paymentMode : undefined;
    const method = (init?.method ?? 'GET').toUpperCase();
    const isRead = method === 'GET' || method === 'HEAD';
    const paying = x402 !== undefined && (!isRead || x402.payForReads === true);
    // Unpaid requests in x402 mode use the free tier, as in 'free' mode
    const freeTier = this.paymentMode === 'free' || (x402 !== undefined && !paying);
    const transport = paying ? await this.getX402Transport() : undefined;
    const idempotencyKey = paying && !isRead ? options.idempotencyKey : undefined;
    const timeout = transport ? this.paidTimeout : this.timeout;

    let idempotentRetries = 0;
    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const headers = new Headers(init?.headers);
      if (freeTier && !headers.has('X-Payment-Mode')) {
        headers.set('X-Payment-Mode', 'free');
      }
      if (idempotencyKey !== undefined) headers.set('Idempotency-Key', idempotencyKey);
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
        if (paid) {
          const record: PaidAttempt = {};
          if (idempotencyKey !== undefined) record.idempotencyKey = idempotencyKey;
          if (state.approved) record.approved = state.approved;
          this.paidResponses.set(response, record);
        }

        // A 429 that refuses a quota (pool allowance, spend budget, free chunk
        // quota) is not a rate limit: no Retry-After, and waiting seconds does
        // not help. Report it with its code, without a retry (#112).
        if (response.status === 429 && !RATE_LIMIT_CODES.has(await peekErrorCode(response))) {
          return response;
        }

        // Detect free-tier rate limiting
        if (response.status === 429 && freeTier) {
          const retryAfter = response.headers.get('Retry-After');
          const rateLimit = response.headers.get('X-RateLimit-Limit');
          const rateRemaining = response.headers.get('X-RateLimit-Remaining');

          throw new PaymentRateLimitError(
            x402
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
    if (isWalletRejection(state.creationFailure) || ((state.creationFailure !== undefined || state.handedToLibrary) && isWalletRejection(error))) {
      // The person declined to sign in the wallet: a refusal, not a failure (#112)
      const request = state.approved;
      const price = request ? describePrice(request, this.paymentPolicy?.decimals) : undefined;
      return new PaymentRefusedError(
        `Payment refused: the signature was rejected in the wallet${
          request ? ` (${price ?? `${request.amount} on ${request.network}`} to ${request.payTo})` : ''
        }`,
        request ? [{ request, reasons: ['rejected in the wallet'] }] : []
      );
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
        failure.payment = paymentAttempt(response, this.paidResponses.get(response)!, this.paymentPolicy?.decimals);
        failure.message += ' (a payment was sent with this request and may have been charged)';
      }
      throw failure;
    }
  }

  /**
   * The payment receipt for a successful response (#111), or undefined if the
   * request was not paid. Also undefined when the gateway says it used the free
   * tier or its receipt reports a failed settlement: no charge is reported that
   * did not happen.
   */
  private receiptOf(response: Response): PaymentReceipt | undefined {
    const paid = this.paidResponses.get(response);
    if (!paid) return undefined;
    if (/^free/i.test(response.headers.get('X-Payment-Mode') ?? '')) return undefined;
    const settle = settleResponse(response);
    if (settle && settle['success'] === false) return undefined;
    return receiptFields(response, settle, paid.approved, this.paymentPolicy?.decimals);
  }

  /**
   * Handle error responses from the gateway. The error keeps the body (`body`),
   * shows the gateway's message (top-level `message` of its error envelope
   * first) and, on a 402, the price asked (#112).
   */
  private async handleError(response: Response): Promise<GatewayConnectionError | PaymentOutcomeError> {
    let message = `Gateway error: ${response.status} ${response.statusText}`;
    let code: string | undefined;
    let suggestion: string | undefined;
    let fields: Record<string, unknown> = {};
    /** Transaction named in the body: in `detail`, or top level (the gateway's paid-request crash answer) */
    let bodyTransaction: unknown;
    const { parsed, body } = await readErrorBody(response);

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const data = parsed as GatewayErrorResponse & Record<string, unknown>;
      message = gatewayMessage(data) ?? message;
      code = errorCode(data);
      if (data.detail && typeof data.detail === 'object' && !Array.isArray(data.detail)) {
        fields = data.detail as Record<string, unknown>;
        if (typeof fields['suggestion'] === 'string') suggestion = fields['suggestion'];
      }
      bodyTransaction = reported(fields['transaction']) ?? reported(data['transaction']);
      const price = response.status === 402 ? priceOf(data) : undefined;
      // The gateway's message and the price together stay within the cap
      if (price) message = capText(`${message} (price: ${price})`);
    } else if (response.status === 413) {
      // Not the gateway's JSON 413 (FILE_TOO_LARGE): the proxy in front of it refused the body
      code = 'FILE_TOO_LARGE';
      const status = response.statusText ? `${response.status} ${response.statusText}` : String(response.status);
      message = `Upload too large: the gateway's proxy refused the request body (${status}). Send less data.`;
    }

    const paid = this.paidResponses.has(response);
    const payment = paid ? paymentAttempt(response, this.paidResponses.get(response)!, this.paymentPolicy?.decimals) : undefined;
    if (payment && typeof fields['nonce'] === 'string' && fields['nonce']) payment.nonce = fields['nonce'];
    if (payment && !payment.transaction && typeof bodyTransaction === 'string') payment.transaction = bodyTransaction;

    const outcome = code === undefined ? undefined : PAYMENT_OUTCOMES[code];
    if (payment && outcome) {
      const error = new PaymentOutcomeError(`${outcomeMessage(outcome, payment)} Gateway: ${message}`, code!, outcome);
      error.payment = payment;
      if (body !== undefined) error.body = body;
      return error;
    }

    const error = new GatewayConnectionError(message, response.status, code, suggestion);
    if (body !== undefined) error.body = body;
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

/**
 * A wallet's "user rejected the request" (EIP-1193 code 4001; viem's
 * UserRejectedRequestError), here or in the error's cause chain.
 */
function isWalletRejection(error: unknown): boolean {
  for (let e = error, depth = 0; e && typeof e === 'object' && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    const { code, name } = e as { code?: unknown; name?: unknown };
    if (code === 4001 || name === 'UserRejectedRequestError') return true;
  }
  return false;
}

/** Upload metadata serialised around its stamp_id value: before + JSON.stringify(stampId) + after */
interface PreparedUpload {
  metadata: ProvenanceMetadata | DocumentMetadata;
  before: string;
  after: string;
}

/** UTF-8 byte length of a string, without encoding it */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4; // a surrogate pair
      i++;
    } else bytes += 3; // other BMP characters; a lone surrogate encodes as U+FFFD
  }
  return bytes;
}

/** Stand-in stamp_id while the stamp is not known yet: as long as a batch ID (64 hex characters) */
const STAMP_PLACEHOLDER = '0'.repeat(64);

/** The gateway's default MAX_UPLOAD_SIZE_MB (10), in bytes: the limit on the uploaded metadata JSON */
const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** A raw-mode document: a JSON object string, or a plain object */
function rawDocument(content: unknown): Record<string, unknown> {
  if (typeof content === 'string') {
    try {
      return JSON.parse(content) as Record<string, unknown>;
    } catch {
      throw new ProvenanceError('Raw mode requires valid JSON string or plain object', 'INVALID_INPUT');
    }
  }
  if (
    typeof content === 'object' &&
    content !== null &&
    !ArrayBuffer.isView(content) &&
    !(content instanceof ArrayBuffer) &&
    !(content instanceof Blob)
  ) {
    return content as Record<string, unknown>;
  }
  throw new ProvenanceError('Raw mode requires valid JSON string or plain object', 'INVALID_INPUT');
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

/**
 * The gateway's 429 codes that are rate limits: its global limiter, and the
 * free tier (raised without a code, so HTTP_429). Undefined: no code (an older
 * gateway, or no JSON body), treated as a rate limit as before.
 */
const RATE_LIMIT_CODES = new Set<string | undefined>([undefined, 'RATE_LIMIT_EXCEEDED', 'HTTP_429']);

/** An error response's code, read from a copy so the body stays readable */
async function peekErrorCode(response: Response): Promise<string | undefined> {
  try {
    return errorCode(JSON.parse(await response.clone().text()) as GatewayErrorResponse);
  } catch {
    return undefined;
  }
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
  if (!(error instanceof ProvenanceError)) return error;
  if (!error.payment && error.stampPayment && stampId !== undefined) {
    // The upload paid nothing, but its pool stamp was paid for: reuse it
    const tx = error.stampPayment.transaction ? ` (transaction ${error.stampPayment.transaction})` : '';
    error.message += `${/[.!?]$/.test(error.message) ? '' : '.'} The pool stamp was paid for${tx}: to use it instead of paying for another, call ${operation} again with stampId "${stampId}"`;
    return error;
  }
  if (!error.payment || idempotencyKey === undefined) return error;
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

/** A response to an attempt that sent a payment: its key and what was signed */
interface PaidAttempt {
  idempotencyKey?: string;
  /** The requirement the library was cleared to sign */
  approved?: PaymentRequest;
}

/** The decoded PAYMENT-RESPONSE (v2) or X-PAYMENT-RESPONSE (v1): the facilitator's SettleResponse */
function settleResponse(response: Response): Record<string, unknown> | undefined {
  const encoded = response.headers.get('PAYMENT-RESPONSE') ?? response.headers.get('X-PAYMENT-RESPONSE');
  if (!encoded) return undefined;
  try {
    const decoded = JSON.parse(base64Decode(encoded)) as unknown;
    return decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? (decoded as Record<string, unknown>) : undefined;
  } catch {
    return undefined; // not decodable: as if absent
  }
}

/** A non-empty string that is not the gateway's "unknown" placeholder */
function reported(value: unknown): string | undefined {
  return typeof value === 'string' && value && value !== 'unknown' ? value : undefined;
}

/**
 * What a paid response says about its payment: the transaction (header, else
 * receipt), network and payer (receipt; network falls back to the signed
 * requirement), and the amount the SDK signed. The amount is never taken from
 * the gateway: its receipt has none.
 */
function receiptFields(
  response: Response,
  settle: Record<string, unknown> | undefined,
  approved: PaymentRequest | undefined,
  decimals: number | undefined
): PaymentReceipt {
  const receipt: PaymentReceipt = {};
  // The gateway sends "unknown" when it has no transaction to name
  const transaction = reported(response.headers.get('X-Payment-Transaction')) ?? reported(settle?.['transaction']);
  if (transaction) receipt.transaction = transaction;
  const network = reported(settle?.['network']) ?? reported(approved?.network);
  if (network) receipt.network = network;
  const payer = reported(settle?.['payer']);
  if (payer) receipt.payer = payer;
  if (approved && /^\d+$/.test(approved.amount)) {
    receipt.amount = approved.amount;
    if (decimals !== undefined) receipt.amountDecimal = formatAtomic(BigInt(approved.amount), decimals);
    if (approved.asset) receipt.asset = approved.asset;
  }
  if (response.headers.get('Idempotent-Replayed')?.toLowerCase() === 'true') receipt.replayed = true;
  return receipt;
}

/**
 * Payment details for an error response to a paid request. The transaction is
 * reported whenever the gateway sent one. Network, payer and the signed amount
 * are added only with a decodable receipt header: without one the SDK cannot
 * tell whether, or on what terms, the payment settled.
 */
function paymentAttempt(response: Response, paid: PaidAttempt, decimals: number | undefined): PaymentAttempt {
  const attempt: PaymentAttempt = { paymentSent: true };
  if (paid.idempotencyKey !== undefined) attempt.idempotencyKey = paid.idempotencyKey;
  const settle = settleResponse(response);
  const fields = receiptFields(response, settle, settle ? paid.approved : undefined, decimals);
  if (fields.transaction) attempt.transaction = fields.transaction;
  if (settle) {
    if (fields.network) attempt.network = fields.network;
    if (fields.payer) attempt.payer = fields.payer;
    if (fields.amount) attempt.amount = fields.amount;
    if (fields.amountDecimal) attempt.amountDecimal = fields.amountDecimal;
    if (fields.asset) attempt.asset = fields.asset;
  }
  if (fields.replayed) attempt.replayed = true;
  const status = response.headers.get('X-Payment-Status');
  if (status) attempt.status = status;
  return attempt;
}

/** Carry the payment flag and the body over when a gateway error is re-thrown as another error type. */
function withPayment<E extends ProvenanceError>(target: E, source: ProvenanceError): E {
  if (source.payment) target.payment = source.payment;
  if (source.body !== undefined) target.body = source.body;
  return target;
}

/** Longest gateway text kept on an error (`body` text, message): a proxy's error page is not kept whole */
const MAX_ERROR_TEXT = 4096;
/** Largest JSON error body kept parsed on `error.body`; a larger one is kept as capped text */
const MAX_ERROR_JSON = 16384;

/** `text` cut to MAX_ERROR_TEXT characters, with an ellipsis when cut */
function capText(text: string): string {
  return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT)}…` : text;
}

/**
 * An error response's body. `parsed` is the JSON (read for code and message);
 * `body` is what the error keeps: the JSON up to MAX_ERROR_JSON characters as
 * sent, else the text capped at MAX_ERROR_TEXT.
 */
async function readErrorBody(response: Response): Promise<{ parsed: unknown; body: unknown }> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { parsed: undefined, body: undefined };
  }
  if (!text) return { parsed: undefined, body: undefined };
  try {
    const parsed = JSON.parse(text) as unknown;
    return { parsed, body: text.length > MAX_ERROR_JSON ? capText(text) : parsed };
  } catch {
    return { parsed: undefined, body: capText(text) };
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * The text to show for a gateway error. FastAPI validation errors list their
 * fields; otherwise the error envelope's top-level `message`, else `detail`'s
 * `message` or `error`, else a `detail` string. A further `detail` text (as in
 * `{detail: {error, detail}}`) is added when the message does not contain it.
 */
function gatewayMessage(data: GatewayErrorResponse & Record<string, unknown>): string | undefined {
  const message = composeMessage(data);
  return message === undefined ? undefined : capText(message);
}

function composeMessage(data: GatewayErrorResponse & Record<string, unknown>): string | undefined {
  const detail = data.detail as unknown;
  if (Array.isArray(detail)) {
    const fields = detail.map((e: { msg?: unknown } | null) => nonEmpty(e?.msg)).filter((m): m is string => m !== undefined);
    if (fields.length > 0) return fields.join('; ');
  }
  const nested = detail && typeof detail === 'object' && !Array.isArray(detail) ? (detail as Record<string, unknown>) : undefined;
  const base = nonEmpty(data.message) ?? nonEmpty(nested?.['message']) ?? nonEmpty(nested?.['error']) ?? nonEmpty(data['error']);
  const extra = nonEmpty(nested?.['detail']) ?? nonEmpty(detail);
  if (base === undefined) return extra;
  if (extra === undefined || base.includes(extra)) return base;
  return `${base}${/[.!?]$/.test(base) ? ' ' : ': '}${extra}`;
}

/** Prices named in a 402's message; the rest are counted, and all are in `error.body` */
const MAX_PRICES_SHOWN = 3;

/** An x402 payment request: top level (the gateway now), else under the deprecated `detail` */
function paymentRequestOf(data: Record<string, unknown>): { x402Version: number; accepts: unknown[] } | undefined {
  const isRequest = (v: unknown): v is { x402Version: number; accepts: unknown[] } =>
    Boolean(v) && typeof v === 'object' && typeof (v as { x402Version?: unknown }).x402Version === 'number' &&
    Array.isArray((v as { accepts?: unknown }).accepts);
  if (isRequest(data)) return data;
  return isRequest(data['detail']) ? data['detail'] : undefined;
}

/** The price a 402 asks, e.g. "0.01 USDC on base-sepolia"; options joined with "or". Never the raw JSON. */
function priceOf(data: Record<string, unknown>): string | undefined {
  const request = paymentRequestOf(data);
  if (!request) return undefined;
  const prices = request.accepts
    .filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === 'object')
    .map((o) => describePrice(toPaymentRequest(request.x402Version, o)))
    .filter((p): p is string => p !== undefined);
  if (prices.length === 0) return undefined;
  const shown = prices.slice(0, MAX_PRICES_SHOWN).join(' or ');
  return prices.length > MAX_PRICES_SHOWN ? `${shown} (and ${prices.length - MAX_PRICES_SHOWN} more)` : shown;
}

/**
 * A requested payment as a price, e.g. "0.01 USDC on base-sepolia". USDC is
 * known to have 6 decimals; another asset uses `decimals` (the policy's) when
 * given, else is shown in its smallest units. Undefined if the amount is not an integer.
 */
function describePrice(request: PaymentRequest, decimals?: number): string | undefined {
  if (!/^\d+$/.test(request.amount)) return undefined;
  const network = request.network || '?';
  const usdc = Object.hasOwn(USDC_BY_NETWORK, request.network) ? USDC_BY_NETWORK[request.network] : undefined;
  if (usdc && usdc.toLowerCase() === request.asset.toLowerCase()) {
    return `${formatAtomic(BigInt(request.amount), 6)} USDC on ${network}`;
  }
  return decimals !== undefined
    ? `${formatAtomic(BigInt(request.amount), decimals)} of token ${request.asset || '?'} on ${network}`
    : `${request.amount} smallest units of ${request.asset || '?'} on ${network}`;
}
