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

  describe('getExplorerUrl', () => {
    it('should return correct explorer URL', () => {
      const client = new ChainClient({ chain: 'base-sepolia' });
      const url = client.getExplorerUrl('0xabc');
      expect(url).toBe('https://sepolia.basescan.org/tx/0xabc');
    });
  });
});
