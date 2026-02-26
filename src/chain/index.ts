// Main client
export { ChainClient } from './client.js';

// Signer factories
export { fromViemWalletClient, fromPrivateKey, fromEip1193Provider } from './signer.js';

// Types
export type {
  Address,
  Hex,
  ChainSigner,
  ChainClientConfig,
  ChainPreset,
  ChainProvenanceRecord,
  ChainTransformation,
  TransactionResult,
  AnchorResult,
  AccessResult,
  TransformResult,
  StatusResult,
  TransferResult,
  DelegateResult,
  BatchResult,
} from './types.js';

export { DataStatus } from './types.js';

// Errors
export {
  ChainError,
  ChainConfigurationError,
  ChainConnectionError,
  ChainTransactionError,
  ChainValidationError,
  DataNotRegisteredError,
  SignerRequiredError,
} from './errors.js';

// Constants
export { BASE_SEPOLIA, BASE_MAINNET, CHAIN_PRESETS } from './constants.js';

// Validation utilities
export { normalizeHash } from './validation.js';
