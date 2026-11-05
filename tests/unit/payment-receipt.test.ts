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

/** A v2 PaymentRequired, base64-encoded for the PAYMENT-REQUIRED header */
function v2Header(url: string, accepts: unknown[] = [v2Option()]): string {
  return Buffer.from(JSON.stringify({ x402Version: 2, error: 'Payment required', resource: { url }, accepts })).toString('base64');
}

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

/**
 * x402 protocol of the stub's 402: v1 in the body, v2 in the PAYMENT-REQUIRED
 * header, or 'dual': both in one 402 (the gateway's transition mode, epic D2)
 */
let protocol: 1 | 2 | 'dual';
/** The payment header of the last paid request the stub received */
let paidWith: 'X-PAYMENT' | 'PAYMENT-SIGNATURE' | undefined;
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
    return Promise.resolve(new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': v2Header(request.url) } }));
  }
  if (!paid && protocol === 'dual') {
    return json({ x402Version: 1, error: 'Payment required', accepts: [v1Option()] }, 402, { 'PAYMENT-REQUIRED': v2Header(request.url) });
  }
  if (!paid) {
    return json({ detail: { x402Version: 1, error: 'Payment required', accepts: [v1Option()] } }, 402);
  }
  payments++;
  paidWith = request.headers.has('PAYMENT-SIGNATURE') ? 'PAYMENT-SIGNATURE' : 'X-PAYMENT';
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
  paidWith = undefined;
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
    // One network format (#159): the x402 v1 name, also for a v2 receipt
    expect(result.payment).toEqual({
      transaction: TX_UPLOAD,
      network: 'base-sepolia',
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

  it('pin (#209): a paid v1 request answered by a v1 402 names the v1 price and the v1 receipt', async () => {
    answers[UPLOAD] = {
      status: 402,
      headers: { 'X-PAYMENT-RESPONSE': receipt({ success: false, transaction: '', errorReason: 'invalid_signature' }) },
      body: { x402Version: 1, error: 'Payment verification failed', accepts: [v1Option()] },
    };
    const error = (await client().upload('hello', { stampId: STAMP }).catch((e: unknown) => e)) as GatewayConnectionError;
    expect(payments).toBe(1);
    expect(
      error.message.startsWith(
        'Payment verification failed (price: 0.01 USDC on base-sepolia) (a payment was sent with this request and may have been charged).'
      )
    ).toBe(true);
    expect(error.payment).toEqual({
      paymentSent: true,
      network: 'base-sepolia',
      payer: account.address,
      amount: '10000',
      amountDecimal: '0.01',
      asset: USDC_SEPOLIA,
      idempotencyKey: ANY_KEY,
      stampId: STAMP,
    });
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

/** The receipt for the stub's 0.025 USDC v2 payment, in the SDK's one network format (#159) */
const V2_RECEIPT = {
  transaction: TX_UPLOAD,
  network: 'base-sepolia',
  payer: account.address,
  amount: '25000',
  amountDecimal: '0.025',
  asset: USDC_SEPOLIA,
};

describe('x402 v2 shapes (#209)', () => {
  it('a dual-mode 402 (v1 body, v2 header): the library pays v2, and the SDK reports the v2 price and receipt', async () => {
    protocol = 'dual';
    answers[UPLOAD] = { status: 200, headers: { 'PAYMENT-RESPONSE': receipt({ network: 'eip155:84532' }) } };
    const seen: unknown[] = [];
    const result = await client({ payment: { wallet, onBeforePayment: (request) => void seen.push(request) } }).upload('hello', {
      stampId: STAMP,
    });
    expect(payments).toBe(1);
    expect(paidWith).toBe('PAYMENT-SIGNATURE');
    expect(seen).toEqual([expect.objectContaining({ x402Version: 2, amount: '25000', network: 'eip155:84532' })]);
    expect(result.payment).toEqual(V2_RECEIPT);
  });

  it('a dual-mode 402 answering the paid request: the message names the v2 price, error.payment the v2 terms', async () => {
    protocol = 'dual';
    answers[UPLOAD] = {
      status: 402,
      headers: {
        'PAYMENT-REQUIRED': v2Header('http://gateway.test/api/v1/data/'),
        'PAYMENT-RESPONSE': receipt({ success: false, transaction: '', network: 'eip155:84532', errorReason: 'invalid_signature' }),
      },
      body: { x402Version: 1, error: 'Payment verification failed', accepts: [v1Option()] },
    };
    const error = (await client().upload('hello', { stampId: STAMP }).catch((e: unknown) => e)) as GatewayConnectionError;
    expect(paidWith).toBe('PAYMENT-SIGNATURE');
    expect(error.message.startsWith('Payment verification failed (price: 0.025 USDC on base-sepolia) (a payment was sent')).toBe(true);
    expect(error.payment).toEqual({
      paymentSent: true,
      network: 'base-sepolia',
      payer: account.address,
      amount: '25000',
      amountDecimal: '0.025',
      asset: USDC_SEPOLIA,
      idempotencyKey: ANY_KEY,
      stampId: STAMP,
    });
  });

  it('PAYMENT-RESPONSE is read before X-PAYMENT-RESPONSE (D4)', async () => {
    protocol = 2;
    const other = '0x' + '3'.repeat(64);
    answers[UPLOAD] = {
      status: 200,
      headers: { 'X-PAYMENT-RESPONSE': receipt({ transaction: other }), 'PAYMENT-RESPONSE': receipt({ network: 'eip155:84532' }) },
    };
    const result = await client().upload('hello', { stampId: STAMP });
    expect(result.payment?.transaction).toBe(TX_UPLOAD);
  });

  it('an empty PAYMENT-RESPONSE falls through to X-PAYMENT-RESPONSE; an undecodable one does not', async () => {
    // The first non-empty header decides, as in @x402/core getPaymentSettleResponse
    answers[UPLOAD] = { status: 200, headers: { 'PAYMENT-RESPONSE': '', 'X-PAYMENT-RESPONSE': receipt() } };
    expect((await client().upload('hello', { stampId: STAMP })).payment).toEqual(UPLOAD_RECEIPT);

    answers[UPLOAD] = { status: 200, headers: { 'PAYMENT-RESPONSE': '%%%not-base64', 'X-PAYMENT-RESPONSE': receipt() } };
    expect((await client().upload('hello', { stampId: STAMP })).payment?.payer).toBeUndefined();
  });

  it('#159: a v2 receipt without a network falls back to the signed network, as its v1 name', async () => {
    protocol = 2;
    answers[UPLOAD] = { status: 200, headers: { 'PAYMENT-RESPONSE': receipt({ network: undefined }) } };
    expect((await client().upload('hello', { stampId: STAMP })).payment).toEqual(V2_RECEIPT);

    // No receipt at all (hidden by CORS): the signed v2 network, as its v1 name
    answers[UPLOAD] = { status: 200, headers: {} };
    expect((await client().upload('hello', { stampId: STAMP })).payment?.network).toBe('base-sepolia');
  });

  it('#159: v1 and v2 receipt names give the same network; a malformed one is replaced by the signed network', async () => {
    protocol = 2;
    for (const network of ['eip155:84532', 'base-sepolia', '<b>Base Sepolia</b>', 42]) {
      answers[UPLOAD] = { status: 200, headers: { 'PAYMENT-RESPONSE': receipt({ network }) } };
      expect((await client().upload('hello', { stampId: STAMP })).payment?.network).toBe('base-sepolia');
    }
  });

  it('a PAYMENT-RESPONSE over 8192 characters counts as no receipt', async () => {
    protocol = 2;
    answers[UPLOAD] = { status: 200, headers: { 'PAYMENT-RESPONSE': receipt({ network: 'eip155:84532', padding: 'x'.repeat(9000) }) } };
    const result = await client().upload('hello', { stampId: STAMP });
    expect(result.payment).toEqual({ network: 'base-sepolia', amount: '25000', amountDecimal: '0.025', asset: USDC_SEPOLIA });
  });
});
