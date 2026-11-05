import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
// Node 18 has no global File; node:buffer has it from 18.13
import { File } from 'node:buffer';
import { ProvenanceClient } from '../../src/client.js';
import { ProvenanceError, GatewayConnectionError, StampError, NotaryError, PaymentRateLimitError } from '../../src/errors.js';
import { sha256Hex, toBytes } from '../../src/utils.js';
import { verifyDocumentHash } from '../../src/metadata.js';
import { ChainValidationError } from '../../src/chain/errors.js';

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

/** A pool stamp's batch id as the gateway returns it: 64 hex characters, which acquireStamp() checks (#199) */
const POOL_BATCH_ID = '5ca1ab1e'.repeat(8);

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
    it('throws INVALID_RESPONSE for a 200 body that is not JSON (#173)', async () => {
      mockFetch.mockResolvedValueOnce(new Response('<html>proxy error</html>', { status: 200 }));

      const client = new ProvenanceClient();
      const error = await client.notaryInfo().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(GatewayConnectionError);
      expect((error as GatewayConnectionError).code).toBe('INVALID_RESPONSE');
      expect((error as GatewayConnectionError).statusCode).toBe(200);
    });

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
    it('throws INVALID_RESPONSE for a 200 body that is not JSON (#173)', async () => {
      mockFetch.mockResolvedValueOnce(new Response('<html>proxy error</html>', { status: 200 }));

      const client = new ProvenanceClient();
      const error = await client.poolStatus().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(GatewayConnectionError);
      expect((error as GatewayConnectionError).code).toBe('INVALID_RESPONSE');
      expect((error as GatewayConnectionError).statusCode).toBe(200);
    });

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
          batch_id: POOL_BATCH_ID,
          depth: 17,
          size_name: 'small',
          fallback_used: false,
        }),
      });

      const client = new ProvenanceClient();
      const stamp = await client.acquireStamp('small');

      expect(stamp.batchId).toBe(POOL_BATCH_ID);
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

    it.each([['free' as const], ['none' as const]])(
      'a pool 402 in %s mode is a StampError that says how to continue (#109)',
      async (payment) => {
        const answer402 = (detail: unknown) => ({
          ok: false,
          status: 402,
          statusText: 'Payment Required',
          headers: new Headers({}),
          json: () => Promise.resolve({ detail }),
        });
        const client = new ProvenanceClient({ payment, retry: { maxRetries: 0 } });

        mockFetch.mockResolvedValueOnce(
          answer402({ code: 'DAILY_STAMP_ALLOWANCE_EXHAUSTED', message: 'Daily stamp allowance used up.', accepts: [] })
        );
        const withCode = await client.acquireStamp().catch((e: unknown) => e);
        expect(withCode).toBeInstanceOf(StampError);
        expect((withCode as StampError).code).toBe('DAILY_STAMP_ALLOWANCE_EXHAUSTED');
        expect((withCode as Error).message).toMatch(/payForPool/);
        expect((withCode as Error).message).toMatch(/stampId/);
        // The 402's price and quota details stay available (#163)
        expect((withCode as StampError).body).toEqual({
          detail: { code: 'DAILY_STAMP_ALLOWANCE_EXHAUSTED', message: 'Daily stamp allowance used up.', accepts: [] },
        });

        mockFetch.mockResolvedValueOnce(answer402({ x402Version: 1, error: 'Payment required', accepts: [] }));
        const withoutCode = await client.acquireStamp().catch((e: unknown) => e);
        expect(withoutCode).toBeInstanceOf(StampError);
        expect((withoutCode as StampError).code).toBe('PAYMENT_REQUIRED');
        expect((withoutCode as Error).message).toMatch(/payForPool/);
        expect((withoutCode as StampError).body).toEqual({ detail: { x402Version: 1, error: 'Payment required', accepts: [] } });
      }
    );

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
          batch_id: POOL_BATCH_ID,
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
      expect(result.metadata.stamp_id).toBe(POOL_BATCH_ID);
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

    it('sends a mixed-case stampId in lowercase, as Bee batch ids are (#168)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ reference: 'abcd1234'.repeat(8) }),
      });
      const mixed = 'ABCDEF'.padEnd(64, '0');

      const result = await new ProvenanceClient().upload('Hello', { stampId: mixed });

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(new URL(url).searchParams.get('stamp_id')).toBe(mixed.toLowerCase());
      const file = (init.body as FormData).get('file') as Blob;
      expect((JSON.parse(await file.text()) as { stamp_id: string }).stamp_id).toBe(mixed.toLowerCase());
      expect(result.metadata.stamp_id).toBe(mixed.toLowerCase());
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
          batch_id: POOL_BATCH_ID,
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
      expect(result.metadata.stamp_id).toBe(POOL_BATCH_ID);
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
          batch_id: POOL_BATCH_ID,
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
    it('throws INVALID_RESPONSE for a 200 body that is not JSON (#173)', async () => {
      mockFetch.mockResolvedValueOnce(new Response('<html>proxy error</html>', { status: 200 }));

      const client = new ProvenanceClient();
      const error = await client.download('abcd1234'.repeat(8)).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(GatewayConnectionError);
      expect((error as GatewayConnectionError).code).toBe('INVALID_RESPONSE');
      expect((error as GatewayConnectionError).statusCode).toBe(200);
    });

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

  describe('reference validation (#123)', () => {
    const helloBody = () => ({
      ok: true,
      json: () =>
        Promise.resolve({
          data: 'aGVsbG8=',
          content_hash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
          stamp_id: 'stamp123',
        }),
    });

    it.each([
      ['a path', '../pool/status'],
      ['a query', `${'a'.repeat(64)}?sign=notary`],
      ['63 hex characters', 'a'.repeat(63)],
      ['65 hex characters', 'a'.repeat(65)],
      ['127 hex characters', 'a'.repeat(127)],
      ['non-hex characters', 'g'.repeat(64)],
      ['an empty string', ''],
      ['surrounding whitespace', ` ${'a'.repeat(64)} `],
    ])('download() rejects %s with INVALID_INPUT and sends no request', async (_name, reference) => {
      const client = new ProvenanceClient();
      const error = await client.download(reference).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProvenanceError);
      expect((error as ProvenanceError).code).toBe('INVALID_INPUT');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('downloadDocument() rejects a malformed reference with INVALID_INPUT and sends no request', async () => {
      const client = new ProvenanceClient();
      const error = await client.downloadDocument('x/../../health').catch((e: unknown) => e);
      expect((error as ProvenanceError).code).toBe('INVALID_INPUT');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('strips a 0x prefix before building the request path', async () => {
      mockFetch.mockResolvedValueOnce(helloBody());
      const client = new ProvenanceClient({ gatewayUrl: 'https://gw.test' });
      await client.download(`0x${'ab'.repeat(32)}`);
      expect((mockFetch.mock.calls[0] as unknown[])[0]).toBe(`https://gw.test/api/v1/data/${'ab'.repeat(32)}`);
    });

    it('accepts a 128-hex encrypted reference', async () => {
      mockFetch.mockResolvedValueOnce(helloBody());
      const client = new ProvenanceClient({ gatewayUrl: 'https://gw.test' });
      await client.download('cd'.repeat(64));
      expect((mockFetch.mock.calls[0] as unknown[])[0]).toBe(`https://gw.test/api/v1/data/${'cd'.repeat(64)}`);
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
        json: () => Promise.resolve({ reference: 'abc123'.padEnd(64, '0') }),
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
          batch_id: POOL_BATCH_ID,
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

      expect(result.metadata.stamp_id).toBe(POOL_BATCH_ID);
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
        json: () => Promise.resolve({ reference: 'fe'.padEnd(64, '0') }),
      });

      const client = new ProvenanceClient();
      const result = await client.upload(
        { data: 'test' },
        { raw: true, stampId: 'myStamp', sign: 'notary' }
      );

      expect(result.reference).toBe('fe'.padEnd(64, '0'));

      // Verify the query string included sign=notary
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain('sign=notary');
    });
  });

  describe('downloadDocument (#89)', () => {
    it('throws INVALID_RESPONSE for a 200 body that is not JSON (#173)', async () => {
      mockFetch.mockResolvedValueOnce(new Response('<html>proxy error</html>', { status: 200 }));

      const client = new ProvenanceClient();
      const error = await client.downloadDocument('abcd1234'.repeat(8)).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(GatewayConnectionError);
      expect((error as GatewayConnectionError).code).toBe('INVALID_RESPONSE');
      expect((error as GatewayConnectionError).statusCode).toBe(200);
    });

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

    it('does not cache a failed x402 transport setup: the next paid request tries again (#123)', async () => {
      const createX402Transport = vi
        .fn()
        .mockRejectedValueOnce(new Error('@x402/fetch could not be loaded'))
        .mockResolvedValueOnce({ fetchFor: () => (url: string, init: RequestInit) => mockFetch(url, init) as Promise<Response> });
      vi.resetModules();
      vi.doMock('../../src/payment.js', async (importOriginal) => ({
        ...(await importOriginal<typeof import('../../src/payment.js')>()),
        createX402Transport,
      }));
      try {
        const { ProvenanceClient: Client } = await import('../../src/client.js');
        const client = new Client({
          payment: {
            wallet: {
              address: '0x1234567890abcdef1234567890abcdef12345678',
              signTypedData: vi.fn(),
              readContract: vi.fn(),
            },
            // A paid pool acquisition (the x402 transport) needs payForPool since #109
            payForPool: true,
          },
        });

        await expect(client.acquireStamp()).rejects.toThrow('@x402/fetch could not be loaded');

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ batch_id: 'b'.repeat(64), depth: 17, size_name: 'small', fallback_used: false }),
        });
        await expect(client.acquireStamp()).resolves.toMatchObject({ batchId: 'b'.repeat(64) });
        expect(createX402Transport).toHaveBeenCalledTimes(2);
      } finally {
        vi.doUnmock('../../src/payment.js');
        vi.resetModules();
      }
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

    it('reads a Retry-After HTTP date into retryAfterSeconds (#123)', async () => {
      const now = Date.UTC(2026, 9, 21, 12, 0, 0);
      vi.useFakeTimers({ toFake: ['Date'], now });
      try {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          headers: new Headers({ 'Retry-After': new Date(now + 60_000).toUTCString() }),
        });
        const error = await new ProvenanceClient().notaryInfo().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(PaymentRateLimitError);
        expect((error as PaymentRateLimitError).retryAfterSeconds).toBe(60);
      } finally {
        vi.useRealTimers();
      }
    });

    it('gives retryAfterSeconds undefined for a Retry-After above Number.MAX_SAFE_INTEGER (#185)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: new Headers({ 'Retry-After': '99999999999999999999999' }),
      });
      const error = await new ProvenanceClient().notaryInfo().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PaymentRateLimitError);
      expect((error as PaymentRateLimitError).retryAfterSeconds).toBeUndefined();
      expect((error as PaymentRateLimitError).message).not.toContain('e+');
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

    it('waits until a Retry-After given as an HTTP date (#123)', async () => {
      const now = Date.UTC(2026, 9, 21, 12, 0, 0);
      vi.useFakeTimers({ toFake: ['setTimeout', 'Date'], now });
      try {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          headers: new Headers({ 'Retry-After': new Date(now + 3_000).toUTCString() }),
        });
        mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: 'ok' }) });

        const client = new ProvenanceClient({ payment: 'none', retry: { maxRetries: 1, baseDelayMs: 1 } });
        const health = client.health();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1_100);
        await expect(health).resolves.toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('uses the normal backoff for a Retry-After above Number.MAX_SAFE_INTEGER (#185)', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      try {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          headers: new Headers({ 'Retry-After': '99999999999999999999999' }),
        });
        mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: 'ok' }) });

        const client = new ProvenanceClient({ payment: 'none', retry: { maxRetries: 1, baseDelayMs: 1_000 } });
        const health = client.health();
        await vi.advanceTimersByTimeAsync(900);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(200);
        await expect(health).resolves.toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    describe('Retry-After cap (#161)', () => {
      const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
      const rateLimited = (retryAfter?: string, code?: string) =>
        new Response(JSON.stringify(code ? { code, message: 'Too many requests.' } : { detail: 'Too many requests.' }), {
          status: 429,
          statusText: 'Too Many Requests',
          headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter },
        });
      const ok = () => new Response(JSON.stringify({ enabled: true, available: true }), { status: 200 });

      /** Settle state of a promise, without waiting for it */
      function track<T>(promise: Promise<T>) {
        const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
        promise.then(
          (value) => Object.assign(state, { settled: true, value }),
          (error: unknown) => Object.assign(state, { settled: true, error })
        );
        return state;
      }

      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'Date'], now: NOW });
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      it.each([
        ['a large delta-seconds value', '3600', 3600],
        ['an HTTP date one day ahead', new Date(NOW + 86_400_000).toUTCString(), 86_400],
      ])('throws at once, without waiting, for %s', async (_label, retryAfter, seconds) => {
        mockFetch.mockResolvedValueOnce(rateLimited(retryAfter));
        mockFetch.mockResolvedValueOnce(ok());
        const client = new ProvenanceClient({ payment: 'none', retry: { maxRetries: 2, baseDelayMs: 1 } });
        const result = track(client.notaryInfo());
        await vi.advanceTimersByTimeAsync(1_000);

        expect(result.settled).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const error = result.error as GatewayConnectionError;
        expect(error).toBeInstanceOf(GatewayConnectionError);
        expect(error.statusCode).toBe(429);
        expect(error.retryAfterSeconds).toBe(seconds);
        expect(error.message).toContain(`asked to wait ${seconds} s`);
        expect(error.message).toContain('60 s');
      });

      it('throws a pool StampError with the gateway code at once', async () => {
        mockFetch.mockResolvedValueOnce(rateLimited('120', 'RATE_LIMIT_EXCEEDED'));
        mockFetch.mockResolvedValueOnce(ok());
        const client = new ProvenanceClient({ payment: 'none', retry: { maxRetries: 2, baseDelayMs: 1 } });
        const result = track(client.acquireStamp());
        await vi.advanceTimersByTimeAsync(1_000);

        expect(result.settled).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const error = result.error as StampError;
        expect(error).toBeInstanceOf(StampError);
        expect(error.code).toBe('RATE_LIMIT_EXCEEDED');
        expect(error.retryAfterSeconds).toBe(120);
        expect(error.message).toContain('asked to wait 120 s');
      });

      it('waits and retries at exactly 60 s', async () => {
        mockFetch.mockResolvedValueOnce(rateLimited('60'));
        mockFetch.mockResolvedValueOnce(ok());
        const client = new ProvenanceClient({ payment: 'none', retry: { maxRetries: 1, baseDelayMs: 1 } });
        const result = track(client.notaryInfo());
        await vi.advanceTimersByTimeAsync(59_000);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(result.settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1_100);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(result.error).toBeUndefined();
        expect(result.value).toEqual({ enabled: true, available: true, address: undefined });
      });

      it.each([
        ['0', '0'],
        ['a past date', new Date(NOW - 60_000).toUTCString()],
        ['a missing header (backoff)', undefined],
        ['a negative number (backoff)', '-5'],
        ['an unparsable value (backoff)', 'soon'],
      ])('retries without the cap for %s', async (_label, retryAfter) => {
        mockFetch.mockResolvedValueOnce(rateLimited(retryAfter));
        mockFetch.mockResolvedValueOnce(ok());
        const client = new ProvenanceClient({ payment: 'none', retry: { maxRetries: 1, baseDelayMs: 1 } });
        const result = track(client.notaryInfo());
        await vi.advanceTimersByTimeAsync(10);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(result.error).toBeUndefined();
        expect(result.settled).toBe(true);
      });

      it('puts retryAfterSeconds on the error after retries run out, without the cap sentence', async () => {
        mockFetch.mockResolvedValue(rateLimited('1'));
        const client = new ProvenanceClient({ payment: 'none', retry: { maxRetries: 1, baseDelayMs: 1 } });
        const result = track(client.notaryInfo());
        await vi.advanceTimersByTimeAsync(1_100);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        const error = result.error as GatewayConnectionError;
        expect(error).toBeInstanceOf(GatewayConnectionError);
        expect(error.retryAfterSeconds).toBe(1);
        expect(error.message).not.toContain('did not retry');
      });

      it("throws a NotaryError for a sign: 'notary' upload at once", async () => {
        mockFetch.mockResolvedValueOnce(rateLimited('120', 'RATE_LIMIT_EXCEEDED'));
        mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ reference: 'b'.repeat(64) }), { status: 200 }));
        const client = new ProvenanceClient({ payment: 'none', retry: { maxRetries: 2, baseDelayMs: 1 } });
        const result = track(client.upload('Hello', { stampId: 'a'.repeat(64), sign: 'notary' }));
        await vi.advanceTimersByTimeAsync(1_000);

        expect(result.settled).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const error = result.error as NotaryError;
        expect(error).toBeInstanceOf(NotaryError);
        expect(error.code).toBe('RATE_LIMIT_EXCEEDED');
        expect(error.retryAfterSeconds).toBe(120);
        expect(error.message).toContain('asked to wait 120 s');
      });

      it('keeps the cap sentence within the error text cap for a long gateway message', async () => {
        /** src/client.ts MAX_ERROR_TEXT (not exported): the cap on error messages, in UTF-16 code units */
        const MAX_ERROR_TEXT = 4096;
        const longMessage = 'x'.repeat(MAX_ERROR_TEXT - 10);
        mockFetch.mockResolvedValueOnce(
          new Response(JSON.stringify({ code: 'RATE_LIMIT_EXCEEDED', message: longMessage }), {
            status: 429,
            headers: { 'Retry-After': '3600' },
          })
        );
        const client = new ProvenanceClient({ payment: 'none', retry: { maxRetries: 2, baseDelayMs: 1 } });
        const result = track(client.notaryInfo());
        await vi.advanceTimersByTimeAsync(1_000);

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const error = result.error as GatewayConnectionError;
        expect(error).toBeInstanceOf(GatewayConnectionError);
        expect(error.message.length).toBeLessThanOrEqual(MAX_ERROR_TEXT);
        expect(error.message).toMatch(/The SDK did not retry: the gateway asked to wait 3600 s .*See retryAfterSeconds\.$/);
        expect(error.message.startsWith('xxxx')).toBe(true);
      });

      it("leaves the free tier as it is: PaymentRateLimitError at once, with retryAfterSeconds", async () => {
        mockFetch.mockResolvedValueOnce(rateLimited('3600'));
        const client = new ProvenanceClient({ retry: { maxRetries: 2, baseDelayMs: 1 } });
        const error = await client.notaryInfo().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(PaymentRateLimitError);
        expect((error as PaymentRateLimitError).retryAfterSeconds).toBe(3600);
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });
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
          batch_id: POOL_BATCH_ID,
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
          batch_id: POOL_BATCH_ID,
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

    it('a 402 lists at most 3 prices and stays within the 4096-character cap', async () => {
      const many = { ...x402Body, accepts: Array.from({ length: 2000 }, () => x402Body.accepts[0]) };
      mockFetch.mockResolvedValueOnce(json({ ...many, code: 'HTTP_402', message: x402Body.error }, 402));
      const error = await new ProvenanceClient({ payment: 'none' }).upload('hello', { stampId: STAMP }).catch((e: unknown) => e);
      const message = (error as Error).message;
      expect(message).toContain('0.01 USDC on base-sepolia or 0.01 USDC on base-sepolia or 0.01 USDC on base-sepolia (and 1997 more)');
      expect(message.split('USDC')).toHaveLength(4);

      mockFetch.mockResolvedValueOnce(json({ ...x402Body, code: 'HTTP_402', message: 'p'.repeat(5000) }, 402));
      const long = await new ProvenanceClient({ payment: 'none' }).upload('hello', { stampId: STAMP }).catch((e: unknown) => e);
      expect((long as Error).message.length).toBeLessThanOrEqual(4096);
      // The price always appears: the gateway's message is cut to make room for it
      expect((long as Error).message).toMatch(/…\s\(price: 0\.01 USDC on base-sepolia\)$/);
    });

    it('a 402 with the payment request only under the deprecated detail still shows the price', async () => {
      mockFetch.mockResolvedValueOnce(json({ detail: x402Body }, 402, 'Payment Required'));
      const error = await new ProvenanceClient({ payment: 'none' }).upload('hello', { stampId: STAMP }).catch((e: unknown) => e);
      expect((error as Error).message).toContain(x402Body.error);
      expect((error as Error).message).toContain('0.01 USDC on base-sepolia');
    });

    // Pins (#209): the exact message for today's v1-only 402s, top level and under detail
    it('pin: the exact message of a v1 402 in the body, top level or under detail', async () => {
      const expected = `${x402Body.error} (price: 0.01 USDC on base-sepolia)`;
      for (const body of [{ ...x402Body, code: 'HTTP_402', message: x402Body.error }, { detail: x402Body }]) {
        mockFetch.mockResolvedValueOnce(json(body, 402, 'Payment Required'));
        const error = await new ProvenanceClient({ payment: 'none' }).upload('hello', { stampId: STAMP }).catch((e: unknown) => e);
        expect((error as Error).message).toBe(expected);
        expect((error as GatewayConnectionError).statusCode).toBe(402);
      }
    });

    it('pin: a v1 402 for another token or network names it as offered', async () => {
      const option = { ...x402Body.accepts[0]!, network: 'polygon', asset: '0x2222222222222222222222222222222222222222', maxAmountRequired: '7' };
      mockFetch.mockResolvedValueOnce(json({ ...x402Body, accepts: [option] }, 402));
      const error = await new ProvenanceClient({ payment: 'none' }).upload('hello', { stampId: STAMP }).catch((e: unknown) => e);
      expect((error as Error).message).toBe(
        `${x402Body.error} (price: 7 smallest units of 0x2222222222222222222222222222222222222222 on polygon)`
      );
    });

    describe('x402 v2: the price from the PAYMENT-REQUIRED header (#167, #209)', () => {
      const v2Request = (accepts: unknown[] = [{ ...x402Body.accepts[0]!, network: 'eip155:84532', amount: '25000', maxAmountRequired: undefined }]) => ({
        x402Version: 2,
        error: 'Payment required',
        resource: { url: 'http://gateway.test/api/v1/data/' },
        accepts,
      });
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
      const answer = (body: string, headers: Record<string, string>) =>
        new Response(body, { status: 402, statusText: 'Payment Required', headers: { 'content-type': 'application/json', ...headers } });
      const upload = () => new ProvenanceClient({ payment: 'none' }).upload('hello', { stampId: STAMP }).catch((e: unknown) => e) as Promise<Error>;

      it("a header-only v2 402 in 'none' mode names the v2 price", async () => {
        mockFetch.mockResolvedValueOnce(answer('{}', { 'PAYMENT-REQUIRED': encode(v2Request()) }));
        const error = await upload();
        expect(error).toBeInstanceOf(GatewayConnectionError);
        expect(error.message).toBe('Gateway error: 402 Payment Required (price: 0.025 USDC on base-sepolia)');
      });

      it('a header-only v2 402 with a body that is not JSON still names the price', async () => {
        mockFetch.mockResolvedValueOnce(answer('', { 'PAYMENT-REQUIRED': encode(v2Request()) }));
        expect((await upload()).message).toBe('Gateway error: 402 Payment Required (price: 0.025 USDC on base-sepolia)');
      });

      it('a dual-mode 402 (v1 body, v2 header) names the header price, as @x402/core pays it', async () => {
        mockFetch.mockResolvedValueOnce(answer(JSON.stringify(x402Body), { 'PAYMENT-REQUIRED': encode(v2Request()) }));
        const error = await upload();
        expect(error.message).toContain('(price: 0.025 USDC on base-sepolia)');
        expect(error.message).not.toContain('0.01 USDC');
      });

      it('header text that is not a network, address or amount never reaches the message', async () => {
        const evil = '<script>alert(1)</script>';
        const accepts = [
          { ...x402Body.accepts[0]!, network: evil, asset: evil, amount: '5', maxAmountRequired: undefined },
          { ...x402Body.accepts[0]!, network: 'eip155:84532', amount: evil, maxAmountRequired: undefined },
        ];
        mockFetch.mockResolvedValueOnce(answer('{}', { 'PAYMENT-REQUIRED': encode(v2Request(accepts)) }));
        const error = await upload();
        expect(error.message).toBe('Gateway error: 402 Payment Required (price: 5 smallest units of ? on ?)');
        expect(error.message).not.toContain('script');
      });

      it('a CAIP-2 network with no known v1 name is shown as offered', async () => {
        const accepts = [{ ...x402Body.accepts[0]!, network: 'eip155:137', asset: '0x2222222222222222222222222222222222222222', amount: '7' }];
        mockFetch.mockResolvedValueOnce(answer('{}', { 'PAYMENT-REQUIRED': encode(v2Request(accepts)) }));
        expect((await upload()).message).toBe(
          'Gateway error: 402 Payment Required (price: 7 smallest units of 0x2222222222222222222222222222222222222222 on eip155:137)'
        );
      });

      it.each([
        ['undecodable', '%%%not-base64%%%'],
        ['too long', encode({ ...v2Request(), padding: 'x'.repeat(9000) })],
        ['not an object', encode([v2Request()])],
        ['without accepts', encode({ x402Version: 2, error: 'Payment required' })],
      ])('a PAYMENT-REQUIRED header that is %s falls back to the body price', async (_name, header) => {
        mockFetch.mockResolvedValueOnce(answer(JSON.stringify(x402Body), { 'PAYMENT-REQUIRED': header }));
        expect((await upload()).message).toBe(`${x402Body.error} (price: 0.01 USDC on base-sepolia)`);
      });
    });

    it('a non-JSON error body is kept as text, capped at 4096 characters', async () => {
      const page = `<html><body>${'Bad gateway. '.repeat(1000)}</body></html>`;
      mockFetch.mockResolvedValueOnce(new Response(page, { status: 502, statusText: 'Bad Gateway' }));
      const error = await new ProvenanceClient({ retry: { maxRetries: 0 } }).notaryInfo().catch((e: unknown) => e);
      const body = (error as ProvenanceError).body;
      expect(typeof body).toBe('string');
      expect((body as string).length).toBe(4096);
      expect(page.startsWith((body as string).slice(0, 100))).toBe(true);
      expect((error as Error).message).toBe('Gateway error: 502 Bad Gateway');
    });

    it('a long gateway message is capped at 4096 characters, with an ellipsis', async () => {
      mockFetch.mockResolvedValueOnce(json({ code: 'X', message: 'm'.repeat(10_000) }, 400));
      const error = await new ProvenanceClient().notaryInfo().catch((e: unknown) => e);
      expect((error as Error).message).toBe(`${'m'.repeat(4095)}…`);

      mockFetch.mockResolvedValueOnce(json({ detail: { error: 'e'.repeat(3000), detail: 'd'.repeat(3000) } }, 400));
      const nested = await new ProvenanceClient().notaryInfo().catch((e: unknown) => e);
      expect((nested as Error).message).toBe(`${'e'.repeat(3000)}: ${'d'.repeat(4095 - 3002)}…`);
    });

    it('a cut never splits a surrogate pair', async () => {
      // The emoji's high surrogate would be the last unit kept (index 4094)
      mockFetch.mockResolvedValueOnce(json({ code: 'X', message: `${'a'.repeat(4094)}\u{1F600}${'b'.repeat(10)}` }, 400));
      const error = await new ProvenanceClient().notaryInfo().catch((e: unknown) => e);
      expect((error as Error).message).toBe(`${'a'.repeat(4094)}…`);
    });

    it('a JSON body over 16384 characters is kept as its first 4096 characters of text; its code and message are still read', async () => {
      const body = { code: 'BIG_ERROR', message: 'Too much detail.', detail: { list: 'x'.repeat(20_000) } };
      mockFetch.mockResolvedValueOnce(json(body, 400));
      const error = await new ProvenanceClient().notaryInfo().catch((e: unknown) => e);
      expect((error as GatewayConnectionError).code).toBe('BIG_ERROR');
      expect((error as Error).message).toBe('Too much detail.');
      const kept = (error as ProvenanceError).body;
      expect(kept).toBe(`${JSON.stringify(body).slice(0, 4095)}…`);
    });

    it('a suggestion after a message ending in a full stop gets no second full stop', async () => {
      mockFetch.mockResolvedValueOnce(json(envelope({ code: 'POOL_EXHAUSTED', message: 'Pool is exhausted.', suggestion: 'Buy a stamp.' }), 409));
      const error = await new ProvenanceClient().acquireStamp().catch((e: unknown) => e);
      expect((error as Error).message).toBe('Pool is exhausted. Buy a stamp.');
    });

    it.each([Infinity, 1.5, 0, -1, NaN, '1000'])('maxUploadBytes %s is a configuration error', (value) => {
      const named = typeof value === 'string' ? JSON.stringify(value) : String(value);
      expect(() => new ProvenanceClient({ maxUploadBytes: value as number })).toThrow(
        `maxUploadBytes must be a positive integer (bytes), got ${named}`
      );
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
        const result = await new ProvenanceClient().upload(doc, { raw: true });
        const sent = JSON.parse(await sentFile(2)) as { data: unknown; content_hash: string };
        expect(sent.data).toEqual({ a: 1 });
        expect(sent.content_hash).toBe(sha256Hex(toBytes('{"a":1}')));
        // The result describes what was sent, not the caller's changed object
        expect(result.metadata.data).toEqual({ a: 1 });
        expect(result.metadata.content_hash).toBe(sent.content_hash);
        expect(verifyDocumentHash(result.metadata)).toBe(true);
      });

      // Bodies and hashes the base (ff3c522) produced for these raw inputs, with stampId STAMP
      it.each([
        ['an array string', '[1,2]', '[1,2]', '49a64717d5d4cb19952e6eac2946415cf6879adacf9908e7d872332d32c6e684'],
        ['an array value', [1, 2], '[1,2]', '49a64717d5d4cb19952e6eac2946415cf6879adacf9908e7d872332d32c6e684'],
        ["the string 'null'", 'null', 'null', '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b'],
        ["the string '5'", '5', '5', 'ef2d127de37b942baad06145e54b0c619a1f22327b2ebbcfbec78f5564afe39d'],
        ['a JSON string literal', '"x"', '"x"', 'ba2df4903a2c14e86dc3bcca58911b44ac1d2514b7227bf6eb08cfb978f55a1b'],
      ])('raw mode accepts %s as the base did, with the same body and hash', async (_label, content, dataJson, hash) => {
        mockFetch.mockResolvedValueOnce(json({ reference: 'b'.repeat(64) }, 200));
        const result = await new ProvenanceClient().upload(content as never, { raw: true, stampId: STAMP });
        const sent = await sentFile(0);
        expect(sent).toBe(`{"data":${dataJson},"content_hash":"${hash}","stamp_id":"${STAMP}"}`);
        expect(JSON.stringify(result.metadata)).toBe(sent);
      });

      it.each([
        ['a null value', null],
        ['a number value', 5],
      ])('raw mode refuses %s as the base did', async (_label, content) => {
        const error = await new ProvenanceClient().upload(content as never, { raw: true, stampId: STAMP }).catch((e: unknown) => e);
        expect((error as ProvenanceError).code).toBe('INVALID_INPUT');
        expect(mockFetch).not.toHaveBeenCalled();
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

describe('success bodies that are not the expected shape (#179)', () => {
  const REF = 'abcd1234'.repeat(8);
  const methods = {
    download: (c: ProvenanceClient) => c.download(REF),
    downloadDocument: (c: ProvenanceClient) => c.downloadDocument(REF),
    notaryInfo: (c: ProvenanceClient) => c.notaryInfo(),
    poolStatus: (c: ProvenanceClient) => c.poolStatus(),
  } as const;
  type Method = keyof typeof methods;

  beforeEach(() => {
    mockFetch.mockReset();
  });

  async function expectInvalid(method: Method, body: string | ReadableStream<Uint8Array>) {
    mockFetch.mockResolvedValueOnce(new Response(body, { status: 200 }));
    const error = await methods[method](new ProvenanceClient()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayConnectionError);
    expect((error as GatewayConnectionError).code).toBe('INVALID_RESPONSE');
    expect((error as GatewayConnectionError).statusCode).toBe(200);
    return error as GatewayConnectionError;
  }

  const bodies = ['null', '"str"', '42', '[]', '{}'];
  const cases = (Object.keys(methods) as Method[]).flatMap((m) => bodies.map((b) => [m, b] as const));

  it.each(cases)('%s() with the 200 body %s throws INVALID_RESPONSE', async (method, body) => {
    const error = await expectInvalid(method, body);
    expect(error.message).toMatch(/^Invalid response from gateway: expected a JSON object/);
  });

  it.each([
    ['download', 'direct body without content_hash', { data: 'aGVsbG8=', stamp_id: 's' }],
    ['download', 'direct body whose data is not a string', { data: 42, content_hash: '0'.repeat(64) }],
    ['download', 'wrapped body whose metadata.data is not a string', { metadata: { data: 42, content_hash: '0'.repeat(64) } }],
    ['downloadDocument', 'direct body without a data field', { content_hash: '0'.repeat(64), stamp_id: 's' }],
    ['downloadDocument', 'direct body whose content_hash is not a string', { data: { a: 1 }, content_hash: 42 }],
    ['downloadDocument', 'wrapped body without metadata.content_hash', { metadata: { data: { a: 1 } } }],
    ['notaryInfo', 'body without available', { enabled: true }],
    ['notaryInfo', 'body whose enabled is not a boolean', { enabled: 'yes', available: true }],
    ['poolStatus', 'body whose current_levels is null', { enabled: true, current_levels: null, reserve_config: {}, total_stamps: 1 }],
    ['poolStatus', 'body without total_stamps', { enabled: true, current_levels: {}, reserve_config: {} }],
    ['poolStatus', 'body without reserve_config', { enabled: true, current_levels: {}, total_stamps: 1 }],
  ] as const)('%s() with a %s throws INVALID_RESPONSE', async (method, _label, body) => {
    await expectInvalid(method, JSON.stringify(body));
  });

  it.each([['download'], ['downloadDocument']] as const)('%s() turns a body read failure into INVALID_RESPONSE', async (method) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('connection reset'));
      },
    });
    const error = await expectInvalid(method, stream);
    expect(error.message).toMatch(/connection reset/);
  });

  it('notaryInfo() still accepts a disabled notary with a null or absent address', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ enabled: false, available: false, address: null, message: 'off' }), { status: 200 }));
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ enabled: false, available: false }), { status: 200 }));
    const client = new ProvenanceClient();
    expect(await client.notaryInfo()).toEqual({ enabled: false, available: false, address: null, message: 'off' });
    expect(await client.notaryInfo()).toEqual({ enabled: false, available: false });
  });

  it('poolStatus() does not require low_reserve_warning or the fields it does not read', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ enabled: true, current_levels: { '17': 2 }, reserve_config: { '17': 1 }, total_stamps: 2 }), { status: 200 }));
    const status = await new ProvenanceClient().poolStatus();
    expect(status).toMatchObject({ enabled: true, available: { '17': 2 }, reserve: { '17': 1 }, totalStamps: 2 });
  });

  it.each([
    ['an array', '[1,2]', [1, 2]],
    ['null', 'null', null],
    ['a number', '5', 5],
    ['a string', '"x"', 'x'],
  ])('downloadDocument() returns a raw upload whose data is %s, with a matching hash', async (_label, content, value) => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ reference: 'b'.repeat(64) }), { status: 200 }));
    const uploaded = await new ProvenanceClient().upload(content, { raw: true, stampId: 'a'.repeat(64) });
    const call = mockFetch.mock.calls.at(0) as [string, RequestInit];
    const stored = await ((call[1].body as FormData).get('file') as Blob).text();
    mockFetch.mockResolvedValueOnce(new Response(stored, { status: 200 }));
    const result = await new ProvenanceClient().downloadDocument(REF);
    expect(result.document).toEqual(value);
    expect(result.metadata.content_hash).toBe(uploaded.metadata.content_hash);
  });

  it('download() ignores a wrapped signatures value that is not an array', async () => {
    const data = 'aGVsbG8=';
    const metadata = { data, content_hash: sha256Hex(toBytes('hello')), stamp_id: 's' };
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ metadata, signatures: 'abc' }), { status: 200 }));
    const result = await new ProvenanceClient().download(REF);
    expect(new TextDecoder().decode(result.file)).toBe('hello');
    expect(result.signatures).toBeUndefined();
    expect(result.verified).toBeUndefined();
  });

  it('downloadDocument() ignores a wrapped signatures value that is not an array', async () => {
    const doc = { a: 1 };
    const metadata = { data: doc, content_hash: sha256Hex(toBytes(JSON.stringify(doc))), stamp_id: 's' };
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ metadata, signatures: 'abc' }), { status: 200 }));
    const result = await new ProvenanceClient().downloadDocument(REF);
    expect(result.document).toEqual(doc);
    expect(result.signatures).toBeUndefined();
    expect(result.verified).toBeUndefined();
  });

  it('downloadDocument() still reports a well-formed record with a wrong hash as CONTENT_HASH_MISMATCH', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: { a: 1 }, content_hash: '0'.repeat(64), stamp_id: 's' }), { status: 200 }));
    await expect(new ProvenanceClient().downloadDocument(REF)).rejects.toMatchObject({ name: 'ProvenanceError', code: 'CONTENT_HASH_MISMATCH' });
  });

  it('download() still reports a well-formed record with a wrong hash as CONTENT_HASH_MISMATCH', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: 'aGVsbG8=', content_hash: '0'.repeat(64), stamp_id: 's' }), { status: 200 }));
    await expect(new ProvenanceClient().download(REF)).rejects.toMatchObject({ name: 'ProvenanceError', code: 'CONTENT_HASH_MISMATCH' });
  });
});

