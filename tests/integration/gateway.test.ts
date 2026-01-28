import { describe, it, expect, beforeAll } from 'vitest';
import { ProvenanceClient } from '../../src/client.js';

/**
 * Integration tests against the real gateway
 * Run with: pnpm test:integration
 *
 * These tests require:
 * - Network access to the gateway
 * - The gateway to be running and healthy
 * - Stamps to be available in the pool
 */

const GATEWAY_URL = process.env['PROVENANCE_GATEWAY_URL'] ?? 'https://provenance-gateway.datafund.io';

describe('Gateway Integration', () => {
  let client: ProvenanceClient;

  beforeAll(() => {
    client = new ProvenanceClient({ gatewayUrl: GATEWAY_URL });
  });

  describe('health check', () => {
    it('should report gateway as healthy', async () => {
      const healthy = await client.health();
      expect(healthy).toBe(true);
    });
  });

  describe('notary info', () => {
    it('should return notary status', async () => {
      const info = await client.notaryInfo();

      expect(typeof info.enabled).toBe('boolean');
      expect(typeof info.available).toBe('boolean');

      if (info.available) {
        expect(info.address).toBeDefined();
        expect(info.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      }
    });
  });

  describe('pool status', () => {
    it('should return pool status', async () => {
      const status = await client.poolStatus();

      expect(typeof status.enabled).toBe('boolean');

      if (status.enabled) {
        expect(typeof status.available).toBe('object');
        expect(typeof status.reserve).toBe('object');
      }
    });
  });

  describe('upload and download round-trip', () => {
    it('should upload and download text content', async () => {
      const originalContent = `Test content created at ${new Date().toISOString()}`;

      // Upload
      const uploadResult = await client.upload(originalContent, {
        poolSize: 'small',
        standard: 'integration-test-v1',
      });

      expect(uploadResult.reference).toMatch(/^[a-f0-9]{64}$/);
      expect(uploadResult.metadata.stamp_id).toBeDefined();
      expect(uploadResult.metadata.provenance_standard).toBe('integration-test-v1');

      // Download
      const downloadResult = await client.download(uploadResult.reference);

      const downloadedContent = new TextDecoder().decode(downloadResult.file);
      expect(downloadedContent).toBe(originalContent);
    });

    it('should upload and download binary content', async () => {
      const originalContent = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);

      // Upload
      const uploadResult = await client.upload(originalContent, {
        poolSize: 'small',
      });

      expect(uploadResult.reference).toMatch(/^[a-f0-9]{64}$/);

      // Download
      const downloadResult = await client.download(uploadResult.reference);

      expect(Array.from(downloadResult.file)).toEqual(Array.from(originalContent));
    });

    it('should upload with notary signing (if available)', async () => {
      const notaryInfo = await client.notaryInfo();

      if (!notaryInfo.available) {
        console.log('Skipping notary test - notary not available');
        return;
      }

      const content = 'Notary signed content';

      const uploadResult = await client.upload(content, {
        poolSize: 'small',
        sign: 'notary',
      });

      expect(uploadResult.signedDocument).toBeDefined();
      expect(uploadResult.signedDocument?.signatures.length).toBeGreaterThan(0);

      // Download and verify
      const downloadResult = await client.download(uploadResult.reference);

      expect(downloadResult.verified).toBe(true);
      expect(downloadResult.signatures?.length).toBeGreaterThan(0);
    });
  });
});
