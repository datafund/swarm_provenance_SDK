/** Set on errors for requests that carried an x402 payment: the gateway may have settled it. */
export interface PaymentAttempt {
  /** The request carried a signed payment authorization */
  paymentSent: true;
  /** Settlement transaction, if the gateway reported one */
  transaction?: string;
  /** Gateway-reported payment status, if any */
  status?: string;
  /**
   * Network the payment was made on: the receipt's, else the one signed for.
   * Always the x402 v1 name ('base-sepolia', 'base', or `payment.v1Network`),
   * whichever x402 version paid (#159); CAIP-2 with x402 v1's removal (#210).
   */
  network?: string;
  /** Paying address, from the gateway's receipt, if it sent one */
  payer?: string;
  /**
   * Amount the SDK signed, in the token's smallest unit (integer string): the
   * approved requirement's v1 `maxAmountRequired` or v2 `amount`. Not proof of
   * a charge: see `transaction`.
   */
  amount?: string;
  /** `amount` in tokens, with the policy's decimals */
  amountDecimal?: string;
  /** Token contract the amount is in */
  asset?: string;
  /**
   * The gateway replayed a stored answer for this Idempotency-Key
   * (`Idempotent-Replayed: true`, Node only). `transaction` is the first
   * attempt's; `amount` is this retry's authorization, which was not settled.
   */
  replayed?: true;
  /**
   * Idempotency-Key the request was sent with. Retrying the same operation with
   * it (`idempotencyKey` option) is never charged twice: the gateway returns the
   * first result instead.
   */
  idempotencyKey?: string;
  /** Payment authorization nonce, when the gateway could not tell whether it settled */
  nonce?: string;
  /**
   * Stamp the upload used. Pass it back as `stampId` together with
   * `idempotencyKey`: a retry with another stamp is a different request.
   */
  stampId?: string;
}

/**
 * Marks a ProvenanceError from any copy of this class (#205). The main entry and
 * each chain entry are separate bundles with their own copy of ProvenanceError.
 * Symbol.for returns the same symbol in every copy, so the brand lets
 * `instanceof ProvenanceError` match across them.
 */
const PROVENANCE_ERROR_BRAND = Symbol.for('@datafund/swarm-provenance/ProvenanceError');

/**
 * Base error class for all SDK errors
 */
export class ProvenanceError extends Error {
  /**
   * `error instanceof ProvenanceError` is true for errors from every entry of
   * the package (#205): `/chain` errors too, although that bundle has its own
   * copy of this class. Subclasses (StampError, ChainError, ...) inherit this
   * method but match by prototype only, so they never match across copies.
   * Never throws: a value whose prototype or brand cannot be read (for example
   * a Proxy whose traps throw, or a revoked Proxy) is not a ProvenanceError.
   */
  static [Symbol.hasInstance](value: unknown): boolean {
    try {
      if (Function.prototype[Symbol.hasInstance].call(this, value)) return true;
      // Read the brand as an own data property: no getter or Proxy get trap runs
      return (
        this === ProvenanceError &&
        typeof value === 'object' &&
        value !== null &&
        Object.getOwnPropertyDescriptor(value, PROVENANCE_ERROR_BRAND)?.value === true
      );
    } catch {
      return false;
    }
  }

  /**
   * Present when the failed request carried an x402 payment: the gateway may
   * have settled it even though the request failed. Not retried automatically,
   * except a paid write the gateway answers with IDEMPOTENCY_KEY_IN_PROGRESS or
   * IDEMPOTENCY_UNAVAILABLE: that is retried with the same Idempotency-Key.
   */
  public payment?: PaymentAttempt;

  /**
   * `upload()` only: the stamp it acquired from the pool before this error.
   * Set whether or not the failed request paid; pass it back as `stampId`.
   */
  public stampId?: string;

  /**
   * `upload()` only: the receipt for the pool stamp it paid for before this
   * error. That payment succeeded; `payment` (if set) is the failed request's own.
   */
  public stampPayment?: import('./types.js').PaymentReceipt;

  /**
   * Gateway error responses only: the response body, parsed if it is JSON of
   * at most 16384 characters. A larger JSON body, or one that is not JSON, is
   * kept as its text, cut to 4096 characters with an ellipsis when longer.
   * Codes and fields the SDK does not map are here.
   */
  public body?: unknown;

  /**
   * 429 responses only: the wait the gateway asked for in `Retry-After`, in
   * seconds, when it sent one the SDK can read (delta-seconds or an HTTP date).
   * Set also when the SDK did not retry because the wait was longer than 60 s.
   */
  public retryAfterSeconds?: number | undefined;

