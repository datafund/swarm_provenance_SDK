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
    code?: string
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
