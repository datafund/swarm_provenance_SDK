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
  constructor(
    message: string,
    public readonly txHash?: string,
  ) {
    super(message, 'CHAIN_TRANSACTION');
    this.name = 'ChainTransactionError';
    Object.setPrototypeOf(this, ChainTransactionError.prototype);
  }
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
