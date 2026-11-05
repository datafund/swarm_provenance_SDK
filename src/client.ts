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
  PaymentRefusedError,
  withCause,
  type PaymentAttempt,
} from './errors.js';
import { buildMetadata, buildDocumentMetadata, extractContent, verifyDocumentHash } from './metadata.js';
import { verifyAllSignatures } from './notary.js';
import { canonicalizeJsonText, notJsonError, NOT_REPRESENTABLE } from './canonical-json.js';
import { toBytes, isAddress, ownerProofMessage, referencePathSegment, retryAfterSeconds, sha256Hex, base64ToBytes } from './utils.js';
import {
  decodePaymentHeader,
  formatAtomic,
  networkName,
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
 * Longest Retry-After the SDK waits before retrying an unpaid 429, in seconds
 * (#161). Asked to wait longer, it does not retry: the 429 error is thrown at
 * once, with `retryAfterSeconds`, so the caller decides.
 */
const MAX_RETRY_AFTER_S = 60;

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
  /** 429 responses not retried because Retry-After asked for more than MAX_RETRY_AFTER_S, with that wait (see fetch, handleError) */
  private readonly overlongRetryAfter = new WeakMap<Response, number>();
  private x402TransportPromise: Promise<{ fetchFor(state: PaymentAttemptState): typeof fetch }> | undefined;
  /** Last owner-proof timestamp used, per stamp and signer (see reserveOwnerProofTimestamp) */
  private readonly ownerProofTimestamps = new Map<string, number>();

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
        `maxUploadBytes must be a positive integer (bytes), got ${
          typeof config.maxUploadBytes === 'string' ? JSON.stringify(config.maxUploadBytes) : String(config.maxUploadBytes)
        }`,
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
   * A unix timestamp (seconds) no earlier than now and later than any this
   * client used before for `key` (stamp and signer). Reserved synchronously, so
   * concurrent uploads never share one: the gateway refuses a second use of the
   * same signed message (#124). A burst runs the counter ahead of the clock;
   * the gateway refuses timestamps more than 300 s ahead, so once it is more
   * than OWNER_PROOF_MAX_LEAD_S ahead this waits for the clock, bounded by the
   * attempt's signal.
   */
  private async reserveOwnerProofTimestamp(key: string, signal: AbortSignal): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    for (const [k, last] of this.ownerProofTimestamps) {
      if (last < now) this.ownerProofTimestamps.delete(k); // now is later anyway
    }
    const timestamp = Math.max(now, (this.ownerProofTimestamps.get(key) ?? 0) + 1);
    this.ownerProofTimestamps.set(key, timestamp);
    const waitMs = (timestamp - OWNER_PROOF_MAX_LEAD_S) * 1000 - Date.now();
    if (waitMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(new DOMException('The operation was aborted', 'AbortError'));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, waitMs);
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    return timestamp;
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

    const data = await this.readJson<GatewayNotaryInfoResponse>(response);
    // address may be null or absent (notary disabled or not configured): not required
    if (!isRecord(data) || typeof data.enabled !== 'boolean' || typeof data.available !== 'boolean') {
      throw this.shapeError('a JSON object with boolean "enabled" and "available"', response);
    }
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

    const data = await this.readJson<GatewayPoolStatusResponse>(response);
    if (
      !isRecord(data) ||
      typeof data.enabled !== 'boolean' ||
      typeof data.total_stamps !== 'number' ||
      !isRecord(data.current_levels) ||
      !isRecord(data.reserve_config)
    ) {
      throw this.shapeError(
        'a JSON object with boolean "enabled", number "total_stamps" and objects "current_levels" and "reserve_config"',
        response
      );
    }
    // Absent means false, as for a gateway without a pool (404); any other non-boolean is a broken answer (#199)
    const lowReserveWarning = data.low_reserve_warning as unknown;
    if (lowReserveWarning !== undefined && typeof lowReserveWarning !== 'boolean') {
      throw this.shapeError('a JSON object whose "low_reserve_warning", if present, is a boolean', response);
    }
    return {
      enabled: data.enabled,
      available: Object.fromEntries(
        Object.entries(data.current_levels).map(([k, v]) => [k, v])
      ),
      reserve: data.reserve_config,
      totalStamps: data.total_stamps,
      lowReserveWarning: lowReserveWarning === true,
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

    const data = await this.readJson<unknown>(response);
    // Optional fields may be absent (or null); present ones must have the type they are copied as (#199)
    if (!isPricingResponse(data)) {
      throw this.shapeError(
        'a JSON object with boolean "x402_enabled", and optional fields of the expected types ' +
          '(string "currency", "network", "asset" and "pay_to", number "min_price_usd", object "free_tier" ' +
          'with boolean "enabled" and string "header", object "quotes" of price quotes)',
        response
      );
    }
    const pricing: Pricing = { x402Enabled: data.x402_enabled, quotes: {} };
    if (data.currency != null) pricing.currency = data.currency;
    if (data.network != null) pricing.network = data.network;
    if (data.asset != null) pricing.asset = data.asset;
    if (data.pay_to != null) pricing.payTo = data.pay_to;
    if (data.min_price_usd != null) pricing.minPriceUsd = data.min_price_usd;
    if (data.free_tier != null) pricing.freeTier = { enabled: data.free_tier.enabled, header: data.free_tier.header };
    const quotes = data.quotes ?? {}; // absent or null: no quotes
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
    const payForPool = typeof this.paymentMode === 'object' && this.paymentMode.payForPool === true;
    const response = await this.fetch(
      '/api/v1/pool/acquire',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ size }),
      },
      // Paid pool acquisition is opt-in (#109): the pool can answer 402 once the
      // shared daily allowance is spent, at twice the gateway's purchase price for
      // that stamp (default pool markup 100%)
      { idempotencyKey, payable: payForPool }
    );

    if (!response.ok) {
      const error = await this.handleError(response);
      if (error instanceof PaymentOutcomeError) throw error;
      if (response.status === 402 && !error.payment) {
        // withPayment keeps the 402's body (price options, quota code) (#163)
        throw withPayment(
          new StampError(
            `${error.message.replace(/[.\s]*$/, '')}. The pool asked for payment, and the SDK did not pay it.` +
              (payForPool
                ? ''
                : ' To let the SDK pay for pool stamps within the payment policy, use x402 mode with ' +
                  'payment.payForPool: true, or pass a stampId you own.'),
            error.code ?? 'PAYMENT_REQUIRED'
          ),
          error,
        );
      }
      throw withPayment(
        new StampError(
          error.suggestion ? `${error.message}${/[.!?]$/.test(error.message) ? '' : '.'} ${error.suggestion}` : error.message,
          error.code
        ),
        error,
      );
    }

    const data = await this.readJson<GatewayAcquireStampResponse>(response);
    // The gateway's only 200 sets all of these; fallback_used has a default there, so absent means false (#199)
    if (
      !isRecord(data) ||
      typeof data.batch_id !== 'string' ||
      !STAMP_ID.test(data.batch_id) ||
      typeof data.depth !== 'number' ||
      typeof data.size_name !== 'string' ||
      (data.fallback_used !== undefined && typeof data.fallback_used !== 'boolean')
    ) {
      throw this.shapeError(
        'a JSON object with a 64-hex-character "batch_id", number "depth", string "size_name" ' +
          'and, if present, boolean "fallback_used"',
        response
      );
    }
    const stamp: AcquiredStamp = {
      // Lowercased as a caller's stampId is (#168): the gateway's ownership registry matches it exactly
      batchId: data.batch_id.toLowerCase(),
      depth: data.depth,
      sizeName: data.size_name,
      fallbackUsed: data.fallback_used === true,
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
    assertOwnerProofOptions(options);
    // Bee batch ids are lowercase, and the gateway looks the stamp up in its
    // ownership registry exactly as sent: a mixed-case id is refused there
    // (#168). Lowercased once, so the query, the body, the owner proof, the
    // retry advice and a keyed retry all carry the same id.
    if (options.stampId !== undefined && STAMP_ID.test(options.stampId)) {
      options = { ...options, stampId: options.stampId.toLowerCase() };
    }
    // An owner-proof upload is unpaid: no key (#124)
    const idempotencyKey = options.ownerSigner ? undefined : this.operationKey(options.idempotencyKey);
    const metadata = await this.prepareMetadata(content, options);
    // Get stamp - either from options or acquire from pool
    let stampId: string;
    let stampPayment: PaymentReceipt | undefined;
    try {
      ({ stampId, payment: stampPayment } = await this.resolveStampId(options, idempotencyKey));
    } catch (error) {
      // Nothing uploaded yet. The hint is only added after a payment, so the
      // acquisition was paid (payForPool): the same key gets the same stamp again
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
   *
   * As in download(), the content-hash check is self-consistency only: it does
   * not bind the document to `reference`.
   */
  async downloadDocument(reference: string, options: DownloadOptions = {}): Promise<DocumentDownloadResult> {
    const ref = checkedReference(reference);
    assertNotaryAddress(options);
    const response = await this.fetch(`/api/v1/data/${ref}`);

    if (!response.ok) {
      throw await this.handleError(response);
    }

    const text = await this.readText(response);
    const raw = this.parseJson<unknown>(text, response);
    const record = isRecord(raw) ? (isRecord(raw['metadata']) ? raw['metadata'] : raw) : undefined;
    // A record without a data field or a content_hash is malformed, not tampered with (#179).
    // data may be any JSON value: raw uploads accept arrays, null, numbers and strings.
    if (!isRecord(raw) || !record || !('data' in record) || typeof record['content_hash'] !== 'string') {
      throw this.shapeError('a JSON object with a "data" field and a string "content_hash" (directly or under "metadata")', response);
    }
    const wrapped = record !== raw;
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
      // As in the direct format, a signatures value that is not an array is ignored
      if (Array.isArray(raw['signatures'])) {
        signatures = raw['signatures'] as NotarySignature[];
      }
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

    // Verify content hash. A base64 record fails here; name download() only
    // when its hash proves that format, so a tampered record stays plain (#190)
    if (!verifyDocumentHash(metadata, canonicalData)) {
      const base64 = typeof documentData === 'string' && matchesAsBase64(documentData, contentHash);
      throw this.hashMismatch(response, base64 ? BASE64_IN_DOWNLOAD_DOCUMENT : undefined);
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
    // key when the acquisition is paid (payForPool): the first attempt may have
    // taken the last stamp, which the gateway replays for that key even though
    // the pool now looks empty. An unpaid acquisition sends no key, so nothing
    // is replayed and the pre-check runs as for any other call (#109).
    const paidAcquisition = typeof this.paymentMode === 'object' && this.paymentMode.payForPool === true;
    if (options.idempotencyKey !== undefined && paidAcquisition) {
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
    /** A raw document's JSON: serialised once, then hashed, sent and returned as parsed from it */
    let dataJson: string | undefined;
    /** Base64 uploads: the content's size in bytes, for the FILE_TOO_LARGE hint */
    let contentLength = 0;
    if (options.raw) {
      // Accepts what earlier versions accepted: any JSON text, or a non-null object (arrays too)
      const document = rawDocument(content);
      // Content JSON cannot represent is INVALID_INPUT here, before any request (#202).
      // A caller's toJSON() or getter may throw anything, a ProvenanceError too: it is the cause
      try {
        dataJson = JSON.stringify(document) as string | undefined;
      } catch (error) {
        throw notJsonError('Raw mode content', error);
      }
      if (dataJson === undefined) throw notJsonError('Raw mode content', new TypeError(NOT_REPRESENTABLE));
      try {
        // The caller's object may change while the stamp is acquired: the
        // snapshot is what is hashed, sent and returned
        metadata = buildDocumentMetadata(JSON.parse(dataJson) as Record<string, unknown>, metadataOptions);
      } catch (error) {
        // The snapshot is plain JSON, so this is buildDocumentMetadata's own
        // INVALID_INPUT (nesting deeper than 1000 levels): named for the upload
        throw notJsonError(
          'Raw mode content',
          error instanceof ProvenanceError && error.code === 'INVALID_INPUT' ? error.cause : error
        );
      }
    } else {
      const bytes =
        content instanceof Blob
          ? await readBlob(content)
          : toBytes(content as Uint8Array | ArrayBuffer | string);
      contentLength = bytes.length;
      metadata = buildMetadata(bytes, metadataOptions);
    }

    // {..fields before stamp_id.., "stamp_id": <value>, ..fields after..}
    const keys = Object.keys(metadata);
    const at = keys.indexOf('stamp_id');
    const record = metadata as unknown as Record<string, unknown>;
    // As JSON.stringify of those fields, reusing a raw document's JSON instead of serialising it again
    const part = (names: string[]) =>
      `{${names
        .map((k) => [k, k === 'data' && dataJson !== undefined ? dataJson : (JSON.stringify(record[k]) as string | undefined)] as const)
        .filter(([, value]) => value !== undefined) // as JSON.stringify omits them
        .map(([k, value]) => `${JSON.stringify(k)}:${value}`)
        .join(',')}}`;
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
              base64SizeHint(size - base64Length(contentLength), this.maxUploadBytes),
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

    // Owner proof (#124): free tier, never paid, a new proof per attempt
    const ownerSigner = options.ownerSigner;
    const response = await this.fetch(
      `/api/v1/data/?${params.toString()}`,
      ownerSigner
        ? { method: 'POST', body: formData, headers: { 'X-Payment-Mode': 'free' } }
        : { method: 'POST', body: formData },
      ownerSigner
        ? {
            unpaid: true,
            attemptHeaders: ownerProofHeaders(ownerSigner, stampId, (key, signal) =>
              this.reserveOwnerProofTimestamp(key, signal)
            ),
          }
        : { idempotencyKey: options.idempotencyKey }
    );

    if (!response.ok) {
      const error = await this.handleError(response);
      if (options.sign === 'notary' && !(error instanceof PaymentOutcomeError)) {
        throw withPayment(new NotaryError(error.message, error.code), error);
      }
      throw error;
    }

    const data = await this.readJson<GatewayUploadResponse>(response);
    // The same check download() applies to a reference, so the result can be downloaded (#199)
    if (!isRecord(data) || typeof data.reference !== 'string' || referencePathSegment(data.reference) === undefined) {
      throw this.shapeError('a JSON object with a "reference" of 64 or 128 hex characters', response);
    }
    return { data, payment: this.receiptOf(response) };
  }

  /**
   * Download and optionally verify provenance data from Swarm.
   *
   * The content-hash check is self-consistency only: `content_hash` and `data`
   * come from the same response, so it detects corruption but does not prove
   * the gateway returned the document stored at `reference`. Notary signatures
   * and on-chain anchors are what bind the data to an author or a time.
   */
  async download(reference: string, options: DownloadOptions = {}): Promise<DownloadResult> {
    const ref = checkedReference(reference);
    assertNotaryAddress(options);
    const response = await this.fetch(`/api/v1/data/${ref}`);

    if (!response.ok) {
      throw await this.handleError(response);
    }

    let metadata: ProvenanceMetadata;
    let signatures: NotarySignature[] | undefined;

    // Parse response - gateway may return:
    // 1. Wrapped format: {metadata: {...}, signatures: [...]}
    // 2. Direct format: {data: "...", content_hash: "...", stamp_id: "...", signatures?: [...]}
    const text = await this.readText(response);
    const parsed = this.parseJson<unknown>(text, response);
    const record = isRecord(parsed) ? (isRecord(parsed['metadata']) ? parsed['metadata'] : parsed) : undefined;
    // Non-string data is never a base64 record. Name downloadDocument() only when
    // the hash proves a raw upload, as downloadDocument() checks it (#190)
    if (
      record &&
      'data' in record &&
      typeof record['data'] !== 'string' &&
      typeof record['content_hash'] === 'string' &&
      verifyDocumentHash(record as unknown as DocumentMetadata, canonicalDataOf(text, record !== parsed))
    ) {
      throw this.withPayment(new GatewayConnectionError(RAW_IN_DOWNLOAD, response.status, 'INVALID_RESPONSE'), response);
    }
    // data is base64-decoded and content_hash compared: both must be strings (#179)
    if (!record || typeof record['data'] !== 'string' || typeof record['content_hash'] !== 'string') {
      throw this.shapeError('a JSON object with string "data" and "content_hash" (directly or under "metadata")', response);
    }
    const data = parsed as
      | { metadata: ProvenanceMetadata; signatures?: NotarySignature[] }
      | (ProvenanceMetadata & { signatures?: NotarySignature[] });
    const wrapped = record !== parsed;

    if ('metadata' in data && wrapped) {
      // Wrapped format
      metadata = data.metadata;
      // As in the direct format, a signatures value that is not an array is ignored
      if (Array.isArray(data.signatures)) {
        signatures = data.signatures;
      }
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

    // Extract file content. atob (browsers) throws on invalid base64; Buffer does not
    let file: Uint8Array | undefined;
    try {
      file = extractContent(metadata);
    } catch {
      // No bytes: the hash cannot match, as with a Buffer decode of invalid base64
    }

    // Verify content hash. A raw upload whose document is a JSON string fails
    // here; name downloadDocument() only when its hash proves that format (#190)
    if (file === undefined || sha256Hex(file) !== metadata.content_hash) {
      const asDocument = { ...metadata } as unknown as DocumentMetadata;
      if (verifyDocumentHash(asDocument)) throw this.hashMismatch(response, RAW_STRING_IN_DOWNLOAD);
      throw this.hashMismatch(response);
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
      // Delta-seconds or an HTTP date (#123: a date used to give NaN, i.e. no wait)
      const seconds = retryAfterSeconds(response.headers.get('Retry-After'));
      if (seconds !== undefined) return seconds * 1000;
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
   * unless `payForReads`, and a write with `payable: false` (pool acquisition
   * without `payForPool`) uses plain fetch. Each attempt gets its own paying fetch and state, so
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
      /** false: a write that must not pay (pool acquisition without payForPool, #109) */
      payable?: boolean;
      /** Never pay, even in x402 mode: the request uses the free tier (owner proofs, #124) */
      unpaid?: boolean;
      /** Headers made anew for each attempt (owner proofs are single use) */
      attemptHeaders?: AttemptHeaders;
    } = {}
  ): Promise<Response> {
    const url = `${this.gatewayUrl}${path}`;

    const x402 = typeof this.paymentMode === 'object' ? this.paymentMode : undefined;
    const method = (init?.method ?? 'GET').toUpperCase();
    const isRead = method === 'GET' || method === 'HEAD';
    const paying =
      x402 !== undefined && !options.unpaid && (isRead ? x402.payForReads === true : options.payable !== false);
    // Unpaid reads in x402 mode use the free tier, as in 'free' mode. An unpaid
    // pool acquisition does not: the gateway ignores X-Payment-Mode there, and its
    // 429 is an allowance refusal for the caller to see, not a read rate limit (#109)
    // Owner-proof requests (unpaid) send X-Payment-Mode: free in every mode, 'none' included
    const freeTier =
      this.paymentMode === 'free' || (x402 !== undefined && !paying && isRead) || options.unpaid === true;
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
          extraHeaders = await untilAborted(options.attemptHeaders.make(controller.signal), controller.signal);
        } catch (error) {
          clearTimeout(timeoutId);
          if (controller.signal.aborted) {
            throw new GatewayConnectionError(options.attemptHeaders.timeoutMessage(), undefined, 'TIMEOUT');
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
            options.attemptHeaders
              ? 'Free tier rate limit exceeded. Owner-proof uploads use the free tier and its rate limit: wait for Retry-After, or (in x402 mode) upload without ownerSigner to pay instead.'
              : x402 && !options.unpaid
                ? 'Free tier rate limit exceeded for reads. Set payment.payForReads to pay for reads in x402 mode.'
                : 'Free tier rate limit exceeded. Consider using x402 payment mode for higher limits.',
            retryAfterSeconds(retryAfter),
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
          // Asked to wait longer than the SDK waits: do not retry (#161)
          if (response.status === 429) {
            const seconds = retryAfterSeconds(response.headers.get('Retry-After'));
            if (seconds !== undefined && seconds > MAX_RETRY_AFTER_S) {
              this.overlongRetryAfter.set(response, seconds);
              return response;
            }
          }
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
      const seconds = retryAfterSeconds(response.headers.get('Retry-After')) ?? 5;
      return Math.min(seconds, MAX_IN_PROGRESS_WAIT_S) * 1000;
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
      const price = request ? describePrice(request, this.paymentPolicy?.decimals, this.paymentPolicy) : undefined;
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
      throw this.invalidResponse(error, response);
    }
  }

  /**
   * Parse a successful response body already read as text (downloads keep the
   * text for canonical hashing). Fails as readJson does (#173).
   */
  private parseJson<T>(text: string, response: Response): T {
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw this.invalidResponse(error, response);
    }
  }

  /** Read a successful response body as text. A read failure is INVALID_RESPONSE, as in readJson (#179) */
  private async readText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch (error) {
      throw this.invalidResponse(error, response);
    }
  }

  /** INVALID_RESPONSE for a success body that is JSON but not the shape the method needs (#179) */
  private shapeError(expected: string, response: Response): GatewayConnectionError {
    const failure = this.invalidResponse(new Error(`expected ${expected}`), response);
    SHAPE_ERRORS.add(failure);
    return failure;
  }

  /** INVALID_RESPONSE for a success body that is not JSON, flagged if the request was paid */
  private invalidResponse(error: unknown, response: Response): GatewayConnectionError {
    const failure = new GatewayConnectionError(
      `Invalid response from gateway: ${error instanceof Error ? error.message : String(error)}`,
      response.status,
      'INVALID_RESPONSE'
    );
    return this.withPayment(failure, response);
  }

  /**
   * CONTENT_HASH_MISMATCH for a downloaded record, flagged if the request was
   * paid. `message` names the right method when the hash proves the record is
   * in the other method's format (#190).
   */
  private hashMismatch(response: Response, message = 'Content hash verification failed'): ProvenanceError {
    return this.withPayment(new ProvenanceError(message, 'CONTENT_HASH_MISMATCH'), response);
  }

  /** Set error.payment and say so in the message if the request was paid */
  private withPayment<E extends ProvenanceError>(failure: E, response: Response): E {
    if (this.paidResponses.has(response)) {
      failure.payment = paymentAttempt(response, this.paidResponses.get(response)!, this.paymentPolicy);
      failure.message += ' (a payment was sent with this request and may have been charged)';
    }
    return failure;
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
    return receiptFields(response, settle, paid.approved, this.paymentPolicy);
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
    } else if (response.status === 413) {
      // Not the gateway's JSON 413 (FILE_TOO_LARGE): the proxy in front of it refused the body
      code = 'FILE_TOO_LARGE';
      const status = response.statusText ? `${response.status} ${response.statusText}` : String(response.status);
      message = `Upload too large: the gateway's proxy refused the request body (${status}). Send less data.`;
    }

    // The price asked: the PAYMENT-REQUIRED header first, then the body (#167)
    const price =
      response.status === 402 ? priceOf(response.headers, isRecord(parsed) ? parsed : undefined, this.paymentPolicy) : undefined;
    if (price) {
      // The gateway's message is cut to leave room for the price, so the price
      // always shows and the two together stay within the cap
      const suffix = ` (price: ${price})`;
      message = suffix.length < MAX_ERROR_TEXT ? `${capText(message, MAX_ERROR_TEXT - suffix.length)}${suffix}` : capText(`${message}${suffix}`);
    }

    const paid = this.paidResponses.has(response);
    const payment = paid ? paymentAttempt(response, this.paidResponses.get(response)!, this.paymentPolicy) : undefined;
    if (payment && typeof fields['nonce'] === 'string' && fields['nonce']) payment.nonce = fields['nonce'];
    if (payment && !payment.transaction && typeof bodyTransaction === 'string') payment.transaction = bodyTransaction;

    const outcome = code === undefined ? undefined : PAYMENT_OUTCOMES[code];
    if (payment && outcome) {
      const error = new PaymentOutcomeError(`${outcomeMessage(outcome, payment)} Gateway: ${message}`, code!, outcome);
      error.payment = payment;
      if (body !== undefined) error.body = body;
      return error;
    }

    // A 429's Retry-After, also when the SDK did not wait for it (#161)
    const overlong = this.overlongRetryAfter.get(response);
    const retryAfter =
      overlong ?? (response.status === 429 ? retryAfterSeconds(response.headers?.get('Retry-After')) : undefined);
    if (overlong !== undefined) {
      // The gateway's message is cut to leave room, so this always shows
      const suffix =
        `. The SDK did not retry: the gateway asked to wait ${overlong} s ` +
        `(Retry-After), more than the ${MAX_RETRY_AFTER_S} s it waits. See retryAfterSeconds.`;
      message = `${capText(message.replace(/[.\s]*$/, ''), MAX_ERROR_TEXT - suffix.length)}${suffix}`;
    }

    const error = new GatewayConnectionError(message, response.status, code, suggestion);
    if (body !== undefined) error.body = body;
    if (retryAfter !== undefined) error.retryAfterSeconds = retryAfter;
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
 * UserRejectedRequestError; ethers v6 code ACTION_REJECTED), here or in the
 * error's cause chain. ethers sets ACTION_REJECTED only for a user rejection
 * and nests the provider's error under `info.error`, not `cause`; the code is
 * enough, so `info` is not inspected (#166).
 */
function isWalletRejection(error: unknown): boolean {
  for (let e = error, depth = 0; e && typeof e === 'object' && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    const { code, name } = e as { code?: unknown; name?: unknown };
    if (code === 4001 || code === 'ACTION_REJECTED' || name === 'UserRejectedRequestError') return true;
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

/**
 * The bytes of a Blob or File to upload. A failed read (for example a
 * NotReadableError DOMException when the file changed or was removed after it
 * was picked) is INVALID_INPUT, before any request (#202). The read error is
 * the cause: a local file read carries no URL.
 */
async function readBlob(content: Blob): Promise<Uint8Array> {
  try {
    return new Uint8Array(await content.arrayBuffer());
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw withCause(new ProvenanceError(`Could not read the Blob or File content: ${reason}`, 'INVALID_INPUT'), error);
  }
}

/** Length of the base64 text for `bytes` bytes, with padding */
function base64Length(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

/**
 * The largest content that fits in a base64 upload, exactly, from the size of
 * the metadata without content (#202). Base64 text needs no JSON escaping, so
 * the metadata is `overhead` plus the base64 length.
 */
function base64SizeHint(overhead: number, maxUploadBytes: number): string {
  if (maxUploadBytes < overhead) return `No content fits: the metadata alone is ${overhead} bytes`;
  const fits = Math.floor((maxUploadBytes - overhead) / 4) * 3;
  if (fits === 0) return `Only empty content fits: the metadata alone is ${overhead} bytes`;
  const mib = fits >= 1048576 ? ` (about ${(fits / 1048576).toFixed(1)} MiB)` : '';
  return `Content up to ${fits} bytes${mib} fits`;
}

/** Stand-in stamp_id while the stamp is not known yet: as long as a batch ID (64 hex characters) */
const STAMP_PLACEHOLDER = '0'.repeat(64);

/** The gateway's default MAX_UPLOAD_SIZE_MB (10), in bytes: the limit on the uploaded metadata JSON */
const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * A raw-mode document: parsed JSON text (any JSON value), or a non-null object
 * that is not binary data (arrays included), as SDK 0.6.x accepted.
 */
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
  if (error instanceof GatewayConnectionError && SHAPE_ERRORS.has(error)) {
    // Valid JSON of the wrong shape is the answer the gateway's app produced. A
    // keyed retry gets that answer again, or IDEMPOTENCY_KEY_DELIVERED_NOT_STORED
    // when the gateway did not store it (too large, or not storable): never a
    // valid one. A body that could not be read or is not JSON (a reset, a proxy
    // page) is not the gateway's answer, so the advice below still applies to it.
    const tx = error.payment.transaction;
    error.message +=
      `${/[.!?]$/.test(error.message) ? '' : '.'} The gateway itself sent this answer, so calling ${operation} again ` +
      `with idempotencyKey "${idempotencyKey}" does not return a valid answer. The payment may have been taken: ` +
      `contact the gateway operator with ${tx ? `transaction ${tx}` : 'the idempotency key'}`;
    // A stamp taken from the pool stays usable for another upload. A caller's
    // own stamp is not named: the caller already has it
    if (stampId !== undefined && error.stampId === stampId) {
      const take = error.stampPayment ? 'buying' : 'taking';
      error.message += `. The pool stamp can still be used: to upload without ${take} another, call ${operation} again with stampId "${stampId}" and a new idempotencyKey`;
    }
    return error;
  }
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

/** download() on a record whose non-string data matches its hash as a JSON value (#190) */
const RAW_IN_DOWNLOAD =
  'Record format does not match download(): "data" is not a string and content_hash is its hash ' +
  'as a JSON value, so this is a raw upload: use downloadDocument() for raw uploads';
/** download() on a record whose hash is that of its string data as a JSON value (#190) */
const RAW_STRING_IN_DOWNLOAD =
  'Record format does not match download(): content_hash is the hash of "data" as a JSON value, ' +
  'so this is a raw upload: use downloadDocument() for raw uploads';
/** downloadDocument() on a record whose hash is that of its base64-decoded data (#190) */
const BASE64_IN_DOWNLOAD_DOCUMENT =
  'Record format does not match downloadDocument(): content_hash is the hash of the base64-decoded ' +
  '"data", so this is a base64 upload: use download() for base64 uploads';

/** content_hash is SHA-256 of the base64-decoded data, as download() checks. Invalid base64 is no match */
function matchesAsBase64(data: string, contentHash: string): boolean {
  try {
    return sha256Hex(base64ToBytes(data)) === contentHash;
  } catch {
    return false;
  }
}

/**
 * INVALID_RESPONSE errors for a success body that is JSON of the wrong shape
 * (shapeError), as opposed to one that could not be read or is not JSON (#199)
 */
const SHAPE_ERRORS = new WeakSet<GatewayConnectionError>();

/** A JSON object: not null, not an array */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Absent, null, or of the given typeof */
function optionalOf(value: unknown, type: 'string' | 'number'): boolean {
  return value === undefined || value === null || typeof value === type;
}

/** A price quote with every field toPriceQuote() copies */
function isPriceQuote(value: unknown): value is GatewayPriceQuote {
  return (
    isRecord(value) &&
    typeof value['method'] === 'string' &&
    typeof value['path'] === 'string' &&
    typeof value['price_usd'] === 'number' &&
    typeof value['max_amount_required'] === 'string' &&
    typeof value['description'] === 'string'
  );
}

/**
 * A GET /api/v1/pricing body pricing() can read (#199): boolean x402_enabled,
 * and optional fields that are absent, null, or of the type they are copied as.
 */
function isPricingResponse(value: unknown): value is GatewayPricingResponse {
  if (!isRecord(value) || typeof value['x402_enabled'] !== 'boolean') return false;
  if (!(['currency', 'network', 'asset', 'pay_to'] as const).every((k) => optionalOf(value[k], 'string'))) return false;
  if (!optionalOf(value['min_price_usd'], 'number')) return false;
  const freeTier = value['free_tier'];
  if (
    freeTier !== undefined &&
    freeTier !== null &&
    !(isRecord(freeTier) && typeof freeTier['enabled'] === 'boolean' && typeof freeTier['header'] === 'string')
  ) {
    return false;
  }
  const quotes = value['quotes'];
  if (quotes === undefined || quotes === null) return true;
  // Only the quotes pricing() reads; one that is absent or null is not listed, as before
  return (
    isRecord(quotes) &&
    (['stamp_purchase', 'pool_acquire', 'data_upload', 'bandwidth_credit'] as const).every(
      (k) => quotes[k] === undefined || quotes[k] === null || isPriceQuote(quotes[k])
    )
  );
}

/** Minimum interval between re-checks of a cached notary address (see verifySignatures) */
const NOTARY_RECHECK_MS = 60_000;

/**
 * The reference for the request path (#123): 64 or 128 hex characters, optional
 * 0x (removed). Anything else (a path, a query, whitespace) throws before a request.
 */
function checkedReference(reference: string): string {
  const ref = referencePathSegment(reference);
  if (ref === undefined) {
    throw new ProvenanceError(
      `Invalid Swarm reference: expected 64 or 128 hex characters (optional 0x prefix), got ${JSON.stringify(reference)}`,
      'INVALID_INPUT'
    );
  }
  return ref;
}

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

/**
 * The facilitator's SettleResponse: the decoded PAYMENT-RESPONSE (v2), else
 * X-PAYMENT-RESPONSE (v1), in @x402/core's order (D4). The first header present
 * decides: one that does not decode (or is too long) counts as no receipt.
 */
function settleResponse(response: Response): Record<string, unknown> | undefined {
  return decodePaymentHeader(response.headers.get('PAYMENT-RESPONSE') || response.headers.get('X-PAYMENT-RESPONSE'));
}

/** A non-empty string that is not the gateway's "unknown" placeholder */
function reported(value: unknown): string | undefined {
  return typeof value === 'string' && value && value !== 'unknown' ? value : undefined;
}

/**
 * What a paid response says about its payment: the transaction (header, else
 * receipt), network and payer (receipt; network falls back to the signed
 * requirement), and the amount the SDK signed. The amount is never taken from
 * the gateway: its receipt has none. The network is always the x402 v1 name
 * (#159): a receipt network with no v1 name, or a malformed one, is replaced by
 * the signed network's.
 */
function receiptFields(
  response: Response,
  settle: Record<string, unknown> | undefined,
  approved: PaymentRequest | undefined,
  policy: PaymentPolicy | undefined
): PaymentReceipt {
  const decimals = policy?.decimals;
  const v1Name = (id: unknown) => {
    const name = networkName(reported(id), policy);
    return name && !name.includes(':') ? name : undefined;
  };
  const receipt: PaymentReceipt = {};
  // The gateway sends "unknown" when it has no transaction to name
  const transaction = reported(response.headers.get('X-Payment-Transaction')) ?? reported(settle?.['transaction']);
  if (transaction) receipt.transaction = transaction;
  const network = v1Name(settle?.['network']) ?? v1Name(approved?.network);
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
function paymentAttempt(response: Response, paid: PaidAttempt, policy: PaymentPolicy | undefined): PaymentAttempt {
  const attempt: PaymentAttempt = { paymentSent: true };
  if (paid.idempotencyKey !== undefined) attempt.idempotencyKey = paid.idempotencyKey;
  const settle = settleResponse(response);
  const fields = receiptFields(response, settle, settle ? paid.approved : undefined, policy);
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
  if (source.retryAfterSeconds !== undefined) target.retryAfterSeconds = source.retryAfterSeconds;
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

/**
 * How far an owner-proof timestamp may run ahead of the clock before the
 * client waits. The gateway refuses more than 300 s; 30 s leaves room for
 * clock skew.
 */
const OWNER_PROOF_MAX_LEAD_S = 30;

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
 * Headers made anew for each request attempt (owner proofs are single use),
 * and the message for a timeout while they are being made.
 */
interface AttemptHeaders {
  make(signal: AbortSignal): Promise<Record<string, string>>;
  timeoutMessage(): string;
}

/** The signer's address, when it exposes one (viem LocalAccount or WalletClient) */
function signerAddress(signer: OwnerSigner): string | undefined {
  const s = signer as { address?: unknown; account?: { address?: unknown } };
  const address = typeof s.address === 'string' ? s.address : s.account?.address;
  return typeof address === 'string' ? address.toLowerCase() : undefined;
}

/**
 * Makes the owner-proof headers for one attempt (#124). The gateway accepts a
 * proof once, keyed on the signed message and signer, and signing is
 * deterministic, so each attempt signs a timestamp the client has not used
 * for this stamp and signer (see reserveOwnerProofTimestamp). The signature is a bearer credential for one upload: it is
 * never put in an error message.
 */
function ownerProofHeaders(
  signer: OwnerSigner,
  stampId: string,
  reserve: (key: string, signal: AbortSignal) => Promise<number>
): AttemptHeaders {
  const key = `${stampId.toLowerCase()}|${signerAddress(signer) ?? ''}`;
  // What the current attempt is waiting for; attempts of one upload run one at a time
  let waitingFor: 'clock' | 'signature' = 'clock';
  const timeoutMessage = () =>
    waitingFor === 'clock'
      ? `Request timed out waiting for the clock: too many owner-proof uploads to this stamp are in flight (one client signs at most one proof per second per stamp, up to ${OWNER_PROOF_MAX_LEAD_S} s ahead)`
      : 'Request timed out waiting for the owner-proof signature';
  const make = async (signal: AbortSignal): Promise<Record<string, string>> => {
    waitingFor = 'clock';
    const timestamp = await reserve(key, signal);
    waitingFor = 'signature';
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
  return { make, timeoutMessage };
}

/** Longest gateway text kept on an error (`body` text, message), in characters: a proxy's error page is not kept whole */
const MAX_ERROR_TEXT = 4096;
/** Largest JSON error body (characters of its text) kept parsed on `error.body`; a larger one is kept as capped text */
const MAX_ERROR_JSON = 16384;

/**
 * `text` cut to MAX_ERROR_TEXT characters (UTF-16 code units), with an
 * ellipsis when cut. A cut never splits a surrogate pair.
 */
function capText(text: string, max = MAX_ERROR_TEXT): string {
  if (text.length <= max) return text;
  let end = max - 1; // room for the ellipsis: a cut text is at most `max` characters
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--; // a high surrogate whose pair would be cut off
  return `${text.slice(0, end)}…`;
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

/**
 * An x402 payment request, in @x402/core's order: the PAYMENT-REQUIRED header
 * (v2) when it decodes to one, else the body's top level (the gateway now),
 * else the deprecated `detail` copy.
 */
function paymentRequestOf(
  headers: Headers,
  data: Record<string, unknown> | undefined
): { x402Version: number; accepts: unknown[] } | undefined {
  const isRequest = (v: unknown): v is { x402Version: number; accepts: unknown[] } =>
    Boolean(v) && typeof v === 'object' && typeof (v as { x402Version?: unknown }).x402Version === 'number' &&
    Array.isArray((v as { accepts?: unknown }).accepts);
  const header = decodePaymentHeader(headers.get('PAYMENT-REQUIRED'));
  if (isRequest(header)) return header;
  if (data === undefined) return undefined;
  if (isRequest(data)) return data;
  return isRequest(data['detail']) ? data['detail'] : undefined;
}

/** The price a 402 asks, e.g. "0.01 USDC on base-sepolia"; options joined with "or". Never the raw JSON. */
function priceOf(
  headers: Headers,
  data: Record<string, unknown> | undefined,
  policy: PaymentPolicy | undefined
): string | undefined {
  const request = paymentRequestOf(headers, data);
  if (!request) return undefined;
  const prices = request.accepts
    .filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === 'object')
    .map((o) => describePrice(toPaymentRequest(request.x402Version, o), undefined, policy))
    .filter((p): p is string => p !== undefined);
  if (prices.length === 0) return undefined;
  const shown = prices.slice(0, MAX_PRICES_SHOWN).join(' or ');
  return prices.length > MAX_PRICES_SHOWN ? `${shown} (and ${prices.length - MAX_PRICES_SHOWN} more)` : shown;
}

/** Longest amount shown in a price, in digits: more than any token supply */
const MAX_AMOUNT_DIGITS = 78;

/**
 * A requested payment as a price, e.g. "0.01 USDC on base-sepolia". USDC is
 * known to have 6 decimals; another asset uses `decimals` (the policy's) when
 * given, else is shown in its smallest units. Undefined if the amount is not an
 * integer. The network is named the x402 v1 way, as receipts name it (#159).
 * The 402 is untrusted: a network or asset that is not well formed shows as '?'.
 */
function describePrice(request: PaymentRequest, decimals?: number, policy?: PaymentPolicy): string | undefined {
  if (!/^\d+$/.test(request.amount) || request.amount.length > MAX_AMOUNT_DIGITS) return undefined;
  const network = networkName(request.network, policy) ?? '?';
  const asset = isAddress(request.asset) ? request.asset : '?';
  const usdc = Object.hasOwn(USDC_BY_NETWORK, request.network) ? USDC_BY_NETWORK[request.network] : undefined;
  if (usdc && usdc.toLowerCase() === request.asset.toLowerCase()) {
    return `${formatAtomic(BigInt(request.amount), 6)} USDC on ${network}`;
  }
  return decimals !== undefined
    ? `${formatAtomic(BigInt(request.amount), decimals)} of token ${asset} on ${network}`
    : `${request.amount} smallest units of ${asset} on ${network}`;
}
