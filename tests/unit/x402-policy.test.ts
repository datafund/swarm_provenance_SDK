import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createWalletClient, http, publicActions } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { ProvenanceClient } from '../../src/client.js';
import {
  GatewayConnectionError,
  PaymentConfigurationError,
  PaymentRefusedError,
} from '../../src/errors.js';
import type { PaymentRequest, X402PaymentConfig } from '../../src/types.js';

// Drives the REAL @x402/fetch + @x402/evm (whatever version is installed)
// against a stubbed gateway: a 402 first, then the paid retry. Nothing leaves
// the process; payments are signed with Hardhat account #0 (a public test key).

const wallet = createWalletClient({
  account: privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'),
  chain: baseSepolia,
  transport: http('http://127.0.0.1:1'), // never called: signing is local
}).extend(publicActions);

const USDC_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const GATEWAY_PAYTO = '0x1111111111111111111111111111111111111111';
const STAMP = 'a'.repeat(64);

function requirement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scheme: 'exact',
    network: 'base-sepolia',
    maxAmountRequired: '10000', // 0.01 USDC
    asset: USDC_SEPOLIA,
    payTo: GATEWAY_PAYTO,
    maxTimeoutSeconds: 60,
    resource: 'http://gateway.test/api/v1/data/',
    description: 'upload',
    mimeType: 'application/json',
    extra: { name: 'USDC', version: '2' },
    ...overrides,
  };
}

interface Seen {
  method: string;
  path: string;
  paid: boolean;
  /** X-Payment-Mode header, if sent */
  mode?: string;
}

let seen: Seen[];
let accepts: Array<Record<string, unknown>>;
/** x402 protocol of the stub's 402: v1 in the body (the gateway today), v2 in the PAYMENT-REQUIRED header */
let protocol: 1 | 2;
let afterPayment: { status: number; headers?: Record<string, string>; body?: unknown; hang?: boolean };
/** Statuses to answer unpaid requests with before the 402 (e.g. a transient 503) */
let beforePayment: number[];

