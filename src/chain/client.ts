import {
  createPublicClient,
  formatEther,
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
  ChainValidationError,
  DataAlreadyRegisteredError,
  DataNotRegisteredError,
  SignerRequiredError,
} from './errors.js';
import { normalizeHash, validateDataType, validateAddress } from './validation.js';
import {
  encodeRegisterData,
  encodeRegisterDataFor,
  encodeRecordAccess,
  encodeRecordTransformation,
  encodeRecordMergeTransformation,
  encodeSetDataStatus,
  encodeSetDelegate,
  encodeTransferDataOwnership,
  encodeBatchRegisterData,
  encodeBatchRecordAccess,
  encodeBatchSetDataStatus,
} from './contract.js';
import type {
  Address,
  BalanceInfo,
  ChainClientConfig,
  ChainPreset,
  ChainProvenanceRecord,
  ChainSigner,
  RetryConfig,
  TransformationLink,
  AnchorResult,
  AccessResult,
  TransformResult,
  MergeTransformResult,
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
  private readonly gasLimit: bigint | undefined;
  private readonly retryConfig: Required<RetryConfig>;

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
    this.gasLimit = config.gasLimit != null ? BigInt(config.gasLimit) : undefined;
    this.retryConfig = {
      maxRetries: config.retry?.maxRetries ?? 2,
      baseDelayMs: config.retry?.baseDelayMs ?? 1000,
    };

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
      const [storedHash] = result as [Hex, Address, bigint, string, Hex, number];
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
        storageRef: Hex;
        transformationLinks: readonly { newDataHash: Hex; description: string }[];
        accessors: readonly Address[];
        status: number;
      };

      if (record.dataHash === ZERO_BYTES32) {
        throw new DataNotRegisteredError(dataHash);
      }

      const parsed: ChainProvenanceRecord = {
        dataHash: record.dataHash,
        owner: record.owner,
        timestamp: Number(record.timestamp),
        dataType: record.dataType,
        status: record.status as DataStatus,
        accessors: [...record.accessors],
        transformationLinks: record.transformationLinks.map((link) => ({
          newDataHash: link.newDataHash,
          description: link.description,
        })),
      };
      if (record.storageRef && record.storageRef !== ZERO_BYTES32) {
        parsed.storageRef = record.storageRef;
      }
      return parsed;
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

  /**
   * Get the transformation links (children) for a data hash.
   * Returns an array of TransformationLink with newDataHash and description.
   */
  async getTransformationLinks(dataHash: string): Promise<TransformationLink[]> {
    const hash = normalizeHash(dataHash);

    try {
      const result = await this.publicClient.readContract({
        address: this.contractAddress,
        abi: DATA_PROVENANCE_ABI,
        functionName: 'getTransformationLinks',
        args: [hash],
      });

      return (result as readonly { newDataHash: Hex; description: string }[]).map((link) => ({
        newDataHash: link.newDataHash,
        description: link.description,
      }));
    } catch (error) {
      throw new ChainConnectionError(
        `Failed to get transformation links: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get the parent hashes for a data hash (reverse traversal).
   * Returns hashes that were transformed to produce this hash.
   */
  async getTransformationParents(dataHash: string): Promise<string[]> {
    const hash = normalizeHash(dataHash);

    try {
      const result = await this.publicClient.readContract({
        address: this.contractAddress,
        abi: DATA_PROVENANCE_ABI,
        functionName: 'getTransformationParents',
        args: [hash],
      });

      return [...(result as readonly Hex[])];
    } catch (error) {
      throw new ChainConnectionError(
        `Failed to get transformation parents: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get child hashes for a data hash (lightweight, no descriptions).
   */
  async getChildHashes(dataHash: string): Promise<string[]> {
    const hash = normalizeHash(dataHash);

    try {
      const result = await this.publicClient.readContract({
        address: this.contractAddress,
        abi: DATA_PROVENANCE_ABI,
        functionName: 'getChildHashes',
        args: [hash],
      });

      return [...(result as readonly Hex[])];
    } catch (error) {
      throw new ChainConnectionError(
        `Failed to get child hashes: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Traverse the full provenance chain (DAG) from any node.
   * Performs BFS in both directions (ancestors via parents, descendants via children).
   *
   * @param dataHash - Starting hash
   * @param maxDepth - Maximum traversal depth (default 10, max 50)
   * @returns Array of ChainProvenanceRecord for each node in the DAG
   */
  async getProvenanceChain(dataHash: string, maxDepth = 10): Promise<ChainProvenanceRecord[]> {
    const effectiveMaxDepth = Math.min(Math.max(maxDepth, 1), 50);
    const startHash = normalizeHash(dataHash);

    const visited = new Set<string>();
    const records: ChainProvenanceRecord[] = [];
    // Queue: [hash, currentDepth]
    const queue: Array<[Hex, number]> = [[startHash, 0]];

    while (queue.length > 0) {
      const [hash, depth] = queue.shift()!;
      const hashLower = hash.toLowerCase();

      if (visited.has(hashLower)) continue;
      visited.add(hashLower);

      let record: ChainProvenanceRecord;
      try {
        record = await this.getDataRecord(hash);
      } catch (error) {
        if (error instanceof DataNotRegisteredError) continue;
        throw error;
      }
      records.push(record);

      if (depth >= effectiveMaxDepth) continue;

      // Forward: child hashes
      try {
        const children = await this.getChildHashes(hash);
        for (const child of children) {
          if (!visited.has(child.toLowerCase())) {
            queue.push([child as Hex, depth + 1]);
          }
        }
      } catch {
        // Ignore errors in traversal — node may not have children
      }

      // Backward: parent hashes
      try {
        const parents = await this.getTransformationParents(hash);
        for (const parent of parents) {
          if (!visited.has(parent.toLowerCase())) {
            queue.push([parent as Hex, depth + 1]);
          }
        }
      } catch {
        // Ignore errors in traversal — node may not have parents
      }
    }

    return records;
  }

  /**
   * Get the count of data records owned by a user.
   */
  async getUserDataRecordsCount(user: string): Promise<number> {
    validateAddress(user);

    try {
      const result = await this.publicClient.readContract({
        address: this.contractAddress,
        abi: DATA_PROVENANCE_ABI,
        functionName: 'getUserDataRecordsCount',
        args: [user as Address],
      });

      return Number(result);
    } catch (error) {
      throw new ChainConnectionError(
        `Failed to get user data records count: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get paginated data record hashes owned by a user.
   */
  async getUserDataRecordsPaginated(user: string, offset: number, limit: number): Promise<string[]> {
    validateAddress(user);

    try {
      const result = await this.publicClient.readContract({
        address: this.contractAddress,
        abi: DATA_PROVENANCE_ABI,
        functionName: 'getUserDataRecordsPaginated',
        args: [user as Address, BigInt(offset), BigInt(limit)],
      });

      return [...(result as readonly Hex[])];
    } catch (error) {
      throw new ChainConnectionError(
        `Failed to get paginated data records: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Detect whether the connected contract supports v2 features (TransformationLinks).
   * Returns true for v2 contracts, false for v1 (does not throw).
   */
  async supportsTransformationLinks(): Promise<boolean> {
    try {
      await this.publicClient.readContract({
        address: this.contractAddress,
        abi: DATA_PROVENANCE_ABI,
        functionName: 'getTransformationLinks',
        args: [ZERO_BYTES32],
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if the RPC connection is healthy.
   * Returns true if connected, false on error (does not throw).
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.publicClient.getChainId();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the ETH balance of the signer's address.
   * Requires a signer.
   */
  async getBalance(): Promise<BalanceInfo> {
    this.requireSigner();

    const address = await this.signer!.getAddress();

    try {
      const balanceWei = await this.publicClient.getBalance({ address });
      const balanceEth = formatEther(balanceWei);

      return {
        address,
        balanceWei,
        balanceEth,
        chain: this.preset.name,
        contractAddress: this.contractAddress,
      };
    } catch (error) {
      throw new ChainConnectionError(
        `Failed to get balance: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // ─── Write Operations ────────────────────────────────────────

  /**
   * Anchor a data hash on-chain by registering it in the DataProvenance contract.
   * Optionally link a storage reference (e.g. Swarm reference) for bidirectional lookup.
   * Requires a signer.
   */
  async anchor(dataHash: string, dataType: string, storageRef?: string): Promise<AnchorResult> {
    this.requireSigner();
    validateDataType(dataType);

    const hash = normalizeHash(dataHash);
    const normalizedStorageRef = storageRef ? normalizeHash(storageRef) : undefined;
    await this.checkNotRegistered(hash, dataHash);

    const data = encodeRegisterData(hash, dataType, normalizedStorageRef);
    const owner = await this.signer!.getAddress();

    let receipt: TransactionResult;
    try {
      receipt = await this.sendAndWait(data);
    } catch (error) {
      // Fallback: pre-check may miss due to RPC read lag
      if (this.isAlreadyRegisteredRevert(error)) {
        await this.throwAlreadyRegistered(hash, dataHash);
      }
      throw error;
    }

    const result: AnchorResult = {
      ...receipt,
      dataHash: hash,
      dataType,
      owner,
    };
    if (normalizedStorageRef) {
      result.storageRef = normalizedStorageRef;
    }
    return result;
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
   * Optionally link a storage reference for bidirectional lookup.
   * Requires a signer with operator role.
   */
  async anchorFor(dataHash: string, dataType: string, actualOwner: string, storageRef?: string): Promise<AnchorResult> {
    this.requireSigner();
    validateDataType(dataType);
    validateAddress(actualOwner);

    const hash = normalizeHash(dataHash);
    const normalizedStorageRef = storageRef ? normalizeHash(storageRef) : undefined;
    await this.checkNotRegistered(hash, dataHash);

    const data = encodeRegisterDataFor(hash, dataType, actualOwner as Address, normalizedStorageRef);

    let receipt: TransactionResult;
    try {
      receipt = await this.sendAndWait(data);
    } catch (error) {
      if (this.isAlreadyRegisteredRevert(error)) {
        await this.throwAlreadyRegistered(hash, dataHash);
      }
      throw error;
    }

    const result: AnchorResult = {
      ...receipt,
      dataHash: hash,
      dataType,
      owner: actualOwner as Address,
    };
    if (normalizedStorageRef) {
      result.storageRef = normalizedStorageRef;
    }
    return result;
  }

  /**
   * Look up a data hash by its storage reference (reverse lookup).
   * Returns the data hash associated with the given storage reference,
   * or null if no mapping exists.
   */
  async getDataHashByStorageRef(storageRef: string): Promise<string | null> {
    const normalizedRef = normalizeHash(storageRef);

    try {
      const result = await this.publicClient.readContract({
        address: this.contractAddress,
        abi: DATA_PROVENANCE_ABI,
        functionName: 'getDataHashByStorageRef',
        args: [normalizedRef],
      });

      const dataHash = result;
      return dataHash === ZERO_BYTES32 ? null : (dataHash as string);
    } catch (error) {
      throw new ChainConnectionError(
        `Failed to get data hash by storage ref: ${error instanceof Error ? error.message : String(error)}`
      );
    }
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

    // Check for duplicate transformation (saves gas)
    try {
      const existingLinks = await this.getTransformationLinks(origHash);
      if (existingLinks.some((link) => link.newDataHash.toLowerCase() === nHash.toLowerCase())) {
        throw new ChainValidationError(
          `Transformation from ${originalHash} to ${newHash} is already recorded on-chain`
        );
      }
    } catch (error) {
      if (error instanceof ChainValidationError) throw error;
      // Ignore read errors — proceed with the transaction
    }

    // Check that the new hash is not already registered (contract will revert otherwise)
    try {
      const exists = await this.verifyOnChain(nHash);
      if (exists) {
        throw new ChainValidationError(
          `New hash ${newHash} is already registered on-chain. The contract auto-registers the new hash during transformation — do not anchor it beforehand.`
        );
      }
    } catch (error) {
      if (error instanceof ChainValidationError) throw error;
      // Ignore read errors — proceed with the transaction
    }

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
   * Record a merge transformation (N-to-1) on-chain.
   * Combines multiple source hashes into a single new hash.
   * The contract automatically registers the new hash.
   * Requires a signer.
   *
   * @param sourceHashes - Array of 2–50 source data hashes
   * @param newHash - The resulting merged data hash
   * @param description - Description of the merge transformation
   * @param newDataType - Data type for the merged result (default: 'merged')
   */
  async mergeTransform(
    sourceHashes: string[],
    newHash: string,
    description: string,
    newDataType = 'merged',
  ): Promise<MergeTransformResult> {
    this.requireSigner();

    if (sourceHashes.length < 2) {
      throw new ChainValidationError('Merge transformation requires at least 2 source hashes');
    }
    if (sourceHashes.length > 50) {
      throw new ChainValidationError(
        `Merge transformation source count ${sourceHashes.length} exceeds maximum of 50`
      );
    }

    const normalizedSources = sourceHashes.map((h) => normalizeHash(h));
    const normalizedNew = normalizeHash(newHash);

    // Check for duplicate merge (saves gas)
    try {
      const existingParents = await this.getTransformationParents(normalizedNew);
      if (existingParents.length > 0) {
        throw new ChainValidationError(
          `Hash ${newHash} already has transformation parents recorded on-chain`
        );
      }
    } catch (error) {
      if (error instanceof ChainValidationError) throw error;
      // Ignore read errors — proceed with the transaction
    }

    // Check that the new hash is not already registered (contract will revert otherwise)
    try {
      const exists = await this.verifyOnChain(normalizedNew);
      if (exists) {
        throw new ChainValidationError(
          `New hash ${newHash} is already registered on-chain. The contract auto-registers the new hash during merge — do not anchor it beforehand.`
        );
      }
    } catch (error) {
      if (error instanceof ChainValidationError) throw error;
      // Ignore read errors — proceed with the transaction
    }

    const data = encodeRecordMergeTransformation(
      normalizedSources,
      normalizedNew,
      description,
      newDataType,
    );

    const receipt = await this.sendAndWait(data);

    return {
      ...receipt,
      sourceHashes: normalizedSources,
      newHash: normalizedNew,
      description,
      newDataType,
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
   * Items may optionally include a storageRef for bidirectional lookup.
   * Requires a signer.
   */
  async batchAnchor(items: Array<{ dataHash: string; dataType: string; storageRef?: string }>): Promise<BatchResult> {
    this.requireSigner();
    this.validateBatchSize(items.length);

    const hashes = items.map((item) => normalizeHash(item.dataHash));
    const types = items.map((item) => {
      validateDataType(item.dataType);
      return item.dataType;
    });

    const hasAnyStorageRef = items.some((item) => item.storageRef);
    let storageRefs: Hex[] | undefined;
    if (hasAnyStorageRef) {
      storageRefs = items.map((item) =>
        item.storageRef ? normalizeHash(item.storageRef) : ZERO_BYTES32
      );
    }

    const data = encodeBatchRegisterData(hashes, types, storageRefs);
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
    this.validateBatchSize(dataHashes.length);

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
    this.validateBatchSize(items.length);

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

  private validateBatchSize(count: number): void {
    const MAX_BATCH_SIZE = 50;
    if (count === 0) {
      throw new ChainValidationError('Batch must contain at least one item');
    }
    if (count > MAX_BATCH_SIZE) {
      throw new ChainValidationError(
        `Batch size ${count} exceeds maximum of ${MAX_BATCH_SIZE}. Split into smaller batches.`
      );
    }
  }

  private async checkNotRegistered(normalizedHash: Hex, originalHash: string): Promise<void> {
    try {
      const record = await this.getDataRecord(normalizedHash);
      throw new DataAlreadyRegisteredError(
        originalHash,
        record.owner,
        record.timestamp,
        record.dataType,
      );
    } catch (error) {
      if (error instanceof DataAlreadyRegisteredError) {
        throw error;
      }
      // DataNotRegisteredError means the hash is free — proceed
    }
  }

  private isAlreadyRegisteredRevert(error: unknown): boolean {
    return (
      error instanceof ChainTransactionError &&
      /already registered/i.test(error.message)
    );
  }

  private async throwAlreadyRegistered(normalizedHash: Hex, originalHash: string): Promise<never> {
    try {
      const record = await this.getDataRecord(normalizedHash);
      throw new DataAlreadyRegisteredError(
        originalHash,
        record.owner,
        record.timestamp,
        record.dataType,
      );
    } catch (error) {
      if (error instanceof DataAlreadyRegisteredError) {
        throw error;
      }
      // If we can't fetch the record, throw a basic version
      throw new DataAlreadyRegisteredError(originalHash, '', 0, '');
    }
  }

  private cleanTransactionError(error: unknown): string {
    let raw: string;
    if (error instanceof Error) {
      raw = error.message;
    } else if (typeof error === 'object' && error !== null) {
      // Handle raw RPC error objects from EIP-1193 providers (e.g. MetaMask)
      const obj = error as Record<string, unknown>;
      raw = (obj['message'] as string) ?? (obj['reason'] as string) ?? JSON.stringify(error);
    } else {
      raw = String(error);
    }

    // Extract revert reason from Hardhat/EVM error messages
    const revertMatch = raw.match(/reverted with reason string '([^']+)'/);
    if (revertMatch) {
      return revertMatch[1]!;
    }

    // Extract the first meaningful section before viem's verbose details
    const match = raw.match(/^(.*?)(?:\n\n|\nContract Call:|\nRequest Arguments:|\nDocs:)/s);
    const cleaned = match ? match[1]!.trim() : raw;
    if (cleaned.length > 200) {
      return cleaned.slice(0, 197) + '...';
    }
    return cleaned;
  }

  private isTransientError(error: unknown): boolean {
    let msg: string;
    if (error instanceof Error) {
      msg = error.message;
    } else if (typeof error === 'object' && error !== null && 'message' in error) {
      msg = String((error as Record<string, unknown>)['message']);
    } else {
      msg = String(error);
    }
    return /nonce too (low|high)|replacement underpriced/i.test(msg);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async sendWithRetry(data: Hex): Promise<Hex> {
    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        return await this.signer!.sendTransaction({
          to: this.contractAddress,
          data,
          ...(this.gasLimit ? { gas: this.gasLimit } : {}),
        });
      } catch (error) {
        if (attempt < this.retryConfig.maxRetries && this.isTransientError(error)) {
          await this.delay(this.retryConfig.baseDelayMs * Math.pow(2, attempt));
          continue;
        }
        const originalError = error instanceof Error ? error : undefined;
        throw new ChainTransactionError(
          `Transaction failed: ${this.cleanTransactionError(error)}`,
          undefined,
          originalError,
        );
      }
    }
    // Unreachable — the last iteration always throws in the catch block
    throw new ChainTransactionError('Transaction failed after retries');
  }

  private async sendAndWait(data: Hex): Promise<TransactionResult> {
    const txHash = await this.sendWithRetry(data);

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
