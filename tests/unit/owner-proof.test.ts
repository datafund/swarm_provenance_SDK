import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { createWalletClient, http, publicActions, recoverMessageAddress } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { ProvenanceClient } from '../../src/client.js';
import { GatewayConnectionError, NotaryError, PaymentRateLimitError, ProvenanceError } from '../../src/errors.js';
import { ownerProofMessage } from '../../src/utils.js';
import type { OwnerSigner, ProvenanceClientConfig } from '../../src/types.js';

// Owner-proof uploads (#124) against a stubbed gateway. The message, headers and
// error bodies follow swarm_connect origin/main: app/services/signed_auth.py and
// app/api/endpoints/data.py (_check_stamp_access). Signed with Hardhat account #0
// (a public test key).

const OWNER = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const wallet = createWalletClient({
  account: OWNER,
  chain: baseSepolia,
  transport: http('http://127.0.0.1:1'), // never called: signing is local
}).extend(publicActions);

const GATEWAY = 'http://gateway.test';
const STAMP = 'AbCdEf'.padEnd(64, 'a');
const REFERENCE = 'b'.repeat(64);

const mockFetch = vi.fn<[string | URL | Request, RequestInit | undefined], Promise<Response>>();
vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => mockFetch(input, init));
afterAll(() => {
  vi.unstubAllGlobals();
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function headersOf(call: number): Headers {
  return new Headers(mockFetch.mock.calls[call]![1]?.headers);
}

function client(payment?: ProvenanceClientConfig['payment']): ProvenanceClient {
  const config: ProvenanceClientConfig = { gatewayUrl: GATEWAY, retry: { maxRetries: 2, baseDelayMs: 1 } };
  if (payment !== undefined) config.payment = payment;
  return new ProvenanceClient(config);
}

async function recoveredSigner(call: number): Promise<string> {
  const headers = headersOf(call);
  return recoverMessageAddress({
    message: ownerProofMessage(STAMP, Number(headers.get('X-Owner-Timestamp'))),
    signature: headers.get('X-Owner-Signature') as `0x${string}`,
  });
}

describe('ownerProofMessage()', () => {
  it('matches the gateway format, with the stamp id lowercased', () => {
    expect(ownerProofMessage('ABCDEF', 1700000000)).toBe('swarm-connect-owner-upload:abcdef:1700000000');
  });
});

describe('owner-proof uploads', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('sends a fresh proof signed by the owner over the lowercased stamp id, on the free tier', async () => {
    mockFetch.mockResolvedValueOnce(json(200, { reference: REFERENCE }));
    const before = Math.floor(Date.now() / 1000);

    const result = await client().upload('hello', { stampId: STAMP, ownerSigner: OWNER });

    expect(result.reference).toBe(REFERENCE);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const headers = headersOf(0);
    expect(headers.get('X-Payment-Mode')).toBe('free');
    const timestamp = Number(headers.get('X-Owner-Timestamp'));
    expect(Number.isInteger(timestamp)).toBe(true);
    expect(Math.abs(timestamp - before)).toBeLessThanOrEqual(300);
    expect(await recoveredSigner(0)).toBe(OWNER.address);
    expect(new URL(String(mockFetch.mock.calls[0]![0])).searchParams.get('stamp_id')).toBe(STAMP);
  });

  it('works for raw uploads too', async () => {
    mockFetch.mockResolvedValueOnce(json(200, { reference: REFERENCE }));

    await client().upload({ a: 1 }, { raw: true, stampId: STAMP, ownerSigner: OWNER });

    expect(headersOf(0).get('X-Payment-Mode')).toBe('free');
    expect(await recoveredSigner(0)).toBe(OWNER.address);
  });

  it("sends the free-tier header with the proof in 'none' mode", async () => {
    mockFetch.mockResolvedValueOnce(json(200, { reference: REFERENCE }));

    await client('none').upload('hello', { stampId: STAMP, ownerSigner: OWNER });

    expect(headersOf(0).get('X-Payment-Mode')).toBe('free');
    expect(headersOf(0).get('X-Owner-Signature')).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('never pays in x402 mode: no payment, no Idempotency-Key, a 402 is returned as an error', async () => {
    mockFetch.mockResolvedValueOnce(
      json(402, {
        detail: {
          x402Version: 1,
          error: 'Free tier is not available. Payment required.',
          accepts: [
            {
              scheme: 'exact',
              network: 'base-sepolia',
              maxAmountRequired: '10000',
              asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
              payTo: '0x1111111111111111111111111111111111111111',
              maxTimeoutSeconds: 60,
              resource: `${GATEWAY}/api/v1/data/`,
              description: 'upload',
              mimeType: 'application/json',
              extra: { name: 'USDC', version: '2' },
            },
          ],
        },
      })
    );

    // The x402 payment wallet doubles as the owner signer
    const error = await client({ wallet }).upload('hello', { stampId: STAMP, ownerSigner: wallet }).catch((e: unknown) => e);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const headers = headersOf(0);
    expect(headers.get('X-Payment-Mode')).toBe('free');
    expect(headers.has('X-PAYMENT')).toBe(false);
    expect(headers.has('PAYMENT-SIGNATURE')).toBe(false);
    expect(headers.has('Idempotency-Key')).toBe(false);
    expect(await recoveredSigner(0)).toBe(OWNER.address);
    expect(error).toBeInstanceOf(GatewayConnectionError);
    expect(error).toMatchObject({ statusCode: 402 });
    expect((error as ProvenanceError).payment).toBeUndefined();
  });

  it('succeeds in x402 mode without paying', async () => {
    mockFetch.mockResolvedValueOnce(json(200, { reference: REFERENCE }));

    const result = await client({ wallet }).upload('hello', { stampId: STAMP, ownerSigner: wallet });

    expect(result.reference).toBe(REFERENCE);
    expect(headersOf(0).has('X-PAYMENT')).toBe(false);
  });

  it('signs a new proof for each attempt, so a retry never re-sends a used proof', async () => {
    mockFetch
      .mockResolvedValueOnce(json(502, { detail: 'Bad gateway' }))
      .mockResolvedValueOnce(json(200, { reference: REFERENCE }));
    const sign = vi.fn((args: { message: string }) => OWNER.signMessage(args));
    const signer: OwnerSigner = { signMessage: sign };

    await client().upload('hello', { stampId: STAMP, ownerSigner: signer });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(sign).toHaveBeenCalledTimes(2);
    const first = headersOf(0);
    const second = headersOf(1);
    expect(Number(second.get('X-Owner-Timestamp'))).toBeGreaterThan(Number(first.get('X-Owner-Timestamp')));
    expect(second.get('X-Owner-Signature')).not.toBe(first.get('X-Owner-Signature'));
    expect(await recoveredSigner(1)).toBe(OWNER.address);
  });

  it('throws 401 OWNER_PROOF_INVALID with the gateway message', async () => {
    mockFetch.mockResolvedValueOnce(
      json(401, {
        detail: {
          code: 'OWNER_PROOF_INVALID',
          message: 'Owner proof rejected: owner proof has already been used; sign a new one',
          stamp_id: STAMP,
        },
      })
    );

    const error = await client().upload('hello', { stampId: STAMP, ownerSigner: OWNER }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GatewayConnectionError);
    expect(error).toMatchObject({
      statusCode: 401,
      code: 'OWNER_PROOF_INVALID',
      message: 'Owner proof rejected: owner proof has already been used; sign a new one',
    });
  });

  it('never puts the proof in an error message', async () => {
    mockFetch.mockResolvedValueOnce(
      json(401, {
        detail: { code: 'OWNER_PROOF_INVALID', message: 'Owner proof rejected: signature is not valid', stamp_id: STAMP },
      })
    );

    const error = (await client()
      .upload('hello', { stampId: STAMP, ownerSigner: OWNER })
      .catch((e: unknown) => e)) as ProvenanceError;

    const signature = headersOf(0).get('X-Owner-Signature')!;
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(error.code).toBe('OWNER_PROOF_INVALID');
    expect(error.message).not.toContain(signature);
    expect(error.message).not.toContain(signature.slice(2));
    expect(JSON.stringify(error)).not.toContain(signature.slice(2));
  });

  it('throws 403 STAMP_OWNERSHIP_DENIED for a proof from another wallet', async () => {
    mockFetch.mockResolvedValueOnce(
      json(403, {
        detail: {
          code: 'STAMP_OWNERSHIP_DENIED',
          message: 'Access denied: stamp owned by 0x11111111..., not accessible to wallet 0xf39Fd6e5...',
          stamp_id: STAMP,
        },
      })
    );

    const error = await client().upload('hello', { stampId: STAMP, ownerSigner: OWNER }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GatewayConnectionError);
    expect(error).toMatchObject({ statusCode: 403, code: 'STAMP_OWNERSHIP_DENIED' });
  });

  it.each([
    [401, 'OWNER_PROOF_INVALID'],
    [403, 'STAMP_OWNERSHIP_DENIED'],
  ])('keeps the %s %s code as a NotaryError when notary signing was asked for', async (status, code) => {
    mockFetch.mockResolvedValueOnce(json(status, { detail: { code, message: 'refused', stamp_id: STAMP } }));

    const error = await client()
      .upload('hello', { stampId: STAMP, ownerSigner: OWNER, sign: 'notary' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotaryError);
    expect(error).toMatchObject({ code });
  });

  it.each([
    ['no stampId', undefined],
    ['a 0x-prefixed stampId', `0x${'a'.repeat(64)}`],
    ['a short stampId', 'abc'],
  ])('refuses %s before signing or sending anything', async (_label, stampId) => {
    const sign = vi.fn((args: { message: string }) => OWNER.signMessage(args));
    const signer: OwnerSigner = { signMessage: sign };
    const options: { ownerSigner: OwnerSigner; stampId?: string } = { ownerSigner: signer };
    if (stampId !== undefined) options.stampId = stampId;

    const error = await client().upload('hello', options).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProvenanceError);
    expect(error).toMatchObject({ code: 'INVALID_INPUT' });
    expect(sign).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws OWNER_PROOF_FAILED and sends nothing when signing fails', async () => {
    const signer: OwnerSigner = { signMessage: () => Promise.reject(new Error('User rejected the request')) };

    const error = await client().upload('hello', { stampId: STAMP, ownerSigner: signer }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProvenanceError);
    expect(error).toMatchObject({ code: 'OWNER_PROOF_FAILED' });
    expect((error as Error).message).toContain('User rejected the request');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends no owner-proof headers without ownerSigner', async () => {
    mockFetch.mockResolvedValueOnce(json(200, { reference: REFERENCE }));

    await client().upload('hello', { stampId: STAMP });

    expect(headersOf(0).has('X-Owner-Timestamp')).toBe(false);
    expect(headersOf(0).has('X-Owner-Signature')).toBe(false);
  });
});

describe('owner-proof signing timeout', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('bounds a signer that never answers by paidTimeout, and sends nothing', async () => {
    const signer: OwnerSigner = { signMessage: () => new Promise<`0x${string}`>(() => undefined) };
    const c = new ProvenanceClient({ gatewayUrl: GATEWAY, timeout: 200, paidTimeout: 1000, retry: { maxRetries: 0 } });

    let settled: unknown = 'pending';
    const upload = c.upload('hello', { stampId: STAMP, ownerSigner: signer }).then(
      () => 'resolved',
      (e: unknown) => e
    );
    void upload.then((v) => (settled = v));

    // A person may be approving a wallet prompt: the short timeout does not apply
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe('pending');

    await vi.advanceTimersByTimeAsync(600);
    const error = await upload;
    expect(error).toBeInstanceOf(GatewayConnectionError);
    expect(error).toMatchObject({ code: 'TIMEOUT' });
    expect((error as Error).message).toContain('owner-proof signature');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('owner-proof options and isolation', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('gives owner-proof advice for a free-tier 429 in x402 mode', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: { error: 'Rate limit exceeded' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '42' },
      })
    );

    const error = await client({ wallet }).upload('hello', { stampId: STAMP, ownerSigner: wallet }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PaymentRateLimitError);
    expect(error).toMatchObject({ retryAfterSeconds: 42 });
    const message = (error as Error).message;
    expect(message).toContain('Owner-proof uploads use the free tier');
    expect(message).toContain('without ownerSigner');
    expect(message).not.toContain('Consider using x402 payment mode');
  });

  it('refuses ownerSigner with idempotencyKey before signing or sending', async () => {
    const sign = vi.fn((args: { message: string }) => OWNER.signMessage(args));

    const error = await client({ wallet })
      .upload('hello', { stampId: STAMP, ownerSigner: { signMessage: sign }, idempotencyKey: 'my-key' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProvenanceError);
    expect(error).toMatchObject({ code: 'INVALID_INPUT' });
    expect((error as Error).message).toContain('idempotencyKey');
    expect(sign).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['a value without 0x', 'deadbeef'],
    ['a non-hex value', '0xnothex'],
    ['an empty string', ''],
    ['a non-string', 42],
    ['undefined', undefined],
  ])('throws OWNER_PROOF_FAILED and sends nothing when the signer returns %s', async (_label, value) => {
    const signer = { signMessage: () => Promise.resolve(value) } as unknown as OwnerSigner;

    const error = await client().upload('hello', { stampId: STAMP, ownerSigner: signer }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProvenanceError);
    expect(error).toMatchObject({ code: 'OWNER_PROOF_FAILED' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('keeps owner-proof headers off later pricing and pool requests, which keep their payment behaviour', async () => {
    const seen: { method: string; path: string; headers: Headers }[] = [];
    mockFetch.mockImplementation((input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      seen.push({ method: request.method, path, headers: request.headers });
      if (path === '/api/v1/pricing') return Promise.resolve(json(200, { x402_enabled: false, quotes: {} }));
      if (path === '/api/v1/pool/acquire') {
        if (!request.headers.has('X-PAYMENT')) {
          return Promise.resolve(
            json(402, {
              x402Version: 1,
              error: 'Payment required',
              accepts: [
                {
                  scheme: 'exact',
                  network: 'base-sepolia',
                  maxAmountRequired: '10000',
                  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
                  payTo: '0x1111111111111111111111111111111111111111',
                  maxTimeoutSeconds: 60,
                  resource: `${GATEWAY}/api/v1/pool/acquire`,
                  description: 'acquire',
                  mimeType: 'application/json',
                  extra: { name: 'USDC', version: '2' },
                },
              ],
            })
          );
        }
        return Promise.resolve(json(200, { batch_id: 'c'.repeat(64), depth: 17, size_name: 'small', fallback_used: false }));
      }
      return Promise.resolve(json(200, { reference: REFERENCE }));
    });
    const c = client({ wallet });

    await c.upload('hello', { stampId: STAMP, ownerSigner: wallet });
    await c.pricing();
    const stamp = await c.acquireStamp('small');

    expect(stamp.batchId).toBe('c'.repeat(64));
    const [upload, pricing, ...acquire] = seen;
    expect(upload!.headers.has('X-Owner-Signature')).toBe(true);
    for (const request of [pricing!, ...acquire]) {
      expect(request.headers.has('X-Owner-Timestamp')).toBe(false);
      expect(request.headers.has('X-Owner-Signature')).toBe(false);
    }
    // pricing: an unpaid read on the free tier
    expect(pricing!.method).toBe('GET');
    expect(pricing!.headers.get('X-Payment-Mode')).toBe('free');
    // acquisition: paid as before, with an Idempotency-Key and no free-tier header
    expect(acquire.map((r) => r.path)).toEqual(['/api/v1/pool/acquire', '/api/v1/pool/acquire']);
    expect(acquire[0]!.headers.has('X-PAYMENT')).toBe(false);
    expect(acquire[1]!.headers.has('X-PAYMENT')).toBe(true);
    expect(acquire[1]!.headers.get('Idempotency-Key')).toBeTruthy();
    expect(acquire[1]!.headers.has('X-Payment-Mode')).toBe(false);
  });

  it.each([
    ['none', 'none' as const],
    ['x402', 'x402' as const],
  ])("sends no owner-proof headers without ownerSigner in '%s' mode", async (_label, mode) => {
    const seen: Headers[] = [];
    mockFetch.mockImplementation((input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push(request.headers);
      if (mode === 'x402' && !request.headers.has('X-PAYMENT')) {
        return Promise.resolve(
          json(402, {
            x402Version: 1,
            error: 'Payment required',
            accepts: [
              {
                scheme: 'exact',
                network: 'base-sepolia',
                maxAmountRequired: '10000',
                asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
                payTo: '0x1111111111111111111111111111111111111111',
                maxTimeoutSeconds: 60,
                resource: `${GATEWAY}/api/v1/data/`,
                description: 'upload',
                mimeType: 'application/json',
                extra: { name: 'USDC', version: '2' },
              },
            ],
          })
        );
      }
      return Promise.resolve(json(200, { reference: REFERENCE }));
    });

    const result = await client(mode === 'x402' ? { wallet } : 'none').upload('hello', { stampId: STAMP });

    expect(result.reference).toBe(REFERENCE);
    expect(seen.length).toBe(mode === 'x402' ? 2 : 1);
    for (const headers of seen) {
      expect(headers.has('X-Owner-Timestamp')).toBe(false);
      expect(headers.has('X-Owner-Signature')).toBe(false);
    }
    if (mode === 'x402') expect(seen[1]!.has('X-PAYMENT')).toBe(true);
    else expect(seen[0]!.has('X-Payment-Mode')).toBe(false);
  });
});

describe('owner-proof timestamps across uploads', () => {
  const OTHER_STAMP = 'd'.repeat(64);
  const NOW_MS = Date.UTC(2026, 9, 21, 12, 0, 0, 100);
  const NOW = Math.floor(NOW_MS / 1000);
  /** X-Owner-Timestamp of each request, with the clock (seconds) when it was sent */
  let sent: { stamp: string; timestamp: number; signature: string; clock: number }[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    sent = [];
    mockFetch.mockReset();
    mockFetch.mockImplementation((input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      sent.push({
        stamp: new URL(request.url).searchParams.get('stamp_id')!,
        timestamp: Number(request.headers.get('X-Owner-Timestamp')),
        signature: request.headers.get('X-Owner-Signature')!,
        clock: Math.floor(Date.now() / 1000),
      });
      return Promise.resolve(json(200, { reference: REFERENCE }));
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives sequential uploads to one stamp within one second distinct proofs', async () => {
    const c = client();

    await c.upload('one', { stampId: STAMP, ownerSigner: OWNER });
    await c.upload('two', { stampId: STAMP, ownerSigner: OWNER });

    expect(sent.map((s) => s.timestamp)).toEqual([NOW, NOW + 1]);
    expect(sent[0]!.signature).not.toBe(sent[1]!.signature);
  });

  it('gives concurrent uploads to one stamp distinct proofs', async () => {
    const c = client();

    await Promise.all([1, 2, 3, 4].map((n) => c.upload(`n${n}`, { stampId: STAMP, ownerSigner: OWNER })));

    const timestamps = sent.map((s) => s.timestamp).sort((a, b) => a - b);
    expect(timestamps).toEqual([NOW, NOW + 1, NOW + 2, NOW + 3]);
    expect(new Set(sent.map((s) => s.signature)).size).toBe(4);
  });

  it('keeps stamps independent', async () => {
    const c = client();

    await c.upload('one', { stampId: STAMP, ownerSigner: OWNER });
    await c.upload('two', { stampId: OTHER_STAMP, ownerSigner: OWNER });

    expect(sent.map((s) => [s.stamp, s.timestamp])).toEqual([
      [STAMP, NOW],
      [OTHER_STAMP, NOW],
    ]);
  });

  it('does not send a burst of proofs more than 30 s ahead of the clock', async () => {
    const c = client();

    const burst = Promise.all(
      Array.from({ length: 40 }, (_, n) => c.upload(`n${n}`, { stampId: STAMP, ownerSigner: OWNER }))
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await burst;

    expect(sent).toHaveLength(40);
    expect(new Set(sent.map((s) => s.timestamp)).size).toBe(40);
    for (const s of sent) expect(s.timestamp - s.clock).toBeLessThanOrEqual(30);
  });
});

describe("owner-proof 429 in 'none' mode", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('throws PaymentRateLimitError with owner-proof advice and does not retry or sign again', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ detail: { error: 'Rate limit exceeded' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
        })
      )
    );
    const sign = vi.fn((args: { message: string }) => OWNER.signMessage(args));

    const error = await client('none')
      .upload('hello', { stampId: STAMP, ownerSigner: { signMessage: sign } })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PaymentRateLimitError);
    expect((error as Error).message).toContain('Owner-proof uploads use the free tier');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledTimes(1);
  });
});
