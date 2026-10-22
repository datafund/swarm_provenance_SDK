import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { ProvenanceClient } from '../../src/client.js';
import { GatewayConnectionError } from '../../src/errors.js';

// GET /api/v1/pricing (#124), against a stubbed gateway. The response bodies
// follow swarm_connect app/api/endpoints/pricing.py on origin/main.

const mockFetch = vi.fn<[string, RequestInit | undefined], Promise<Response>>();
vi.stubGlobal('fetch', (url: string, init?: RequestInit) => mockFetch(url, init));
afterAll(() => {
  vi.unstubAllGlobals();
});

const GATEWAY = 'http://gateway.test';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function quote(path: string, priceUsd: number, amount: string, description: string) {
  return { method: 'POST', path, price_usd: priceUsd, max_amount_required: amount, description };
}

const FULL = {
  x402_enabled: true,
  currency: 'USDC',
  network: 'base-sepolia',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  pay_to: '0x1111111111111111111111111111111111111111',
  min_price_usd: 0.01,
  free_tier: { enabled: true, header: 'X-Payment-Mode: free' },
  quotes: {
    stamp_purchase: quote('/api/v1/stamps/', 0.5, '500000', 'Stamp purchase'),
    pool_acquire: quote('/api/v1/pool/acquire', 0.25, '250000', 'Pool acquire'),
    data_upload: quote('/api/v1/data/', 0.01, '10000', 'Data upload'),
    bandwidth_credit: quote('/api/v1/chunks/credit', 0.02, '20000', 'Bandwidth credit'),
  },
};

function client(): ProvenanceClient {
  return new ProvenanceClient({ gatewayUrl: GATEWAY, retry: { maxRetries: 2, baseDelayMs: 1 } });
}

describe('pricing()', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns the gateway price list in camelCase', async () => {
    mockFetch.mockResolvedValueOnce(json(200, FULL));

    const pricing = await client().pricing();

    expect(pricing).toEqual({
      x402Enabled: true,
      currency: 'USDC',
      network: 'base-sepolia',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      payTo: '0x1111111111111111111111111111111111111111',
      minPriceUsd: 0.01,
      freeTier: { enabled: true, header: 'X-Payment-Mode: free' },
      quotes: {
        stampPurchase: { method: 'POST', path: '/api/v1/stamps/', priceUsd: 0.5, maxAmountRequired: '500000', description: 'Stamp purchase' },
        poolAcquire: { method: 'POST', path: '/api/v1/pool/acquire', priceUsd: 0.25, maxAmountRequired: '250000', description: 'Pool acquire' },
        dataUpload: { method: 'POST', path: '/api/v1/data/', priceUsd: 0.01, maxAmountRequired: '10000', description: 'Data upload' },
        bandwidthCredit: { method: 'POST', path: '/api/v1/chunks/credit', priceUsd: 0.02, maxAmountRequired: '20000', description: 'Bandwidth credit' },
      },
    });
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe(`${GATEWAY}/api/v1/pricing`);
    expect((init?.method ?? 'GET').toUpperCase()).toBe('GET');
  });

  it('returns only x402Enabled and empty quotes when the gateway does not charge', async () => {
    mockFetch.mockResolvedValueOnce(json(200, { x402_enabled: false, quotes: {} }));

    const pricing = await client().pricing();

    expect(pricing).toEqual({ x402Enabled: false, quotes: {} });
    expect(pricing.payTo).toBeUndefined();
    expect(pricing.freeTier).toBeUndefined();
  });

  it('leaves out quotes for operations the gateway does not offer', async () => {
    const quotes = { stamp_purchase: FULL.quotes.stamp_purchase, data_upload: FULL.quotes.data_upload };
    mockFetch.mockResolvedValueOnce(json(200, { ...FULL, quotes }));

    const pricing = await client().pricing();

    expect(Object.keys(pricing.quotes).sort()).toEqual(['dataUpload', 'stampPurchase']);
  });

  it('sends exactly the query parameters that are set', async () => {
    mockFetch.mockResolvedValueOnce(json(200, FULL));

    await client().pricing({ size: 'medium', depth: 20, durationHours: 48, uploadBytes: 1234, mb: 5 });

    const url = new URL(mockFetch.mock.calls[0]![0]);
    expect(url.pathname).toBe('/api/v1/pricing');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      size: 'medium',
      depth: '20',
      duration_hours: '48',
      upload_bytes: '1234',
      mb: '5',
    });
  });

  it('sends only the parameters given', async () => {
    mockFetch.mockResolvedValueOnce(json(200, FULL));

    await client().pricing({ uploadBytes: 0 });

    const url = new URL(mockFetch.mock.calls[0]![0]);
    expect(Object.fromEntries(url.searchParams)).toEqual({ upload_bytes: '0' });
  });

  it.each([
    ['FILE_TOO_LARGE', 'upload_bytes exceeds the maximum upload size of 10 MB.'],
    ['TOPUP_TOO_LARGE', 'mb exceeds the maximum single top-up of 1000 MB.'],
  ])('throws 422 %s with its code and message', async (code, message) => {
    mockFetch.mockResolvedValueOnce(json(422, { detail: { code, message } }));

    const error = await client().pricing({ uploadBytes: 1e9 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GatewayConnectionError);
    expect(error).toMatchObject({ statusCode: 422, code, message });
  });

  it('throws a FastAPI validation error for an out-of-range value', async () => {
    mockFetch.mockResolvedValueOnce(
      json(422, { detail: [{ loc: ['query', 'depth'], msg: 'Input should be less than or equal to 32', type: 'less_than_equal' }] })
    );

    const error = await client().pricing({ depth: 99 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GatewayConnectionError);
    expect(error).toMatchObject({ statusCode: 422, message: 'Input should be less than or equal to 32' });
  });

  it('retries 503 PRICING_UNAVAILABLE, then throws it', async () => {
    const unavailable = () =>
      json(503, { detail: { code: 'PRICING_UNAVAILABLE', message: 'Could not compute prices right now (the chain price is unavailable). Retry shortly.' } });
    mockFetch.mockImplementation(() => Promise.resolve(unavailable()));

    const error = await client().pricing().catch((e: unknown) => e);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(GatewayConnectionError);
    expect(error).toMatchObject({ statusCode: 503, code: 'PRICING_UNAVAILABLE' });
  });

  it('throws on a gateway without the pricing endpoint', async () => {
    mockFetch.mockResolvedValueOnce(json(404, { detail: 'Not Found' }));

    const error = await client().pricing().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GatewayConnectionError);
    expect(error).toMatchObject({ statusCode: 404 });
  });

  it('gives a payTo that seeds payment.payTo', async () => {
    mockFetch.mockResolvedValueOnce(json(200, FULL));
    const pricing = await client().pricing();

    const wallet = {
      address: '0x2222222222222222222222222222222222222222' as const,
      signTypedData: () => Promise.resolve('0x' as const),
      readContract: () => Promise.resolve(undefined),
    };
    expect(
      () => new ProvenanceClient({ gatewayUrl: GATEWAY, payment: { wallet, payTo: [pricing.payTo!] } })
    ).not.toThrow();
  });
});
