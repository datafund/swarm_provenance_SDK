import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createWalletClient, http, publicActions } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { ProvenanceClient } from '../../src/client.js';
import { GatewayConnectionError, PaymentRefusedError } from '../../src/errors.js';
import type { ProvenanceClientConfig } from '../../src/types.js';

// The payment receipt (#111), with the REAL @x402/fetch + @x402/evm against a
// stubbed gateway: a 402 first, then the paid request, answered with the
// receipt headers the gateway sends (swarm_connect app/x402/middleware.py).
// Payments are signed with Hardhat account #0 (a public test key).

const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const wallet = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http('http://127.0.0.1:1'), // never called: signing is local
}).extend(publicActions);

const USDC_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const GATEWAY_PAYTO = '0x1111111111111111111111111111111111111111';
const STAMP = 'a'.repeat(64);
const POOL_STAMP = 'c'.repeat(64);
const REFERENCE = 'b'.repeat(64);
const TX_UPLOAD = '0x' + '1'.repeat(64);
const TX_POOL = '0x' + '2'.repeat(64);
const ANY_KEY: unknown = expect.any(String);

const v1Option = (amount = '10000') => ({
  scheme: 'exact',
  network: 'base-sepolia',
  maxAmountRequired: amount,
  asset: USDC_SEPOLIA,
  payTo: GATEWAY_PAYTO,
  maxTimeoutSeconds: 60,
  resource: 'http://gateway.test/api/v1/data/',
  description: 'upload',
  mimeType: 'application/json',
  extra: { name: 'USDC', version: '2' },
});

const v2Option = (amount = '25000') => ({
  scheme: 'exact',
  network: 'eip155:84532',
  amount,
  asset: USDC_SEPOLIA,
  payTo: GATEWAY_PAYTO,
  maxTimeoutSeconds: 60,
  extra: { name: 'USDC', version: '2' },
});

/** The facilitator's SettleResponse, serialized by alias and base64-encoded, as the gateway sends it */
function receipt(fields: Record<string, unknown> = {}): string {
  const settle = { success: true, transaction: TX_UPLOAD, network: 'base-sepolia', payer: account.address, errorReason: null, ...fields };
  return Buffer.from(JSON.stringify(settle)).toString('base64');
}

/** The headers the gateway attaches to a settled paid response */
function settled(transaction: string): Record<string, string> {
  return {
    'X-PAYMENT-RESPONSE': receipt({ transaction }),
    'X-Payment-Transaction': transaction,
    'X-Payment-Mode': 'paid',
  };
}

interface Answer {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/** x402 protocol of the stub's 402: v1 in the body, v2 in the PAYMENT-REQUIRED header */
let protocol: 1 | 2;
/** Answer to the paid request, per path */
let answers: Record<string, Answer>;
/** Whether pool acquisition asks for payment (else it is free) */
let poolPaid: boolean;
/** Number of paid requests the stub received */
let payments: number;

const UPLOAD = '/api/v1/data/';
const ACQUIRE = '/api/v1/pool/acquire';

const gateway = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  if (request.signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
  const paid = request.headers.has('X-PAYMENT') || request.headers.has('PAYMENT-SIGNATURE');
  const path = new URL(request.url).pathname;
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }));
  const defaultBody = path === ACQUIRE ? { batch_id: POOL_STAMP, depth: 17, size_name: 'small', fallback_used: false } : { reference: REFERENCE };

  if (request.method === 'GET') {
    return json({ enabled: true, total_stamps: 3, current_levels: {}, reserve_config: {}, low_reserve_warning: false });
  }
  // Free tier, and free pool acquisition: answered without payment or receipt
  if (request.headers.get('X-Payment-Mode') === 'free' || (path === ACQUIRE && !poolPaid)) {
    return json(defaultBody, 200, { 'X-Payment-Mode': 'free-tier' });
  }
  if (!paid && protocol === 2) {
    const header = Buffer.from(
      JSON.stringify({ x402Version: 2, error: 'Payment required', resource: { url: request.url }, accepts: [v2Option()] })
    ).toString('base64');
    return Promise.resolve(new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': header } }));
  }
  if (!paid) {
    return json({ detail: { x402Version: 1, error: 'Payment required', accepts: [v1Option()] } }, 402);
  }
  payments++;
  const answer = answers[path] ?? { status: 200, headers: settled(TX_UPLOAD) };
  return json(answer.body ?? defaultBody, answer.status, answer.headers);
};
vi.stubGlobal('fetch', gateway);

