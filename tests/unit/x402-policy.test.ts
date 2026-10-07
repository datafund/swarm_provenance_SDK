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
}

let seen: Seen[];
let accepts: Array<Record<string, unknown>>;
let afterPayment: { status: number; headers?: Record<string, string>; body?: unknown };

vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  const paid = request.headers.has('X-PAYMENT') || request.headers.has('PAYMENT-SIGNATURE');
  const path = new URL(request.url).pathname;
  seen.push({ method: request.method, path, paid });

  if (!paid) {
    // The gateway wraps the x402 payload in FastAPI's `detail`
    return Promise.resolve(
      new Response(JSON.stringify({ detail: { x402Version: 1, error: 'Payment required', accepts } }), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }
  return Promise.resolve(
    new Response(JSON.stringify(afterPayment.body ?? { reference: 'b'.repeat(64) }), {
      status: afterPayment.status,
      headers: { 'content-type': 'application/json', ...afterPayment.headers },
    }),
  );
});

function client(payment: Partial<X402PaymentConfig> = {}): ProvenanceClient {
  return new ProvenanceClient({ gatewayUrl: 'http://gateway.test', payment: { wallet, ...payment } });
}

const payments = () => seen.filter((s) => s.paid).length;

beforeEach(() => {
  seen = [];
  accepts = [requirement()];
  afterPayment = { status: 200 };
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
    ['an unconfigured network', { network: 'base' }, /is not configured/],
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

  it('GET requests never go through the paying fetch', async () => {
    const error = await client().download('c'.repeat(64)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayConnectionError);
    expect((error as GatewayConnectionError).statusCode).toBe(402);
    expect(seen).toEqual([{ method: 'GET', path: `/api/v1/data/${'c'.repeat(64)}`, paid: false }]);
  });

  it('requires maxAmount on Base mainnet, at construction', () => {
    expect(() => client({ network: 'eip155:8453', v1Network: 'base' })).toThrow(PaymentConfigurationError);
    expect(() => client({ v1Network: 'base' })).toThrow(/maxAmount is required on Base mainnet/);
    expect(() => client({ network: 'eip155:8453', v1Network: 'base', maxAmount: '0.25' })).not.toThrow();
  });

  it.each([['-1'], ['1e3'], ['0.1234567'], ['abc']])('rejects a malformed maxAmount %j at construction', (maxAmount) => {
    expect(() => client({ maxAmount })).toThrow(PaymentConfigurationError);
  });
});

describe('a paid request is never retried (#107)', () => {
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
