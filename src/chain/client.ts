import {
  createPublicClient,
  http,
  type PublicClient,
  type Hex,
} from 'viem';
import { DATA_PROVENANCE_ABI } from './abi.js';
import { CHAIN_PRESETS, ZERO_BYTES32, ZERO_ADDRESS } from './constants.js';
import {
  ChainConfigurationError,
  ChainConnectionError,
  ChainTransactionError,
  DataNotRegisteredError,
  SignerRequiredError,
} from './errors.js';
import { normalizeHash, validateDataType, validateAddress } from './validation.js';
import {
  encodeRegisterData,
  encodeRegisterDataFor,
  encodeRecordAccess,
  encodeRecordTransformation,
  encodeSetDataStatus,
  encodeSetDelegate,
  encodeTransferDataOwnership,
  encodeBatchRegisterData,
  encodeBatchRecordAccess,
  encodeBatchSetDataStatus,
} from './contract.js';
import type {
  Address,
  ChainClientConfig,
  ChainPreset,
  ChainProvenanceRecord,
  ChainSigner,
  AnchorResult,
  AccessResult,
  TransformResult,
  StatusResult,
  TransferResult,
  DelegateResult,
  BatchResult,
  TransactionResult,
  DataStatus,
} from './types.js';

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
export class ChainClient {
  private readonly publicClient: PublicClient;
  private readonly contractAddress: Address;
  private readonly preset: ChainPreset;
  private readonly signer: ChainSigner | undefined;
  private readonly txTimeout: number;

  constructor(config: ChainClientConfig) {
    // Resolve chain preset
    if (typeof config.chain === 'string') {
      const preset = CHAIN_PRESETS[config.chain];
      if (!preset) {
        throw new ChainConfigurationError(
          `Unknown chain preset: "${config.chain}". Available: ${Object.keys(CHAIN_PRESETS).join(', ')}`
        );
      }
      this.preset = preset;
    } else {
      this.preset = config.chain;
    }

    const rpcUrl = config.rpcUrl ?? this.preset.rpcUrl;
    this.contractAddress = config.contractAddress ?? this.preset.contractAddress;
    this.signer = config.signer;
    this.txTimeout = config.txTimeout ?? 120_000;

    if (this.contractAddress === ZERO_ADDRESS) {
      throw new ChainConfigurationError(
        `Contract not yet deployed on ${this.preset.name}. Use a chain with a deployed contract.`
      );
    }

    this.publicClient = createPublicClient({
      transport: http(rpcUrl),
    });
  }

  // ─── Read Operations ─────────────────────────────────────────

