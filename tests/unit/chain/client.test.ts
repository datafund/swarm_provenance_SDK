import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChainClient } from '../../../src/chain/client.js';
import {
  ChainConfigurationError,
  ChainValidationError,
  DataAlreadyRegisteredError,
  SignerRequiredError,
} from '../../../src/chain/errors.js';
import { DataStatus } from '../../../src/chain/types.js';
import type { Address, Hex, ChainSigner } from '../../../src/chain/types.js';

// Mock viem's createPublicClient and its readContract/waitForTransactionReceipt
const mockReadContract = vi.fn();
const mockWaitForTransactionReceipt = vi.fn();

vi.mock('viem', async () => {
  const actual = await vi.importActual('viem');
  return {
    ...actual,
    createPublicClient: () => ({
      readContract: mockReadContract,
      waitForTransactionReceipt: mockWaitForTransactionReceipt,
    }),
  };
});

const MOCK_ADDRESS: Address = '0x1234567890abcdef1234567890abcdef12345678';
const MOCK_TX_HASH: Hex = `0x${'bb'.repeat(32)}`;
const SAMPLE_HASH = 'ab'.repeat(32);
const SAMPLE_HASH_0X: Hex = `0x${SAMPLE_HASH}`;
const ZERO_HASH: Hex = `0x${'00'.repeat(32)}`;

function createMockSigner(): ChainSigner {
  return {
    getAddress: () => Promise.resolve(MOCK_ADDRESS),
    sendTransaction: () => Promise.resolve(MOCK_TX_HASH),
  };
}