describe('pricing(), acquireStamp() and upload() success bodies that are not the expected shape (#199)', () => {
  const STAMP_ID = 'a'.repeat(64);
  const REFERENCE = 'b'.repeat(64);
  const QUOTE = { method: 'POST', path: '/api/v1/data/', price_usd: 0.01, max_amount_required: '10000', description: 'Upload' };
  /** GET /api/v1/pricing with x402 enabled, as the gateway sends it (app/api/endpoints/pricing.py) */
  const PRICING = {
    x402_enabled: true,
    currency: 'USDC',
    network: 'base-sepolia',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    pay_to: '0x1111111111111111111111111111111111111111',
    min_price_usd: 0.01,
    free_tier: { enabled: true, header: 'X-Payment-Mode: free' },
    quotes: {
      stamp_purchase: { ...QUOTE, path: '/api/v1/stamps/' },
      pool_acquire: { ...QUOTE, path: '/api/v1/pool/acquire' },
      data_upload: QUOTE,
      bandwidth_credit: { ...QUOTE, path: '/api/v1/chunks/credit' },
    },
  };
  /** POST /api/v1/pool/acquire, as the gateway sends it (AcquireStampResponse) */
  const ACQUIRED = {
    success: true,
    batch_id: STAMP_ID,
    depth: 17,
    size_name: 'small',
    message: 'Stamp acquired from pool (depth=17, size=small)',
    fallback_used: false,
    expires_at: '2026-12-01T10:00:00Z',
  };
  const POOL = { enabled: true, current_levels: { '17': 2 }, reserve_config: { '17': 1 }, total_stamps: 2, low_reserve_warning: false };

  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const methods = {
    pricing: (c: ProvenanceClient) => c.pricing(),
    acquireStamp: (c: ProvenanceClient) => c.acquireStamp(),
    upload: (c: ProvenanceClient) => c.upload('hello', { stampId: STAMP_ID }),
  } as const;
  type Method = keyof typeof methods;

  beforeEach(() => {
    mockFetch.mockReset();
  });

  async function expectInvalid(method: Method, body: string) {
    mockFetch.mockResolvedValueOnce(new Response(body, { status: 200 }));
    const error = await methods[method](new ProvenanceClient()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayConnectionError);
    expect((error as GatewayConnectionError).code).toBe('INVALID_RESPONSE');
    expect((error as GatewayConnectionError).statusCode).toBe(200);
    expect((error as Error).message).toMatch(/^Invalid response from gateway: expected a JSON object/);
    return error as GatewayConnectionError;
  }

  const bodies = ['null', '"str"', '42', '[]', '{}'];
  const cases = (Object.keys(methods) as Method[]).flatMap((m) => bodies.map((b) => [m, b] as const));

  it.each(cases)('%s() with the 200 body %s throws INVALID_RESPONSE', async (method, body) => {
    await expectInvalid(method, body);
  });

  it.each([
    ['pricing', 'x402_enabled that is not a boolean', { ...PRICING, x402_enabled: 'yes' }],
    ['pricing', 'quotes that is an array', { ...PRICING, quotes: [] }],
    ['pricing', 'quote that is not an object', { ...PRICING, quotes: { data_upload: 'cheap' } }],
    ['pricing', 'quote without price_usd', { ...PRICING, quotes: { data_upload: { ...QUOTE, price_usd: undefined } } }],
    ['pricing', 'quote whose max_amount_required is a number', { ...PRICING, quotes: { data_upload: { ...QUOTE, max_amount_required: 10000 } } }],
    ['pricing', 'quote whose amount is a number', { ...PRICING, quotes: { data_upload: { ...QUOTE, amount: 10000 } } }],
    ['pricing', 'quote without amount or max_amount_required', { ...PRICING, quotes: { data_upload: { ...QUOTE, max_amount_required: undefined } } }],
    ['pricing', 'quote whose amount and max_amount_required disagree', { ...PRICING, quotes: { data_upload: { ...QUOTE, amount: '99000000' } } }],
    ['pricing', 'quote without a description', { ...PRICING, quotes: { data_upload: { ...QUOTE, description: undefined } } }],
    ['pricing', 'free_tier without a header', { ...PRICING, free_tier: { enabled: true } }],
    ['pricing', 'free_tier that is a boolean', { ...PRICING, free_tier: true }],
    ['pricing', 'pay_to that is a number', { ...PRICING, pay_to: 42 }],
    ['pricing', 'min_price_usd that is a string', { ...PRICING, min_price_usd: '0.01' }],
    ['pricing', 'currency that is an object', { ...PRICING, currency: {} }],
    ['acquireStamp', 'body without batch_id', { ...ACQUIRED, batch_id: undefined }],
    ['acquireStamp', 'batch_id that is null', { ...ACQUIRED, batch_id: null }],
    ['acquireStamp', 'batch_id that is not hex', { ...ACQUIRED, batch_id: 'z'.repeat(64) }],
    ['acquireStamp', 'batch_id of 63 characters', { ...ACQUIRED, batch_id: 'a'.repeat(63) }],
    ['acquireStamp', 'depth that is a string', { ...ACQUIRED, depth: '17' }],
    ['acquireStamp', 'body without size_name', { ...ACQUIRED, size_name: undefined }],
    ['acquireStamp', 'fallback_used that is not a boolean', { ...ACQUIRED, fallback_used: 'no' }],
    ['upload', 'reference that is a number', { reference: 42 }],
    ['upload', 'reference that is not hex', { reference: 'xyz' }],
    ['upload', 'reference of 96 hex characters', { reference: 'b'.repeat(96) }],
    ['upload', 'reference that is null', { reference: null, message: 'ok' }],
  ] as const)('%s() with a %s throws INVALID_RESPONSE', async (method, _label, body) => {
    await expectInvalid(method, JSON.stringify(body));
  });

  it('upload() with sign: notary reports a malformed 200 as INVALID_RESPONSE, not a NotaryError', async () => {
    mockFetch.mockResolvedValueOnce(json({ message: 'ok' }));
    const error = await new ProvenanceClient().upload('hello', { stampId: STAMP_ID, sign: 'notary' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayConnectionError);
    expect(error).not.toBeInstanceOf(NotaryError);
    expect((error as GatewayConnectionError).code).toBe('INVALID_RESPONSE');
  });

  it('upload() with a pool stamp names the stamp when the upload body is malformed', async () => {
    mockFetch.mockResolvedValueOnce(json(POOL));
    mockFetch.mockResolvedValueOnce(json(ACQUIRED));
    mockFetch.mockResolvedValueOnce(json({}));
    const error = await new ProvenanceClient().upload('hello').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayConnectionError);
    expect((error as GatewayConnectionError).code).toBe('INVALID_RESPONSE');
    expect((error as GatewayConnectionError).stampId).toBe(STAMP_ID);
  });

  it.each([
    ['{}', {}],
    ['null', null],
    ['a body without batch_id', { ...ACQUIRED, batch_id: undefined }],
  ])('upload() does not send the data when the pool acquisition answers %s', async (_label, body) => {
    mockFetch.mockResolvedValueOnce(json(POOL));
    mockFetch.mockResolvedValueOnce(json(body));
    mockFetch.mockResolvedValueOnce(json({ reference: REFERENCE }));
    const error = await new ProvenanceClient().upload('hello').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayConnectionError);
    expect((error as GatewayConnectionError).code).toBe('INVALID_RESPONSE');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls.some(([url]) => String(url).includes('/api/v1/data/'))).toBe(false);
  });

  it('poolStatus() returns lowReserveWarning false when the gateway leaves it out', async () => {
    mockFetch.mockResolvedValueOnce(json({ ...POOL, low_reserve_warning: undefined }));
    const status = await new ProvenanceClient().poolStatus();
    expect(status.lowReserveWarning).toBe(false);
  });

  it.each([['the string "true"', 'true'], ['null', null], ['1', 1]])(
    'poolStatus() throws INVALID_RESPONSE for low_reserve_warning %s',
    async (_label, value) => {
      mockFetch.mockResolvedValueOnce(json({ ...POOL, low_reserve_warning: value }));
      const error = await new ProvenanceClient().poolStatus().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GatewayConnectionError);
      expect((error as GatewayConnectionError).code).toBe('INVALID_RESPONSE');
      expect((error as GatewayConnectionError).statusCode).toBe(200);
    }
  );

  it.each([true, false])('poolStatus() keeps low_reserve_warning %s and ignores the fields it does not read', async (value) => {
    mockFetch.mockResolvedValueOnce(
      json({
        ...POOL,
        low_reserve_warning: value,
        available_stamps: { '17': [STAMP_ID] },
        pending_stamps: { '20': 1 },
        last_check: null,
        next_check: '2026-11-03T10:15:00Z',
        errors: [],
      })
    );
    expect((await new ProvenanceClient().poolStatus()).lowReserveWarning).toBe(value);
  });

  it('pricing() accepts the gateway answer with x402 disabled', async () => {
    mockFetch.mockResolvedValueOnce(json({ x402_enabled: false, quotes: {} }));
    expect(await new ProvenanceClient().pricing()).toEqual({ x402Enabled: false, quotes: {} });
  });

  it('pricing() accepts the full gateway answer', async () => {
    mockFetch.mockResolvedValueOnce(json(PRICING));
    const pricing = await new ProvenanceClient().pricing();
    expect(pricing).toMatchObject({
      x402Enabled: true,
      currency: 'USDC',
      payTo: PRICING.pay_to,
      minPriceUsd: 0.01,
      freeTier: { enabled: true, header: 'X-Payment-Mode: free' },
    });
    expect(Object.keys(pricing.quotes).sort()).toEqual(['bandwidthCredit', 'dataUpload', 'poolAcquire', 'stampPurchase']);
    expect(pricing.quotes.dataUpload).toEqual({ method: 'POST', path: '/api/v1/data/', priceUsd: 0.01, amount: '10000', maxAmountRequired: '10000', description: 'Upload' });
  });

  it('pricing() accepts an answer without the pool and bandwidth quotes, with the free tier off', async () => {
    const quotes = { stamp_purchase: PRICING.quotes.stamp_purchase, data_upload: PRICING.quotes.data_upload };
    mockFetch.mockResolvedValueOnce(json({ ...PRICING, free_tier: { enabled: false, header: 'X-Payment-Mode: free' }, quotes }));
    const pricing = await new ProvenanceClient().pricing();
    expect(Object.keys(pricing.quotes).sort()).toEqual(['dataUpload', 'stampPurchase']);
    expect(pricing.freeTier).toEqual({ enabled: false, header: 'X-Payment-Mode: free' });
  });

  it('pricing() treats absent quotes and null optional fields as absent', async () => {
    mockFetch.mockResolvedValueOnce(json({ x402_enabled: true, currency: null, pay_to: null, free_tier: null, quotes: { data_upload: null } }));
    expect(await new ProvenanceClient().pricing()).toEqual({ x402Enabled: true, quotes: {} });
    mockFetch.mockResolvedValueOnce(json({ ...PRICING, quotes: null }));
    expect((await new ProvenanceClient().pricing()).quotes).toEqual({});
    mockFetch.mockResolvedValueOnce(json({ x402_enabled: false }));
    expect(await new ProvenanceClient().pricing()).toEqual({ x402Enabled: false, quotes: {} });
  });

  it.each([
    ['expires_at as a string', { expires_at: '2026-12-01T10:00:00Z' }, { expiresAt: '2026-12-01T10:00:00Z' }],
    ['expires_at null', { expires_at: null }, {}],
    ['no expires_at', {}, {}],
    ['fallback_used true', { fallback_used: true, depth: 20, size_name: 'medium' }, { fallbackUsed: true, depth: 20, sizeName: 'medium' }],
    ['no fallback_used', { fallback_used: undefined }, { fallbackUsed: false }],
    ['an uppercase batch_id, returned in lowercase', { batch_id: 'A'.repeat(64) }, { batchId: 'a'.repeat(64) }],
  ])('acquireStamp() accepts a gateway answer with %s', async (_label, overrides, expected) => {
    mockFetch.mockResolvedValueOnce(json({ ...ACQUIRED, expires_at: undefined, ...overrides }));
    const stamp = await new ProvenanceClient().acquireStamp();
    expect(stamp).toMatchObject({ batchId: STAMP_ID, depth: 17, sizeName: 'small', fallbackUsed: false, ...expected });
    expect(typeof stamp.fallbackUsed).toBe('boolean');
    if (!('expiresAt' in expected)) expect(stamp.expiresAt).toBeUndefined();
  });

  it.each([
    ['expires_at as a string', { reference: REFERENCE, message: 'ok', expires_at: '2026-12-01T10:00:00Z' }, REFERENCE],
    ['expires_at null', { reference: REFERENCE, expires_at: null }, REFERENCE],
    ['timing', { reference: REFERENCE, message: 'ok', timing: { file_read_ms: 1, bee_upload_ms: 2, total_ms: 3 } }, REFERENCE],
    ['a 128-hex reference', { reference: 'c'.repeat(128) }, 'c'.repeat(128)],
  ])('upload() accepts a gateway answer with %s', async (_label, body, reference) => {
    mockFetch.mockResolvedValueOnce(json(body));
    const result = await new ProvenanceClient().upload('hello', { stampId: STAMP_ID });
    expect(result.reference).toBe(reference);
    if (typeof (body as { expires_at?: unknown }).expires_at === 'string') expect(result.expiresAt).toBe('2026-12-01T10:00:00Z');
    else expect(result.expiresAt).toBeUndefined();
  });

  it('upload() with sign: notary accepts the gateway answer', async () => {
    mockFetch.mockResolvedValueOnce(json({ reference: REFERENCE, message: 'ok', expires_at: null }));
    const result = await new ProvenanceClient().upload('hello', { stampId: STAMP_ID, sign: 'notary' });
    expect(result.reference).toBe(REFERENCE);
  });

  it('upload() sends an uppercase pool batch_id in lowercase, as a caller stampId (#168)', async () => {
    const upper = 'ABCDEF01'.repeat(8);
    mockFetch.mockResolvedValueOnce(json(POOL));
    mockFetch.mockResolvedValueOnce(json({ ...ACQUIRED, batch_id: upper }));
    mockFetch.mockResolvedValueOnce(json({ reference: REFERENCE }));
    const result = await new ProvenanceClient().upload('hello');
    const [url, init] = mockFetch.mock.calls[2] as [string, RequestInit];
    expect(new URL(url).searchParams.get('stamp_id')).toBe(upper.toLowerCase());
    const sent = JSON.parse(await ((init.body as FormData).get('file') as Blob).text()) as { stamp_id: string };
    expect(sent.stamp_id).toBe(upper.toLowerCase());
    expect(result.metadata.stamp_id).toBe(upper.toLowerCase());
  });

  it('upload() from the pool accepts the gateway answers', async () => {
    mockFetch.mockResolvedValueOnce(json(POOL));
    mockFetch.mockResolvedValueOnce(json(ACQUIRED));
    mockFetch.mockResolvedValueOnce(json({ reference: REFERENCE, message: 'ok' }));
    const result = await new ProvenanceClient().upload('hello');
    expect(result.reference).toBe(REFERENCE);
    expect(result.metadata.stamp_id).toBe(STAMP_ID);
  });
});

