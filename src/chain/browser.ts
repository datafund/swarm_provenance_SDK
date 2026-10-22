// Browser build of @datafund/swarm-provenance/chain (#123): everything the Node
// entry exports except fromPrivateKey, so a raw private key cannot be wired into
// frontend code by accident. Bundlers that resolve the "browser" export
// condition use this file; use fromEip1193Provider or fromViemWalletClient there.
// Main client
export { ChainClient } from './client.js';

// Signer factories
export { fromViemWalletClient, fromEip1193Provider } from './signer.js';

// Types
export type {
  Address,
  BalanceInfo,
  Hex,
  ChainSigner,
  ChainClientConfig,
  ChainPreset,
  ChainProvenanceRecord,
  ChainTransformation,
  ProvenanceChainResult,
  RetryConfig,
  TransformationLink,
  TransactionResult,
  AnchorResult,
  AccessResult,
  TransformResult,
  MergeTransformResult,
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
  DataAlreadyRegisteredError,
  DataNotRegisteredError,
  SignerRequiredError,
  ReceiptTimeoutError,
  rpcErrorMessage,
} from './errors.js';

export type { ExpectedEvent } from './client.js';

// Constants
export { BASE_SEPOLIA, BASE_MAINNET, CHAIN_PRESETS, PRESET_RPC_FALLBACKS } from './constants.js';

// Validation utilities
export { normalizeHash } from './validation.js';

// Contract encoding (advanced use)
export { encodeGetDataHashByStorageRef, decodeGetDataHashByStorageRef } from './contract.js';