const gateway = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  // Like real fetch: an already-aborted request is rejected without being sent
  if (request.signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
  const paid = request.headers.has('X-PAYMENT') || request.headers.has('PAYMENT-SIGNATURE');
  const path = new URL(request.url).pathname;
  const mode = request.headers.get('X-Payment-Mode') ?? undefined;
  seen.push({ method: request.method, path, paid, ...(mode ? { mode } : {}) });
  if (request.headers.has('x-provenance-sdk-attempt')) throw new Error('internal attempt header leaked to the gateway');

  if (!paid && beforePayment.length > 0) {
    return Promise.resolve(new Response('{"detail":"busy"}', { status: beforePayment.shift()! }));
  }
  if (!paid && protocol === 2) {
    const header = Buffer.from(JSON.stringify({ x402Version: 2, error: 'Payment required', resource: { url: request.url }, accepts })).toString('base64');
    return Promise.resolve(new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': header } }));
  }
  if (!paid) {
    // The gateway wraps the x402 payload in FastAPI's `detail`
    return Promise.resolve(
      new Response(JSON.stringify({ detail: { x402Version: 1, error: 'Payment required', accepts } }), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }
  if (afterPayment.hang) {
    // Never answers: only the client's timeout (AbortSignal) ends the request
    return new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  }
  return Promise.resolve(
    new Response(JSON.stringify(afterPayment.body ?? { reference: 'b'.repeat(64) }), {
      status: afterPayment.status,
      headers: { 'content-type': 'application/json', ...afterPayment.headers },
    }),
  );
};
vi.stubGlobal('fetch', gateway);

function client(payment: Partial<X402PaymentConfig> = {}): ProvenanceClient {
  return new ProvenanceClient({ gatewayUrl: 'http://gateway.test', payment: { wallet, ...payment } });
}

const payments = () => seen.filter((s) => s.paid).length;

beforeEach(() => {
  seen = [];
  accepts = [requirement()];
  afterPayment = { status: 200 };
  beforePayment = [];
  protocol = 1;
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe('x402 payment policy with the real x402 library (#106)', () => {
  it('pays an in-policy request once and uploads', async () => {
    const result = await client().upload('hello', { stampId: STAMP });
    expect(result.reference).toBe('b'.repeat(64));
    expect(payments()).toBe(1);
  });

  it.each([
    ['above maxAmount', { maxAmountRequired: '1000001' }, /exceeds maxAmount 1/],
    ['a non-USDC asset', { asset: '0x2222222222222222222222222222222222222222' }, /is not the expected/],
    ['a validity above the bound', { maxTimeoutSeconds: 3600 }, /exceeds maxTimeoutSeconds 600/],
    ['another scheme', { scheme: 'upto' }, /is not 'exact'/],
    ['an unconfigured network', { network: 'base' }, /is not the configured x402 v1 network/],
    ['the other version\'s network name', { network: 'eip155:84532' }, /is not the configured x402 v1 network/],
    ['the permit2 transfer method', { extra: { name: 'USDC', version: '2', assetTransferMethod: 'permit2' } }, /transfer method/],
  ])('refuses a request %s before signing', async (_label, overrides, reason) => {
    accepts = [requirement(overrides)];
    const error = await client().upload('hello', { stampId: STAMP }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PaymentRefusedError);
    expect((error as PaymentRefusedError).code).toBe('PAYMENT_REFUSED');
    expect((error as Error).message).toMatch(reason);
    expect(payments()).toBe(0);
  });

  it('refuses a recipient outside payTo', async () => {
    const error = await client({ payTo: ['0x3333333333333333333333333333333333333333'] })
      .upload('hello', { stampId: STAMP })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentRefusedError);
    expect((error as Error).message).toMatch(/not in payment.payTo/);
    expect(payments()).toBe(0);
  });

  it('refuses a v1 option whose amount and maxAmountRequired disagree (v1 signs maxAmountRequired)', async () => {
    accepts = [requirement({ amount: '1', maxAmountRequired: '500000000' })];
    const error = await client().upload('hello', { stampId: STAMP }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentRefusedError);
    expect((error as Error).message).toMatch(/exceeds maxAmount|disagree/);
    expect(payments()).toBe(0);
  });

  it('a non-array payTo is a configuration error', () => {
    expect(() => client({ payTo: GATEWAY_PAYTO as unknown as string[] })).toThrow(PaymentConfigurationError);
  });

  it('pays a recipient inside payTo (case-insensitive)', async () => {
    await client({ payTo: [GATEWAY_PAYTO.toUpperCase().replace('0X', '0x')] }).upload('hello', { stampId: STAMP });
    expect(payments()).toBe(1);
  });

  it('onBeforePayment sees amount, asset and recipient, and can veto', async () => {
    const asked: PaymentRequest[] = [];
    const error = await client({
      onBeforePayment: (p) => {
        asked.push(p);
        return false;
      },
    })
      .upload('hello', { stampId: STAMP })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PaymentRefusedError);
    expect(asked).toEqual([
      expect.objectContaining({ amount: '10000', asset: USDC_SEPOLIA, payTo: GATEWAY_PAYTO, network: 'base-sepolia' }),
    ]);
    expect(payments()).toBe(0);
  });

  it('skips a refused option and pays the acceptable one offered after it', async () => {
    accepts = [requirement({ maxAmountRequired: '99000000' }), requirement()];
    const asked: PaymentRequest[] = [];
    await client({ onBeforePayment: (p) => void asked.push(p) }).upload('hello', { stampId: STAMP });
    expect(payments()).toBe(1);
    expect(asked.map((p) => p.amount)).toEqual(['10000']);
  });

  it('GET requests use the free tier, not the paying fetch', async () => {
    const error = await client().download('c'.repeat(64)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayConnectionError);
    expect((error as GatewayConnectionError).statusCode).toBe(402);
    expect(seen).toEqual([{ method: 'GET', path: `/api/v1/data/${'c'.repeat(64)}`, paid: false, mode: 'free' }]);
  });

  it('payForReads: true pays for a GET within the policy', async () => {
    afterPayment = { status: 200, body: { data: 'aGk=', content_hash: 'x', stamp_id: STAMP } };
    await client({ payForReads: true }).download('c'.repeat(64)).catch(() => undefined);
    expect(payments()).toBe(1);
    expect(seen[0]?.mode).toBeUndefined();
  });

  it('requires maxAmount everywhere except Base Sepolia test USDC, at construction', () => {
    expect(() => client({ network: 'eip155:8453', v1Network: 'base' })).toThrow(PaymentConfigurationError);
    expect(() => client({ v1Network: 'base' })).toThrow(/maxAmount is required/);
    expect(() => client({ network: 'eip155:137' })).toThrow(/maxAmount is required/);
    expect(() => client({ network: 'eip155:8453', v1Network: 'base', maxAmount: '0.25' })).not.toThrow();
  });

  it('a custom asset requires assetDecimals', () => {
    const asset = '0x2222222222222222222222222222222222222222';
    expect(() => client({ asset, maxAmount: '1' })).toThrow(/assetDecimals is required/);
    expect(() => client({ asset, maxAmount: '1', assetDecimals: 18 })).not.toThrow();
  });

  it.each([['-1'], ['1e3'], ['0.1234567'], ['abc']])('rejects a malformed maxAmount %j at construction', (maxAmount) => {
    expect(() => client({ maxAmount })).toThrow(PaymentConfigurationError);
  });
});

describe('a paid request is never retried (#107)', () => {
  it('an unpaid write is still retried on a transient 503 (no payment was sent)', async () => {
    beforePayment = [503];
    await new ProvenanceClient({
      gatewayUrl: 'http://gateway.test',
      payment: { wallet },
      retry: { maxRetries: 2, baseDelayMs: 1 },
    }).upload('hello', { stampId: STAMP });
    expect(seen.map((s) => s.paid)).toEqual([false, false, true]);
    expect(payments()).toBe(1);
  });

  it('a timeout while the payment is still being approved is not reported as paid', async () => {
    const error = await new ProvenanceClient({
      gatewayUrl: 'http://gateway.test',
      payment: { wallet, onBeforePayment: () => new Promise((resolve) => setTimeout(() => resolve(true), 100)) },
      timeout: 30,
      retry: { maxRetries: 0 },
    })
      .upload('hello', { stampId: STAMP })
      .catch((e: unknown) => e);

    expect((error as GatewayConnectionError).code).toBe('TIMEOUT');
    expect((error as GatewayConnectionError).payment).toBeUndefined();
    expect(payments()).toBe(0);
  });

  it('a 502 after payment produces exactly one payment and an error that says so', async () => {
    afterPayment = { status: 502, headers: { 'X-Payment-Transaction': '0xabc123' }, body: { detail: 'Bee upload failed' } };
    const error = await new ProvenanceClient({
      gatewayUrl: 'http://gateway.test',
      payment: { wallet },
      retry: { maxRetries: 2, baseDelayMs: 1 },
    })
      .upload('hello', { stampId: STAMP })
      .catch((e: unknown) => e);

    expect(payments()).toBe(1);
    expect(error).toBeInstanceOf(GatewayConnectionError);
    expect((error as GatewayConnectionError).payment).toEqual({ paymentSent: true, transaction: '0xabc123' });
    expect((error as Error).message).toMatch(/may have been charged; transaction 0xabc123/);
  });

  it('a timeout after payment produces exactly one payment and an error that says so', async () => {
    afterPayment = { status: 200, hang: true };
    const error = await new ProvenanceClient({
      gatewayUrl: 'http://gateway.test',
      payment: { wallet },
      timeout: 50,
      retry: { maxRetries: 2, baseDelayMs: 1 },
    })
      .upload('hello', { stampId: STAMP })
      .catch((e: unknown) => e);

    expect(payments()).toBe(1);
    expect(error).toBeInstanceOf(GatewayConnectionError);
    expect((error as GatewayConnectionError).code).toBe('TIMEOUT');
    expect((error as GatewayConnectionError).payment).toEqual({ paymentSent: true });
  });

  it('the payment flag survives the NotaryError conversion (sign: notary)', async () => {
    afterPayment = { status: 503, body: { detail: 'notary down' } };
    const error = await client().upload('hello', { stampId: STAMP, sign: 'notary' }).catch((e: unknown) => e);
    expect((error as { payment?: unknown }).payment).toEqual({ paymentSent: true });
    expect(payments()).toBe(1);
  });
});

describe('maxAmount above the library default cap (#110)', () => {
  it('a 2 USDC charge passes with maxAmount "5" on any @x402 version', async () => {
    accepts = [requirement({ maxAmountRequired: '2000000' })];
    await client({ maxAmount: '5' }).upload('hello', { stampId: STAMP });
    expect(payments()).toBe(1);
  });
});

describe('x402 v2: requirements in the PAYMENT-REQUIRED header', () => {
  const v2 = (overrides: Record<string, unknown> = {}) => ({
    scheme: 'exact',
    network: 'eip155:84532',
    amount: '10000',
    asset: USDC_SEPOLIA,
    payTo: GATEWAY_PAYTO,
    maxTimeoutSeconds: 60,
    extra: { name: 'USDC', version: '2' },
    ...overrides,
  });

  it('pays an in-policy v2 request once', async () => {
    protocol = 2;
    accepts = [v2()];
    await client().upload('hello', { stampId: STAMP });
    expect(payments()).toBe(1);
  });

  it('refuses a v2 request above maxAmount, and one using permit2', async () => {
    protocol = 2;
    for (const option of [v2({ amount: '2000000' }), v2({ extra: { name: 'USDC', version: '2', assetTransferMethod: 'permit2' } })]) {
      accepts = [option];
      await expect(client().upload('hello', { stampId: STAMP })).rejects.toThrow(PaymentRefusedError);
    }
    expect(payments()).toBe(0);
  });

  it('narrows the header to the approved option', async () => {
    protocol = 2;
    accepts = [v2({ amount: '99000000' }), v2()];
    await client().upload('hello', { stampId: STAMP });
    expect(payments()).toBe(1);
  });
});

describe('free-tier reads in x402 mode', () => {
  it('a read rate limit points to payForReads', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 429 })));
    try {
      const error = await client().download('c'.repeat(64)).catch((e: unknown) => e);
      expect((error as Error).message).toMatch(/payForReads/);
    } finally {
      vi.stubGlobal('fetch', gateway);
    }
  });
});

