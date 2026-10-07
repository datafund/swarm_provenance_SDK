import { describe, it, expect, beforeAll } from 'vitest';
import { createWalletClient, http, publicActions } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { ProvenanceClient } from '../../src/client.js';
import { GATEWAY_URL, WRITES_ALLOWED } from './env.js';

/**
 * x402 payment mode integration tests against the real gateway.
 *
 * These tests require:
 * - CHAIN_PRIVATE_KEY env var (wallet with USDC on Base Sepolia)
 * - Network access to the gateway
 * - The gateway to be running with x402 support enabled
 *
 * Each upload costs a small amount of USDC — tests are kept minimal.
 */


const PRIVATE_KEY = process.env['CHAIN_PRIVATE_KEY'];

function createX402Client(): ProvenanceClient {
  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
  const wallet = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(),
  }).extend(publicActions);

  return new ProvenanceClient({
    gatewayUrl: GATEWAY_URL,
    // maxAmount: Base Sepolia test USDC; the policy refuses anything above it
    payment: { wallet, maxAmount: '1' },
  });
}

describe('x402 Payment Integration', () => {
  beforeAll(() => {
    if (!PRIVATE_KEY) {
      console.log('Skipping x402 tests - set CHAIN_PRIVATE_KEY env var');
    }
  });

  describe('x402 client setup', () => {
    it('should create x402 client without error', () => {
      if (!PRIVATE_KEY) return;

      const client = createX402Client();
      expect(client).toBeInstanceOf(ProvenanceClient);
    });
  });

  describe('x402 gateway access', () => {
    it('should reach gateway health via x402 client', async () => {
      if (!PRIVATE_KEY) return;

      const client = createX402Client();
      const healthy = await client.health();
      expect(healthy).toBe(true);
    });

    it('should get pool status via x402 client', async () => {
      if (!PRIVATE_KEY) return;

      const client = createX402Client();
      const status = await client.poolStatus();
      expect(typeof status.enabled).toBe('boolean');
    });
  });

  describe('x402 upload and download', () => {
    it.skipIf(!WRITES_ALLOWED)('should upload and download content via x402 payment', async () => {
      if (!PRIVATE_KEY) return;

      const client = createX402Client();
      const content = `x402 test content at ${new Date().toISOString()}`;

      const uploadResult = await client.upload(content, {
        poolSize: 'small',
        standard: 'x402-integration-test',
      });

      expect(uploadResult.reference).toMatch(/^[a-f0-9]{64}$/);
      expect(uploadResult.metadata.stamp_id).toBeDefined();

      // Download and verify round-trip
      const downloadResult = await client.download(uploadResult.reference);
      const downloaded = new TextDecoder().decode(downloadResult.file);
      expect(downloaded).toBe(content);
    });
  });

  // Reads are deliberately not paid (#106): GETs never go through the paying
  // fetch, so x402 mode no longer pays its way past read rate limits.
});
