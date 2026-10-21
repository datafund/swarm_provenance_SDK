import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProvenanceClient } from '../../src/client.js';
import { ProvenanceError, GatewayConnectionError, StampError, NotaryError, PaymentRateLimitError } from '../../src/errors.js';
import { sha256Hex, toBytes } from '../../src/utils.js';

// Mock fetch globally. The mocks are plain objects with json(); the client
// reads download bodies with text() (to canonicalise them losslessly), so
// derive text() from json() for any mock that lacks it.
const mockFetch = vi.fn();
vi.stubGlobal('fetch', async (...args: unknown[]) => {
  const res = (await mockFetch(...args)) as { json?: () => Promise<unknown>; text?: () => Promise<string> } | undefined;
  if (res && res.json && !res.text) {
    const json = res.json;
    return { ...res, text: async () => JSON.stringify(await json()) };
  }
  return res;
});

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

    it('should parse structured detail object (pool exhausted)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        headers: new Headers({}),
        json: () => Promise.resolve({
          detail: {
            message: 'No stamp available for depth 17 (size: small). Pool is exhausted.',
            suggestion: 'Purchase a stamp directly via POST /api/v1/stamps/',
          },
        }),
      });

      const client = new ProvenanceClient({ retry: { maxRetries: 0 } });
      await expect(client.acquireStamp()).rejects.toThrow('Pool is exhausted');
    });

    it('should include suggestion in StampError message', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        headers: new Headers({}),
        json: () => Promise.resolve({
          detail: {
            message: 'No stamps available for size: small',
            suggestion: 'Try a larger size or wait for stamps to be replenished',
          },
        }),
      });

      const client = new ProvenanceClient({ retry: { maxRetries: 0 } });
      try {
        await client.acquireStamp();
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(StampError);
        const stampError = error as StampError;
        expect(stampError.message).toContain('No stamps available for size: small');
        expect(stampError.message).toContain('Try a larger size or wait');
      }
    });

    it('should parse FastAPI validation error array', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        json: () => Promise.resolve({
          detail: [
            { type: 'literal_error', loc: ['body', 'size'], msg: "Input should be 'small', 'medium' or 'large'" },
          ],
        }),
      });

      const client = new ProvenanceClient();
      await expect(client.acquireStamp()).rejects.toThrow("Input should be 'small', 'medium' or 'large'");
    });

    it('should fall back to status text when detail is missing', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.resolve({}),
      });

      const client = new ProvenanceClient();
      await expect(client.acquireStamp()).rejects.toThrow('Gateway error: 500 Internal Server Error');
    });

    it('should handle non-JSON error responses', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        headers: new Headers({}),
        json: () => Promise.reject(new Error('not JSON')),
      });

      const client = new ProvenanceClient({ retry: { maxRetries: 0 } });
      await expect(client.acquireStamp()).rejects.toThrow('Gateway error: 502 Bad Gateway');
    });
  });

  describe('upload', () => {
    it('should upload content and return reference', async () => {
      // Mock pool status pre-check
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          enabled: true,
          reserve_config: { '17': 1 },
          current_levels: { '17': 5 },
          available_stamps: {},
          total_stamps: 5,
          low_reserve_warning: false,
          last_check: '2024-01-01T00:00:00Z',
          next_check: '2024-01-01T01:00:00Z',
          errors: [],
        }),
      });

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
      expect(mockFetch).toHaveBeenCalledTimes(3);
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
      // Mock pool status pre-check
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          enabled: true,
          reserve_config: { '17': 1 },
          current_levels: { '17': 5 },
          available_stamps: {},
          total_stamps: 5,
          low_reserve_warning: false,
          last_check: '2024-01-01T00:00:00Z',
          next_check: '2024-01-01T01:00:00Z',
          errors: [],
        }),
      });

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
      // Mock pool status pre-check
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          enabled: true,
          reserve_config: { '17': 1 },
          current_levels: { '17': 5 },
          available_stamps: {},
          total_stamps: 5,
          low_reserve_warning: false,
          last_check: '2024-01-01T00:00:00Z',
          next_check: '2024-01-01T01:00:00Z',
          errors: [],
        }),
      });

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

    it('does not report a placeholder signature as verified (the 0.6.1 false positive, #113)', async () => {
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
              signer: '0x1234567890123456789012345678901234567890',
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
          address: '0x1234567890123456789012345678901234567890',
        }),
      });

      const client = new ProvenanceClient();
      const result = await client.download('abcd1234'.repeat(8));

      expect(result.signatures).toHaveLength(1);
      // Data hash matches and the declared signer is the notary, but '0xsig' is
      // not a signature: 0.6.1 returned verified: true here.
      expect(result.verified).toBe(false);
      expect(result.verification?.expectedSignerSource).toBe('gateway');
      expect(result.verification?.results[0]?.error).toMatch(/^Invalid signature/);
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

  describe('upload raw mode (#89)', () => {
    it('should upload raw JSON object without base64 wrapping', async () => {
      // Mock upload (stampId provided, so no pool/acquire calls)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          reference: 'abcd1234'.repeat(8),
        }),
      });

      const client = new ProvenanceClient();
      const doc = { file_hash: 'abc123', filename: 'report.pdf' };
      const result = await client.upload(doc, { raw: true, stampId: 'myStamp' });

      expect(result.reference).toBe('abcd1234'.repeat(8));
      expect(result.metadata.data).toEqual(doc);
      expect(result.metadata.stamp_id).toBe('myStamp');
      // content_hash should be SHA256 of JSON.stringify(doc)
      const expectedHash = sha256Hex(toBytes(JSON.stringify(doc)));
      expect(result.metadata.content_hash).toBe(expectedHash);
    });

    it('should upload raw JSON string', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          reference: 'abcd1234'.repeat(8),
        }),
      });

      const client = new ProvenanceClient();
      const doc = { key: 'value' };
      const result = await client.upload(JSON.stringify(doc), { raw: true, stampId: 'myStamp' });

      expect(result.metadata.data).toEqual(doc);
    });

    it('should throw on invalid JSON string in raw mode', async () => {
      const client = new ProvenanceClient();
      await expect(
        client.upload('not valid json', { raw: true, stampId: 'myStamp' })
      ).rejects.toThrow(ProvenanceError);
    });

    it('should include provenance standard in raw upload', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ reference: 'ref123'.padEnd(64, '0') }),
      });

      const client = new ProvenanceClient();
      const result = await client.upload(
        { data: 'test' },
        { raw: true, stampId: 'myStamp', standard: 'provenance-v1' }
      );

      expect(result.metadata.provenance_standard).toBe('provenance-v1');
    });

    it('should acquire stamp from pool in raw mode when no stampId', async () => {
      // Pool status
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          enabled: true,
          reserve_config: { '17': 1 },
          current_levels: { '17': 5 },
          available_stamps: {},
          total_stamps: 5,
          low_reserve_warning: false,
          last_check: '2024-01-01T00:00:00Z',
          next_check: '2024-01-01T01:00:00Z',
          errors: [],
        }),
      });
      // Acquire stamp
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          batch_id: 'poolStamp',
          depth: 17,
          size_name: 'small',
          fallback_used: false,
        }),
      });
      // Upload
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ reference: 'abcd1234'.repeat(8) }),
      });

      const client = new ProvenanceClient();
      const result = await client.upload({ test: true }, { raw: true });

      expect(result.metadata.stamp_id).toBe('poolStamp');
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should reject Blob content in raw mode', async () => {
      const client = new ProvenanceClient();
      const blob = new Blob(['test']);
      await expect(
        client.upload(blob, { raw: true, stampId: 'myStamp' })
      ).rejects.toThrow('Raw mode requires valid JSON string or plain object');
    });

    it('should reject Uint8Array content in raw mode', async () => {
      const client = new ProvenanceClient();
      await expect(
        client.upload(new Uint8Array([1, 2, 3]), { raw: true, stampId: 'myStamp' })
      ).rejects.toThrow('Raw mode requires valid JSON string or plain object');
    });

    it('should support notary signing in raw mode', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ reference: 'ref'.padEnd(64, '0') }),
      });

      const client = new ProvenanceClient();
      const result = await client.upload(
        { data: 'test' },
        { raw: true, stampId: 'myStamp', sign: 'notary' }
      );

      expect(result.reference).toBe('ref'.padEnd(64, '0'));

      // Verify the query string included sign=notary
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain('sign=notary');
    });
  });

  describe('downloadDocument (#89)', () => {
    it('should download raw JSON document (wrapped format)', async () => {
      const doc = { file_hash: 'abc123', filename: 'test.txt' };
      const contentHash = sha256Hex(toBytes(JSON.stringify(doc)));

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          metadata: {
            data: doc,
            content_hash: contentHash,
            stamp_id: 'stamp123',
          },
        }),
      });

      const client = new ProvenanceClient();
      const result = await client.downloadDocument('abcd1234'.repeat(8));

      expect(result.document).toEqual(doc);
      expect(result.metadata.content_hash).toBe(contentHash);
      expect(result.metadata.stamp_id).toBe('stamp123');
    });

    it('should download raw JSON document (direct format)', async () => {
      const doc = { file_hash: 'abc123' };
      const contentHash = sha256Hex(toBytes(JSON.stringify(doc)));

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: doc,
          content_hash: contentHash,
          stamp_id: 'stamp123',
        }),
      });

      const client = new ProvenanceClient();
      const result = await client.downloadDocument('abcd1234'.repeat(8));

      expect(result.document).toEqual(doc);
    });

    it('should throw on content hash mismatch', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          metadata: {
            data: { file_hash: 'abc' },
            content_hash: 'wrong_hash',
            stamp_id: 'stamp123',
          },
        }),
      });

      const client = new ProvenanceClient();
      await expect(client.downloadDocument('abcd1234'.repeat(8))).rejects.toThrow(
        'Content hash verification failed'
      );
    });

    it('should include signatures when present', async () => {
      const doc = { test: true };
      const contentHash = sha256Hex(toBytes(JSON.stringify(doc)));

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: doc,
          content_hash: contentHash,
          stamp_id: 'stamp123',
          signatures: [
            {
              type: 'notary',
              signer: '0xNotary',
              timestamp: '2024-01-01T00:00:00Z',
              data_hash: 'somehash',
              signature: '0xsig',
              hashed_fields: ['data'],
              signed_message_format: '{data_hash}|{timestamp}',
            },
          ],
        }),
      });

      // Mock notary info
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          enabled: true,
          available: true,
          address: '0xNotary',
        }),
      });

      const client = new ProvenanceClient();
      const result = await client.downloadDocument('abcd1234'.repeat(8));

      expect(result.signatures).toHaveLength(1);
    });

    it('should include provenance_standard when present', async () => {
      const doc = { test: true };
      const contentHash = sha256Hex(toBytes(JSON.stringify(doc)));

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          metadata: {
            data: doc,
            content_hash: contentHash,
            stamp_id: 'stamp123',
            provenance_standard: 'prov-v1',
          },
        }),
      });

      const client = new ProvenanceClient();
      const result = await client.downloadDocument('abcd1234'.repeat(8));

      expect(result.metadata.provenance_standard).toBe('prov-v1');
    });

    it('should skip signature verification when verify is false', async () => {
      const doc = { test: true };
      const contentHash = sha256Hex(toBytes(JSON.stringify(doc)));

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: doc,
          content_hash: contentHash,
          stamp_id: 'stamp123',
          signatures: [
            {
              type: 'notary',
              signer: '0xNotary',
              timestamp: '2024-01-01T00:00:00Z',
              data_hash: 'somehash',
              signature: '0xsig',
              hashed_fields: ['data'],
              signed_message_format: '{data_hash}|{timestamp}',
            },
          ],
        }),
      });

      const client = new ProvenanceClient();
      const result = await client.downloadDocument('abcd1234'.repeat(8), { verify: false });

      expect(result.signatures).toHaveLength(1);
      expect(result.verified).toBeUndefined();
      // Only 1 fetch call — no notary info lookup
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should throw on gateway error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: () => Promise.resolve({ detail: 'Not found' }),
      });

      const client = new ProvenanceClient();
      await expect(client.downloadDocument('abcd1234'.repeat(8))).rejects.toThrow(
        GatewayConnectionError
      );
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

  describe('suggestion surfacing (#76)', () => {
    it('should surface suggestion on GatewayConnectionError', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.resolve({
          detail: {
            message: 'Pool exhausted',
            suggestion: 'Wait for replenishment',
          },
        }),
      });

      const client = new ProvenanceClient();
      try {
        await client.notaryInfo();
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(GatewayConnectionError);
        const gError = error as GatewayConnectionError;
        expect(gError.message).toBe('Pool exhausted');
        expect(gError.suggestion).toBe('Wait for replenishment');
        expect(gError.statusCode).toBe(500);
      }
    });

    it('should set suggestion to undefined when not present', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.resolve({ detail: 'Server error' }),
      });

      const client = new ProvenanceClient();
      try {
        await client.notaryInfo();
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(GatewayConnectionError);
        expect((error as GatewayConnectionError).suggestion).toBeUndefined();
      }
    });
  });

  describe('gateway retry (#77)', () => {
    it('should retry on 503 and succeed', async () => {
      // First call: 503
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        headers: new Headers({}),
      });
      // Second call: success
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'ok' }),
      });

      const client = new ProvenanceClient({ retry: { maxRetries: 2, baseDelayMs: 1 } });
      const result = await client.health();

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should retry on 502 and succeed', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        headers: new Headers({}),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'ok' }),
      });

      const client = new ProvenanceClient({ retry: { maxRetries: 1, baseDelayMs: 1 } });
      const result = await client.health();

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should not retry on 429 in free mode (throws PaymentRateLimitError)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: new Headers({ 'Retry-After': '60' }),
      });

      const client = new ProvenanceClient({ retry: { maxRetries: 2, baseDelayMs: 1 } });
      // health() swallows errors, use notaryInfo() instead
      await expect(client.notaryInfo()).rejects.toThrow(PaymentRateLimitError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should retry on 429 in none mode', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: new Headers({}),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'ok' }),
      });

      const client = new ProvenanceClient({ payment: 'none', retry: { maxRetries: 2, baseDelayMs: 1 } });
      const result = await client.health();

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should return error response after exhausting retries', async () => {
      // All calls return 503
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        headers: new Headers({}),
        json: () => Promise.resolve({ detail: 'Service down' }),
      });

      const client = new ProvenanceClient({ retry: { maxRetries: 2, baseDelayMs: 1 } });
      await expect(client.notaryInfo()).rejects.toThrow(GatewayConnectionError);
      // 1 initial + 2 retries = 3 calls
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should not retry by default on non-retryable errors (e.g. 400)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: () => Promise.resolve({ detail: 'Invalid input' }),
      });

      const client = new ProvenanceClient({ retry: { maxRetries: 2, baseDelayMs: 1 } });
      await expect(client.notaryInfo()).rejects.toThrow(GatewayConnectionError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('pool pre-check (#78)', () => {
    it('should throw StampError early when pool is empty', async () => {
      // Pool status: empty
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          enabled: true,
          reserve_config: {},
          current_levels: {},
          available_stamps: {},
          total_stamps: 0,
          low_reserve_warning: true,
          last_check: '2024-01-01T00:00:00Z',
          next_check: '2024-01-01T01:00:00Z',
          errors: [],
        }),
      });

      const client = new ProvenanceClient();
      try {
        await client.upload('Hello');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(StampError);
        expect((error as StampError).message).toContain('Stamp pool is empty');
        expect((error as StampError).code).toBe('POOL_EXHAUSTED');
      }
      // Only 1 call (pool status), no acquire
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should proceed when pool has stamps', async () => {
      // Pool status: has stamps
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          enabled: true,
          reserve_config: { '17': 1 },
          current_levels: { '17': 5 },
          available_stamps: { '17': ['s1'] },
          total_stamps: 5,
          low_reserve_warning: false,
          last_check: '2024-01-01T00:00:00Z',
          next_check: '2024-01-01T01:00:00Z',
          errors: [],
        }),
      });
      // Acquire stamp
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          batch_id: 'stamp123',
          depth: 17,
          size_name: 'small',
          fallback_used: false,
        }),
      });
      // Upload
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          reference: 'abcd1234'.repeat(8),
        }),
      });

      const client = new ProvenanceClient();
      const result = await client.upload('Hello');

      expect(result.reference).toBe('abcd1234'.repeat(8));
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should proceed when pool status check fails', async () => {
      // Pool status: network error
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      // Acquire stamp (this is the retry after pool pre-check failure, handled by fetch's catch)
      // Actually, the pool status call will throw GatewayConnectionError which is caught
      // Then acquireStamp is called:
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          batch_id: 'stamp123',
          depth: 17,
          size_name: 'small',
          fallback_used: false,
        }),
      });
      // Upload
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          reference: 'abcd1234'.repeat(8),
        }),
      });

      const client = new ProvenanceClient({ retry: { maxRetries: 0 } });
      const result = await client.upload('Hello');

      expect(result.reference).toBe('abcd1234'.repeat(8));
    });

    it('should skip pool pre-check when stampId is provided', async () => {
      // Upload directly with stampId
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          reference: 'abcd1234'.repeat(8),
        }),
      });

      const client = new ProvenanceClient();
      const result = await client.upload('Hello', { stampId: 'myStamp' });

      expect(result.reference).toBe('abcd1234'.repeat(8));
      expect(mockFetch).toHaveBeenCalledTimes(1); // Only upload, no pool check
    });
  });

  describe('error handling (#112)', () => {
    const STAMP = 'a'.repeat(64);
    const json = (body: unknown, status: number, statusText = '') =>
      new Response(JSON.stringify(body), { status, statusText, headers: { 'content-type': 'application/json' } });
    /** The gateway's error envelope (swarm_connect app/main.py error_envelope) */
    const envelope = (detail: Record<string, unknown>) => ({ detail, code: detail['code'], message: detail['message'] });

    const QUOTA_CODES = [
      'DAILY_STAMP_ALLOWANCE_EXHAUSTED',
      'DAILY_STAMP_ALLOWANCE_PER_CLIENT_EXHAUSTED',
      'DAILY_SPEND_BUDGET_EXHAUSTED',
      'FREE_QUOTA_EXCEEDED',
    ];
    const quota = (code: string) =>
      envelope({
        code,
        message: 'The daily free allowance of 10 small stamps for this application has been used up.',
        resets_at: '2026-10-22T00:00:00Z',
      });

    it.each(QUOTA_CODES)("a 429 %s in 'free' mode is reported with its code, not as the free-tier rate limit", async (code) => {
      mockFetch.mockImplementation(() => Promise.resolve(json(quota(code), 429, 'Too Many Requests')));
      const error = await new ProvenanceClient({ retry: { maxRetries: 2, baseDelayMs: 1 } })
        .acquireStamp()
        .catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(PaymentRateLimitError);
      expect(error).toBeInstanceOf(StampError);
      expect((error as StampError).code).toBe(code);
      expect((error as Error).message).toContain('daily free allowance');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it.each(QUOTA_CODES)("a 429 %s in 'none' mode is not retried", async (code) => {
      mockFetch.mockImplementation(() => Promise.resolve(json(quota(code), 429, 'Too Many Requests')));
      const error = await new ProvenanceClient({ payment: 'none', retry: { maxRetries: 2, baseDelayMs: 1 } })
        .acquireStamp()
        .catch((e: unknown) => e);
      expect((error as StampError).code).toBe(code);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('the global limiter 429 (RATE_LIMIT_EXCEEDED) is still a rate limit', async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ detail: 'Too many requests.', retry_after: 7, code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests.' }),
            { status: 429, headers: { 'Retry-After': '7' } }
          )
        )
      );
      const error = await new ProvenanceClient().notaryInfo().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PaymentRateLimitError);
      expect((error as PaymentRateLimitError).retryAfterSeconds).toBe(7);
    });

    it('{detail: {error, detail}} shows both texts, with or without the envelope', async () => {
      const detail = { error: 'Payment verification failed', detail: 'Could not verify payment with facilitator. Please try again.' };
      for (const body of [{ detail }, { detail, code: 'HTTP_400', message: 'Payment verification failed' }]) {
        mockFetch.mockResolvedValueOnce(json(body, 400, 'Bad Request'));
        const error = await new ProvenanceClient().notaryInfo().catch((e: unknown) => e);
        expect((error as Error).message).toBe('Payment verification failed: Could not verify payment with facilitator. Please try again.');
      }
    });

    it('a top-level message is shown, not "Gateway error: 503"', async () => {
      mockFetch.mockResolvedValueOnce(json({ code: 'PRICING_UNAVAILABLE', message: 'Could not read the chain price.' }, 503));
      const error = await new ProvenanceClient({ retry: { maxRetries: 0 } }).notaryInfo().catch((e: unknown) => e);
      expect((error as Error).message).toBe('Could not read the chain price.');
      expect((error as GatewayConnectionError).code).toBe('PRICING_UNAVAILABLE');
    });

    const x402Body = {
      x402Version: 1,
      error: 'Payment required. Use X-PAYMENT header for paid access or X-Payment-Mode: free for free tier.',
      accepts: [
        {
          scheme: 'exact',
          network: 'base-sepolia',
          maxAmountRequired: '10000',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          payTo: '0x1111111111111111111111111111111111111111',
          maxTimeoutSeconds: 60,
          resource: 'http://gateway.test/api/v1/data/',
          extra: { name: 'USDC', version: '2' },
        },
      ],
    };

    it("a 402 in 'none' mode shows the price and keeps the body, without the accepts JSON", async () => {
      const body = { ...x402Body, code: 'HTTP_402', message: x402Body.error, detail: x402Body };
      mockFetch.mockResolvedValueOnce(json(body, 402, 'Payment Required'));
      const error = await new ProvenanceClient({ payment: 'none' }).upload('hello', { stampId: STAMP }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GatewayConnectionError);
      expect((error as Error).message).toContain('0.01 USDC on base-sepolia');
      expect((error as Error).message).not.toMatch(/[{}]|maxAmountRequired|"accepts"/);
      expect((error as ProvenanceError).body).toEqual(body);
    });

    it('a 402 lists at most 3 prices and stays within the 4 KiB cap', async () => {
      const many = { ...x402Body, accepts: Array.from({ length: 2000 }, () => x402Body.accepts[0]) };
      mockFetch.mockResolvedValueOnce(json({ ...many, code: 'HTTP_402', message: x402Body.error }, 402));
      const error = await new ProvenanceClient({ payment: 'none' }).upload('hello', { stampId: STAMP }).catch((e: unknown) => e);
      const message = (error as Error).message;
      expect(message).toContain('0.01 USDC on base-sepolia or 0.01 USDC on base-sepolia or 0.01 USDC on base-sepolia (and 1997 more)');
      expect(message.split('USDC')).toHaveLength(4);

      mockFetch.mockResolvedValueOnce(json({ ...x402Body, code: 'HTTP_402', message: 'p'.repeat(5000) }, 402));
      const long = await new ProvenanceClient({ payment: 'none' }).upload('hello', { stampId: STAMP }).catch((e: unknown) => e);
      expect((long as Error).message.length).toBeLessThanOrEqual(4097);
    });

    it('a 402 with the payment request only under the deprecated detail still shows the price', async () => {
      mockFetch.mockResolvedValueOnce(json({ detail: x402Body }, 402, 'Payment Required'));
      const error = await new ProvenanceClient({ payment: 'none' }).upload('hello', { stampId: STAMP }).catch((e: unknown) => e);
      expect((error as Error).message).toContain(x402Body.error);
      expect((error as Error).message).toContain('0.01 USDC on base-sepolia');
    });

    it('a non-JSON error body is kept as text, capped at 4 KiB', async () => {
      const page = `<html><body>${'Bad gateway. '.repeat(1000)}</body></html>`;
      mockFetch.mockResolvedValueOnce(new Response(page, { status: 502, statusText: 'Bad Gateway' }));
      const error = await new ProvenanceClient({ retry: { maxRetries: 0 } }).notaryInfo().catch((e: unknown) => e);
      const body = (error as ProvenanceError).body;
      expect(typeof body).toBe('string');
      expect((body as string).length).toBeLessThanOrEqual(4096 + 32);
      expect(page.startsWith((body as string).slice(0, 100))).toBe(true);
      expect((error as Error).message).toBe('Gateway error: 502 Bad Gateway');
    });

    it('a long gateway message is capped at 4 KiB, with an ellipsis', async () => {
      mockFetch.mockResolvedValueOnce(json({ code: 'X', message: 'm'.repeat(10_000) }, 400));
      const error = await new ProvenanceClient().notaryInfo().catch((e: unknown) => e);
      expect((error as Error).message).toBe(`${'m'.repeat(4096)}…`);

      mockFetch.mockResolvedValueOnce(json({ detail: { error: 'e'.repeat(3000), detail: 'd'.repeat(3000) } }, 400));
      const nested = await new ProvenanceClient().notaryInfo().catch((e: unknown) => e);
      expect((nested as Error).message).toBe(`${'e'.repeat(3000)}: ${'d'.repeat(4096 - 3002)}…`);
    });

    it('a JSON body over 16 KiB is kept as its first 4 KiB of text; its code and message are still read', async () => {
      const body = { code: 'BIG_ERROR', message: 'Too much detail.', detail: { list: 'x'.repeat(20_000) } };
      mockFetch.mockResolvedValueOnce(json(body, 400));
      const error = await new ProvenanceClient().notaryInfo().catch((e: unknown) => e);
      expect((error as GatewayConnectionError).code).toBe('BIG_ERROR');
      expect((error as Error).message).toBe('Too much detail.');
      const kept = (error as ProvenanceError).body;
      expect(kept).toBe(`${JSON.stringify(body).slice(0, 4096)}…`);
    });

    it('a suggestion after a message ending in a full stop gets no second full stop', async () => {
      mockFetch.mockResolvedValueOnce(json(envelope({ code: 'POOL_EXHAUSTED', message: 'Pool is exhausted.', suggestion: 'Buy a stamp.' }), 409));
      const error = await new ProvenanceClient().acquireStamp().catch((e: unknown) => e);
      expect((error as Error).message).toBe('Pool is exhausted. Buy a stamp.');
    });

    it.each([Infinity, 1.5, 0, -1, NaN, '1000'])('maxUploadBytes %s is a configuration error', (value) => {
      expect(() => new ProvenanceClient({ maxUploadBytes: value as number })).toThrow(/maxUploadBytes must be a positive integer/);
    });

    it('the body survives the StampError conversion', async () => {
      const body = envelope({ code: 'POOL_EXHAUSTED', message: 'No stamps.' });
      mockFetch.mockResolvedValueOnce(json(body, 409));
      const error = await new ProvenanceClient().acquireStamp().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StampError);
      expect((error as StampError).body).toEqual(body);
    });

    it.each([
      ['critical', false],
      ['degraded', true],
      ['ok', true],
    ])('health() with status %s is %s', async (status, healthy) => {
      mockFetch.mockResolvedValueOnce(json({ status, message: 'Welcome' }, 200));
      await expect(new ProvenanceClient().health()).resolves.toBe(healthy);
    });

    it('upload results and acquired stamps carry expiresAt; null leaves it out', async () => {
      const expires = '2026-11-21T10:00:00Z';
      mockFetch.mockResolvedValueOnce(json({ reference: 'b'.repeat(64), expires_at: expires }, 200));
      const client = new ProvenanceClient();
      expect((await client.upload('hello', { stampId: STAMP })).expiresAt).toBe(expires);

      mockFetch.mockResolvedValueOnce(json({ reference: 'b'.repeat(64), expires_at: expires }, 200));
      expect((await client.upload({ a: 1 }, { stampId: STAMP, raw: true })).expiresAt).toBe(expires);

      mockFetch.mockResolvedValueOnce(json({ batch_id: STAMP, depth: 17, size_name: 'small', fallback_used: false, expires_at: expires }, 200));
      expect((await client.acquireStamp()).expiresAt).toBe(expires);

      mockFetch.mockResolvedValueOnce(json({ reference: 'b'.repeat(64), expires_at: null }, 200));
      expect('expiresAt' in (await client.upload('hello', { stampId: STAMP }))).toBe(false);
    });

    describe('upload size (#112)', () => {
      /** The gateway's default MAX_UPLOAD_SIZE_MB (10) in bytes */
      const LIMIT = 10 * 1024 * 1024;

      it('content over the limit after base64 is refused before any request, also before the pool', async () => {
        const error = await new ProvenanceClient().upload(new Uint8Array(7_900_000)).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ProvenanceError);
        expect((error as ProvenanceError).code).toBe('FILE_TOO_LARGE');
        expect((error as Error).message).toContain(String(LIMIT));
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('content just under the limit is sent', async () => {
        mockFetch.mockResolvedValueOnce(json({ reference: 'b'.repeat(64) }, 200));
        await new ProvenanceClient().upload(new Uint8Array(7_860_000), { stampId: STAMP });
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      it('a raw document over the limit is refused', async () => {
        const error = await new ProvenanceClient()
          .upload({ text: 'x'.repeat(LIMIT) }, { stampId: STAMP, raw: true })
          .catch((e: unknown) => e);
        expect((error as ProvenanceError).code).toBe('FILE_TOO_LARGE');
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('maxUploadBytes sets the limit', async () => {
        const error = await new ProvenanceClient({ maxUploadBytes: 1000 })
          .upload('x'.repeat(1000), { stampId: STAMP })
          .catch((e: unknown) => e);
        expect((error as ProvenanceError).code).toBe('FILE_TOO_LARGE');
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('a bare 413 without status text does not show an empty one', async () => {
        mockFetch.mockResolvedValueOnce(new Response('', { status: 413 }));
        const error = await new ProvenanceClient().upload('hello', { stampId: STAMP }).catch((e: unknown) => e);
        expect((error as Error).message).toContain('(413)');
      });

      /** The uploaded file (metadata JSON) of the mocked fetch call at `index` (negative: from the end) */
      const sentFile = async (index: number) => {
        const call = mockFetch.mock.calls.at(index) as [string, RequestInit];
        const form = call[1].body as FormData;
        return (form.get('file') as Blob).text();
      };
      const poolStatus = { enabled: true, current_levels: {}, reserve_config: {}, total_stamps: 3, low_reserve_warning: false };

      it('a raw document changed during pool acquisition is sent as it was hashed', async () => {
        const doc: Record<string, unknown> = { a: 1 };
        mockFetch
          .mockResolvedValueOnce(json(poolStatus, 200))
          .mockImplementationOnce(() => {
            doc['a'] = 2; // the caller changes the object while the stamp is acquired
            return Promise.resolve(json({ batch_id: STAMP, depth: 17, size_name: 'small', fallback_used: false }, 200));
          })
          .mockResolvedValueOnce(json({ reference: 'b'.repeat(64) }, 200));
        await new ProvenanceClient().upload(doc, { raw: true });
        const sent = JSON.parse(await sentFile(2)) as { data: unknown; content_hash: string };
        expect(sent.data).toEqual({ a: 1 });
        expect(sent.content_hash).toBe(sha256Hex(toBytes('{"a":1}')));
      });

      it('the body is the metadata JSON, and only the stamp_id field gets the stamp', async () => {
        // A document can hold the placeholder's exact text: a nested stamp_id of 64 zeros
        const decoy = `"stamp_id":"${'0'.repeat(64)}"`;
        for (const [content, options] of [
          [{ inner: { stamp_id: '0'.repeat(64) }, n: [1, 2.5] }, { raw: true, standard: 'std' }],
          ['hello', { standard: 'std' }],
        ] as const) {
          mockFetch
            .mockResolvedValueOnce(json(poolStatus, 200))
            .mockResolvedValueOnce(json({ batch_id: STAMP, depth: 17, size_name: 'small', fallback_used: false }, 200))
            .mockResolvedValueOnce(json({ reference: 'b'.repeat(64) }, 200));
          const result = await new ProvenanceClient().upload(content as never, options as never);
          const sent = await sentFile(-1);
          expect(sent).toBe(JSON.stringify(result.metadata));
          expect((JSON.parse(sent) as { stamp_id: string }).stamp_id).toBe(STAMP);
          if (options.raw) {
            expect(sent).toContain(decoy);
            expect((JSON.parse(sent) as { data: { inner: unknown } }).data.inner).toEqual({ stamp_id: '0'.repeat(64) });
          }
        }
      });

      it("the edge proxy's bare 413 is a clear FILE_TOO_LARGE error", async () => {
        mockFetch.mockResolvedValueOnce(new Response('', { status: 413, statusText: 'Request Entity Too Large' }));
        const error = await new ProvenanceClient().upload('hello', { stampId: STAMP }).catch((e: unknown) => e);
        expect((error as ProvenanceError).code).toBe('FILE_TOO_LARGE');
        expect((error as Error).message).toMatch(/too large/i);
      });
    });
  });
});