  /**
   * Check if a data hash is registered on-chain.
   */
  async verifyOnChain(dataHash: string): Promise<boolean> {
    const hash = normalizeHash(dataHash);

    try {
      const result = await this.publicClient.readContract({
        address: this.contractAddress,
        abi: DATA_PROVENANCE_ABI,
        functionName: 'dataRecords',
        args: [hash],
      });

      // dataRecords returns a tuple; first element is the stored dataHash
      // If it's zero, the record doesn't exist
      const [storedHash] = result as [Hex, Address, bigint, string, number];
      return storedHash !== ZERO_BYTES32;
    } catch (error) {
      throw new ChainConnectionError(
        `Failed to verify on-chain: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get the full on-chain provenance record for a data hash.
   * Throws DataNotRegisteredError if the hash is not registered.
   */
  async getDataRecord(dataHash: string): Promise<ChainProvenanceRecord> {
    const hash = normalizeHash(dataHash);

    try {
      const result = await this.publicClient.readContract({
        address: this.contractAddress,
        abi: DATA_PROVENANCE_ABI,
        functionName: 'getDataRecord',
        args: [hash],
      });

      const record = result as {
        dataHash: Hex;
        owner: Address;
        timestamp: bigint;
        dataType: string;
        transformations: readonly string[];
        accessors: readonly Address[];
        status: number;
      };

      if (record.dataHash === ZERO_BYTES32) {
        throw new DataNotRegisteredError(dataHash);
      }

      return {
        dataHash: record.dataHash,
        owner: record.owner,
        timestamp: Number(record.timestamp),
        dataType: record.dataType,
        status: record.status as DataStatus,
        accessors: [...record.accessors],
        transformations: [...record.transformations],
      };
    } catch (error) {
      if (error instanceof DataNotRegisteredError) {
        throw error;
      }
      throw new ChainConnectionError(
        `Failed to get data record: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get all data record hashes owned by a user.
   */
  async getUserDataRecords(user: string): Promise<string[]> {
    validateAddress(user);

    try {
      const result = await this.publicClient.readContract({
        address: this.contractAddress,
        abi: DATA_PROVENANCE_ABI,
        functionName: 'getUserDataRecords',
        args: [user as Address],
      });

      return [...(result as readonly Hex[])];
    } catch (error) {
      throw new ChainConnectionError(
        `Failed to get user data records: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Check if an address has accessed a data hash.
   */
  async hasAddressAccessed(dataHash: string, accessor: string): Promise<boolean> {
    const hash = normalizeHash(dataHash);
    validateAddress(accessor);

    try {
      const result = await this.publicClient.readContract({
        address: this.contractAddress,
        abi: DATA_PROVENANCE_ABI,
        functionName: 'hasAddressAccessed',
        args: [hash, accessor as Address],
      });

      return result;
    } catch (error) {
      throw new ChainConnectionError(
        `Failed to check access: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Check if an address is an authorized delegate for an owner.
   */
  async isAuthorizedDelegate(owner: string, delegate: string): Promise<boolean> {
    validateAddress(owner);
    validateAddress(delegate);

    try {
      const result = await this.publicClient.readContract({
        address: this.contractAddress,
        abi: DATA_PROVENANCE_ABI,
        functionName: 'isAuthorizedDelegate',
        args: [owner as Address, delegate as Address],
      });

      return result;
    } catch (error) {
      throw new ChainConnectionError(
        `Failed to check delegate: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // ─── Write Operations ────────────────────────────────────────

  /**
   * Anchor a data hash on-chain by registering it in the DataProvenance contract.
   * Requires a signer.
   */
  async anchor(dataHash: string, dataType: string): Promise<AnchorResult> {
    this.requireSigner();
    validateDataType(dataType);

    const hash = normalizeHash(dataHash);
    const data = encodeRegisterData(hash, dataType);
    const owner = await this.signer!.getAddress();

    const receipt = await this.sendAndWait(data);

    return {
      ...receipt,
      dataHash: hash,
      dataType,
      owner,
    };
  }

  /**
   * Record an access event for a data hash on-chain.
   * Requires a signer.
   */
  async recordAccess(dataHash: string): Promise<AccessResult> {
    this.requireSigner();

    const hash = normalizeHash(dataHash);
    const data = encodeRecordAccess(hash);
    const accessor = await this.signer!.getAddress();

    const receipt = await this.sendAndWait(data);

    return {
      ...receipt,
      dataHash: hash,
      accessor,
    };
  }

  /**
   * Anchor a data hash on-chain on behalf of another owner (operator only).
   * Requires a signer with operator role.
   */
  async anchorFor(dataHash: string, dataType: string, actualOwner: string): Promise<AnchorResult> {
    this.requireSigner();
    validateDataType(dataType);
    validateAddress(actualOwner);

    const hash = normalizeHash(dataHash);
    const data = encodeRegisterDataFor(hash, dataType, actualOwner as Address);

    const receipt = await this.sendAndWait(data);

    return {
      ...receipt,
      dataHash: hash,
      dataType,
      owner: actualOwner as Address,
    };
  }

  /**
   * Record a data transformation on-chain.
   * Requires a signer.
   */
  async recordTransformation(
    originalHash: string,
    newHash: string,
    description: string,
  ): Promise<TransformResult> {
    this.requireSigner();

    const origHash = normalizeHash(originalHash);
    const nHash = normalizeHash(newHash);
    const data = encodeRecordTransformation(origHash, nHash, description);

    const receipt = await this.sendAndWait(data);

    return {
      ...receipt,
      originalHash: origHash,
      newHash: nHash,
      description,
    };
  }

  /**
   * Set the status of a data record (owner only).
   * Requires a signer.
   */
  async setDataStatus(dataHash: string, newStatus: DataStatus): Promise<StatusResult> {
    this.requireSigner();

    const hash = normalizeHash(dataHash);
    const data = encodeSetDataStatus(hash, newStatus as number);

    const receipt = await this.sendAndWait(data);

    return {
      ...receipt,
      dataHash: hash,
      newStatus,
    };
  }

  /**
   * Transfer data ownership to a new address.
   * Requires a signer (current owner).
   */
  async transferOwnership(dataHash: string, newOwner: string): Promise<TransferResult> {
    this.requireSigner();
    validateAddress(newOwner);

    const hash = normalizeHash(dataHash);
    const data = encodeTransferDataOwnership(hash, newOwner as Address);

    const receipt = await this.sendAndWait(data);

    return {
      ...receipt,
      dataHash: hash,
      newOwner: newOwner as Address,
    };
  }

  /**
   * Authorize or revoke a delegate for the signer's account.
   * Requires a signer.
   */
  async setDelegate(delegate: string, authorized: boolean): Promise<DelegateResult> {
    this.requireSigner();
    validateAddress(delegate);

    const data = encodeSetDelegate(delegate as Address, authorized);

    const receipt = await this.sendAndWait(data);

    return {
      ...receipt,
      delegate: delegate as Address,
      authorized,
    };
  }

  /**
   * Anchor multiple data hashes in a single transaction.
   * Requires a signer.
   */
  async batchAnchor(items: Array<{ dataHash: string; dataType: string }>): Promise<BatchResult> {
    this.requireSigner();

    const hashes = items.map((item) => normalizeHash(item.dataHash));
    const types = items.map((item) => {
      validateDataType(item.dataType);
      return item.dataType;
    });

    const data = encodeBatchRegisterData(hashes, types);
    const receipt = await this.sendAndWait(data);

    return {
      ...receipt,
      count: items.length,
    };
  }

  /**
   * Record access for multiple data hashes in a single transaction.
   * Requires a signer.
   */
  async batchRecordAccess(dataHashes: string[]): Promise<BatchResult> {
    this.requireSigner();

    const hashes = dataHashes.map((h) => normalizeHash(h));
    const data = encodeBatchRecordAccess(hashes);
    const receipt = await this.sendAndWait(data);

    return {
      ...receipt,
      count: dataHashes.length,
    };
  }

  /**
   * Set status for multiple data records in a single transaction.
   * Requires a signer.
   */
  async batchSetDataStatus(
    items: Array<{ dataHash: string; status: DataStatus }>,
  ): Promise<BatchResult> {
    this.requireSigner();

    const hashes = items.map((item) => normalizeHash(item.dataHash));
    const statuses = items.map((item) => item.status as number);
    const data = encodeBatchSetDataStatus(hashes, statuses);
    const receipt = await this.sendAndWait(data);

    return {
      ...receipt,
      count: items.length,
    };
  }

  // ─── Helpers ─────────────────────────────────────────────────

  /**
   * Get the explorer URL for a transaction hash.
   */
  getExplorerUrl(txHash: string): string {
    return `${this.preset.explorerUrl}/tx/${txHash}`;
  }

  private requireSigner(): void {
    if (!this.signer) {
      throw new SignerRequiredError();
    }
  }

  private async sendAndWait(data: Hex): Promise<TransactionResult> {
    let txHash: Hex;
    try {
      txHash = await this.signer!.sendTransaction({
        to: this.contractAddress,
        data,
      });
    } catch (error) {
      throw new ChainTransactionError(
        `Transaction failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    try {
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: this.txTimeout,
        pollingInterval: 2_000,
      });

      if (receipt.status === 'reverted') {
        throw new ChainTransactionError('Transaction reverted', txHash);
      }

      return {
        txHash,
        blockNumber: Number(receipt.blockNumber),
        gasUsed: receipt.gasUsed,
        explorerUrl: this.getExplorerUrl(txHash),
      };
    } catch (error) {
      if (error instanceof ChainTransactionError) {
        throw error;
      }
      throw new ChainConnectionError(
        `Failed waiting for receipt: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
