/**
 * Base error class for all SDK errors
 */
export class ProvenanceError extends Error {
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
