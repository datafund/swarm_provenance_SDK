import { describe, it, expect, beforeAll } from 'vitest';
import { ChainClient } from '../../src/chain/client.js';
import { fromPrivateKey } from '../../src/chain/signer.js';
import { DataStatus } from '../../src/chain/types.js';
import {
  DataAlreadyRegisteredError,
  DataNotRegisteredError,
  SignerRequiredError,
} from '../../src/chain/errors.js';
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
 *   CHAIN_CONTRACT=0xD42912755319665397FF090fBB63B1a31aE87Cee
 *   CHAIN_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry an assertion with delays to handle RPC read lag on public testnets */
async function waitFor<T>(fn: () => Promise<T>, retries = 5, delayMs = 2_000): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch {
      if (i === retries - 1) throw new Error(`waitFor failed after ${retries} retries`);
      await sleep(delayMs);
    }
  }
  throw new Error('unreachable');
}

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

      // Verify it's now on-chain (retry for RPC read lag on public testnets)
      await waitFor(async () => {
        const exists = await readClient.verifyOnChain(uniqueHash);
        expect(exists).toBe(true);
      });

      // Get the full record
      const record = await readClient.getDataRecord(uniqueHash);
      expect(record.dataType).toBe('integration-test');
      expect(record.owner).toBe(await signer.getAddress());
      expect(record.status).toBe(DataStatus.ACTIVE);
    });

    it('should throw DataAlreadyRegisteredError when anchoring duplicate hash', async () => {
      if (!writeClient || !signer) {
        console.log('Skipping write test - set CHAIN_PRIVATE_KEY env var');
        return;
      }

      // Anchor a unique hash first
      const timestamp = Date.now().toString(16).padStart(16, '0');
      const uniqueHash = `${timestamp}${'d'.repeat(48)}`;
      await writeClient.anchor(uniqueHash, 'duplicate-test');

      // Attempt to anchor the same hash again — should throw DataAlreadyRegisteredError
      // via pre-check (if RPC has caught up) or via contract revert fallback
      await waitFor(async () => {
        await expect(writeClient!.anchor(uniqueHash, 'duplicate-test')).rejects.toThrow(
          DataAlreadyRegisteredError,
        );
      });

      // Verify error has context fields
      try {
        await writeClient.anchor(uniqueHash, 'duplicate-test');
      } catch (err) {
        expect(err).toBeInstanceOf(DataAlreadyRegisteredError);
        const e = err as DataAlreadyRegisteredError;
        expect(e.owner).toBe(await signer.getAddress());
        expect(e.dataType).toBe('duplicate-test');
        expect(e.timestamp).toBeGreaterThan(0);
      }
    });

    it('should fail with insufficient gas limit', async () => {
      if (!writeClient || !signer) {
        console.log('Skipping write test - set CHAIN_PRIVATE_KEY env var');
        return;
      }

      // Create a client with an absurdly low gas limit
      const lowGasClient = new ChainClient({
        ...getChainConfig(signer),
        signer,
        gasLimit: 21_000, // bare minimum for ETH transfer, way too low for contract call
      });

      const timestamp = Date.now().toString(16).padStart(16, '0');
      const uniqueHash = `${timestamp}${'e'.repeat(48)}`;

      // Should fail — either tx send fails or tx reverts due to out of gas
      await expect(lowGasClient.anchor(uniqueHash, 'gas-test')).rejects.toThrow();
    });

    it('should succeed with explicit gas limit', async () => {
      if (!writeClient || !signer) {
        console.log('Skipping write test - set CHAIN_PRIVATE_KEY env var');
        return;
      }

      // Create a client with a reasonable explicit gas limit
      const gasClient = new ChainClient({
        ...getChainConfig(signer),
        signer,
        gasLimit: 500_000,
      });

      const timestamp = Date.now().toString(16).padStart(16, '0');
      const uniqueHash = `${timestamp}${'f'.repeat(48)}`;

      const result = await gasClient.anchor(uniqueHash, 'gas-limit-test');
      expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(result.gasUsed).toBeGreaterThan(0);
      expect(result.gasUsed).toBeLessThan(500_000n);
    });

    it('should merge transform and verify', async () => {
      if (!writeClient || !signer) {
        console.log('Skipping write test - set CHAIN_PRIVATE_KEY env var');
        return;
      }

      // Anchor two source hashes
      const ts = Date.now().toString(16).padStart(16, '0');
      const sourceA = `${ts}${'a'.repeat(48)}`;
      const sourceB = `${ts}${'b'.repeat(48)}`;
      const mergedHash = `${ts}${'c'.repeat(48)}`;

      await writeClient.anchor(sourceA, 'merge-source-a');
      await writeClient.anchor(sourceB, 'merge-source-b');

      // Wait for sources to be confirmed on-chain before merging
      // (contract validates source hashes are registered)
      await waitFor(async () => {
        const existsA = await readClient.verifyOnChain(sourceA);
        const existsB = await readClient.verifyOnChain(sourceB);
        expect(existsA).toBe(true);
        expect(existsB).toBe(true);
      });

      // Merge transform: sourceA + sourceB → mergedHash
      const result = await writeClient.mergeTransform(
        [sourceA, sourceB],
        mergedHash,
        'combined two sources',
        'merged-dataset',
      );

      expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(result.sourceHashes).toHaveLength(2);
      expect(result.newHash).toMatch(/^0x/);
      expect(result.description).toBe('combined two sources');
      expect(result.newDataType).toBe('merged-dataset');

      // Verify merged hash is registered on-chain
      await waitFor(async () => {
        const exists = await readClient.verifyOnChain(mergedHash);
        expect(exists).toBe(true);
      });

      // Verify merged record metadata
      const record = await readClient.getDataRecord(mergedHash);
      expect(record.dataType).toBe('merged-dataset');
      expect(record.owner).toBe(await signer.getAddress());

      // Verify transformation parents (merged hash should have sourceA and sourceB as parents)
      await waitFor(async () => {
        const parents = await readClient.getTransformationParents(mergedHash);
        expect(parents.length).toBeGreaterThanOrEqual(2);
      });

      // Verify child hashes (sourceA should have mergedHash as child)
      await waitFor(async () => {
        const children = await readClient.getChildHashes(sourceA);
        const childrenLower = children.map((c) => c.toLowerCase());
        expect(childrenLower).toContain(`0x${mergedHash}`.toLowerCase());
      });

      // Verify transformation links on sourceA
      const links = await readClient.getTransformationLinks(sourceA);
      const linkHashes = links.map((l) => l.newDataHash.toLowerCase());
      expect(linkHashes).toContain(`0x${mergedHash}`.toLowerCase());
    });

    it('should traverse provenance chain', async () => {
      if (!writeClient || !signer) {
        console.log('Skipping write test - set CHAIN_PRIVATE_KEY env var');
        return;
      }

      // Create a small chain: A → transform → B
      const ts = Date.now().toString(16).padStart(16, '0');
      const hashA = `${ts}${'2'.repeat(48)}`;
      const hashB = `${ts}${'3'.repeat(48)}`;

      await writeClient.anchor(hashA, 'chain-source');

      // Wait for A to be confirmed before transforming
      await waitFor(async () => {
        const exists = await readClient.verifyOnChain(hashA);
        expect(exists).toBe(true);
      });

      const txResult = await writeClient.recordTransformation(hashA, hashB, 'filtered PII');
      expect(txResult.txHash).toMatch(/^0x/);

      // Wait for B to be on-chain
      await waitFor(async () => {
        const existsB = await readClient.verifyOnChain(hashB);
        expect(existsB).toBe(true);
      });

      // Verify transformation links on source (A should link to B)
      await waitFor(async () => {
        const links = await readClient.getTransformationLinks(hashA);
        const linkHashes = links.map((l) => l.newDataHash.toLowerCase());
        expect(linkHashes).toContain(`0x${hashB}`.toLowerCase());
      });

      // Verify parents on target (B should have A as parent)
      await waitFor(async () => {
        const parents = await readClient.getTransformationParents(hashB);
        const parentLower = parents.map((p) => p.toLowerCase());
        expect(parentLower).toContain(`0x${hashA}`.toLowerCase());
      });

      // Traverse from A — should find A and B
      const chain = await readClient.getProvenanceChain(hashA, 5);
      expect(chain.length).toBeGreaterThanOrEqual(2);
      const chainHashes = chain.map((r) => r.dataHash.toLowerCase());
      expect(chainHashes).toContain(`0x${hashA}`.toLowerCase());
      expect(chainHashes).toContain(`0x${hashB}`.toLowerCase());

      // Traverse from B — should also find both A and B
      const chainFromB = await readClient.getProvenanceChain(hashB, 5);
      expect(chainFromB.length).toBeGreaterThanOrEqual(2);
      const chainFromBHashes = chainFromB.map((r) => r.dataHash.toLowerCase());
      expect(chainFromBHashes).toContain(`0x${hashA}`.toLowerCase());
      expect(chainFromBHashes).toContain(`0x${hashB}`.toLowerCase());
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

      // Verify access was recorded (retry for RPC read lag)
      await waitFor(async () => {
        const accessed = await readClient.hasAddressAccessed(
          uniqueHash,
          await signer!.getAddress(),
        );
        expect(accessed).toBe(true);
      });
    });
  });

  // ─── Convenience Methods ──────────────────────────────────────

  describe('convenience methods', () => {
    it('should pass health check', async () => {
      const healthy = await readClient.healthCheck();
      expect(healthy).toBe(true);
    });

    it('should get balance with signer', async () => {
      if (!writeClient || !signer) {
        console.log('Skipping write test - set CHAIN_PRIVATE_KEY env var');
        return;
      }

      const balance = await writeClient.getBalance();
      expect(balance.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(balance.balanceWei).toBeGreaterThanOrEqual(0n);
      expect(balance.balanceEth).toBeDefined();
      expect(balance.chain).toBeDefined();
      expect(balance.contractAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    it('should get user data records count', async () => {
      if (!signer) {
        console.log('Skipping - set CHAIN_PRIVATE_KEY env var');
        return;
      }

      const address = await signer.getAddress();
      const count = await readClient.getUserDataRecordsCount(address);
      expect(count).toBeGreaterThanOrEqual(0);
    });

    it('should get paginated user data records', async () => {
      if (!signer) {
        console.log('Skipping - set CHAIN_PRIVATE_KEY env var');
        return;
      }

      const address = await signer.getAddress();
      const count = await readClient.getUserDataRecordsCount(address);

      if (count > 0) {
        const hashes = await readClient.getUserDataRecordsPaginated(address, 0, 10);
        expect(hashes.length).toBeGreaterThan(0);
        expect(hashes.length).toBeLessThanOrEqual(10);
        // Each hash should be a bytes32
        for (const h of hashes) {
          expect(h).toMatch(/^0x[a-fA-F0-9]{64}$/);
        }
      }
    });
  });
});