describe('ChainClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create with preset string', () => {
      const client = new ChainClient({ chain: 'base-sepolia' });
      expect(client).toBeInstanceOf(ChainClient);
    });

    it('should create with custom preset object', () => {
      const client = new ChainClient({
        chain: {
          chainId: 1,
          name: 'custom',
          rpcUrl: 'https://example.com',
          contractAddress: '0x1234567890abcdef1234567890abcdef12345678',
          explorerUrl: 'https://explorer.example.com',
        },
      });
      expect(client).toBeInstanceOf(ChainClient);
    });

    it('should throw for unknown preset', () => {
      expect(() => new ChainClient({ chain: 'unknown-chain' })).toThrow(ChainConfigurationError);
    });

    it('should throw for zero contract address (mainnet not deployed)', () => {
      expect(() => new ChainClient({ chain: 'base' })).toThrow(ChainConfigurationError);
    });
  });

  describe('verifyOnChain', () => {
    it('should return true when record exists', async () => {
      mockReadContract.mockResolvedValueOnce([
        SAMPLE_HASH_0X,              // dataHash
        MOCK_ADDRESS,                // owner
        BigInt(1700000000),          // timestamp
        'dataset',                   // dataType
        0,                           // status
      ]);

      const client = new ChainClient({ chain: 'base-sepolia' });
      const result = await client.verifyOnChain(SAMPLE_HASH);
      expect(result).toBe(true);
    });

    it('should return false when record does not exist', async () => {
      mockReadContract.mockResolvedValueOnce([
        ZERO_HASH,                    // zero = not registered
        '0x' + '00'.repeat(20),
        BigInt(0),
        '',
        0,
      ]);

      const client = new ChainClient({ chain: 'base-sepolia' });
      const result = await client.verifyOnChain(SAMPLE_HASH);
      expect(result).toBe(false);
    });

    it('should accept both 0x-prefixed and bare hash', async () => {
      mockReadContract.mockResolvedValue([SAMPLE_HASH_0X, MOCK_ADDRESS, BigInt(0), '', 0]);

      const client = new ChainClient({ chain: 'base-sepolia' });
      await client.verifyOnChain(SAMPLE_HASH);
      await client.verifyOnChain(SAMPLE_HASH_0X);
      expect(mockReadContract).toHaveBeenCalledTimes(2);
    });
  });

  describe('getDataRecord', () => {
    it('should return parsed record', async () => {
      mockReadContract.mockResolvedValueOnce({
        dataHash: SAMPLE_HASH_0X,
        owner: MOCK_ADDRESS,
        timestamp: BigInt(1700000000),
        dataType: 'dataset',
        transformationLinks: [{ newDataHash: `0x${'cd'.repeat(32)}`, description: 'transformed-v2' }],
        accessors: [MOCK_ADDRESS],
        status: 0,
      });

      const client = new ChainClient({ chain: 'base-sepolia' });
      const record = await client.getDataRecord(SAMPLE_HASH);

      expect(record.dataHash).toBe(SAMPLE_HASH_0X);
      expect(record.owner).toBe(MOCK_ADDRESS);
      expect(record.timestamp).toBe(1700000000);
      expect(record.dataType).toBe('dataset');
      expect(record.status).toBe(DataStatus.ACTIVE);
      expect(record.accessors).toEqual([MOCK_ADDRESS]);
      expect(record.transformationLinks).toEqual([{ newDataHash: `0x${'cd'.repeat(32)}`, description: 'transformed-v2' }]);
    });

    it('should throw DataNotRegisteredError for zero hash', async () => {
      mockReadContract.mockResolvedValueOnce({
        dataHash: ZERO_HASH,
        owner: '0x' + '00'.repeat(20),
        timestamp: BigInt(0),
        dataType: '',
        transformationLinks: [],
        accessors: [],
        status: 0,
      });

      const client = new ChainClient({ chain: 'base-sepolia' });
      await expect(client.getDataRecord(SAMPLE_HASH)).rejects.toThrow('not registered');
    });
  });

  describe('anchor', () => {
    it('should throw SignerRequiredError without signer', async () => {
      const client = new ChainClient({ chain: 'base-sepolia' });
      await expect(client.anchor(SAMPLE_HASH, 'dataset')).rejects.toThrow(SignerRequiredError);
    });

    it('should anchor data and return result', async () => {
      // Pre-check: hash not registered
      mockReadContract.mockResolvedValueOnce({
        dataHash: ZERO_HASH,
        owner: '0x' + '00'.repeat(20),
        timestamp: BigInt(0),
        dataType: '',
        transformationLinks: [],
        accessors: [],
        status: 0,
      });

      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        status: 'success',
        blockNumber: BigInt(12345),
        gasUsed: BigInt(50000),
      });

      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      const result = await client.anchor(SAMPLE_HASH, 'dataset');

      expect(result.txHash).toBe(MOCK_TX_HASH);
      expect(result.blockNumber).toBe(12345);
      expect(result.gasUsed).toBe(BigInt(50000));
      expect(result.dataHash).toBe(SAMPLE_HASH_0X);
      expect(result.dataType).toBe('dataset');
      expect(result.owner).toBe(MOCK_ADDRESS);
      expect(result.explorerUrl).toContain(MOCK_TX_HASH);
    });

    it('should throw on reverted transaction', async () => {
      // Pre-check: hash not registered
      mockReadContract.mockResolvedValueOnce({
        dataHash: ZERO_HASH,
        owner: '0x' + '00'.repeat(20),
        timestamp: BigInt(0),
        dataType: '',
        transformationLinks: [],
        accessors: [],
        status: 0,
      });

      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        status: 'reverted',
        blockNumber: BigInt(12345),
        gasUsed: BigInt(21000),
      });

      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      await expect(client.anchor(SAMPLE_HASH, 'dataset')).rejects.toThrow('reverted');
    });

    it('should throw DataAlreadyRegisteredError when hash is already registered', async () => {
      mockReadContract.mockResolvedValueOnce({
        dataHash: SAMPLE_HASH_0X,
        owner: MOCK_ADDRESS,
        timestamp: BigInt(1700000000),
        dataType: 'dataset',
        transformationLinks: [],
        accessors: [],
        status: 0,
      });

      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      await expect(client.anchor(SAMPLE_HASH, 'dataset')).rejects.toThrow(DataAlreadyRegisteredError);
    });

    it('should proceed when hash is not registered', async () => {
      // Pre-check: hash not registered (getDataRecord returns zero)
      mockReadContract.mockResolvedValueOnce({
        dataHash: ZERO_HASH,
        owner: '0x' + '00'.repeat(20),
        timestamp: BigInt(0),
        dataType: '',
        transformationLinks: [],
        accessors: [],
        status: 0,
      });

      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        status: 'success',
        blockNumber: BigInt(12345),
        gasUsed: BigInt(50000),
      });

      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      const result = await client.anchor(SAMPLE_HASH, 'dataset');

      expect(result.txHash).toBe(MOCK_TX_HASH);
      expect(result.dataHash).toBe(SAMPLE_HASH_0X);
    });
  });

  describe('recordAccess', () => {
    it('should throw SignerRequiredError without signer', async () => {
      const client = new ChainClient({ chain: 'base-sepolia' });
      await expect(client.recordAccess(SAMPLE_HASH)).rejects.toThrow(SignerRequiredError);
    });

    it('should record access and return result', async () => {
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        status: 'success',
        blockNumber: BigInt(12346),
        gasUsed: BigInt(30000),
      });

      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      const result = await client.recordAccess(SAMPLE_HASH);

      expect(result.txHash).toBe(MOCK_TX_HASH);
      expect(result.dataHash).toBe(SAMPLE_HASH_0X);
      expect(result.accessor).toBe(MOCK_ADDRESS);
    });
  });

  // ─── Phase 2 Read Operations ────────────────────────────────

  describe('getUserDataRecords', () => {
    it('should return list of hashes', async () => {
      mockReadContract.mockResolvedValueOnce([SAMPLE_HASH_0X]);

      const client = new ChainClient({ chain: 'base-sepolia' });
      const result = await client.getUserDataRecords(MOCK_ADDRESS);
      expect(result).toEqual([SAMPLE_HASH_0X]);
    });

    it('should throw on invalid address', async () => {
      const client = new ChainClient({ chain: 'base-sepolia' });
      await expect(client.getUserDataRecords('bad')).rejects.toThrow('Invalid Ethereum address');
    });
  });

  describe('hasAddressAccessed', () => {
    it('should return true when accessed', async () => {
      mockReadContract.mockResolvedValueOnce(true);

      const client = new ChainClient({ chain: 'base-sepolia' });
      const result = await client.hasAddressAccessed(SAMPLE_HASH, MOCK_ADDRESS);
      expect(result).toBe(true);
    });

    it('should return false when not accessed', async () => {
      mockReadContract.mockResolvedValueOnce(false);

      const client = new ChainClient({ chain: 'base-sepolia' });
      const result = await client.hasAddressAccessed(SAMPLE_HASH, MOCK_ADDRESS);
      expect(result).toBe(false);
    });
  });

  describe('isAuthorizedDelegate', () => {
    it('should return boolean', async () => {
      mockReadContract.mockResolvedValueOnce(true);

      const client = new ChainClient({ chain: 'base-sepolia' });
      const result = await client.isAuthorizedDelegate(MOCK_ADDRESS, MOCK_ADDRESS);
      expect(result).toBe(true);
    });
  });

  // ─── Phase 2 Write Operations ────────────────────────────────

  describe('anchorFor', () => {
    it('should throw SignerRequiredError without signer', async () => {
      const client = new ChainClient({ chain: 'base-sepolia' });
      await expect(client.anchorFor(SAMPLE_HASH, 'dataset', MOCK_ADDRESS)).rejects.toThrow(SignerRequiredError);
    });

    it('should throw DataAlreadyRegisteredError when hash is already registered', async () => {
      mockReadContract.mockResolvedValueOnce({
        dataHash: SAMPLE_HASH_0X,
        owner: MOCK_ADDRESS,
        timestamp: BigInt(1700000000),
        dataType: 'dataset',
        transformationLinks: [],
        accessors: [],
        status: 0,
      });

      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      await expect(client.anchorFor(SAMPLE_HASH, 'dataset', MOCK_ADDRESS)).rejects.toThrow(DataAlreadyRegisteredError);
    });

    it('should anchor for another owner', async () => {
      // Pre-check: hash not registered
      mockReadContract.mockResolvedValueOnce({
        dataHash: ZERO_HASH,
        owner: '0x' + '00'.repeat(20),
        timestamp: BigInt(0),
        dataType: '',
        transformationLinks: [],
        accessors: [],
        status: 0,
      });

      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        status: 'success',
        blockNumber: BigInt(100),
        gasUsed: BigInt(60000),
      });

      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      const result = await client.anchorFor(SAMPLE_HASH, 'dataset', MOCK_ADDRESS);

      expect(result.owner).toBe(MOCK_ADDRESS);
      expect(result.dataHash).toBe(SAMPLE_HASH_0X);
    });
  });

  describe('recordTransformation', () => {
    it('should record transformation', async () => {
      // First call: getTransformationLinks check (no duplicates)
      mockReadContract.mockResolvedValueOnce([]);
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        status: 'success',
        blockNumber: BigInt(101),
        gasUsed: BigInt(55000),
      });

      const newHash = 'cd'.repeat(32);
      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      const result = await client.recordTransformation(SAMPLE_HASH, newHash, 'filtered PII');

      expect(result.originalHash).toBe(SAMPLE_HASH_0X);
      expect(result.newHash).toBe(`0x${newHash}`);
      expect(result.description).toBe('filtered PII');
    });

    it('should throw on duplicate transformation', async () => {
      const newHash = 'cd'.repeat(32);
      // getTransformationLinks returns existing link
      mockReadContract.mockResolvedValueOnce([
        { newDataHash: `0x${newHash}`, description: 'already done' },
      ]);

      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });

      await expect(
        client.recordTransformation(SAMPLE_HASH, newHash, 'filtered PII')
      ).rejects.toThrow('already recorded on-chain');
    });

    it('should proceed if duplicate check fails', async () => {
      // getTransformationLinks fails (e.g. RPC error) — should still proceed
      mockReadContract.mockRejectedValueOnce(new Error('RPC timeout'));
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        status: 'success',
        blockNumber: BigInt(101),
        gasUsed: BigInt(55000),
      });

      const newHash = 'cd'.repeat(32);
      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      const result = await client.recordTransformation(SAMPLE_HASH, newHash, 'filtered PII');

      expect(result.originalHash).toBe(SAMPLE_HASH_0X);
    });
  });

  describe('setDataStatus', () => {
    it('should set status', async () => {
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        status: 'success',
        blockNumber: BigInt(102),
        gasUsed: BigInt(40000),
      });

      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      const result = await client.setDataStatus(SAMPLE_HASH, DataStatus.RESTRICTED);

      expect(result.dataHash).toBe(SAMPLE_HASH_0X);
      expect(result.newStatus).toBe(DataStatus.RESTRICTED);
    });
  });

  describe('transferOwnership', () => {
    it('should transfer ownership', async () => {
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        status: 'success',
        blockNumber: BigInt(103),
        gasUsed: BigInt(45000),
      });

      const newOwner: Address = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      const result = await client.transferOwnership(SAMPLE_HASH, newOwner);

      expect(result.dataHash).toBe(SAMPLE_HASH_0X);
      expect(result.newOwner).toBe(newOwner);
    });

    it('should throw on invalid address', async () => {
      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      await expect(client.transferOwnership(SAMPLE_HASH, 'bad')).rejects.toThrow('Invalid Ethereum address');
    });
  });

  describe('setDelegate', () => {
    it('should set delegate', async () => {
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        status: 'success',
        blockNumber: BigInt(104),
        gasUsed: BigInt(35000),
      });

      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      const result = await client.setDelegate(MOCK_ADDRESS, true);

      expect(result.delegate).toBe(MOCK_ADDRESS);
      expect(result.authorized).toBe(true);
    });
  });

  describe('batchAnchor', () => {
    it('should batch anchor multiple hashes', async () => {
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        status: 'success',
        blockNumber: BigInt(105),
        gasUsed: BigInt(120000),
      });

      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      const result = await client.batchAnchor([
        { dataHash: SAMPLE_HASH, dataType: 'dataset' },
        { dataHash: 'cd'.repeat(32), dataType: 'model' },
      ]);

      expect(result.count).toBe(2);
      expect(result.txHash).toBe(MOCK_TX_HASH);
    });
  });

  describe('batchRecordAccess', () => {
    it('should batch record access', async () => {
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        status: 'success',
        blockNumber: BigInt(106),
        gasUsed: BigInt(80000),
      });

      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      const result = await client.batchRecordAccess([SAMPLE_HASH, 'cd'.repeat(32)]);

      expect(result.count).toBe(2);
    });
  });

  describe('batchSetDataStatus', () => {
    it('should batch set status', async () => {
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        status: 'success',
        blockNumber: BigInt(107),
        gasUsed: BigInt(90000),
      });

      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      const result = await client.batchSetDataStatus([
        { dataHash: SAMPLE_HASH, status: DataStatus.RESTRICTED },
        { dataHash: 'cd'.repeat(32), status: DataStatus.DELETED },
      ]);

      expect(result.count).toBe(2);
    });
  });

  describe('gasLimit config', () => {
    it('should pass gas limit to signer when configured', async () => {
      // Pre-check: hash not registered
      mockReadContract.mockResolvedValueOnce({
        dataHash: ZERO_HASH,
        owner: '0x' + '00'.repeat(20),
        timestamp: BigInt(0),
        dataType: '',
        transformationLinks: [],
        accessors: [],
        status: 0,
      });

      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        status: 'success',
        blockNumber: BigInt(200),
        gasUsed: BigInt(50000),
      });

      const sendTransaction = vi.fn().mockResolvedValue(MOCK_TX_HASH);
      const signer: ChainSigner = {
        getAddress: () => Promise.resolve(MOCK_ADDRESS),
        sendTransaction,
      };
      const client = new ChainClient({ chain: 'base-sepolia', signer, gasLimit: 500_000 });
      await client.anchor(SAMPLE_HASH, 'dataset');

      expect(sendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ gas: BigInt(500_000) }),
      );
    });

    it('should not pass gas when gasLimit is not configured', async () => {
      // Pre-check: hash not registered
      mockReadContract.mockResolvedValueOnce({
        dataHash: ZERO_HASH,
        owner: '0x' + '00'.repeat(20),
        timestamp: BigInt(0),
        dataType: '',
        transformationLinks: [],
        accessors: [],
        status: 0,
      });

      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        status: 'success',
        blockNumber: BigInt(201),
        gasUsed: BigInt(50000),
      });

      const sendTransaction = vi.fn().mockResolvedValue(MOCK_TX_HASH);
      const signer: ChainSigner = {
        getAddress: () => Promise.resolve(MOCK_ADDRESS),
        sendTransaction,
      };
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      await client.anchor(SAMPLE_HASH, 'dataset');

      expect(sendTransaction).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(sendTransaction.mock.calls[0][0]).not.toHaveProperty('gas');
    });
  });

  describe('batch size validation', () => {
    it('should throw on empty batch', async () => {
      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      await expect(client.batchAnchor([])).rejects.toThrow(ChainValidationError);
      await expect(client.batchAnchor([])).rejects.toThrow('at least one item');
    });

    it('should throw when batch exceeds maximum size', async () => {
      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      const items = Array.from({ length: 51 }, (_, i) => ({
        dataHash: `${i.toString(16).padStart(2, '0')}`.repeat(32),
        dataType: 'dataset',
      }));

      await expect(client.batchAnchor(items)).rejects.toThrow(ChainValidationError);
      await expect(client.batchAnchor(items)).rejects.toThrow('exceeds maximum of 50');
    });

    it('should throw on empty batchRecordAccess', async () => {
      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      await expect(client.batchRecordAccess([])).rejects.toThrow(ChainValidationError);
    });

    it('should throw on empty batchSetDataStatus', async () => {
      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      await expect(client.batchSetDataStatus([])).rejects.toThrow(ChainValidationError);
    });
  });

  describe('getExplorerUrl', () => {
    it('should return correct explorer URL', () => {
      const client = new ChainClient({ chain: 'base-sepolia' });
      const url = client.getExplorerUrl('0xabc');
      expect(url).toBe('https://sepolia.basescan.org/tx/0xabc');
    });
  });

  // ─── v2 Read Operations ──────────────────────────────────────

  describe('getTransformationLinks', () => {
    it('should return transformation links', async () => {
      const childHash: Hex = `0x${'cd'.repeat(32)}`;
      mockReadContract.mockResolvedValueOnce([
        { newDataHash: childHash, description: 'filtered PII' },
      ]);

      const client = new ChainClient({ chain: 'base-sepolia' });
      const links = await client.getTransformationLinks(SAMPLE_HASH);

      expect(links).toEqual([{ newDataHash: childHash, description: 'filtered PII' }]);
    });

    it('should return empty array when no links', async () => {
      mockReadContract.mockResolvedValueOnce([]);

      const client = new ChainClient({ chain: 'base-sepolia' });
      const links = await client.getTransformationLinks(SAMPLE_HASH);

      expect(links).toEqual([]);
    });
  });

  describe('getTransformationParents', () => {
    it('should return parent hashes', async () => {
      const parentHash: Hex = `0x${'ee'.repeat(32)}`;
      mockReadContract.mockResolvedValueOnce([parentHash]);

      const client = new ChainClient({ chain: 'base-sepolia' });
      const parents = await client.getTransformationParents(SAMPLE_HASH);

      expect(parents).toEqual([parentHash]);
    });

    it('should return empty array when no parents', async () => {
      mockReadContract.mockResolvedValueOnce([]);

      const client = new ChainClient({ chain: 'base-sepolia' });
      const parents = await client.getTransformationParents(SAMPLE_HASH);

      expect(parents).toEqual([]);
    });
  });

  describe('getChildHashes', () => {
    it('should return child hashes', async () => {
      const childHash: Hex = `0x${'dd'.repeat(32)}`;
      mockReadContract.mockResolvedValueOnce([childHash]);

      const client = new ChainClient({ chain: 'base-sepolia' });
      const children = await client.getChildHashes(SAMPLE_HASH);

      expect(children).toEqual([childHash]);
    });
  });

  describe('getProvenanceChain', () => {
    it('should traverse the provenance DAG', async () => {
      const hashA = SAMPLE_HASH_0X;
      const hashB: Hex = `0x${'bb'.repeat(32)}`;
      const hashC: Hex = `0x${'cc'.repeat(32)}`;

      // getDataRecord for hashA
      mockReadContract
        .mockResolvedValueOnce({
          dataHash: hashA,
          owner: MOCK_ADDRESS,
          timestamp: BigInt(1000),
          dataType: 'dataset',
          transformationLinks: [{ newDataHash: hashB, description: 'step1' }],
          accessors: [],
          status: 0,
        })
        // getChildHashes for hashA → [hashB]
        .mockResolvedValueOnce([hashB])
        // getTransformationParents for hashA → []
        .mockResolvedValueOnce([])
        // getDataRecord for hashB
        .mockResolvedValueOnce({
          dataHash: hashB,
          owner: MOCK_ADDRESS,
          timestamp: BigInt(2000),
          dataType: 'filtered',
          transformationLinks: [{ newDataHash: hashC, description: 'step2' }],
          accessors: [],
          status: 0,
        })
        // getChildHashes for hashB → [hashC]
        .mockResolvedValueOnce([hashC])
        // getTransformationParents for hashB → [hashA]
        .mockResolvedValueOnce([hashA])
        // getDataRecord for hashC
        .mockResolvedValueOnce({
          dataHash: hashC,
          owner: MOCK_ADDRESS,
          timestamp: BigInt(3000),
          dataType: 'final',
          transformationLinks: [],
          accessors: [],
          status: 0,
        })
        // getChildHashes for hashC → []
        .mockResolvedValueOnce([])
        // getTransformationParents for hashC → [hashB]
        .mockResolvedValueOnce([hashB]);

      const client = new ChainClient({ chain: 'base-sepolia' });
      const chain = await client.getProvenanceChain(SAMPLE_HASH);

      expect(chain).toHaveLength(3);
      expect(chain[0]!.dataHash).toBe(hashA);
      expect(chain[1]!.dataHash).toBe(hashB);
      expect(chain[2]!.dataHash).toBe(hashC);
    });

    it('should respect maxDepth', async () => {
      // With maxDepth=0, should only return the starting node (depth clamped to 1)
      mockReadContract
        .mockResolvedValueOnce({
          dataHash: SAMPLE_HASH_0X,
          owner: MOCK_ADDRESS,
          timestamp: BigInt(1000),
          dataType: 'dataset',
          transformationLinks: [],
          accessors: [],
          status: 0,
        })
        // getChildHashes
        .mockResolvedValueOnce([])
        // getTransformationParents
        .mockResolvedValueOnce([]);

      const client = new ChainClient({ chain: 'base-sepolia' });
      const chain = await client.getProvenanceChain(SAMPLE_HASH, 1);

      expect(chain).toHaveLength(1);
    });

    it('should handle cycles gracefully', async () => {
      const hashA = SAMPLE_HASH_0X;
      const hashB: Hex = `0x${'bb'.repeat(32)}`;

      mockReadContract
        // getDataRecord for hashA
        .mockResolvedValueOnce({
          dataHash: hashA,
          owner: MOCK_ADDRESS,
          timestamp: BigInt(1000),
          dataType: 'dataset',
          transformationLinks: [],
          accessors: [],
          status: 0,
        })
        // getChildHashes for hashA → [hashB]
        .mockResolvedValueOnce([hashB])
        // getTransformationParents for hashA → []
        .mockResolvedValueOnce([])
        // getDataRecord for hashB
        .mockResolvedValueOnce({
          dataHash: hashB,
          owner: MOCK_ADDRESS,
          timestamp: BigInt(2000),
          dataType: 'filtered',
          transformationLinks: [],
          accessors: [],
          status: 0,
        })
        // getChildHashes for hashB → [hashA] (cycle!)
        .mockResolvedValueOnce([hashA])
        // getTransformationParents for hashB → [hashA]
        .mockResolvedValueOnce([hashA]);

      const client = new ChainClient({ chain: 'base-sepolia' });
      const chain = await client.getProvenanceChain(SAMPLE_HASH);

      // Should visit both A and B, but not revisit A
      expect(chain).toHaveLength(2);
    });

    it('should skip unregistered nodes during traversal', async () => {
      const hashA = SAMPLE_HASH_0X;
      const hashB: Hex = `0x${'bb'.repeat(32)}`;
      const hashC: Hex = `0x${'cc'.repeat(32)}`;

      mockReadContract
        // getDataRecord for hashA — exists
        .mockResolvedValueOnce({
          dataHash: hashA,
          owner: MOCK_ADDRESS,
          timestamp: BigInt(1000),
          dataType: 'dataset',
          transformationLinks: [],
          accessors: [],
          status: 0,
        })
        // getChildHashes for hashA → [hashB, hashC]
        .mockResolvedValueOnce([hashB, hashC])
        // getTransformationParents for hashA → []
        .mockResolvedValueOnce([])
        // getDataRecord for hashB — NOT registered (zero hash)
        .mockResolvedValueOnce({
          dataHash: ZERO_HASH,
          owner: '0x' + '00'.repeat(20),
          timestamp: BigInt(0),
          dataType: '',
          transformationLinks: [],
          accessors: [],
          status: 0,
        })
        // getDataRecord for hashC — exists
        .mockResolvedValueOnce({
          dataHash: hashC,
          owner: MOCK_ADDRESS,
          timestamp: BigInt(3000),
          dataType: 'final',
          transformationLinks: [],
          accessors: [],
          status: 0,
        })
        // getChildHashes for hashC → []
        .mockResolvedValueOnce([])
        // getTransformationParents for hashC → [hashA]
        .mockResolvedValueOnce([hashA]);

      const client = new ChainClient({ chain: 'base-sepolia' });
      const chain = await client.getProvenanceChain(SAMPLE_HASH);

      // Should have A and C, skipping unregistered B
      expect(chain).toHaveLength(2);
      expect(chain[0]!.dataHash).toBe(hashA);
      expect(chain[1]!.dataHash).toBe(hashC);
    });
  });

  describe('getUserDataRecordsCount', () => {
    it('should return count', async () => {
      mockReadContract.mockResolvedValueOnce(BigInt(5));

      const client = new ChainClient({ chain: 'base-sepolia' });
      const count = await client.getUserDataRecordsCount(MOCK_ADDRESS);

      expect(count).toBe(5);
    });

    it('should throw on invalid address', async () => {
      const client = new ChainClient({ chain: 'base-sepolia' });
      await expect(client.getUserDataRecordsCount('bad')).rejects.toThrow('Invalid Ethereum address');
    });
  });

  describe('getUserDataRecordsPaginated', () => {
    it('should return paginated hashes', async () => {
      mockReadContract.mockResolvedValueOnce([SAMPLE_HASH_0X]);

      const client = new ChainClient({ chain: 'base-sepolia' });
      const hashes = await client.getUserDataRecordsPaginated(MOCK_ADDRESS, 0, 10);

      expect(hashes).toEqual([SAMPLE_HASH_0X]);
    });

    it('should throw on invalid address', async () => {
      const client = new ChainClient({ chain: 'base-sepolia' });
      await expect(client.getUserDataRecordsPaginated('bad', 0, 10)).rejects.toThrow('Invalid Ethereum address');
    });
  });

  describe('supportsTransformationLinks', () => {
    it('should return true when contract supports v2', async () => {
      const client = new ChainClient({ chain: 'base-sepolia' });
      mockReadContract.mockResolvedValueOnce([]);

      const result = await client.supportsTransformationLinks();
      expect(result).toBe(true);
    });

    it('should return false when contract reverts (v1)', async () => {
      const client = new ChainClient({ chain: 'base-sepolia' });
      mockReadContract.mockRejectedValueOnce(new Error('execution reverted'));

      const result = await client.supportsTransformationLinks();
      expect(result).toBe(false);
    });
  });

  describe('healthCheck', () => {
    it('should return true when connected', async () => {
      const client = new ChainClient({ chain: 'base-sepolia' });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
      (client as any).publicClient.getChainId = vi.fn().mockResolvedValue(84532);

      const result = await client.healthCheck();
      expect(result).toBe(true);
    });

    it('should return false when disconnected', async () => {
      const client = new ChainClient({ chain: 'base-sepolia' });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
      (client as any).publicClient.getChainId = vi.fn().mockRejectedValue(new Error('connection failed'));

      const result = await client.healthCheck();
      expect(result).toBe(false);
    });
  });

  describe('getBalance', () => {
    it('should throw SignerRequiredError without signer', async () => {
      const client = new ChainClient({ chain: 'base-sepolia' });
      await expect(client.getBalance()).rejects.toThrow(SignerRequiredError);
    });

    it('should return balance info', async () => {
      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
      (client as any).publicClient.getBalance = vi.fn().mockResolvedValue(BigInt('1000000000000000000'));

      const balance = await client.getBalance();

      expect(balance.address).toBe(MOCK_ADDRESS);
      expect(balance.balanceWei).toBe(BigInt('1000000000000000000'));
      expect(balance.balanceEth).toBe('1');
      expect(balance.chain).toBe('base-sepolia');
    });
  });

  // ─── v2 Write Operations ─────────────────────────────────────

  describe('mergeTransform', () => {
    it('should throw SignerRequiredError without signer', async () => {
      const client = new ChainClient({ chain: 'base-sepolia' });
      await expect(
        client.mergeTransform([SAMPLE_HASH, 'cd'.repeat(32)], 'ee'.repeat(32), 'merged')
      ).rejects.toThrow(SignerRequiredError);
    });

    it('should throw on fewer than 2 source hashes', async () => {
      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      await expect(
        client.mergeTransform([SAMPLE_HASH], 'ee'.repeat(32), 'merged')
      ).rejects.toThrow(ChainValidationError);
      await expect(
        client.mergeTransform([SAMPLE_HASH], 'ee'.repeat(32), 'merged')
      ).rejects.toThrow('at least 2');
    });

    it('should throw on more than 50 source hashes', async () => {
      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      const sources = Array.from({ length: 51 }, (_, i) =>
        `${i.toString(16).padStart(2, '0')}`.repeat(32)
      );
      await expect(
        client.mergeTransform(sources, 'ee'.repeat(32), 'merged')
      ).rejects.toThrow(ChainValidationError);
      await expect(
        client.mergeTransform(sources, 'ee'.repeat(32), 'merged')
      ).rejects.toThrow('exceeds maximum of 50');
    });

    it('should merge transform and return result', async () => {
      // getTransformationParents check (no duplicates)
      mockReadContract.mockResolvedValueOnce([]);
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        status: 'success',
        blockNumber: BigInt(200),
        gasUsed: BigInt(100000),
      });

      const hashB = 'cd'.repeat(32);
      const hashMerged = 'ee'.repeat(32);
      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      const result = await client.mergeTransform(
        [SAMPLE_HASH, hashB],
        hashMerged,
        'combined datasets',
        'merged-dataset',
      );

      expect(result.txHash).toBe(MOCK_TX_HASH);
      expect(result.sourceHashes).toEqual([SAMPLE_HASH_0X, `0x${hashB}`]);
      expect(result.newHash).toBe(`0x${hashMerged}`);
      expect(result.description).toBe('combined datasets');
      expect(result.newDataType).toBe('merged-dataset');
    });

    it('should default newDataType to "merged"', async () => {
      mockReadContract.mockResolvedValueOnce([]); // getTransformationParents check
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        status: 'success',
        blockNumber: BigInt(201),
        gasUsed: BigInt(100000),
      });

      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      const result = await client.mergeTransform(
        [SAMPLE_HASH, 'cd'.repeat(32)],
        'ee'.repeat(32),
        'merged two files',
      );

      expect(result.newDataType).toBe('merged');
    });

    it('should throw on duplicate merge', async () => {
      // getTransformationParents returns existing parents
      mockReadContract.mockResolvedValueOnce([SAMPLE_HASH_0X, `0x${'cd'.repeat(32)}`]);

      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });

      await expect(
        client.mergeTransform([SAMPLE_HASH, 'cd'.repeat(32)], 'ee'.repeat(32), 'merged')
      ).rejects.toThrow('already has transformation parents');
    });

    it('should proceed if duplicate check fails', async () => {
      // getTransformationParents fails — should proceed with transaction
      mockReadContract.mockRejectedValueOnce(new Error('RPC timeout'));
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        status: 'success',
        blockNumber: BigInt(202),
        gasUsed: BigInt(100000),
      });

      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      const result = await client.mergeTransform(
        [SAMPLE_HASH, 'cd'.repeat(32)],
        'ee'.repeat(32),
        'merged',
      );

      expect(result.txHash).toBe(MOCK_TX_HASH);
    });
  });
});