describe('wrong download method for the record format (#190)', () => {
  const REF = 'abcd1234'.repeat(8);
  const TO_DOCUMENT = /use downloadDocument\(\) for raw uploads/;
  const TO_DOWNLOAD = /use download\(\) for base64 uploads/;

  beforeEach(() => {
    mockFetch.mockReset();
  });

  /** Upload content and return the record body the gateway stored */
  async function stored(content: unknown, raw: boolean): Promise<string> {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ reference: 'b'.repeat(64) }), { status: 200 }));
    await new ProvenanceClient().upload(content as string, raw ? { raw: true, stampId: 'a'.repeat(64) } : { stampId: 'a'.repeat(64) });
    const call = mockFetch.mock.calls.at(0) as [string, RequestInit];
    const body = await ((call[1].body as FormData).get('file') as Blob).text();
    mockFetch.mockReset();
    return body;
  }

  /** A 200 response as a plain object: Response itself needs Buffer, which one block removes */
  const ok = (body: string) => ({ ok: true, status: 200, headers: new Headers(), text: () => Promise.resolve(body) });

  /**
   * Run a download without Buffer, so that utils.base64ToBytes decodes with
   * atob as in browsers. Buffer is back before any assertion runs.
   */
  async function withoutBuffer<T>(run: () => Promise<T>): Promise<T> {
    const saved = globalThis.Buffer;
    (globalThis as { Buffer?: unknown }).Buffer = undefined;
    try {
      return await run();
    } finally {
      globalThis.Buffer = saved;
    }
  }

  async function failure(method: 'download' | 'downloadDocument', body: string, browser = false): Promise<ProvenanceError> {
    mockFetch.mockResolvedValueOnce(ok(body));
    const client = new ProvenanceClient();
    const run = () => (method === 'download' ? client.download(REF) : client.downloadDocument(REF)).catch((e: unknown) => e);
    const error = await (browser ? withoutBuffer(run) : run());
    expect(error).toBeInstanceOf(ProvenanceError);
    return error as ProvenanceError;
  }

  const wrap = (body: string) => {
    const { signatures, ...metadata } = JSON.parse(body) as Record<string, unknown>;
    return JSON.stringify(signatures === undefined ? { metadata } : { metadata, signatures });
  };

  it.each([
    ['a file', 'hello'],
    ['a file that is JSON text', '{"a":1}'],
  ])('downloadDocument() on a base64 upload of %s names download()', async (_label, content) => {
    const body = await stored(content, false);
    for (const record of [body, wrap(body)]) {
      const error = await failure('downloadDocument', record);
      expect(error.code).toBe('CONTENT_HASH_MISMATCH');
      expect(error.message).toMatch(TO_DOWNLOAD);
      expect(error.message).not.toMatch(/^Content hash verification failed/);
    }
  });

  it.each([
    ['an object', { a: 1 }],
    ['an array', '[1,2]'],
    ['null', 'null'],
    ['a number', '5'],
    ['true', 'true'],
    ['false', 'false'],
  ])('download() on a raw upload whose data is %s names downloadDocument()', async (_label, content) => {
    const body = await stored(content, true);
    for (const record of [body, wrap(body)]) {
      const error = await failure('download', record);
      expect(error).toBeInstanceOf(GatewayConnectionError);
      expect(error.code).toBe('INVALID_RESPONSE');
      expect((error as GatewayConnectionError).statusCode).toBe(200);
      expect(error.message).toMatch(TO_DOCUMENT);
      expect(error.message).not.toMatch(/^Invalid response from gateway/);
    }
  });

  it('download() on a raw upload whose data is a JSON string names downloadDocument()', async () => {
    const body = await stored('"x"', true);
    expect((JSON.parse(body) as { data: unknown }).data).toBe('x');
    for (const record of [body, wrap(body)]) {
      const error = await failure('download', record);
      expect(error.code).toBe('CONTENT_HASH_MISMATCH');
      expect(error.message).toMatch(TO_DOCUMENT);
    }
  });

  it('a tampered base64 record through download() keeps the plain CONTENT_HASH_MISMATCH', async () => {
    const error = await failure('download', JSON.stringify({ data: 'aGVsbG8=', content_hash: '0'.repeat(64), stamp_id: 's' }));
    expect(error.code).toBe('CONTENT_HASH_MISMATCH');
    expect(error.message).toBe('Content hash verification failed');
  });

  it('a tampered raw record through downloadDocument() keeps the plain CONTENT_HASH_MISMATCH', async () => {
    const error = await failure('downloadDocument', JSON.stringify({ data: { a: 1 }, content_hash: '0'.repeat(64), stamp_id: 's' }));
    expect(error.code).toBe('CONTENT_HASH_MISMATCH');
    expect(error.message).toBe('Content hash verification failed');
  });

  it.each([['download'], ['downloadDocument']] as const)(
    'a string-data record that matches neither format through %s() keeps the plain CONTENT_HASH_MISMATCH',
    async (method) => {
      const error = await failure(method, JSON.stringify({ data: 'x', content_hash: '0'.repeat(64), stamp_id: 's' }));
      expect(error.code).toBe('CONTENT_HASH_MISMATCH');
      expect(error.message).toBe('Content hash verification failed');
    }
  );

  it('a tampered raw record with non-string data through download() keeps the #179 shape message, no hint', async () => {
    for (const record of [
      { data: { a: 2 }, content_hash: '0'.repeat(64), stamp_id: 's' },
      { metadata: { data: [1, 2], content_hash: sha256Hex(toBytes('[1,3]')), stamp_id: 's' } },
    ]) {
      const error = await failure('download', JSON.stringify(record));
      expect(error).toBeInstanceOf(GatewayConnectionError);
      expect(error.code).toBe('INVALID_RESPONSE');
      expect(error.message).toMatch(/^Invalid response from gateway: expected a JSON object with string "data"/);
      expect(error.message).not.toMatch(TO_DOCUMENT);
    }
  });

  /**
   * A notary fixture (direct format) and the same record in the wrapped format.
   * The wrapped text is built from the fixture text, not with JSON.stringify,
   * so 2.0 and big integers in the raw fixture stay as they are.
   */
  function signedRecords(name: string): string[] {
    const direct = readFileSync(new URL(`../fixtures/notary/${name}`, import.meta.url), 'utf8');
    const at = direct.lastIndexOf('"signatures"');
    const fields = direct.slice(0, at).trimEnd().replace(/,$/, '');
    const wrapped = `{"metadata": ${fields}\n}, ${direct.slice(at)}`;
    const parsed = JSON.parse(wrapped) as { metadata: Record<string, unknown>; signatures: unknown[] };
    expect(Object.keys(parsed)).toEqual(['metadata', 'signatures']);
    expect(parsed.metadata['content_hash']).toBe((JSON.parse(direct) as Record<string, unknown>)['content_hash']);
    return [direct, wrapped];
  }

  it('a notary-signed raw record through download() names downloadDocument(), direct and wrapped', async () => {
    // The fixture holds 2.0 and a big integer: the raw hash check needs the lossless canonical text
    for (const record of signedRecords('raw-document.json')) {
      expect(record).toContain('2.0');
      const error = await failure('download', record);
      expect(error.code).toBe('INVALID_RESPONSE');
      expect(error.message).toMatch(TO_DOCUMENT);
    }
  });

  it('a notary-signed base64 record through downloadDocument() names download(), direct and wrapped', async () => {
    for (const record of signedRecords('base64-document.json')) {
      const error = await failure('downloadDocument', record);
      expect(error.code).toBe('CONTENT_HASH_MISMATCH');
      expect(error.message).toMatch(TO_DOWNLOAD);
    }
  });

  it('a record without a string content_hash through download() keeps the #179 shape message', async () => {
    const error = await failure('download', JSON.stringify({ data: { a: 1 }, stamp_id: 's' }));
    expect(error.code).toBe('INVALID_RESPONSE');
    expect(error.message).toMatch(/^Invalid response from gateway: expected a JSON object/);
    expect(error.message).not.toMatch(TO_DOCUMENT);
  });

  describe('without Buffer (the browser atob decoder)', () => {
    it('download() on a raw string record that atob cannot decode names downloadDocument()', async () => {
      const body = JSON.stringify({ data: 'x', content_hash: sha256Hex(toBytes('"x"')), stamp_id: 's' });
      expect(() => atob('x')).toThrow();
      const error = await failure('download', body, true);
      expect(error.code).toBe('CONTENT_HASH_MISMATCH');
      expect(error.message).toMatch(TO_DOCUMENT);
    });

    it('download() on a record that atob cannot decode and that is not raw throws CONTENT_HASH_MISMATCH, as with Buffer', async () => {
      const error = await failure('download', JSON.stringify({ data: 'x', content_hash: '0'.repeat(64), stamp_id: 's' }), true);
      expect(error.code).toBe('CONTENT_HASH_MISMATCH');
      expect(error.message).toBe('Content hash verification failed');
    });

    it('downloadDocument() on a base64 record decoded with atob names download()', async () => {
      const body = JSON.stringify({ data: 'aGVsbG8=', content_hash: sha256Hex(toBytes('hello')), stamp_id: 's' });
      const error = await failure('downloadDocument', body, true);
      expect(error.code).toBe('CONTENT_HASH_MISMATCH');
      expect(error.message).toMatch(TO_DOWNLOAD);
    });

    it('downloadDocument() on a string record that atob cannot decode keeps the plain CONTENT_HASH_MISMATCH', async () => {
      const error = await failure('downloadDocument', JSON.stringify({ data: 'x', content_hash: '0'.repeat(64), stamp_id: 's' }), true);
      expect(error.code).toBe('CONTENT_HASH_MISMATCH');
      expect(error.message).toBe('Content hash verification failed');
    });
  });
});

