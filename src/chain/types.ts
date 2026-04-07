/**
 * Chain-specific types for blockchain anchoring
 */

/** Ethereum hex address */
export type Address = `0x${string}`;

/** Hex-encoded value */
export type Hex = `0x${string}`;

/** Data status enum matching the smart contract */
export enum DataStatus {
  ACTIVE = 0,
  RESTRICTED = 1,
  DELETED = 2,
}

/** On-chain transformation link (v2 struct) */
export interface TransformationLink {
  newDataHash: string;
  description: string;
}

/**
 * On-chain transformation record.
 * @deprecated Use TransformationLink instead — kept for backward compatibility.
 */
export interface ChainTransformation {
  originalHash: string;
  newHash: string;
  description: string;
}

/** On-chain provenance record returned by getDataRecord */
export interface ChainProvenanceRecord {
  dataHash: string;
  owner: Address;
  timestamp: number;
  dataType: string;
  /** Storage reference (e.g. Swarm reference) linked on-chain, if set */
  storageRef?: string;
  status: DataStatus;
  accessors: Address[];
  transformationLinks: TransformationLink[];
}

/** Base result for all write transactions */
export interface TransactionResult {
  txHash: Hex;
  blockNumber: number;
  gasUsed: bigint;
  explorerUrl?: string;
}

/** Result of an anchor (registerData) operation */
export interface AnchorResult extends TransactionResult {
  dataHash: string;
  dataType: string;
  owner: Address;
  /** Storage reference (e.g. Swarm reference) linked on-chain, if provided */
  storageRef?: string;
}

/** Result of a recordAccess operation */
export interface AccessResult extends TransactionResult {
  dataHash: string;
  accessor: Address;
}

/** Result of a recordTransformation operation */
export interface TransformResult extends TransactionResult {
  originalHash: string;
  newHash: string;
  description: string;
}

/** Result of a merge transformation (N-to-1) operation */
export interface MergeTransformResult extends TransactionResult {
  sourceHashes: string[];
  newHash: string;
  description: string;
  newDataType: string;
}

/** Result of a setDataStatus operation */
export interface StatusResult extends TransactionResult {
  dataHash: string;
  newStatus: DataStatus;
}

/** Result of a transferDataOwnership operation */
export interface TransferResult extends TransactionResult {
  dataHash: string;
  newOwner: Address;
}

/** Result of a setDelegate operation */
export interface DelegateResult extends TransactionResult {
  delegate: Address;
  authorized: boolean;
}

/** Result of a batch operation */
export interface BatchResult extends TransactionResult {
  count: number;
}

/** Wallet balance information */
export interface BalanceInfo {
  address: Address;
  balanceWei: bigint;
  balanceEth: string;
  chain: string;
  contractAddress: Address;
}

/** Chain preset configuration */
export interface ChainPreset {
  chainId: number;
  name: string;
  rpcUrl: string;
  contractAddress: Address;
  explorerUrl: string;
}

/** Retry configuration for transient failures */
export interface RetryConfig {
  /** Max retry attempts (default: 2) */
  maxRetries?: number;
  /** Base delay in ms, doubled each retry (default: 1000) */
  baseDelayMs?: number;
}

/** Configuration for ChainClient */
export interface ChainClientConfig {
  /** Chain preset name or custom config */
  chain: string | ChainPreset;
  /** Signer for write operations (optional for read-only) */
  signer?: ChainSigner;
  /** Custom RPC URL (overrides preset) */
  rpcUrl?: string;
  /** Custom contract address (overrides preset) */
  contractAddress?: Address;
  /** Timeout in ms for waiting for transaction receipts (default: 120_000) */
  txTimeout?: number;
  /** Explicit gas limit for transactions. Skips provider estimation when set. */
  gasLimit?: bigint | number;
  /** Retry config for transient failures (default: 2 retries, 1s base delay) */
  retry?: RetryConfig;
}

/** Minimal signer interface for transaction signing */
export interface ChainSigner {
  /** Get the signer's address */
  getAddress(): Promise<Address>;
  /** Send a transaction and return the tx hash */
  sendTransaction(tx: {
    to: Address;
    data: Hex;
    gas?: bigint;
  }): Promise<Hex>;
}
