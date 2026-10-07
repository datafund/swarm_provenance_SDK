import { ProvenanceError } from '../errors.js';

/**
 * Base error for all chain-related errors
 */
export class ChainError extends ProvenanceError {
  constructor(message: string, code?: string) {
    super(message, code);
    this.name = 'ChainError';
    Object.setPrototypeOf(this, ChainError.prototype);
  }
}

/**
 * Configuration errors (missing viem, invalid chain config)
 */
export class ChainConfigurationError extends ChainError {
  constructor(message: string) {
    super(message, 'CHAIN_CONFIGURATION');
    this.name = 'ChainConfigurationError';
    Object.setPrototypeOf(this, ChainConfigurationError.prototype);
  }
}

/**
 * RPC connection errors
 */
export class ChainConnectionError extends ChainError {
  constructor(message: string) {
    super(message, 'CHAIN_CONNECTION');
    this.name = 'ChainConnectionError';
    Object.setPrototypeOf(this, ChainConnectionError.prototype);
  }
}

/**
 * Transaction errors (reverted, out of gas, etc.)
 */
export class ChainTransactionError extends ChainError {
  /**
   * The underlying error, for debugging. Not enumerable, so logging or
   * JSON-serialising this error does not expose its details (viem errors carry
   * the RPC URL, which may embed a provider API key).
   */
  declare public readonly originalError?: Error;

  constructor(
    message: string,
    public readonly txHash?: string,
    originalError?: Error,
  ) {
    super(message, 'CHAIN_TRANSACTION');
    this.name = 'ChainTransactionError';
    Object.defineProperty(this, 'originalError', { value: originalError, enumerable: false });
    Object.setPrototypeOf(this, ChainTransactionError.prototype);
  }
}

/**
 * A transaction was sent but its receipt could not be obtained (timeout, or the
 * RPC failed while waiting). It may still confirm: use
 * `ChainClient.waitForTransaction(txHash)` to keep waiting. Do not resend
 * blindly, writes are not idempotent.
 */
export class ReceiptTimeoutError extends ChainConnectionError {
  constructor(
    message: string,
    public readonly txHash: string,
    public readonly explorerUrl?: string,
    /** What the write must emit to count as done: pass to waitForTransaction to keep that check */
    public readonly expected?: { event: string; count?: number },
  ) {
    // Same code as other connection errors (CHAIN_CONNECTION), so code-based
    // handling keeps matching; tell it apart by class or txHash
    super(message);
    this.name = 'ReceiptTimeoutError';
    Object.setPrototypeOf(this, ReceiptTimeoutError.prototype);
  }
}

/**
 * Error text safe to show and log: viem's verbose sections (URL, request
 * body, ...) are dropped and any URL left in the text is redacted, since RPC
 * URLs often embed a provider API key (#118).
 */
export function rpcErrorMessage(error: unknown): string {
  let text: string;
  if (error instanceof Error) {
    // viem errors: shortMessage plus details (e.g. the node's reason), without the URL sections
    const { shortMessage, details } = error as { shortMessage?: unknown; details?: unknown };
    text =
      typeof shortMessage === 'string' && shortMessage
        ? shortMessage + (typeof details === 'string' && details && !shortMessage.includes(details) ? ` ${details}` : '')
        : error.message;
  } else if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
    text = (error as { message: string }).message;
  } else {
    text = String(error);
  }
  return sanitizeErrorText(text);
}

/** Drop viem's verbose sections (URL, request body, arguments, ...) and redact URLs. */
export function sanitizeErrorText(text: string): string {
  const cut = text.search(/\n\s*(URL:|Request body:|Request Arguments:|Raw Call Arguments:|Contract Call:|Docs:|Version:)/);
  return redactUrls((cut >= 0 ? text.slice(0, cut) : text).trim());
}

/** Replace every URL (and its credentials, path and query) with a placeholder */
export function redactUrls(text: string): string {
  return text.replace(/\b(?:https?|wss?):\/\/[^\s"'<>)]+/gi, '<rpc url>');
}

/**
 * Input validation errors (bad hash format, etc.)
 */
export class ChainValidationError extends ChainError {
  constructor(message: string) {
    super(message, 'CHAIN_VALIDATION');
    this.name = 'ChainValidationError';
    Object.setPrototypeOf(this, ChainValidationError.prototype);
  }
}

/**
 * Data hash not found on-chain
 */
export class DataNotRegisteredError extends ChainError {
  constructor(dataHash: string) {
    super(`Data hash ${dataHash} is not registered on-chain`, 'DATA_NOT_REGISTERED');
    this.name = 'DataNotRegisteredError';
    Object.setPrototypeOf(this, DataNotRegisteredError.prototype);
  }
}

/**
 * Data hash is already registered on-chain
 */
export class DataAlreadyRegisteredError extends ChainError {
  constructor(
    public readonly dataHash: string,
    public readonly owner: string,
    public readonly timestamp: number,
    public readonly dataType: string,
  ) {
    super(`Data hash ${dataHash} is already registered on-chain`, 'DATA_ALREADY_REGISTERED');
    this.name = 'DataAlreadyRegisteredError';
    Object.setPrototypeOf(this, DataAlreadyRegisteredError.prototype);
  }
}

/**
 * Write operation attempted without a signer
 */
export class SignerRequiredError extends ChainError {
  constructor() {
    super('A signer is required for write operations', 'SIGNER_REQUIRED');
    this.name = 'SignerRequiredError';
    Object.setPrototypeOf(this, SignerRequiredError.prototype);
  }
}
