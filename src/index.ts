// Main client
export { ProvenanceClient } from './client.js';

// Types
export type {
  ProvenanceClientConfig,
  PaymentWallet,
  X402PaymentConfig,
  PaymentRequest,
  PaymentMode,
  GatewayRetryConfig,
  UploadOptions,
  DownloadOptions,
  SignatureCheck,
  SignatureVerification,
  UploadResult,
  DownloadResult,
  DocumentMetadata,
  DocumentUploadResult,
  DocumentDownloadResult,
  ProvenanceMetadata,
  NotarySignature,
  SignedDocument,
  NotaryInfo,
  PoolStatus,
  AcquiredStamp,
} from './types.js';

// Errors
export {
  ProvenanceError,
  GatewayConnectionError,
  StampError,
  NotaryError,
  VerificationError,
  PaymentError,
  PaymentConfigurationError,
  PaymentRefusedError,
  type PaymentAttempt,
  PaymentRateLimitError,
} from './errors.js';

// Utilities (for advanced use)
export {
  buildMetadata,
  buildDocumentMetadata,
  extractContent,
  verifyContentHash,
  verifyDocumentHash,
  parseMetadata,
  serializeMetadata,
} from './metadata.js';

export {
  verifySignature,
  verifyAllSignatures,
  verifyDataHash,
  recoverSigner,
  computeNotaryDataHash,
  NOTARY_MESSAGE_FORMAT,
} from './notary.js';

export { canonicalizeJsonText, canonicalizeJsonValue } from './canonical-json.js';

export {
  sha256Hex,
  toBytes,
  bytesToBase64,
  base64ToBytes,
  isValidSwarmReference,
} from './utils.js';