function client(config: Partial<ProvenanceClientConfig> = {}): ProvenanceClient {
  return new ProvenanceClient({
    gatewayUrl: 'http://gateway.test',
    payment: { wallet },
    retry: { maxRetries: 2, baseDelayMs: 1 },
    ...config,
  });
}

/** The receipt for the stub's default 0.01 USDC v1 payment */
const UPLOAD_RECEIPT = {
  transaction: TX_UPLOAD,
  network: 'base-sepolia',
  payer: account.address,
  amount: '10000',
  amountDecimal: '0.01',
  asset: USDC_SEPOLIA,
};

beforeEach(() => {
  protocol = 1;
  answers = {};
  poolPaid = false;
  payments = 0;
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe('paid results carry the payment receipt (#111)', () => {
  it('upload(): transaction, network and payer from X-PAYMENT-RESPONSE, amount from the signed maxAmountRequired', async () => {
    const result = await client().upload('hello', { stampId: STAMP });
    expect(payments).toBe(1);
    expect(result.reference).toBe(REFERENCE);
    expect(result.payment).toEqual(UPLOAD_RECEIPT);
    expect(result.stampPayment).toBeUndefined();
  });

  it('upload(raw: true): the document result carries the receipt too', async () => {
    const result = await client().upload({ a: 1 }, { stampId: STAMP, raw: true });
    expect(result.payment).toEqual(UPLOAD_RECEIPT);
  });

  it('acquireStamp(): the paid acquisition carries its receipt', async () => {
    poolPaid = true;
    answers[ACQUIRE] = { status: 200, headers: settled(TX_POOL) };
    const stamp = await client({ payment: { wallet, payForPool: true } }).acquireStamp();
    expect(stamp.batchId).toBe(POOL_STAMP);
    expect(stamp.payment).toEqual({ ...UPLOAD_RECEIPT, transaction: TX_POOL });
  });

  it('upload() that paid for its pool stamp reports both payments, kept apart', async () => {
    poolPaid = true;
    answers[ACQUIRE] = { status: 200, headers: settled(TX_POOL) };
    const result = await client({ payment: { wallet, payForPool: true } }).upload('hello');
    expect(payments).toBe(2);
    expect(result.payment?.transaction).toBe(TX_UPLOAD);
    expect(result.stampPayment?.transaction).toBe(TX_POOL);
    expect(result.metadata.stamp_id).toBe(POOL_STAMP);
  });

  it('x402 v2: the transaction comes from PAYMENT-RESPONSE and the amount from the signed v2 amount', async () => {
    protocol = 2;
    answers[UPLOAD] = {
      status: 200,
      headers: { 'PAYMENT-RESPONSE': receipt({ transaction: TX_UPLOAD, network: 'eip155:84532' }) },
    };
    const result = await client().upload('hello', { stampId: STAMP });
    expect(result.payment).toEqual({
      transaction: TX_UPLOAD,
      network: 'eip155:84532',
      payer: account.address,
      amount: '25000',
      amountDecimal: '0.025',
      asset: USDC_SEPOLIA,
    });
  });

  it('an idempotent replay is marked replayed and names the first attempt\'s transaction', async () => {
    answers[UPLOAD] = { status: 200, headers: { ...settled(TX_POOL), 'Idempotent-Replayed': 'true' } };
    const result = await client().upload('hello', { stampId: STAMP, idempotencyKey: 'k1' });
    expect(result.payment).toEqual({ ...UPLOAD_RECEIPT, transaction: TX_POOL, replayed: true });
  });
});

describe('no charge is reported that did not happen (#111)', () => {
  it("'free' mode results carry no payment", async () => {
    const result = await client({ payment: 'free' }).upload('hello');
    expect(payments).toBe(0);
    expect(result.payment).toBeUndefined();
    expect(result.stampPayment).toBeUndefined();
  });

  it('a free pool acquisition in x402 mode leaves stampPayment unset', async () => {
    const result = await client().upload('hello');
    expect(payments).toBe(1);
    expect(result.payment?.transaction).toBe(TX_UPLOAD);
    expect(result.stampPayment).toBeUndefined();
    expect('stampPayment' in result).toBe(false);
  });

  it('a paid 2xx whose receipt says success: false carries no payment', async () => {
    answers[UPLOAD] = {
      status: 200,
      headers: { 'X-PAYMENT-RESPONSE': receipt({ success: false, transaction: '', errorReason: 'insufficient_funds' }) },
    };
    const result = await client().upload('hello', { stampId: STAMP });
    expect(payments).toBe(1);
    expect(result.payment).toBeUndefined();
  });

  it('a paid 2xx the gateway answered on the free tier carries no payment', async () => {
    answers[UPLOAD] = { status: 200, headers: { 'X-Payment-Mode': 'free-tier' } };
    const result = await client().upload('hello', { stampId: STAMP });
    expect(result.payment).toBeUndefined();
  });

  it('without receipt headers (hidden by CORS) the result has the signed amount but no transaction', async () => {
    answers[UPLOAD] = { status: 200, headers: {} };
    const result = await client().upload('hello', { stampId: STAMP });
    expect(result.payment).toEqual({ network: 'base-sepolia', amount: '10000', amountDecimal: '0.01', asset: USDC_SEPOLIA });
  });

  it('the "unknown" placeholder is never a transaction, in the header or the receipt', async () => {
    for (const transaction of ['unknown', '']) {
      answers[UPLOAD] = {
        status: 200,
        headers: { 'X-PAYMENT-RESPONSE': receipt({ transaction }), 'X-Payment-Transaction': 'unknown' },
      };
      const result = await client().upload('hello', { stampId: STAMP });
      expect(result.payment?.transaction).toBeUndefined();
      expect(result.payment?.amount).toBe('10000');
    }
  });

  it('an undecodable receipt header is ignored: the transaction comes from X-Payment-Transaction', async () => {
    answers[UPLOAD] = { status: 200, headers: { 'X-PAYMENT-RESPONSE': '%%%not-base64', 'X-Payment-Transaction': TX_UPLOAD } };
    const result = await client().upload('hello', { stampId: STAMP });
    expect(result.payment).toEqual({
      transaction: TX_UPLOAD,
      network: 'base-sepolia',
      amount: '10000',
      amountDecimal: '0.01',
      asset: USDC_SEPOLIA,
    });
  });
});

/** swarm_connect _paid_request_crashed: a paid handler raised after settlement (top-level body, no receipt header) */
const crashed = (transaction: string): Answer => ({
  status: 500,
  headers: { 'X-Payment-Transaction': transaction, 'X-Payment-Status': 'settled_not_delivered' },
  body: {
    code: 'DELIVERY_FAILED_AFTER_PAYMENT',
    message: 'The payment was collected but the request failed before completing. Contact the operator with this transaction for a refund.',
    transaction,
    x402_status: 'settled_not_delivered',
  },
});

describe('errors after payment carry the receipt (#111)', () => {
  it('a handler error after settlement (_finish_paid): transaction, network, payer and amount on error.payment', async () => {
    // _finish_paid passes the handler's own error body through and adds the
    // receipt headers, with X-Payment-Status when the status is not 2xx
    answers[UPLOAD] = {
      status: 502,
      headers: { ...settled(TX_UPLOAD), 'X-Payment-Status': 'settled_not_delivered' },
      body: { detail: 'Upload to Swarm failed' },
    };
    const error = await client().upload('hello', { stampId: STAMP }).catch((e: unknown) => e);
    expect(payments).toBe(1);
    expect(error).toBeInstanceOf(GatewayConnectionError);
    expect((error as GatewayConnectionError).payment).toEqual({
      paymentSent: true,
      ...UPLOAD_RECEIPT,
      status: 'settled_not_delivered',
      idempotencyKey: ANY_KEY,
      stampId: STAMP,
    });
    expect((error as Error).message).toContain(`transaction ${TX_UPLOAD}`);
  });

  it('500 DELIVERY_FAILED_AFTER_PAYMENT (_paid_request_crashed): transaction and status, no receipt fields', async () => {
    answers[UPLOAD] = crashed(TX_UPLOAD);
    const error = await client().upload('hello', { stampId: STAMP }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayConnectionError);
    expect((error as GatewayConnectionError).code).toBe('DELIVERY_FAILED_AFTER_PAYMENT');
    expect((error as GatewayConnectionError).payment).toEqual({
      paymentSent: true,
      transaction: TX_UPLOAD,
      status: 'settled_not_delivered',
      idempotencyKey: ANY_KEY,
      stampId: STAMP,
    });
  });

  it('a top-level transaction in the body is read when no header names one; "unknown" is not', async () => {
    const { body } = crashed(TX_UPLOAD);
    answers[UPLOAD] = { status: 500, body };
    const error = await client().upload('hello', { stampId: STAMP }).catch((e: unknown) => e);
    expect((error as GatewayConnectionError).payment?.transaction).toBe(TX_UPLOAD);

    answers[UPLOAD] = { status: 500, body: { ...(body as Record<string, unknown>), transaction: 'unknown' } };
    const unknown = await client().upload('hello', { stampId: STAMP }).catch((e: unknown) => e);
    expect((unknown as GatewayConnectionError).payment).toBeDefined();
    expect((unknown as GatewayConnectionError).payment?.transaction).toBeUndefined();
  });
});

// A paid pool acquisition needs payForPool since #109; without it the pool stamp is acquired unpaid.
describe('a failed upload() keeps the receipt of the pool stamp it paid for (#157 review)', () => {
  it('a paid upload that fails reports both payments and the stamp', async () => {
    poolPaid = true;
    answers[ACQUIRE] = { status: 200, headers: settled(TX_POOL) };
    answers[UPLOAD] = crashed(TX_UPLOAD);
    const error = (await client({ payment: { wallet, payForPool: true } })
      .upload('hello')
      .catch((e: unknown) => e)) as GatewayConnectionError;
    expect(payments).toBe(2);
    expect(error.payment?.transaction).toBe(TX_UPLOAD);
    expect(error.payment?.stampId).toBe(POOL_STAMP);
    expect(error.stampId).toBe(POOL_STAMP);
    expect(error.stampPayment).toEqual({ ...UPLOAD_RECEIPT, transaction: TX_POOL });
    expect(error.message).toMatch(new RegExp(`call upload\\(\\) again with idempotencyKey ".+" and stampId "${POOL_STAMP}"`));
  });

  it('an upload refused after the stamp was paid: no payment of its own, but the stamp and its receipt', async () => {
    poolPaid = true;
    answers[ACQUIRE] = { status: 200, headers: settled(TX_POOL) };
    let approvals = 0;
    const error = (await client({ payment: { wallet, payForPool: true, onBeforePayment: () => ++approvals === 1 } })
      .upload('hello')
      .catch((e: unknown) => e)) as PaymentRefusedError;
    expect(payments).toBe(1); // the stamp only
    expect(error).toBeInstanceOf(PaymentRefusedError);
    expect(error.payment).toBeUndefined();
    expect(error.stampId).toBe(POOL_STAMP);
    expect(error.stampPayment?.transaction).toBe(TX_POOL);
    expect(error.message).toContain(`The pool stamp was paid for (transaction ${TX_POOL})`);
    expect(error.message).toContain(`call upload() again with stampId "${POOL_STAMP}"`);
  });

  it('a stamp passed by the caller is not repeated on the error, and a free pool stamp has no stampPayment', async () => {
    answers[UPLOAD] = crashed(TX_UPLOAD);
    const given = (await client().upload('hello', { stampId: STAMP }).catch((e: unknown) => e)) as GatewayConnectionError;
    expect(given.stampId).toBeUndefined();
    expect(given.stampPayment).toBeUndefined();

    const free = (await client().upload('hello').catch((e: unknown) => e)) as GatewayConnectionError;
    expect(free.stampId).toBe(POOL_STAMP);
    expect(free.stampPayment).toBeUndefined();
  });
});
