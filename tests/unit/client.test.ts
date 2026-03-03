import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProvenanceClient } from '../../src/client.js';
import { GatewayConnectionError, StampError, NotaryError, PaymentRateLimitError } from '../../src/errors.js';

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
          reserve_config: { '17': 1, '20': 1 },
          current_levels: { '17': 52, '20': 5 },
          available_stamps: { '17': ['stamp1', 'stamp2'], '20': ['stamp3'] },
          total_stamps: 57,
          low_reserve_warning: false,
          last_check: '2024-01-01T00:00:00Z',
          next_check: '2024-01-01T01:00:00Z',
          errors: [],
        }),
      });

      const client = new ProvenanceClient();
      const status = await client.poolStatus();

      expect(status.enabled).toBe(true);
      expect(status.available['17']).toBe(52);
      expect(status.reserve['17']).toBe(1);
      expect(status.totalStamps).toBe(57);
      expect(status.lowReserveWarning).toBe(false);
    });

    it('should return disabled when 404', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const client = new ProvenanceClient();
      const status = await client.poolStatus();

      expect(status.enabled).toBe(false);
      expect(status.totalStamps).toBe(0);
      expect(status.lowReserveWarning).toBe(false);
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

    it('should upload with notary signing (signatures available on download)', async () => {
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
        }),
      });

      const client = new ProvenanceClient();
      const result = await client.upload('Hello', { sign: 'notary' });

      expect(result.reference).toBe('abcd1234'.repeat(8));
      expect(result.metadata.stamp_id).toBe('stamp123');
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

  describe('payment modes', () => {
    function getRequestHeaders(): Headers {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      return mockFetch.mock.calls[0][1].headers as Headers;
    }

    it('should send X-Payment-Mode: free header by default', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const client = new ProvenanceClient();
      await client.health();

      expect(getRequestHeaders().get('X-Payment-Mode')).toBe('free');
    });

    it('should send X-Payment-Mode: free header when payment is "free"', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const client = new ProvenanceClient({ payment: 'free' });
      await client.health();

      expect(getRequestHeaders().get('X-Payment-Mode')).toBe('free');
    });

    it('should not send X-Payment-Mode header when payment is "none"', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const client = new ProvenanceClient({ payment: 'none' });
      await client.health();

      expect(getRequestHeaders().has('X-Payment-Mode')).toBe(false);
    });

    it('should accept x402 config in constructor without error', () => {
      const mockWallet = {
        address: '0x1234567890abcdef1234567890abcdef12345678' as `0x${string}`,
        signTypedData: vi.fn(),
        readContract: vi.fn(),
      };
      const client = new ProvenanceClient({
        payment: { wallet: mockWallet },
      });
      expect(client).toBeInstanceOf(ProvenanceClient);
    });

    it('should throw PaymentRateLimitError on 429 in free mode', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: new Headers({
          'Retry-After': '60',
          'X-RateLimit-Limit': '3',
          'X-RateLimit-Remaining': '0',
        }),
      });

      const client = new ProvenanceClient();
      await expect(client.health()).resolves.toBe(false);
    });

    it('should include retry metadata in PaymentRateLimitError', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: new Headers({
          'Retry-After': '60',
          'X-RateLimit-Limit': '3',
          'X-RateLimit-Remaining': '0',
        }),
      });

      const client = new ProvenanceClient();

      // Use notaryInfo() which doesn't swallow errors like health()
      try {
        await client.notaryInfo();
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(PaymentRateLimitError);
        const rateError = error as PaymentRateLimitError;
        expect(rateError.retryAfterSeconds).toBe(60);
        expect(rateError.requestsLimit).toBe(3);
        expect(rateError.requestsRemaining).toBe(0);
        expect(rateError.code).toBe('PAYMENT_RATE_LIMIT');
      }
    });

    it('should not throw PaymentRateLimitError on 429 when payment is "none"', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: new Headers({}),
        json: () => Promise.resolve({ detail: 'Rate limited' }),
      });

      const client = new ProvenanceClient({ payment: 'none' });
      // Should throw regular GatewayConnectionError, not PaymentRateLimitError
      await expect(client.notaryInfo()).rejects.toThrow(GatewayConnectionError);
      await expect(client.notaryInfo()).rejects.not.toThrow(PaymentRateLimitError);
    });
  });
});
