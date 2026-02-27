import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChainClient } from '../../../src/chain/client.js';
import {
  ChainConfigurationError,
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
        transformations: ['transformed-v2'],
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
      expect(record.transformations).toEqual(['transformed-v2']);
    });

    it('should throw DataNotRegisteredError for zero hash', async () => {
      mockReadContract.mockResolvedValueOnce({
        dataHash: ZERO_HASH,
        owner: '0x' + '00'.repeat(20),
        timestamp: BigInt(0),
        dataType: '',
        transformations: [],
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
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        status: 'reverted',
        blockNumber: BigInt(12345),
        gasUsed: BigInt(21000),
      });

      const signer = createMockSigner();
      const client = new ChainClient({ chain: 'base-sepolia', signer });
      await expect(client.anchor(SAMPLE_HASH, 'dataset')).rejects.toThrow('reverted');
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

    it('should anchor for another owner', async () => {
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

  describe('getExplorerUrl', () => {
    it('should return correct explorer URL', () => {
      const client = new ChainClient({ chain: 'base-sepolia' });
      const url = client.getExplorerUrl('0xabc');
      expect(url).toBe('https://sepolia.basescan.org/tx/0xabc');
    });
  });
});
