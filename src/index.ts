// Main client
export { ProvenanceClient } from './client.js';

// Types
export type {
  ProvenanceClientConfig,
  UploadOptions,
  DownloadOptions,
  UploadResult,
  DownloadResult,
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
} from './errors.js';

// Utilities (for advanced use)
export {
  buildMetadata,
  extractContent,
  verifyContentHash,
  parseMetadata,
  serializeMetadata,
} from './metadata.js';

export {
  verifySignature,
  verifyAllSignatures,
  verifyDataHash,
} from './notary.js';

export {
  sha256Hex,
  toBytes,
  bytesToBase64,
  base64ToBytes,
  isValidSwarmReference,
} from './utils.js';
