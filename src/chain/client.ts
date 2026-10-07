import {
  createPublicClient,
  decodeEventLog,
  fallback,
  formatEther,
  http,
  type PublicClient,
  type Hex,
} from 'viem';
import { DATA_PROVENANCE_ABI } from './abi.js';
import { CHAIN_PRESETS, PRESET_RPC_FALLBACKS, ZERO_BYTES32, ZERO_ADDRESS } from './constants.js';
import {
  ChainConfigurationError,
  ChainConnectionError,
  ChainError,
  ChainTransactionError,
  ChainValidationError,
  DataAlreadyRegisteredError,
  DataNotRegisteredError,
  SignerRequiredError,
  ReceiptTimeoutError,
  rpcErrorMessage,
  sanitizeErrorText,
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
  /** RPC chain + contract code check, done once per client (see ensureWriteTarget) */
  private writeTargetCheck: Promise<void> | undefined;
  /** In-flight wallet chain switch, shared by concurrent writes */
  private pendingSwitch: Promise<void> | undefined;

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

    const rpcUrls = this.resolveRpcUrls(config);
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

    // fallback() moves to the next URL on any error except a revert or a user
    // rejection (viem's shouldThrow). retryCount 1: one more pass over the list
    // (with viem's backoff) rides out a burst of 429s; viem's default (3) would
    // make 12 requests for 3 failing URLs. rank stays off: its default ping is
    // net_listening, which says nothing about eth_call. Ranking with an eth_call
    // ping (a cooldown for degraded or hung URLs) is tracked in #104.
    this.publicClient = createPublicClient({
      transport:
        rpcUrls.length === 1
          ? http(rpcUrls[0])
          : fallback(rpcUrls.map((url) => http(url)), { retryCount: 1 }),
    });
  }

  /**
   * Ordered RPC URLs: the primary, then fallbacks.
   *
   * - `config.rpcFallbacks`, when given, is used as is.
   * - A built-in preset (by name, or the exported object itself) brings its
   *   PRESET_RPC_FALLBACKS; any other preset object, including a spread copy,
   *   brings its own `rpcFallbacks`, exactly as written.
   * - An explicit `config.rpcUrl` outside the preset's URL list is treated as a
   *   private endpoint: no preset fallbacks, so its reads never go to public
   *   ones. An `rpcUrl` that is one of the preset's URLs keeps the rest.
   *
   * Blank entries are dropped. Duplicates are compared ignoring a trailing
   * slash; the first spelling is passed to viem unchanged.
   */
  private resolveRpcUrls(config: ChainClientConfig): string[] {
    const norm = (url: string) => url.trim().replace(/\/+$/, '');
    const same = (a: string, b: string) => norm(a) === norm(b);

    const preset = this.preset;
    // A built-in preset, by name or as the (frozen) object itself, brings its
    // PRESET_RPC_FALLBACKS; any other preset object brings its own rpcFallbacks.
    const builtinName = Object.keys(CHAIN_PRESETS).find((name) => CHAIN_PRESETS[name] === preset);
    const presetFallbacks = builtinName ? PRESET_RPC_FALLBACKS[builtinName] ?? [] : preset.rpcFallbacks ?? [];
    const presetUrls = [preset.rpcUrl, ...presetFallbacks];
    const primary = config.rpcUrl?.trim() || preset.rpcUrl;

    let fallbacks: readonly string[];
    if (config.rpcFallbacks) {
      fallbacks = config.rpcFallbacks;
    } else if (presetUrls.some((url) => same(url, primary))) {
      fallbacks = presetUrls; // the primary's own entry is removed as a duplicate below
    } else {
      fallbacks = [];
    }

    const urls: string[] = [];
    for (const url of [primary, ...fallbacks]) {
      if (norm(url) && !urls.some((u) => same(u, url))) urls.push(url.trim());
    }
    if (urls.length === 0) {
      throw new ChainConfigurationError(`No RPC URL configured for ${preset.name}: set rpcUrl or the preset's rpcUrl`);
    }
    return urls;
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
        `Failed to verify on-chain: ${rpcErrorMessage(error)}`
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
        `Failed to get data record: ${rpcErrorMessage(error)}`
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
        `Failed to get user data records: ${rpcErrorMessage(error)}`
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
        `Failed to check access: ${rpcErrorMessage(error)}`
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
        `Failed to check delegate: ${rpcErrorMessage(error)}`
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
        `Failed to get transformation links: ${rpcErrorMessage(error)}`
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
        `Failed to get transformation parents: ${rpcErrorMessage(error)}`
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
        `Failed to get child hashes: ${rpcErrorMessage(error)}`
      );
    }
  }

  /**
   * Traverse the full provenance chain (DAG) from any node.
   * Performs BFS in both directions (ancestors via parents, descendants via children).
   *
   * Edges: each record carries its child edges in `transformationLinks` and its
   * parent edges in `parents`, so the DAG can be rebuilt without further RPC calls.
   * Nodes at `maxDepth` are not expanded and have `parents` undefined. Edges on any
   * node may point to hashes absent from the result (beyond `maxDepth`, or unregistered).
   *
   * Order: BFS order from the start node. This is neither topological nor
   * chronological; sort by `timestamp` or walk the edges if you need either.
   *
   * Fails closed: an RPC error on any node rejects the whole call with
   * ChainConnectionError rather than returning a lineage silently missing a branch.
   * An unregistered start hash returns []; a linked hash that reads as
   * unregistered rejects with DataNotRegisteredError (an inconsistent read).
   *
   * @param dataHash - Starting hash
   * @param maxDepth - Maximum traversal depth (default 10; floored and clamped to 1..50; NaN throws ChainValidationError)
   * @returns Array of ChainProvenanceRecord for each node in the DAG
   */
  async getProvenanceChain(dataHash: string, maxDepth = 10): Promise<ChainProvenanceRecord[]> {
    // Coerce like the clamp always did ('5' -> 5, null -> 0 -> clamped to 1), but reject NaN: it
    // survives Math.min/max and makes `depth >= NaN` always false, i.e. no limit.
    const requestedDepth = Number(maxDepth);
    if (Number.isNaN(requestedDepth)) {
      throw new ChainValidationError(`maxDepth must not be NaN (got ${String(maxDepth)})`);
    }
    const effectiveMaxDepth = Math.min(Math.max(Math.floor(requestedDepth), 1), 50);
    const startHash = normalizeHash(dataHash);

    const records: ChainProvenanceRecord[] = [];
    // BFS queue of [hash, depth]. Hashes are marked when enqueued (BFS reaches
    // each at its minimum depth first), so every node is queued once; `head`
    // replaces O(n) shift().
    const queued = new Set<string>([startHash.toLowerCase()]);
    const queue: Array<[Hex, number]> = [[startHash, 0]];

    for (let head = 0; head < queue.length; head++) {
      const [hash, depth] = queue[head]!;

      // Record and parents are independent: fetch both at once. Children come
      // from the record (the contract's getChildHashes returns exactly
      // transformationLinks[].newDataHash), so no third call.
      const expand = depth < effectiveMaxDepth;
      const [recordResult, parentsResult] = await Promise.allSettled([
        this.getDataRecord(hash),
        expand ? this.getTransformationParents(hash) : Promise.resolve(undefined),
      ]);

      if (recordResult.status === 'rejected') {
        // Only the start hash may be unregistered. The contract registers every
        // transformation's new hash, so a linked hash reading as unregistered
        // means an inconsistent read (e.g. a lagging RPC): fail closed.
        if (recordResult.reason instanceof DataNotRegisteredError && depth === 0) continue;
        throw this.traversalError(hash, depth, recordResult.reason);
      }
      const record = recordResult.value;
      records.push(record);

      if (!expand) continue; // at maxDepth: parents not fetched, stays undefined
      if (parentsResult.status === 'rejected') {
        throw this.traversalError(hash, depth, parentsResult.reason);
      }
      // expand is true, so the parents promise was getTransformationParents (string[])
      const parents = parentsResult.value!;
      record.parents = parents;

      const neighbours = [...record.transformationLinks.map((link) => link.newDataHash), ...parents];
      for (const next of neighbours) {
        const key = next.toLowerCase();
        if (!queued.has(key)) {
          queued.add(key);
          queue.push([next as Hex, depth + 1]);
        }
      }
    }

    return records;
  }

  /**
   * Fail-closed traversal error naming the node it stopped at. Chain errors
   * other than connection errors (validation, not-registered) keep their class.
   */
  private traversalError(hash: Hex, depth: number, cause: unknown): Error {
    if (cause instanceof ChainError && !(cause instanceof ChainConnectionError)) return cause;
    const message = rpcErrorMessage(cause);
    const error = new ChainConnectionError(`getProvenanceChain failed at ${hash} (depth ${depth}): ${message}`);
    // Not enumerable: the cause may be a viem error carrying the RPC URL (#118)
    Object.defineProperty(error, 'cause', { value: cause, enumerable: false, configurable: true, writable: true });
    return error;
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
        `Failed to get user data records count: ${rpcErrorMessage(error)}`
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
        `Failed to get paginated data records: ${rpcErrorMessage(error)}`
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
   * Check that the RPC can serve contract reads against the configured contract.
   * Returns true if it can, false on error (does not throw).
   *
   * Probes with a real eth_call (getUserDataRecordsCount on the zero address),
   * the operation every read depends on. In #101, sepolia.base.org answered
   * eth_chainId and eth_blockNumber while every eth_call returned 503.
   *
   * So it also returns false for a wrong or undeployed contract address. With
   * fallbacks it returns true if any URL can serve the read; to check only the
   * primary, use a client built with `rpcFallbacks: []`.
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.publicClient.readContract({
        address: this.contractAddress,
        abi: DATA_PROVENANCE_ABI,
        functionName: 'getUserDataRecordsCount',
        args: [ZERO_ADDRESS],
      });
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
        `Failed to get balance: ${rpcErrorMessage(error)}`
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
    // After local validation, before any network call (#115/#116)
    await this.ensureWriteTarget();
    await this.checkNotRegistered(hash, dataHash);

    const data = encodeRegisterData(hash, dataType, normalizedStorageRef);
    const owner = await this.signer!.getAddress();

    let receipt: TransactionResult;
    try {
      receipt = await this.sendAndWait(data, { event: 'DataRegistered' });
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
    // After local validation, before any network call (#115/#116)
    await this.ensureWriteTarget();
    const accessor = await this.signer!.getAddress();

    const receipt = await this.sendAndWait(data, { event: 'DataAccessed' });

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
    // After local validation, before any network call (#115/#116)
    await this.ensureWriteTarget();
    await this.checkNotRegistered(hash, dataHash);

    const data = encodeRegisterDataFor(hash, dataType, actualOwner as Address, normalizedStorageRef);

    let receipt: TransactionResult;
    try {
      receipt = await this.sendAndWait(data, { event: 'DataRegistered' });
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
        `Failed to get data hash by storage ref: ${rpcErrorMessage(error)}`
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
    // After local validation, before any network call (#115/#116)
    await this.ensureWriteTarget();
    const existingLinks = await this.getTransformationLinks(origHash);
    if (existingLinks.some((link) => link.newDataHash.toLowerCase() === nHash.toLowerCase())) {
      throw new ChainValidationError(
        `Transformation from ${originalHash} to ${newHash} is already recorded on-chain`
      );
    }


    // Check that the new hash is not already registered (contract will revert otherwise)
    const exists = await this.verifyOnChain(nHash);
    if (exists) {
      throw new ChainValidationError(
        `New hash ${newHash} is already registered on-chain. The contract auto-registers the new hash during transformation — do not anchor it beforehand.`
      );
    }


    const data = encodeRecordTransformation(origHash, nHash, description);

    const receipt = await this.sendAndWait(data, { event: 'DataTransformed' });

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
    // After local validation, before any network call (#115/#116)
    await this.ensureWriteTarget();
    const existingParents = await this.getTransformationParents(normalizedNew);
    if (existingParents.length > 0) {
      throw new ChainValidationError(
        `Hash ${newHash} already has transformation parents recorded on-chain`
      );
    }


    // Check that the new hash is not already registered (contract will revert otherwise)
    const exists = await this.verifyOnChain(normalizedNew);
    if (exists) {
      throw new ChainValidationError(
        `New hash ${newHash} is already registered on-chain. The contract auto-registers the new hash during merge — do not anchor it beforehand.`
      );
    }


    const data = encodeRecordMergeTransformation(
      normalizedSources,
      normalizedNew,
      description,
      newDataType,
    );

    const receipt = await this.sendAndWait(data, { event: 'DataMerged' });

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

    // After local validation, before any network call (#115/#116)
    await this.ensureWriteTarget();
    const receipt = await this.sendAndWait(data, { event: 'DataStatusChanged' });

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

    // After local validation, before any network call (#115/#116)
    await this.ensureWriteTarget();
    const receipt = await this.sendAndWait(data, { event: 'DataOwnershipTransferred' });

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

    // After local validation, before any network call (#115/#116)
    await this.ensureWriteTarget();
    const receipt = await this.sendAndWait(data, { event: 'DelegateAuthorized' });

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
    // After local validation, before any network call (#115/#116)
    await this.ensureWriteTarget();
    const receipt = await this.sendAndWait(data, { event: 'DataRegistered', count: items.length });

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
    // After local validation, before any network call (#115/#116)
    await this.ensureWriteTarget();
    const receipt = await this.sendAndWait(data, { event: 'DataAccessed', count: dataHashes.length });

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
    // After local validation, before any network call (#115/#116)
    await this.ensureWriteTarget();
    const receipt = await this.sendAndWait(data, { event: 'DataStatusChanged', count: items.length });

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
      // Only "not registered" means the hash is free. Any other failure (RPC
      // down, wrong contract) is surfaced instead of anchoring blind (#116).
      if (error instanceof DataNotRegisteredError) return;
      throw error;
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
    const cleaned = sanitizeErrorText(match ? match[1]!.trim() : raw);
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

  /**
   * Refuse to write anywhere but the configured chain and contract (#115, #116):
   * the RPC and the signer must both be on the preset's chain (an EIP-1193
   * wallet is asked to switch), and the contract address must hold code.
   */
  /**
   * Chain details a wallet may add (4902), only for built-in presets: their
   * URLs are public. A custom preset's RPC URL may embed an API key, which must
   * not end up in the user's wallet; the user adds such a chain themselves.
   */
  private addableChain(): { name: string; rpcUrls: string[]; explorerUrl: string } | undefined {
    const builtinName = Object.keys(CHAIN_PRESETS).find((name) => CHAIN_PRESETS[name] === this.preset);
    if (!builtinName) return undefined;
    return {
      name: this.preset.name,
      rpcUrls: [this.preset.rpcUrl, ...(PRESET_RPC_FALLBACKS[builtinName] ?? [])],
      explorerUrl: this.preset.explorerUrl,
    };
  }

  private async ensureWriteTarget(): Promise<void> {
    const expected = this.preset.chainId;
    const check = (this.writeTargetCheck ??= (async () => {
      let rpcChainId: number;
      let code: Hex | undefined;
      try {
        [rpcChainId, code] = await Promise.all([
          this.publicClient.getChainId(),
          this.publicClient.getBytecode({ address: this.contractAddress }),
        ]);
      } catch (error) {
        throw new ChainConnectionError(`Could not check the chain before writing: ${rpcErrorMessage(error)}`);
      }
      if (rpcChainId !== expected) {
        throw new ChainConfigurationError(
          `The RPC is on chain ${rpcChainId}, but the ${this.preset.name} preset is chain ${expected}`
        );
      }
      if (!code || code === '0x') {
        throw new ChainConfigurationError(
          `No contract code at ${this.contractAddress} on ${this.preset.name}: wrong contract address or chain`
        );
      }
    })());
    try {
      await check;
    } catch (error) {
      // Check again next time, unless a newer check already replaced this one
      if (this.writeTargetCheck === check) this.writeTargetCheck = undefined;
      throw error;
    }

    // The signer is checked on every write: a wallet can change network at any time
    const signer = this.signer!;
    let signerChainId: number;
    try {
      signerChainId = await signer.getChainId();
      if (signerChainId !== expected && signer.switchChain) {
        // One switch request at a time: wallets reject a second while one is pending
        this.pendingSwitch ??= signer.switchChain(expected, this.addableChain()).finally(() => {
          this.pendingSwitch = undefined;
        });
        await this.pendingSwitch;
        signerChainId = await signer.getChainId();
      }
    } catch (error) {
      throw new ChainConfigurationError(
        `Could not confirm the signer is on chain ${expected} (${this.preset.name}): ${rpcErrorMessage(error)}`
      );
    }
    if (signerChainId !== expected) {
      throw new ChainConfigurationError(
        `The signer is on chain ${signerChainId}, but the ${this.preset.name} preset is chain ${expected}`
      );
    }
  }

  private async sendWithRetry(data: Hex): Promise<Hex> {
    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        return await this.signer!.sendTransaction({
          to: this.contractAddress,
          data,
          // Wallets that honour it refuse to sign on another chain (closes the
          // gap between the chain check and the send)
          chainId: this.preset.chainId,
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

  private async sendAndWait(data: Hex, expected: ExpectedEvent): Promise<TransactionResult> {
    const txHash = await this.sendWithRetry(data);
    return this.waitForTransaction(txHash, expected);
  }


  /**
   * Wait for a sent transaction and confirm it did what was asked: it did not
   * revert and the contract emitted the expected event(s). Use it to resume
   * after a ReceiptTimeoutError (`error.txHash`).
   *
   * @throws ReceiptTimeoutError if the receipt does not arrive (it may still confirm)
   * @throws ChainTransactionError if it reverted or the expected event is missing
   */
  async waitForTransaction(
    txHash: Hex,
    expected?: ExpectedEvent & { timeout?: number }
  ): Promise<TransactionResult> {
    let receipt: Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>>;
    let replacement: { reason: string; hash: Hex } | undefined;
    try {
      receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: expected?.timeout ?? this.txTimeout,
        pollingInterval: 2_000,
        // The user may speed up or cancel the tx in the wallet: follow the replacement
        onReplaced: (r) => {
          replacement = { reason: r.reason, hash: r.transaction.hash };
        },
      });
    } catch (error) {
      const explorerUrl = this.getExplorerUrl(txHash);
      const resumeWith = expected ? { event: expected.event, ...(expected.count ? { count: expected.count } : {}) } : undefined;
      throw new ReceiptTimeoutError(
        `Transaction ${txHash} was sent but its receipt could not be obtained (${rpcErrorMessage(error)}). ` +
          'It may still confirm: call waitForTransaction(error.txHash, error.expected) instead of sending again.',
        txHash,
        explorerUrl,
        resumeWith,
      );
    }

    // The hash that actually landed (a speed-up replaces it)
    const finalHash = (receipt.transactionHash ?? replacement?.hash ?? txHash);
    if (replacement?.reason === 'cancelled' || replacement?.reason === 'replaced') {
      // 'replaced': same nonce, different call; its events say nothing about this write
      throw new ChainTransactionError(
        `Transaction ${txHash} was ${replacement.reason} in the wallet (by ${finalHash}); the write did not happen as sent`,
        finalHash,
      );
    }
    if (receipt.status === 'reverted') {
      throw new ChainTransactionError('Transaction reverted', finalHash);
    }

    if (expected?.event) {
      // "Did not revert" is not success: a call to an address without the
      // contract also succeeds. Require the contract's own event (#116).
      const emitted = receipt.logs.filter((log) => {
        if (log.address.toLowerCase() !== this.contractAddress.toLowerCase()) return false;
        try {
          return decodeEventLog({ abi: DATA_PROVENANCE_ABI, data: log.data, topics: log.topics }).eventName === expected.event;
        } catch {
          return false;
        }
      }).length;
      const needed = expected.count ?? 1;
      if (emitted < needed) {
        throw new ChainTransactionError(
          `Transaction ${finalHash} succeeded but the contract emitted ${emitted} of ${needed} expected ${expected.event} event(s): nothing may have been recorded`,
          finalHash,
        );
      }
    }

    return {
      txHash: finalHash,
      blockNumber: Number(receipt.blockNumber),
      gasUsed: receipt.gasUsed,
      explorerUrl: this.getExplorerUrl(finalHash),
    };
  }
}

/** The event a write must emit to count as done (see waitForTransaction) */
export interface ExpectedEvent {
  event: string;
  /** How many (batch writes emit one per item; default 1) */
  count?: number;
}
