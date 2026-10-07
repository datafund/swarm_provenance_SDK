/**
 * Wallet interface for x402 payment signing.
 * Compatible with viem's WalletClient extended with publicActions, or
 * composed via `toClientEvmSigner(account, publicClient)` from @x402/evm.
 */
export type PaymentWallet = PaymentWalletMethods &
  (
    | { /** Signer address (e.g. from toClientEvmSigner) */ address: `0x${string}` }
    | { /** viem WalletClient: the address is read from its account */ account: { address: `0x${string}` } }
  );

/** Signing and read methods every payment wallet needs (see PaymentWallet). */
export interface PaymentWalletMethods {
  signTypedData(args: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
  readContract(args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
}

/**
 * Configuration for x402 automatic payment mode
 */
export interface X402PaymentConfig {
  /** Wallet that signs x402 payment authorizations */
  wallet: PaymentWallet;
  /** CAIP-2 network identifier for x402 v2 (default: 'eip155:84532' for Base Sepolia) */
  network?: `${string}:${string}`;
  /** Simple network name for x402 v1 (default: 'base-sepolia') */
  v1Network?: string;
  /**
   * Largest single payment the SDK will sign, in whole tokens as a decimal
   * string (e.g. '0.50' = 50 cents of USDC). Required on Base mainnet; on
   * testnets it defaults to '1'. A 402 asking for more is refused before signing.
   */
  maxAmount?: string;
  /** Recipients (`payTo`) the SDK may pay. If set, payments to any other address are refused. */
  payTo?: string[];
  /** Longest authorization validity the gateway may ask for, in seconds (default: 600). */
  maxTimeoutSeconds?: number;
  /**
   * Token to pay with. Defaults to the network's USDC; required on networks
   * without a known USDC (payments are refused otherwise).
   */
  asset?: string;
  /** Decimals of `asset` (default: 6, as USDC) */
  assetDecimals?: number;
  /**
   * Called before a payment is handed to the x402 library for signing, after the
   * checks above passed. Return false (or throw) to refuse it. A payment may
   * still not happen after this returns (signing fails, timeout), so do not
   * count spend here.
   */
  onBeforePayment?: (payment: PaymentRequest) => boolean | void | Promise<boolean | void>;
  /**
   * Pay for reads (GET/HEAD) too. Default false: reads use the free tier
   * (`X-Payment-Mode: free`, rate-limited) and only writes are paid.
   */
  payForReads?: boolean;
}

/** A payment the gateway asked for, as shown to `onBeforePayment` and in refusals */
export interface PaymentRequest {
  /** x402 protocol version of the 402 response */
  x402Version: number;
  /** Network as the gateway named it (CAIP-2 for v2, e.g. 'base-sepolia' for v1) */
  network: string;
  scheme: string;
  /** Token contract */
  asset: string;
  /** Amount in the token's smallest unit (integer string) */
  amount: string;
  /** Recipient */
  payTo: string;
  /** Authorization validity the gateway asked for */
  maxTimeoutSeconds: number;
}

/**
 * Payment mode for gateway access.
 * - 'free': Sends X-Payment-Mode: free header (default, rate-limited)
 * - 'none': No payment header (get raw 402 responses)
 * - X402PaymentConfig: Automatic x402 USDC payments
 */
export type PaymentMode = 'free' | 'none' | X402PaymentConfig;

/** Retry configuration for transient gateway failures */
export interface GatewayRetryConfig {
  /** Max retry attempts (default: 2) */
  maxRetries?: number;
  /** Base delay in ms, doubled each retry (default: 1000) */
  baseDelayMs?: number;
}

/**
 * Configuration options for ProvenanceClient
 */
export interface ProvenanceClientConfig {
  /** Gateway URL (default: https://provenance-gateway.datafund.io) */
  gatewayUrl?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Payment mode for gateway access (default: 'free') */
  payment?: PaymentMode;
  /** Retry config for transient gateway failures (default: 2 retries, 1s delay) */
  retry?: GatewayRetryConfig;
}

/**
 * Options for uploading provenance data
 */
export interface UploadOptions {
  /** Enable notary signing */
  sign?: 'notary';
  /** Provenance standard identifier */
  standard?: string;
  /** Use existing stamp ID (skip pool acquisition) */
  stampId?: string;
  /** Pool size preset (default: 'small') */
  poolSize?: 'small' | 'medium' | 'large';
  /** Content type of the file */
  contentType?: string;
  /**
   * Upload raw JSON document without base64 metadata wrapping.
   * When true, the content is embedded directly in the `data` field as a JSON object
   * instead of being base64-encoded. Useful for storing structured records (e.g. file proofs)
   * that should be human-readable on Swarm without decoding.
   * Content must be a JSON string or a plain object.
   */
  raw?: boolean;
}

/**
 * Options for downloading provenance data
 */
export interface DownloadOptions {
  /** Verify notary signature (default: true if document is signed) */
  verify?: boolean;
  /**
   * Notary address to trust. Without it the SDK uses the address the gateway
   * reports at /api/v1/notary/info, i.e. it trusts the same gateway that served
   * the document. Pin it to verify independently of the gateway.
   */
  notaryAddress?: string;
}

/** Result of checking one signature (see SignatureVerification) */
export interface SignatureCheck {
  index: number;
  /** True only if the signature cryptographically verifies against the expected signer */
  valid: boolean;
  /** Whether the signature's data_hash matches the document's data */
  dataHashValid: boolean;
  /** Address the signature recovers to, if it recovered */
  recoveredAddress?: string;
  /** Why the signature is not valid */
  error?: string;
}

/** How a download's notary signatures were verified */
export interface SignatureVerification {
  /** The address signatures were verified against, if one was available */
  expectedSigner?: string;
  /** 'option' = DownloadOptions.notaryAddress; 'gateway' = /notary/info; 'none' = no address */
  expectedSignerSource: 'option' | 'gateway' | 'none';
  /** Per-signature results, in document order */
  results: SignatureCheck[];
  /** Why no expected signer was available, e.g. the notary lookup failed */
  error?: string;
}

/**
 * Provenance metadata that wraps the file content
 */
export interface ProvenanceMetadata {
  /** Base64 encoded file content */
  data: string;
  /** SHA256 hash of original file content */
  content_hash: string;
  /** Postage stamp ID used for upload */
  stamp_id: string;
  /** Optional provenance standard identifier */
  provenance_standard?: string;
  /** Optional encryption method */
  encryption?: string;
}

/**
 * Document metadata for raw JSON uploads (no base64 wrapping).
 * The `data` field contains structured JSON directly instead of base64-encoded content.
 */
export interface DocumentMetadata {
  /** Structured JSON document data (not base64-encoded) */
  data: Record<string, unknown>;
  /** SHA256 hash of JSON.stringify(data) */
  content_hash: string;
  /** Postage stamp ID used for upload */
  stamp_id: string;
  /** Optional provenance standard identifier */
  provenance_standard?: string;
  /** Optional encryption method */
  encryption?: string;
}

/**
 * Notary signature attached to a signed document
 */
export interface NotarySignature {
  /** Signature type; the gateway notary uses 'notary' */
  type: string;
  /** Signer's Ethereum address */
  signer: string;
  /** ISO 8601 timestamp of when the signature was created */
  timestamp: string;
  /** SHA256 hash of the data that was signed */
  data_hash: string;
  /** The actual signature */
  signature: string;
  /** Fields that were included in the hash */
  hashed_fields: string[];
  /** Format of the signed message */
  signed_message_format: string;
}

/**
 * A document that has been signed by the notary
 */
export interface SignedDocument {
  /** The provenance metadata */
  metadata: ProvenanceMetadata;
  /** Array of notary signatures */
  signatures: NotarySignature[];
}

/**
 * Result of an upload operation
 */
export interface UploadResult {
  /** Swarm reference hash */
  reference: string;
  /** The provenance metadata that was uploaded */
  metadata: ProvenanceMetadata;
}

/**
 * Result of a raw document upload operation
 */
export interface DocumentUploadResult {
  /** Swarm reference hash */
  reference: string;
  /** The document metadata that was uploaded (data is raw JSON, not base64) */
  metadata: DocumentMetadata;
}

/**
 * Result of downloading a raw JSON document
 */
export interface DocumentDownloadResult {
  /** The structured JSON document data */
  document: Record<string, unknown>;
  /** The document metadata from the gateway */
  metadata: DocumentMetadata;
  /**
   * True only if at least one signature cryptographically verifies against the
   * expected notary over this exact data; other signatures (e.g. an uploader's
   * own) are not covered, see `verification.results`. False if none does.
   * Undefined if the document has no signatures or with `verify: false`: check
   * `verified === true`.
   */
  verified?: boolean;
  /** Details of the signature check, when one ran */
  verification?: SignatureVerification;
  /** Notary signatures if present */
  signatures?: NotarySignature[];
}

/**
 * Result of a download operation
 */
export interface DownloadResult {
  /** Decoded original file content */
  file: Uint8Array;
  /** The provenance metadata from the document */
  metadata: ProvenanceMetadata;
  /**
   * True only if at least one signature cryptographically verifies against the
   * expected notary over this exact data; other signatures (e.g. an uploader's
   * own) are not covered, see `verification.results`. False if none does.
   * Undefined if the document has no signatures or with `verify: false`: check
   * `verified === true`.
   */
  verified?: boolean;
  /** Details of the signature check, when one ran */
  verification?: SignatureVerification;
  /** Notary signatures if present */
  signatures?: NotarySignature[];
}

/**
 * Notary service information
 */
export interface NotaryInfo {
  /** Whether notary service is enabled on the gateway */
  enabled: boolean;
  /** Whether notary service is available and configured */
  available: boolean;
  /** Notary signer's Ethereum address (if available) */
  address?: string;
  /** Optional status message */
  message?: string;
}

/**
 * Stamp pool status information
 */
export interface PoolStatus {
  /** Whether the stamp pool is enabled */
  enabled: boolean;
  /** Available stamps by depth (count per depth) */
  available: Record<string, number>;
  /** Reserve configuration by depth */
  reserve: Record<string, number>;
  /** Total number of stamps across all depths */
  totalStamps: number;
  /** Whether any depth is below its reserve threshold */
  lowReserveWarning: boolean;
}

/**
 * Result of acquiring a stamp from the pool
 */
export interface AcquiredStamp {
  /** The stamp batch ID */
  batchId: string;
  /** Stamp depth */
  depth: number;
  /** Size name (small, medium, large) */
  sizeName: string;
  /** Whether a larger stamp was used as fallback */
  fallbackUsed: boolean;
}

/**
 * Gateway API response types (internal use)
 */
export interface GatewayHealthResponse {
  status: string;
}

export interface GatewayUploadResponse {
  reference: string;
}

export interface GatewayDownloadResponse {
  metadata: ProvenanceMetadata;
  signatures?: NotarySignature[];
}

export interface GatewayNotaryInfoResponse {
  enabled: boolean;
  available: boolean;
  address?: string;
  message?: string;
}

export interface GatewayPoolStatusResponse {
  enabled: boolean;
  reserve_config: Record<string, number>;
  current_levels: Record<string, number>;
  available_stamps: Record<string, string[]>;
  total_stamps: number;
  low_reserve_warning: boolean;
  last_check: string;
  next_check: string;
  errors: string[];
}

export interface GatewayAcquireStampResponse {
  batch_id: string;
  depth: number;
  size_name: string;
  fallback_used: boolean;
}

export interface GatewayErrorResponse {
  code?: string;
  /** FastAPI detail — string, object with message, or validation error array */
  detail: string | { message: string; suggestion?: string } | Array<{ msg: string; loc?: unknown[] }>;
}