describe('review round 3 (#138)', () => {
  it('an option naming the other version\'s network is skipped and the payable one after it is paid', async () => {
    accepts = [requirement({ network: 'eip155:84532' }), requirement()];
    await client().upload('hello', { stampId: STAMP });
    expect(payments()).toBe(1);
  });

  it('the timeout bounds an approval that never answers', async () => {
    const started = Date.now();
    const error = await new ProvenanceClient({
      gatewayUrl: 'http://gateway.test',
      payment: { wallet, onBeforePayment: () => new Promise<boolean>(() => undefined) },
      timeout: 50,
      retry: { maxRetries: 0 },
    })
      .upload('hello', { stampId: STAMP })
      .catch((e: unknown) => e);

    expect((error as GatewayConnectionError).code).toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(payments()).toBe(0);
  });

  it('a paid 2xx with an unreadable body keeps the payment flag', async () => {
    afterPayment = { status: 200, body: undefined };
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      // Read the headers without consuming the body, which gateway() still needs
      const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
      if (headers.has('X-PAYMENT')) {
        seen.push({ method: 'POST', path: '/api/v1/data/', paid: true });
        return Promise.resolve(new Response('<html>proxy error</html>', { status: 200 }));
      }
      return gateway(input, init);
    });
    try {
      const error = await client().upload('hello', { stampId: STAMP }).catch((e: unknown) => e);
      expect((error as GatewayConnectionError).code).toBe('INVALID_RESPONSE');
      expect((error as GatewayConnectionError).payment).toEqual({ paymentSent: true });
      expect(payments()).toBe(1);
    } finally {
      vi.stubGlobal('fetch', gateway);
    }
  });
});

