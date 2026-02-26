import { P as ProvenanceError } from '../errors-jmDO4tHj.js';

/**
 * Chain-specific types for blockchain anchoring
 */
/** Ethereum hex address */
type Address = `0x${string}`;
/** Hex-encoded value */
type Hex = `0x${string}`;
/** Data status enum matching the smart contract */
declare enum DataStatus {
    ACTIVE = 0,
    RESTRICTED = 1,
    DELETED = 2
}
/** On-chain transformation record */
interface ChainTransformation {
    originalHash: string;
    newHash: string;
    description: string;
}
/** On-chain provenance record returned by getDataRecord */
interface ChainProvenanceRecord {
    dataHash: string;
    owner: Address;
    timestamp: number;
    dataType: string;
    status: DataStatus;
    accessors: Address[];
    transformations: string[];
}
/** Base result for all write transactions */
interface TransactionResult {
    txHash: Hex;
    blockNumber: number;
    gasUsed: bigint;
    explorerUrl?: string;
}
/** Result of an anchor (registerData) operation */
interface AnchorResult extends TransactionResult {
    dataHash: string;
    dataType: string;
    owner: Address;
}
/** Result of a recordAccess operation */
interface AccessResult extends TransactionResult {
    dataHash: string;
    accessor: Address;
}
/** Result of a recordTransformation operation */
interface TransformResult extends TransactionResult {
    originalHash: string;
    newHash: string;
    description: string;
}
/** Result of a setDataStatus operation */
interface StatusResult extends TransactionResult {
    dataHash: string;
    newStatus: DataStatus;
}
/** Result of a transferDataOwnership operation */
interface TransferResult extends TransactionResult {
    dataHash: string;
    newOwner: Address;
}
/** Result of a setDelegate operation */
interface DelegateResult extends TransactionResult {
    delegate: Address;
    authorized: boolean;
}
/** Result of a batch operation */
interface BatchResult extends TransactionResult {
    count: number;
}
/** Chain preset configuration */
interface ChainPreset {
    chainId: number;
    name: string;
    rpcUrl: string;
    contractAddress: Address;
    explorerUrl: string;
}
/** Configuration for ChainClient */
interface ChainClientConfig {
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
interface ChainSigner {
    /** Get the signer's address */
    getAddress(): Promise<Address>;
    /** Send a transaction and return the tx hash */
    sendTransaction(tx: {
        to: Address;
        data: Hex;
    }): Promise<Hex>;
}

/**
 * Client for interacting with the DataProvenance smart contract on-chain.
 *
 * Read operations (verifyOnChain, getDataRecord) work without a signer.
 * Write operations (anchor, recordAccess) require a ChainSigner.
 *
 * @example
 * ```ts
 * // Read-only
 * const chain = new ChainClient({ chain: 'base-sepolia' });
 * const exists = await chain.verifyOnChain(hash);
 *
 * // With signer
 * const signer = await fromEip1193Provider(window.ethereum);
 * const chain = new ChainClient({ chain: 'base-sepolia', signer });
 * const result = await chain.anchor(hash, 'dataset');
 * ```
 */
declare class ChainClient {
    private readonly publicClient;
    private readonly contractAddress;
    private readonly preset;
    private readonly signer;
    constructor(config: ChainClientConfig);
    /**
     * Check if a data hash is registered on-chain.
     */
    verifyOnChain(dataHash: string): Promise<boolean>;
    /**
     * Get the full on-chain provenance record for a data hash.
     * Throws DataNotRegisteredError if the hash is not registered.
     */
    getDataRecord(dataHash: string): Promise<ChainProvenanceRecord>;
    /**
     * Get all data record hashes owned by a user.
     */
    getUserDataRecords(user: string): Promise<string[]>;
    /**
     * Check if an address has accessed a data hash.
     */
    hasAddressAccessed(dataHash: string, accessor: string): Promise<boolean>;
    /**
     * Check if an address is an authorized delegate for an owner.
     */
    isAuthorizedDelegate(owner: string, delegate: string): Promise<boolean>;
    /**
     * Anchor a data hash on-chain by registering it in the DataProvenance contract.
     * Requires a signer.
     */
    anchor(dataHash: string, dataType: string): Promise<AnchorResult>;
    /**
     * Record an access event for a data hash on-chain.
     * Requires a signer.
     */
    recordAccess(dataHash: string): Promise<AccessResult>;
    /**
     * Anchor a data hash on-chain on behalf of another owner (operator only).
     * Requires a signer with operator role.
     */
    anchorFor(dataHash: string, dataType: string, actualOwner: string): Promise<AnchorResult>;
    /**
     * Record a data transformation on-chain.
     * Requires a signer.
     */
    recordTransformation(originalHash: string, newHash: string, description: string): Promise<TransformResult>;
    /**
     * Set the status of a data record (owner only).
     * Requires a signer.
     */
    setDataStatus(dataHash: string, newStatus: DataStatus): Promise<StatusResult>;
    /**
     * Transfer data ownership to a new address.
     * Requires a signer (current owner).
     */
    transferOwnership(dataHash: string, newOwner: string): Promise<TransferResult>;
    /**
     * Authorize or revoke a delegate for the signer's account.
     * Requires a signer.
     */
    setDelegate(delegate: string, authorized: boolean): Promise<DelegateResult>;
    /**
     * Anchor multiple data hashes in a single transaction.
     * Requires a signer.
     */
    batchAnchor(items: Array<{
        dataHash: string;
        dataType: string;
    }>): Promise<BatchResult>;
    /**
     * Record access for multiple data hashes in a single transaction.
     * Requires a signer.
     */
    batchRecordAccess(dataHashes: string[]): Promise<BatchResult>;
    /**
     * Set status for multiple data records in a single transaction.
     * Requires a signer.
     */
    batchSetDataStatus(items: Array<{
        dataHash: string;
        status: DataStatus;
    }>): Promise<BatchResult>;
    /**
     * Get the explorer URL for a transaction hash.
     */
    getExplorerUrl(txHash: string): string;
    private requireSigner;
    private sendAndWait;
}

/**
 * EIP-1193 provider interface (window.ethereum / MetaMask)
 */
interface Eip1193Provider {
    request(args: {
        method: string;
        params?: unknown[];
    }): Promise<unknown>;
}
/**
 * Create a ChainSigner from a viem WalletClient.
 *
 * @example
 * ```ts
 * import { createWalletClient, http } from 'viem';
 * import { baseSepolia } from 'viem/chains';
 * import { privateKeyToAccount } from 'viem/accounts';
 *
 * const walletClient = createWalletClient({
 *   account: privateKeyToAccount('0x...'),
 *   chain: baseSepolia,
 *   transport: http(),
 * });
 * const signer = fromViemWalletClient(walletClient);
 * ```
 */
declare function fromViemWalletClient(walletClient: {
    account?: {
        address: Address;
    } | null;
    sendTransaction(args: {
        to: Address;
        data: Hex;
    }): Promise<Hex>;
}): ChainSigner;
/**
 * Create a ChainSigner from a private key (Node.js / server-side).
 * Dynamically imports viem to create a wallet client.
 *
 * @example
 * ```ts
 * const signer = await fromPrivateKey('0xabc...', 'https://sepolia.base.org');
 * ```
 */
declare function fromPrivateKey(privateKey: Hex, rpcUrl: string): Promise<ChainSigner>;
/**
 * Create a ChainSigner from an EIP-1193 provider (browser wallet like MetaMask).
 *
 * @example
 * ```ts
 * const signer = await fromEip1193Provider(window.ethereum);
 * ```
 */
declare function fromEip1193Provider(provider: Eip1193Provider): Promise<ChainSigner>;

/**
 * Base error for all chain-related errors
 */
declare class ChainError extends ProvenanceError {
    constructor(message: string, code?: string);
}
/**
 * Configuration errors (missing viem, invalid chain config)
 */
declare class ChainConfigurationError extends ChainError {
    constructor(message: string);
}
/**
 * RPC connection errors
 */
declare class ChainConnectionError extends ChainError {
    constructor(message: string);
}
/**
 * Transaction errors (reverted, out of gas, etc.)
 */
declare class ChainTransactionError extends ChainError {
    readonly txHash?: string | undefined;
    constructor(message: string, txHash?: string | undefined);
}
/**
 * Input validation errors (bad hash format, etc.)
 */
declare class ChainValidationError extends ChainError {
    constructor(message: string);
}
/**
 * Data hash not found on-chain
 */
declare class DataNotRegisteredError extends ChainError {
    constructor(dataHash: string);
}
/**
 * Write operation attempted without a signer
 */
declare class SignerRequiredError extends ChainError {
    constructor();
}

/** Base Sepolia testnet preset */
declare const BASE_SEPOLIA: ChainPreset;
/** Base mainnet preset (contract not yet deployed) */
declare const BASE_MAINNET: ChainPreset;
/** All available chain presets indexed by name */
declare const CHAIN_PRESETS: Record<string, ChainPreset>;

/**
 * Normalize a data hash to 0x-prefixed bytes32.
 * Accepts both "0xabc..." and bare "abc..." formats.
 */
declare function normalizeHash(hash: string): Hex;

export { type AccessResult, type Address, type AnchorResult, BASE_MAINNET, BASE_SEPOLIA, type BatchResult, CHAIN_PRESETS, ChainClient, type ChainClientConfig, ChainConfigurationError, ChainConnectionError, ChainError, type ChainPreset, type ChainProvenanceRecord, type ChainSigner, ChainTransactionError, type ChainTransformation, ChainValidationError, DataNotRegisteredError, DataStatus, type DelegateResult, type Hex, SignerRequiredError, type StatusResult, type TransactionResult, type TransferResult, type TransformResult, fromEip1193Provider, fromPrivateKey, fromViemWalletClient, normalizeHash };