  /**
   * The error this one wraps, when the SDK wrapped one: for example the
   * JSON.stringify error of raw content, or a wallet's refusal (#202).
   * Declared here so that it can be read with a TypeScript lib older than ES2022.
   */
  declare public cause?: unknown;

  constructor(
    message: string,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'ProvenanceError';
    // Not enumerable: kept out of keys, JSON and default inspection output
    Object.defineProperty(this, PROVENANCE_ERROR_BRAND, { value: true });
    // new.target, not ProvenanceError: a subclass (the SDK's or a consumer's)
    // keeps its own prototype and methods. The subclasses need no call of their own.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Set `cause` on an error, as the ES2022 Error constructor option does
 * (non-enumerable), and return the error.
 */
export function withCause<E extends Error>(error: E, cause: unknown): E {
  Object.defineProperty(error, 'cause', { value: cause, enumerable: false, writable: true, configurable: true });
  return error;
}

/**
 * Error connecting to or communicating with the gateway
 */
export class GatewayConnectionError extends ProvenanceError {
  constructor(
    message: string,
    public readonly statusCode?: number,
    code?: string,
    public readonly suggestion?: string,
  ) {
    super(message, code);
    this.name = 'GatewayConnectionError';
  }
}

/**
 * Error related to postage stamps (acquisition, validation, etc.)
 */
export class StampError extends ProvenanceError {
  constructor(message: string, code?: string) {
    super(message, code);
    this.name = 'StampError';
  }
}

/**
 * Error related to notary signing service
 */
export class NotaryError extends ProvenanceError {
  constructor(message: string, code?: string) {
    super(message, code);
    this.name = 'NotaryError';
  }
}

/**
 * Error when signature verification fails
 */
export class VerificationError extends ProvenanceError {
  constructor(message: string, code?: string) {
    super(message, code);
    this.name = 'VerificationError';
  }
}

/**
 * Base error for payment-related issues
 */
export class PaymentError extends ProvenanceError {
  constructor(message: string, code?: string) {
    super(message, code);
    this.name = 'PaymentError';
  }
}

/**
 * Error when x402 payment packages are missing or wallet is invalid
 */
export class PaymentConfigurationError extends PaymentError {
  constructor(message: string) {
    super(message, 'PAYMENT_CONFIGURATION');
    this.name = 'PaymentConfigurationError';
  }
}

/**
 * A payment the gateway asked for was refused before signing. Nothing was
 * signed or paid. The causes:
 * - it broke the configured policy (amount, asset, recipient, validity,
 *   network), or `onBeforePayment` vetoed it;
 * - the 402 response carries no readable payment requirements (`refusals` is empty);
 * - the signature was declined in the wallet.
 */
export class PaymentRefusedError extends PaymentError {
  constructor(
    message: string,
    /** The requests that were refused and why, one entry per offered option */
    public readonly refusals: ReadonlyArray<{ request: import('./types.js').PaymentRequest; reasons: string[] }> = [],
  ) {
    super(message, 'PAYMENT_REFUSED');
    this.name = 'PaymentRefusedError';
  }
}

/**
 * A retry of a paid request (same Idempotency-Key) found that the first
 * attempt's payment needs a person to follow up. Never retried automatically.
 *
 * - `IDEMPOTENCY_KEY_SETTLEMENT_UNKNOWN` (`outcome: 'unknown'`): the payment may
 *   or may not have been collected. Check `payment.nonce` on-chain before paying again.
 * - `IDEMPOTENCY_KEY_SETTLED_PENDING` (`outcome: 'settled_not_delivered'`): the
 *   first attempt was paid (`payment.transaction`) and its result is not
 *   available. Ask the gateway operator for the result or a refund.
 * - `IDEMPOTENCY_KEY_DELIVERED_NOT_STORED` (`outcome: 'delivered'`): the first
 *   attempt succeeded and was paid once, but the gateway kept no copy of its
 *   response. The operation worked: do not pay for it again.
 */
export class PaymentOutcomeError extends PaymentError {
  constructor(
    message: string,
    code: string,
    public readonly outcome: 'unknown' | 'settled_not_delivered' | 'delivered',
  ) {
    super(message, code);
    this.name = 'PaymentOutcomeError';
  }
}

/**
 * Error when free tier rate limit (429) is exceeded
 */
export class PaymentRateLimitError extends PaymentError {
  constructor(
    message: string,
    public readonly retryAfterSeconds?: number,
    public readonly requestsLimit?: number,
    public readonly requestsRemaining?: number
  ) {
    super(message, 'PAYMENT_RATE_LIMIT');
    this.name = 'PaymentRateLimitError';
  }
}
