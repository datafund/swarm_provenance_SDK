import { describe, it, expect, beforeAll } from 'vitest';
import { ChainClient } from '../../src/chain/client.js';
import { fromPrivateKey } from '../../src/chain/signer.js';
import { DataStatus } from '../../src/chain/types.js';
import { DataNotRegisteredError, SignerRequiredError } from '../../src/chain/errors.js';
import type { ChainSigner, Hex } from '../../src/chain/types.js';

/**
 * Integration tests against a DataProvenance contract.
 * Run with: pnpm test:integration
 *
 * Environment variables:
 *   CHAIN_RPC_URL      - RPC endpoint (default: https://sepolia.base.org)
 *   CHAIN_CONTRACT     - Contract address (default: Base Sepolia preset)
 *   CHAIN_PRIVATE_KEY  - Private key for write tests (optional)
 *   CHAIN_TEST_HASH    - Known registered hash to verify (optional)
 *
 * For local Hardhat:
 *   CHAIN_RPC_URL=http://127.0.0.1:8545
 *   CHAIN_CONTRACT=0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9
 *   CHAIN_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
 */

const RPC_URL = process.env['CHAIN_RPC_URL'] ?? 'https://sepolia.base.org';
const CONTRACT_ADDRESS = process.env['CHAIN_CONTRACT'] as `0x${string}` | undefined;
const PRIVATE_KEY = process.env['CHAIN_PRIVATE_KEY'] as Hex | undefined;
const KNOWN_HASH = process.env['CHAIN_TEST_HASH'];

// Build chain config: use custom preset if contract is overridden, otherwise base-sepolia
function getChainConfig(signer?: ChainSigner) {
  const base: import('../../src/chain/types.js').ChainClientConfig = CONTRACT_ADDRESS
    ? {
        chain: {
          chainId: 31337,
          name: 'local',
          rpcUrl: RPC_URL,
          contractAddress: CONTRACT_ADDRESS,
          explorerUrl: 'http://localhost',
        },
        rpcUrl: RPC_URL,
      }
    : { chain: 'base-sepolia', rpcUrl: RPC_URL };

  if (signer) {
    base.signer = signer;
  }
  return base;
}

describe('Chain Integration', () => {
  let readClient: ChainClient;
  let writeClient: ChainClient | undefined;
  let signer: ChainSigner | undefined;

  beforeAll(async () => {
    readClient = new ChainClient(getChainConfig());

    if (PRIVATE_KEY) {
      signer = await fromPrivateKey(PRIVATE_KEY, RPC_URL);
      writeClient = new ChainClient(getChainConfig(signer));
    }
  });

  // ─── Read Operations (always run) ────────────────────────────

  describe('read operations', () => {
    it('should return false for unregistered hash', async () => {
      // A hash that is almost certainly not registered
      const fakeHash = '0000000000000000000000000000000000000000000000000000000000000001';
      const exists = await readClient.verifyOnChain(fakeHash);
      expect(exists).toBe(false);
    });

    it('should throw DataNotRegisteredError for unregistered getDataRecord', async () => {
      const fakeHash = '0000000000000000000000000000000000000000000000000000000000000001';
      await expect(readClient.getDataRecord(fakeHash)).rejects.toThrow(DataNotRegisteredError);
    });

    it('should throw SignerRequiredError for anchor without signer', async () => {
      const fakeHash = 'ab'.repeat(32);
      await expect(readClient.anchor(fakeHash, 'test')).rejects.toThrow(SignerRequiredError);
    });

    it('should verify a known hash if provided', async () => {
      if (!KNOWN_HASH) {
        console.log('Skipping known hash test - set CHAIN_TEST_HASH env var');
        return;
      }

      const exists = await readClient.verifyOnChain(KNOWN_HASH);
      expect(exists).toBe(true);

      const record = await readClient.getDataRecord(KNOWN_HASH);
      expect(record.dataHash).toBeDefined();
      expect(record.owner).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(record.timestamp).toBeGreaterThan(0);
      expect(record.dataType).toBeDefined();
      expect(record.status).toBe(DataStatus.ACTIVE);
    });

    it('should return explorer URL', () => {
      const url = readClient.getExplorerUrl('0xabc123');
      expect(url).toContain('/tx/0xabc123');
    });
  });

  // ─── Write Operations (require CHAIN_PRIVATE_KEY) ────────────

  describe('write operations', () => {
    it('should anchor and verify round-trip', async () => {
      if (!writeClient || !signer) {
        console.log('Skipping write test - set CHAIN_PRIVATE_KEY env var');
        return;
      }

      // Generate a unique hash for this test run
      const timestamp = Date.now().toString(16).padStart(16, '0');
      const uniqueHash = `${timestamp}${'0'.repeat(48)}`;

      const result = await writeClient.anchor(uniqueHash, 'integration-test');

      expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(result.blockNumber).toBeGreaterThan(0);
      expect(result.gasUsed).toBeGreaterThan(0);
      expect(result.explorerUrl).toContain(result.txHash);
      expect(result.dataType).toBe('integration-test');

      // Verify it's now on-chain
      const exists = await readClient.verifyOnChain(uniqueHash);
      expect(exists).toBe(true);

      // Get the full record
      const record = await readClient.getDataRecord(uniqueHash);
      expect(record.dataType).toBe('integration-test');
      expect(record.owner).toBe(await signer.getAddress());
      expect(record.status).toBe(DataStatus.ACTIVE);
    });

    it('should record access', async () => {
      if (!writeClient || !signer) {
        console.log('Skipping write test - set CHAIN_PRIVATE_KEY env var');
        return;
      }

      // Anchor a hash first
      const timestamp = Date.now().toString(16).padStart(16, '0');
      const uniqueHash = `${timestamp}${'1'.repeat(48)}`;
      await writeClient.anchor(uniqueHash, 'access-test');

      // Record access
      const result = await writeClient.recordAccess(uniqueHash);
      expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(result.accessor).toBe(await signer.getAddress());

      // Verify access was recorded
      const accessed = await readClient.hasAddressAccessed(
        uniqueHash,
        await signer.getAddress(),
      );
      expect(accessed).toBe(true);
    });
  });
});
