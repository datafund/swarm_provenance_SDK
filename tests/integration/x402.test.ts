import { describe, it, expect, beforeAll } from 'vitest';
import { createWalletClient, http, publicActions } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { ProvenanceClient } from '../../src/client.js';
import type { PaymentWallet } from '../../src/types.js';

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

const GATEWAY_URL = process.env['PROVENANCE_GATEWAY_URL'] ?? 'https://provenance-gateway.datafund.io';
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
    payment: { wallet: wallet as unknown as PaymentWallet },
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
    it('should upload and download content via x402 payment', async () => {
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

  describe('x402 bypasses rate limits', () => {
    it('should handle multiple sequential requests without 429', async () => {
      if (!PRIVATE_KEY) return;

      const client = createX402Client();

      // Fire 4 requests in sequence — free tier limit is 3/min
      const results = [];
      for (let i = 0; i < 4; i++) {
        const healthy = await client.health();
        results.push(healthy);
      }

      // All should succeed (no PaymentRateLimitError)
      expect(results).toEqual([true, true, true, true]);
    });
  });
});