describe('review round 4 (#138)', () => {
  it('assetDecimals without asset is rejected (it would rescale the USDC cap)', () => {
    expect(() => client({ maxAmount: '1', assetDecimals: 18 })).toThrow(/only valid together with payment.asset/);
  });

  it('one asset across two different chains is rejected', () => {
    const asset = '0x2222222222222222222222222222222222222222';
    expect(() => client({ network: 'eip155:8453', asset, assetDecimals: 6, maxAmount: '1' })).toThrow(/different chains/);
    expect(() => client({ network: 'eip155:8453', v1Network: 'base', asset, assetDecimals: 6, maxAmount: '1' })).not.toThrow();
  });

  it('an undecodable PAYMENT-REQUIRED header falls back to the v1 body', async () => {
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
      if (!headers.has('X-PAYMENT') && !headers.has('PAYMENT-SIGNATURE')) {
        seen.push({ method: 'POST', path: '/api/v1/data/', paid: false });
        return Promise.resolve(
          new Response(JSON.stringify({ detail: { x402Version: 1, accepts } }), {
            status: 402,
            headers: { 'PAYMENT-REQUIRED': '%%%not-base64%%%' },
          }),
        );
      }
      return gateway(input, init);
    });
    try {
      await client().upload('hello', { stampId: STAMP });
      expect(payments()).toBe(1);
    } finally {
      vi.stubGlobal('fetch', gateway);
    }
  });
});

describe('final review (#138)', () => {
  it('a library failure while selecting the payment is a payment error, not a connection error', async () => {
    // A wallet that cannot sign makes the library fail after the SDK approved the 402
    const broken = { ...wallet, signTypedData: () => Promise.reject(new Error('wallet locked')) };
    const error = await new ProvenanceClient({ gatewayUrl: 'http://gateway.test', payment: { wallet: broken } })
      .upload('hello', { stampId: STAMP })
      .catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe('PAYMENT_FAILED');
    expect(payments()).toBe(0);
  });
});
