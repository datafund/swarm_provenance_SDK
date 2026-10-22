/** Set on errors for requests that carried an x402 payment: the gateway may have settled it. */
export interface PaymentAttempt {
  /** The request carried a signed payment authorization */
  paymentSent: true;
  /** Settlement transaction, if the gateway reported one */
  transaction?: string;
  /** Gateway-reported payment status, if any */
  status?: string;
  /** Network the payment was made on: the receipt's, else the one signed for */
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
 * Base error class for all SDK errors
 */
export class ProvenanceError extends Error {
  /**
   * Present when the failed request carried an x402 payment: the gateway may
   * have settled it even though the request failed. Never retried automatically.
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

  constructor(
    message: string,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'ProvenanceError';
    Object.setPrototypeOf(this, ProvenanceError.prototype);
  }
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
    Object.setPrototypeOf(this, GatewayConnectionError.prototype);
  }
}

/**
 * Error related to postage stamps (acquisition, validation, etc.)
 */
export class StampError extends ProvenanceError {
  constructor(message: string, code?: string) {
    super(message, code);
    this.name = 'StampError';
    Object.setPrototypeOf(this, StampError.prototype);
  }
}

/**
 * Error related to notary signing service
 */
export class NotaryError extends ProvenanceError {
  constructor(message: string, code?: string) {
    super(message, code);
    this.name = 'NotaryError';
    Object.setPrototypeOf(this, NotaryError.prototype);
  }
}

/**
 * Error when signature verification fails
 */
export class VerificationError extends ProvenanceError {
  constructor(message: string, code?: string) {
    super(message, code);
    this.name = 'VerificationError';
    Object.setPrototypeOf(this, VerificationError.prototype);
  }
}

/**
 * Base error for payment-related issues
 */
export class PaymentError extends ProvenanceError {
  constructor(message: string, code?: string) {
    super(message, code);
    this.name = 'PaymentError';
    Object.setPrototypeOf(this, PaymentError.prototype);
  }
}

/**
 * Error when x402 payment packages are missing or wallet is invalid
 */
export class PaymentConfigurationError extends PaymentError {
  constructor(message: string) {
    super(message, 'PAYMENT_CONFIGURATION');
    this.name = 'PaymentConfigurationError';
    Object.setPrototypeOf(this, PaymentConfigurationError.prototype);
  }
}

/**
 * A payment the gateway asked for was refused before signing: it broke the
 * configured policy (amount, asset, recipient, validity, network) or
 * `onBeforePayment` vetoed it. Nothing was signed or paid.
 */
export class PaymentRefusedError extends PaymentError {
  constructor(
    message: string,
    /** The requests that were refused and why, one entry per offered option */
    public readonly refusals: ReadonlyArray<{ request: import('./types.js').PaymentRequest; reasons: string[] }> = [],
  ) {
    super(message, 'PAYMENT_REFUSED');
    this.name = 'PaymentRefusedError';
    Object.setPrototypeOf(this, PaymentRefusedError.prototype);
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
    Object.setPrototypeOf(this, PaymentOutcomeError.prototype);
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
    Object.setPrototypeOf(this, PaymentRateLimitError.prototype);
  }
}
