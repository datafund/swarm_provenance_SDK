import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProvenanceClient } from '../../src/client.js';
import { GatewayConnectionError, StampError, NotaryError } from '../../src/errors.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('ProvenanceClient', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should use default gateway URL', () => {
      const client = new ProvenanceClient();
      // We can't directly access private fields, but we can test behavior
      expect(client).toBeInstanceOf(ProvenanceClient);
    });

    it('should accept custom gateway URL', () => {
      const client = new ProvenanceClient({
        gatewayUrl: 'https://custom.gateway.io',
      });
      expect(client).toBeInstanceOf(ProvenanceClient);
    });

    it('should strip trailing slash from gateway URL', () => {
      const client = new ProvenanceClient({
        gatewayUrl: 'https://custom.gateway.io/',
      });
      expect(client).toBeInstanceOf(ProvenanceClient);
    });
  });

  describe('health', () => {
    it('should return true when gateway is healthy', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'ok' }),
      });

      const client = new ProvenanceClient();
      const result = await client.health();

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/health'),
        expect.any(Object)
      );
    });

    it('should return false when gateway returns error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const client = new ProvenanceClient();
      const result = await client.health();

      expect(result).toBe(false);
    });

    it('should return false when fetch throws', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const client = new ProvenanceClient();
      const result = await client.health();

      expect(result).toBe(false);
    });
  });

  describe('notaryInfo', () => {
    it('should return notary info when available', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          enabled: true,
          available: true,
          address: '0xNotaryAddress',
          message: 'Notary active',
        }),
      });

      const client = new ProvenanceClient();
      const info = await client.notaryInfo();

      expect(info.enabled).toBe(true);
      expect(info.available).toBe(true);
      expect(info.address).toBe('0xNotaryAddress');
    });

    it('should return disabled when 404', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const client = new ProvenanceClient();
      const info = await client.notaryInfo();

      expect(info.enabled).toBe(false);
      expect(info.available).toBe(false);
    });

    it('should throw on other errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.resolve({ detail: 'Server error' }),
      });

      const client = new ProvenanceClient();
      await expect(client.notaryInfo()).rejects.toThrow(GatewayConnectionError);
    });
  });

  describe('poolStatus', () => {
    it('should return pool status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          enabled: true,
          available: { '17': 5, '20': 3 },
          reserve: { '17': 10, '20': 5 },
        }),
      });

      const client = new ProvenanceClient();
      const status = await client.poolStatus();

      expect(status.enabled).toBe(true);
      expect(status.available['17']).toBe(5);
    });

    it('should return disabled when 404', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const client = new ProvenanceClient();
      const status = await client.poolStatus();

      expect(status.enabled).toBe(false);
    });
  });

  describe('acquireStamp', () => {
    it('should acquire stamp from pool', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          batch_id: 'stamp123',
          depth: 17,
          size_name: 'small',
          fallback_used: false,
        }),
      });

      const client = new ProvenanceClient();
      const stamp = await client.acquireStamp('small');

      expect(stamp.batchId).toBe('stamp123');
      expect(stamp.depth).toBe(17);
      expect(stamp.sizeName).toBe('small');
      expect(stamp.fallbackUsed).toBe(false);
    });

    it('should throw StampError on failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: () => Promise.resolve({ detail: 'No stamps available' }),
      });

      const client = new ProvenanceClient();
      await expect(client.acquireStamp()).rejects.toThrow(StampError);
    });
  });

  describe('upload', () => {
    it('should upload content and return reference', async () => {
      // Mock stamp acquisition
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          batch_id: 'stamp123',
          depth: 17,
          size_name: 'small',
          fallback_used: false,
        }),
      });

      // Mock upload
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          reference: 'abcd1234'.repeat(8),
        }),
      });

      const client = new ProvenanceClient();
      const result = await client.upload('Hello, World!');

      expect(result.reference).toBe('abcd1234'.repeat(8));
      expect(result.metadata.stamp_id).toBe('stamp123');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should use provided stampId and skip pool', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          reference: 'abcd1234'.repeat(8),
        }),
      });

      const client = new ProvenanceClient();
      const result = await client.upload('Hello', { stampId: 'myStamp' });

      expect(result.metadata.stamp_id).toBe('myStamp');
      expect(mockFetch).toHaveBeenCalledTimes(1); // No stamp acquisition
    });

    it('should include signed document when notary signing', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          batch_id: 'stamp123',
          depth: 17,
          size_name: 'small',
          fallback_used: false,
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          reference: 'abcd1234'.repeat(8),
          signed_document: {
            metadata: {
              data: 'SGVsbG8=',
              content_hash: 'hash123',
              stamp_id: 'stamp123',
            },
            signatures: [
              {
                type: 'eip191',
                signer: '0xNotary',
                timestamp: '2024-01-01T00:00:00Z',
                data_hash: 'hash',
                signature: '0xsig',
                hashed_fields: ['content_hash'],
                signed_message_format: 'format',
              },
            ],
          },
        }),
      });

      const client = new ProvenanceClient();
      const result = await client.upload('Hello', { sign: 'notary' });

      expect(result.signedDocument).toBeDefined();
      expect(result.signedDocument?.signatures).toHaveLength(1);
    });

    it('should throw NotaryError when notary signing fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          batch_id: 'stamp123',
          depth: 17,
          size_name: 'small',
          fallback_used: false,
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: () => Promise.resolve({
          code: 'NOTARY_NOT_ENABLED',
          detail: 'Notary service not enabled',
        }),
      });

      const client = new ProvenanceClient();
      await expect(client.upload('Hello', { sign: 'notary' })).rejects.toThrow(NotaryError);
    });
  });

  describe('download', () => {
    it('should download and decode content', async () => {
      const contentHash = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: () => Promise.resolve({
          metadata: {
            data: 'aGVsbG8=', // "hello" in base64
            content_hash: contentHash,
            stamp_id: 'stamp123',
          },
        }),
      });

      const client = new ProvenanceClient();
      const result = await client.download('abcd1234'.repeat(8));

      expect(new TextDecoder().decode(result.file)).toBe('hello');
      expect(result.metadata.content_hash).toBe(contentHash);
    });

    it('should verify signatures when present', async () => {
      const contentHash = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

      // Mock download - using gateway format with signatures at same level
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: () => Promise.resolve({
          data: 'aGVsbG8=',
          content_hash: contentHash,
          stamp_id: 'stamp123',
          signatures: [
            {
              type: 'notary',
              signer: '0xNotary',
              timestamp: '2024-01-01T00:00:00Z',
              // sha256 of canonicalJson("aGVsbG8=") = sha256('"aGVsbG8="')
              data_hash: 'a06044467a47dac725953f9aec884c638596d7e61cec202a335986aac31e092e',
              signature: '0xsig',
              hashed_fields: ['data'],
              signed_message_format: '{data_hash}|{timestamp}',
            },
          ],
        }),
      });

      // Mock notary info for verification
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          enabled: true,
          available: true,
          address: '0xNotary',
        }),
      });

      const client = new ProvenanceClient();
      const result = await client.download('abcd1234'.repeat(8));

      expect(result.signatures).toHaveLength(1);
      expect(result.verified).toBe(true);
    });

    it('should throw on content hash mismatch', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: () => Promise.resolve({
          metadata: {
            data: 'aGVsbG8=',
            content_hash: 'wrong_hash',
            stamp_id: 'stamp123',
          },
        }),
      });

      const client = new ProvenanceClient();
      await expect(client.download('abcd1234'.repeat(8))).rejects.toThrow(
        'Content hash verification failed'
      );
    });

    it('should throw on gateway error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: () => Promise.resolve({ detail: 'Reference not found' }),
      });

      const client = new ProvenanceClient();
      await expect(client.download('abcd1234'.repeat(8))).rejects.toThrow(GatewayConnectionError);
    });
  });

  describe('timeout handling', () => {
    it('should handle abort errors gracefully in health check', async () => {
      const abortError = new Error('AbortError');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValueOnce(abortError);

      const client = new ProvenanceClient({ timeout: 100 });

      // health() catches errors and returns false
      await expect(client.health()).resolves.toBe(false);
    });
  });
});