describe('raw content JSON cannot represent, and the FILE_TOO_LARGE size hint (#202)', () => {
  const STAMP = 'a'.repeat(64);
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  /** Nested objects `levels` deep: { a: { a: ... {} } } */
  function nested(levels: number): Record<string, unknown> {
    const root: Record<string, unknown> = {};
    let node = root;
    for (let i = 0; i < levels; i++) {
      const child: Record<string, unknown> = {};
      node['a'] = child;
      node = child;
    }
    return root;
  }

  const circular: Record<string, unknown> = {};
  circular['self'] = circular;
  const circularInArray: Record<string, unknown> = { list: [] };
  (circularInArray['list'] as unknown[]).push({ back: circularInArray });

  const UNSERIALIZABLE: Array<[string, unknown, RegExp]> = [
    ['a circular object', circular, /circular/i],
    ['a circular reference through an array', circularInArray, /circular/i],
    ['a BigInt value', { n: 1n }, /BigInt/],
    ['a BigInt in an array', [1n], /BigInt/],
    ['a toJSON() that returns undefined', { toJSON: () => undefined }, /no JSON representation/],
    ['a toJSON() that throws', { toJSON: () => { throw new Error('toJSON failed'); } }, /toJSON failed/],
    ['a getter that throws', { get x() { throw new Error('getter failed'); } }, /getter failed/],
    ['nesting of 1500 levels', nested(1500), /nested deeper than 1000 levels/],
    ['nesting of 1000000 levels', nested(1_000_000), /nested too deeply/],
    ['JSON text nested 1500 levels', `${'{"a":'.repeat(1500)}{}${'}'.repeat(1500)}`, /nested deeper than 1000 levels/],
  ];

  describe.each([
    ['with a stampId', { stampId: STAMP }],
    ['from the pool', {}],
  ])('%s', (_label, options) => {
    it.each(UNSERIALIZABLE)('refuses %s with INVALID_INPUT before any request', async (_name, content, message) => {
      const error = await new ProvenanceClient()
        .upload(content as Record<string, unknown>, { ...options, raw: true })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProvenanceError);
      expect((error as ProvenanceError).code).toBe('INVALID_INPUT');
      expect((error as Error).message).toMatch(/^Raw mode content /);
      expect((error as Error).message).toMatch(message);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  it('keeps the JSON.stringify error as the cause', async () => {
    const error = (await new ProvenanceClient()
      .upload({ n: 1n }, { stampId: STAMP, raw: true })
      .catch((e: unknown) => e)) as Error;
    expect(error.cause).toBeInstanceOf(TypeError);
    expect((error.cause as Error).message).toMatch(/BigInt/);
  });

  it('does not call a RangeError from a toJSON() a nesting problem', async () => {
    const thrown = new RangeError('bad range');
    const error = (await new ProvenanceClient()
      .upload({ x: { toJSON: () => { throw thrown; } } }, { stampId: STAMP, raw: true })
      .catch((e: unknown) => e)) as ProvenanceError;
    expect(error).toBeInstanceOf(ProvenanceError);
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe('Raw mode content cannot be serialized as JSON: bad range');
    expect(error.cause).toBe(thrown);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['a ProvenanceError', () => new ProvenanceError('caller refused', 'CALLER_CODE')],
    ['a ChainError subclass', () => new ChainValidationError('caller refused')],
  ])('keeps %s thrown by the caller\'s toJSON() as the cause', async (_label, make) => {
    const callerError = make();
    const error = (await new ProvenanceClient()
      .upload({ toJSON: () => { throw callerError; } }, { stampId: STAMP, raw: true })
      .catch((e: unknown) => e)) as ProvenanceError;
    expect(error).not.toBe(callerError);
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe('Raw mode content cannot be serialized as JSON: caller refused');
    expect(error.cause).toBe(callerError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses before signing an owner proof', async () => {
    const signMessage = vi.fn(() => Promise.resolve('0x' + '1'.repeat(130)));
    const error = await new ProvenanceClient()
      .upload(circular, { stampId: STAMP, raw: true, ownerSigner: { signMessage } as never })
      .catch((e: unknown) => e);
    expect((error as ProvenanceError).code).toBe('INVALID_INPUT');
    expect(signMessage).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  describe('FILE_TOO_LARGE size hint', () => {
    /** The metadata JSON around empty content: data "", the SHA-256 hash, the 64-character stamp */
    const OVERHEAD = `{"data":"","content_hash":"${'0'.repeat(64)}","stamp_id":"${STAMP}"}`.length;

    const refusal = async (maxUploadBytes: number, content: Uint8Array) =>
      (await new ProvenanceClient({ maxUploadBytes })
        .upload(content, { stampId: STAMP })
        .catch((e: unknown) => e)) as ProvenanceError;

    it('the metadata without content is 171 bytes', () => {
      expect(OVERHEAD).toBe(171);
    });

    it.each([1, 100, 170])('with maxUploadBytes %i says that no content fits', async (max) => {
      const error = await refusal(max, new Uint8Array(1000));
      expect(error.code).toBe('FILE_TOO_LARGE');
      expect(error.message).toContain(`No content fits: the metadata alone is ${OVERHEAD} bytes`);
      expect(error.message).not.toMatch(/-\d|\b0\.0\b|MiB/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it.each([171, 172, 174])('with maxUploadBytes %i says that only empty content fits, and empty content is sent', async (max) => {
      const error = await refusal(max, new Uint8Array(1));
      expect(error.code).toBe('FILE_TOO_LARGE');
      expect(error.message).toContain(`Only empty content fits: the metadata alone is ${OVERHEAD} bytes`);
      expect(error.message).not.toMatch(/-\d|\b0\.0\b|MiB/);
      expect(mockFetch).not.toHaveBeenCalled();

      mockFetch.mockResolvedValueOnce(json({ reference: 'b'.repeat(64) }, 200));
      await new ProvenanceClient({ maxUploadBytes: max }).upload(new Uint8Array(0), { stampId: STAMP });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it.each([
      [175, 3],
      [511, 255],
      [512, 255],
      [513, 255],
      [2000, 1371],
    ])('with maxUploadBytes %i says that %i bytes fit, exactly', async (max, fits) => {
      const error = await refusal(max, new Uint8Array(fits + 1));
      expect(error.code).toBe('FILE_TOO_LARGE');
      expect(error.message).toContain(`Content up to ${fits} bytes fits`);
      expect(error.message).not.toMatch(/-\d|\b0\.0\b|MiB/);
      expect(mockFetch).not.toHaveBeenCalled();

      // The reported size is the exact largest one
      mockFetch.mockResolvedValueOnce(json({ reference: 'b'.repeat(64) }, 200));
      await new ProvenanceClient({ maxUploadBytes: max }).upload(new Uint8Array(fits), { stampId: STAMP });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('with the default limit gives the bytes and the MiB', async () => {
      const error = await refusal(10 * 1024 * 1024, new Uint8Array(7_864_192));
      expect(error.message).toContain('Content up to 7864191 bytes (about 7.5 MiB) fits');
    });

    it('the gateway accepts the reported size at the default limit', async () => {
      mockFetch.mockResolvedValueOnce(json({ reference: 'b'.repeat(64) }, 200));
      await new ProvenanceClient().upload(new Uint8Array(7_864_191), { stampId: STAMP });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('maxUploadBytes 0 is still refused in the constructor', () => {
      expect(() => new ProvenanceClient({ maxUploadBytes: 0 })).toThrow(/maxUploadBytes must be a positive integer/);
    });
  });
});

describe('a Blob or File that cannot be read (#202)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  /** A Blob whose read fails as a browser's does when the picked file changed or was removed */
  function unreadable(kind: 'Blob' | 'File'): Blob {
    const content = kind === 'File' ? (new File(['x'], 'data.bin') as unknown as Blob) : new Blob(['x']);
    const readError = new DOMException('The requested file could not be read', 'NotReadableError');
    Object.defineProperty(content, 'arrayBuffer', { value: () => Promise.reject(readError) });
    return content;
  }

  it.each([
    ['Blob', { stampId: 'a'.repeat(64) }],
    ['File', { stampId: 'a'.repeat(64) }],
    ['File', {}],
  ] as const)('upload() of an unreadable %s is INVALID_INPUT with the read error as cause, before any request', async (kind, options) => {
    const content = unreadable(kind);
    const error = (await new ProvenanceClient().upload(content, options).catch((e: unknown) => e)) as ProvenanceError;
    expect(error).toBeInstanceOf(ProvenanceError);
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe('Could not read the Blob or File content: NotReadableError: The requested file could not be read');
    expect(error.cause).toBeInstanceOf(DOMException);
    expect((error.cause as DOMException).name).toBe('NotReadableError');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
