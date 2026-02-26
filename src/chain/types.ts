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

/** On-chain transformation record */
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
  status: DataStatus;
  accessors: Address[];
  transformations: string[];
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
}

/** Result of a recordAccess operation */
export interface AccessResult extends TransactionResult {
  dataHash: string;
  accessor: Address;
}

/** Chain preset configuration */
export interface ChainPreset {
  chainId: number;
  name: string;
  rpcUrl: string;
  contractAddress: Address;
  explorerUrl: string;
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
}

/** Minimal signer interface for transaction signing */
export interface ChainSigner {
  /** Get the signer's address */
  getAddress(): Promise<Address>;
  /** Send a transaction and return the tx hash */
  sendTransaction(tx: {
    to: Address;
    data: Hex;
  }): Promise<Hex>;
}
