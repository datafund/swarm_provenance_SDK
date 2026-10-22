import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createWalletClient, http, publicActions } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { ProvenanceClient } from '../../src/client.js';
import {
  GatewayConnectionError,
  PaymentOutcomeError,
  ProvenanceError,
  StampError,
} from '../../src/errors.js';
import type { ProvenanceClientConfig } from '../../src/types.js';

// Idempotency-Key on paid requests (#102), with the REAL @x402/fetch + @x402/evm
// against a stubbed gateway: a 402 first, then the paid request, whose answers
// each test scripts. Payments are signed with Hardhat account #0 (a public test key).

const wallet = createWalletClient({
  account: privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'),
  chain: baseSepolia,
  transport: http('http://127.0.0.1:1'), // never called: signing is local
}).extend(publicActions);

const STAMP = 'a'.repeat(64);
const POOL_STAMP = 'c'.repeat(64);
const REFERENCE = 'b'.repeat(64);
/** Matches the generated Idempotency-Key (#102) */
const ANY_KEY: unknown = expect.any(String);

const accepts = [
  {
    scheme: 'exact',
    network: 'base-sepolia',
    maxAmountRequired: '10000',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    payTo: '0x1111111111111111111111111111111111111111',
    maxTimeoutSeconds: 60,
    resource: 'http://gateway.test/api/v1/data/',
    description: 'upload',
    mimeType: 'application/json',
    extra: { name: 'USDC', version: '2' },
  },
];

interface Seen {
  method: string;
  path: string;
  paid: boolean;
  key: string | null;
  /** Nonce of the payment authorization, on paid requests */
  nonce?: string;
}

interface Answer {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Never answers: only the client's timeout ends the request */
  hang?: boolean;
  /** Answers after this many ms */
  delayMs?: number;
}

let seen: Seen[];
/** Answers to paid requests, in order; the last one repeats */
let paidAnswers: Answer[];
/** Whether pool acquisition asks for payment (else it is free) */
let poolPaid: boolean;

/** The gateway's error envelope (swarm_connect app/main.py) */
function envelope(detail: Record<string, unknown>): Record<string, unknown> {
  return { detail, code: detail['code'], message: detail['message'] };
}

function nonceOf(header: string): string {
  const payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as {
    payload: { authorization: { nonce: string } };
  };
  return payload.payload.authorization.nonce;
}

const gateway = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  if (request.signal.aborted) throw new DOMException('aborted', 'AbortError');
  const payment = request.headers.get('X-PAYMENT');
  const path = new URL(request.url).pathname;
  seen.push({
    method: request.method,
    path,
    paid: payment !== null,
    key: request.headers.get('Idempotency-Key'),
    ...(payment ? { nonce: nonceOf(payment) } : {}),
  });

  if (request.method === 'GET') {
    return new Response(JSON.stringify({ enabled: true, total_stamps: 3, current_levels: {}, reserve_config: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (path === '/api/v1/pool/acquire' && !poolPaid) {
    return new Response(JSON.stringify({ batch_id: POOL_STAMP, depth: 17, size_name: 'small', fallback_used: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (!payment) {
    return new Response(JSON.stringify({ x402Version: 1, error: 'Payment required', accepts }), {
      status: 402,
      headers: { 'content-type': 'application/json' },
    });
  }

  const answer = paidAnswers.length > 1 ? paidAnswers.shift()! : paidAnswers[0]!;
  if (answer.hang) {
    return new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  }
  if (answer.delayMs) await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
  const body =
    answer.body ??
    (path === '/api/v1/pool/acquire'
      ? { batch_id: POOL_STAMP, depth: 17, size_name: 'small', fallback_used: false }
      : { reference: REFERENCE });
  return new Response(JSON.stringify(body), {
    status: answer.status,
    headers: { 'content-type': 'application/json', ...answer.headers },
  });
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

/** Paid pool acquisition is opt-in (#109) */
const PAY_FOR_POOL: Partial<ProvenanceClientConfig> = { payment: { wallet, payForPool: true } };

const paid = () => seen.filter((s) => s.paid);
const writes = () => seen.filter((s) => s.method === 'POST');

beforeEach(() => {
  seen = [];
  paidAnswers = [{ status: 200 }];
  poolPaid = false;
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const IN_PROGRESS: Answer = {
  status: 409,
  headers: { 'Retry-After': '0' },
  body: envelope({ code: 'IDEMPOTENCY_KEY_IN_PROGRESS', message: 'The first request with this key is still running.' }),
};

describe('Idempotency-Key on paid requests (#102)', () => {
  it('sends one key on the 402 probe and the paid request of an upload', async () => {
    await client().upload('hello', { stampId: STAMP });

    const keys = writes().map((s) => s.key);
    expect(keys).toHaveLength(2); // 402 probe, then the paid request
    expect(keys[0]).toMatch(/^[\x20-\x7e]{1,255}$/);
    expect(new Set(keys).size).toBe(1);
  });

  it('a new upload gets a new key', async () => {
    await client().upload('hello', { stampId: STAMP });
    await client().upload('hello', { stampId: STAMP });
    const [first, second] = paid().map((s) => s.key);
    expect(first).not.toBe(second);
  });

  it('uses the caller\'s key', async () => {
    await client().upload('hello', { stampId: STAMP, idempotencyKey: 'order-42' });
    expect(paid().map((s) => s.key)).toEqual(['order-42']);
  });

  it('pool acquisition and the upload share the operation\'s key', async () => {
    poolPaid = true;
    await client(PAY_FOR_POOL).upload('hello', { idempotencyKey: 'order-7' });
    expect(paid().map((s) => [s.path, s.key])).toEqual([
      ['/api/v1/pool/acquire', 'order-7'],
      ['/api/v1/data/', 'order-7'],
    ]);
  });

  it('acquireStamp sends a key when it pays', async () => {
    poolPaid = true;
    await client(PAY_FOR_POOL).acquireStamp('small', { idempotencyKey: 'stamp-1' });
    expect(paid().map((s) => s.key)).toEqual(['stamp-1']);
  });

  it('sends no key outside x402 mode, and none on free-tier reads in x402 mode', async () => {
    await new ProvenanceClient({ gatewayUrl: 'http://gateway.test' }).acquireStamp();
    await client().poolStatus();
    expect(seen.map((s) => s.key)).toEqual([null, null]);
  });

  it.each([[''], ['x'.repeat(256)], ['tab\there'], ['naïve']])(
    'refuses the invalid key %j before any request',
    async (key) => {
      const error = await client().upload('hello', { stampId: STAMP, idempotencyKey: key }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProvenanceError);
      expect((error as ProvenanceError).code).toBe('INVALID_INPUT');
      expect(seen).toHaveLength(0);
    }
  );

  it('accepts a 255-character key with spaces', async () => {
    const key = 'a b'.repeat(85);
    await client().upload('hello', { stampId: STAMP, idempotencyKey: key });
    expect(paid().map((s) => s.key)).toEqual([key]);
  });
});

describe('retrying a timed-out paid upload (#102 acceptance)', () => {
  it('the error names the key and stamp; the retry carries the same key and a new authorization', async () => {
    poolPaid = true;
    paidAnswers = [{ status: 200 }, { status: 200, hang: true }, { status: 200 }];
    const first = await client({ ...PAY_FOR_POOL, paidTimeout: 100 })
      .upload('hello')
      .catch((e: unknown) => e);

    expect(first).toBeInstanceOf(GatewayConnectionError);
    expect((first as GatewayConnectionError).code).toBe('TIMEOUT');
    const payment = (first as GatewayConnectionError).payment!;
    expect(payment).toEqual({ paymentSent: true, idempotencyKey: ANY_KEY, stampId: POOL_STAMP });
    expect((first as Error).message).toContain(
      `call upload() again with idempotencyKey "${payment.idempotencyKey}" and stampId "${POOL_STAMP}"`
    );
    // Nothing was retried automatically: one paid upload attempt
    expect(paid().filter((s) => s.path === '/api/v1/data/')).toHaveLength(1);

    const result = await client(PAY_FOR_POOL).upload('hello', { idempotencyKey: payment.idempotencyKey!, stampId: payment.stampId! });
    expect(result.reference).toBe(REFERENCE);

    const uploads = paid().filter((s) => s.path === '/api/v1/data/');
    expect(uploads).toHaveLength(2);
    expect(uploads[1]!.key).toBe(uploads[0]!.key);
    expect(uploads[1]!.nonce).not.toBe(uploads[0]!.nonce);
    // The retry reused the stamp instead of acquiring another one
    expect(paid().filter((s) => s.path === '/api/v1/pool/acquire')).toHaveLength(1);
  });
});

describe('review round 2 (#153)', () => {
  it('a retry with a key skips the empty-pool pre-check: the paid stamp is replayed', async () => {
    poolPaid = true;
    const status = vi.fn(() => ({ enabled: true, total_stamps: 0, current_levels: {}, reserve_config: {} }));
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      // Read the URL without consuming a Request body, which gateway() still needs
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).pathname === '/api/v1/pool/status') {
        return Promise.resolve(new Response(JSON.stringify(status()), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return gateway(input, init);
    });
    try {
      // Without a key the empty pool still fails fast
      await expect(client(PAY_FOR_POOL).upload('hello')).rejects.toMatchObject({ code: 'POOL_EXHAUSTED' });
      // With the first attempt's key it goes to acquisition, which the gateway replays
      const result = await client(PAY_FOR_POOL).upload('hello', { idempotencyKey: 'retry-1' });
      expect(result.reference).toBe(REFERENCE);
      expect(paid().find((s) => s.path === '/api/v1/pool/acquire')?.key).toBe('retry-1');
    } finally {
      vi.stubGlobal('fetch', gateway);
    }
  });

  it('without payForPool, a keyed upload still runs the pool status pre-check (#109)', async () => {
    // Unpaid acquisition sends no key, so the gateway has no stamp to replay
    await client().upload('hello', { idempotencyKey: 'k1' });
    expect(seen.filter((s) => s.path === '/api/v1/pool/status')).toHaveLength(1);

    // A paid acquisition with a key still skips it
    seen = [];
    poolPaid = true;
    await client(PAY_FOR_POOL).upload('hello', { idempotencyKey: 'k2' });
    expect(seen.filter((s) => s.path === '/api/v1/pool/status')).toHaveLength(0);
  });

  it('retry advice does not double a full stop', async () => {
    poolPaid = true;
    paidAnswers = [{ status: 502, body: { detail: { message: 'Bee down', suggestion: 'Try later.' } } }];
    const error = await client(PAY_FOR_POOL).acquireStamp('small', { idempotencyKey: 'p1' }).catch((e: unknown) => e);
    expect((error as Error).message).not.toContain('..');
    expect((error as Error).message).toContain('call acquireStamp() again with idempotencyKey "p1"');
  });
});

describe('retry codes: same key, new authorization', () => {
  it('IDEMPOTENCY_KEY_IN_PROGRESS is retried after Retry-After and returns the first result', async () => {
    paidAnswers = [IN_PROGRESS, { status: 200 }];
    const result = await client().upload('hello', { stampId: STAMP });

    expect(result.reference).toBe(REFERENCE);
    const attempts = paid();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.key).toBe(attempts[0]!.key);
    expect(attempts[1]!.nonce).not.toBe(attempts[0]!.nonce);
  });

  it('IDEMPOTENCY_UNAVAILABLE (503) is retried with the same key', async () => {
    paidAnswers = [
      { status: 503, body: envelope({ code: 'IDEMPOTENCY_UNAVAILABLE', message: 'Key store unavailable.' }) },
      { status: 200 },
    ];
    const result = await client().upload('hello', { stampId: STAMP });

    expect(result.reference).toBe(REFERENCE);
    expect(new Set(paid().map((s) => s.key)).size).toBe(1);
    expect(paid()).toHaveLength(2);
  });

  it('signs at most 3 times, then reports the code as not charged, with how to retry', async () => {
    paidAnswers = [IN_PROGRESS];
    const error = await client().upload('hello', { stampId: STAMP, idempotencyKey: 'k1' }).catch((e: unknown) => e);

    expect(paid()).toHaveLength(3);
    expect(error).toBeInstanceOf(GatewayConnectionError);
    expect((error as GatewayConnectionError).code).toBe('IDEMPOTENCY_KEY_IN_PROGRESS');
    expect((error as GatewayConnectionError).payment).toMatchObject({ paymentSent: true, idempotencyKey: 'k1', stampId: STAMP });
    expect((error as Error).message).toContain('the gateway did not charge');
    expect((error as Error).message).not.toContain('may have been charged');
    expect((error as Error).message).toContain(`call upload() again with idempotencyKey "k1" and stampId "${STAMP}"`);
  });

  it('honours a long Retry-After only up to 30 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      paidAnswers = [{ ...IN_PROGRESS, headers: { 'Retry-After': '3600' } }, { status: 200 }];
      const upload = client({ paidTimeout: 10 * 60_000 }).upload('hello', { stampId: STAMP });
      await vi.waitFor(() => expect(paid()).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(29_000);
      expect(paid()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_100);
      await expect(upload).resolves.toMatchObject({ reference: REFERENCE });
      expect(paid()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honours a Retry-After given as an HTTP date (#123)', async () => {
    const now = Date.UTC(2026, 9, 21, 12, 0, 0);
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'], now });
    try {
      const retryAt = new Date(now + 10_000).toUTCString();
      paidAnswers = [{ ...IN_PROGRESS, headers: { 'Retry-After': retryAt } }, { status: 200 }];
      const upload = client({ paidTimeout: 10 * 60_000 }).upload('hello', { stampId: STAMP });
      await vi.waitFor(() => expect(paid()).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(9_000);
      expect(paid()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_100);
      await expect(upload).resolves.toMatchObject({ reference: REFERENCE });
      expect(paid()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a 409 without an idempotency code after payment is not retried', async () => {
    paidAnswers = [{ status: 409, body: envelope({ code: 'HTTP_409', message: 'Pool exhausted' }) }];
    const error = await client().upload('hello', { stampId: STAMP }).catch((e: unknown) => e);
    expect(paid()).toHaveLength(1);
    expect((error as GatewayConnectionError).statusCode).toBe(409);
  });

  it('IDEMPOTENCY_KEY_REUSED is reported, not retried', async () => {
    paidAnswers = [
      { status: 422, body: envelope({ code: 'IDEMPOTENCY_KEY_REUSED', message: 'This key was used for a different request.' }) },
    ];
    const error = await client().upload('hello', { stampId: STAMP }).catch((e: unknown) => e);
    expect(paid()).toHaveLength(1);
    expect((error as GatewayConnectionError).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((error as Error).message).toContain('This key was used for a different request.');
    // Not charged, and retrying with the same key cannot help: no retry advice
    expect((error as Error).message).toContain('the gateway did not charge');
    expect((error as Error).message).not.toMatch(/may have been charged|again with idempotencyKey/);
  });

  it('a key-only retry advice for acquireStamp, whose body does not depend on a stamp', async () => {
    poolPaid = true;
    paidAnswers = [{ status: 502, body: envelope({ code: 'HTTP_502', message: 'Bee unreachable' }) }];
    const error = await client(PAY_FOR_POOL).acquireStamp('small', { idempotencyKey: 'a1' }).catch((e: unknown) => e);
    expect((error as Error).message).toContain('may have been charged');
    expect((error as Error).message).toContain('call acquireStamp() again with idempotencyKey "a1"');
    expect((error as Error).message).not.toContain('stampId');
  });

  it('a failed paid pool acquisition inside upload() advises the key alone', async () => {
    poolPaid = true;
    paidAnswers = [{ status: 502, body: envelope({ code: 'HTTP_502', message: 'Bee unreachable' }) }];
    const error = await client(PAY_FOR_POOL).upload('hello', { idempotencyKey: 'u1' }).catch((e: unknown) => e);
    expect((error as StampError).payment?.stampId).toBeUndefined();
    expect((error as Error).message).toContain('call upload() again with idempotencyKey "u1"');
    expect((error as Error).message).not.toContain('stampId');
  });
});

describe('stop codes: never retried, identifiers surfaced', () => {
  it('SETTLEMENT_UNKNOWN surfaces the authorization nonce', async () => {
    const nonce = '0x' + '5'.repeat(64);
    paidAnswers = [
      {
        status: 409,
        body: envelope({
          code: 'IDEMPOTENCY_KEY_SETTLEMENT_UNKNOWN',
          message: 'Settlement of the first payment was not confirmed.',
          nonce,
          x402_status: 'settlement_unknown',
        }),
      },
    ];
    const error = await client().upload('hello', { stampId: STAMP, idempotencyKey: 'k2' }).catch((e: unknown) => e);

    expect(paid()).toHaveLength(1);
    expect(error).toBeInstanceOf(PaymentOutcomeError);
    expect((error as PaymentOutcomeError).code).toBe('IDEMPOTENCY_KEY_SETTLEMENT_UNKNOWN');
    expect((error as PaymentOutcomeError).outcome).toBe('unknown');
    expect((error as PaymentOutcomeError).payment).toEqual({ paymentSent: true, idempotencyKey: 'k2', nonce, stampId: STAMP });
    expect((error as Error).message).toContain(nonce);
    expect((error as Error).message).toMatch(/Check it on-chain before paying again/);
  });

  it('SETTLED_PENDING surfaces the transaction', async () => {
    paidAnswers = [
      {
        status: 409,
        headers: { 'X-Payment-Transaction': '0xfeed' },
        body: envelope({ code: 'IDEMPOTENCY_KEY_SETTLED_PENDING', message: 'Paid, no result.', transaction: '0xfeed' }),
      },
    ];
    const error = await client().upload('hello', { stampId: STAMP }).catch((e: unknown) => e);

    expect(paid()).toHaveLength(1);
    expect((error as PaymentOutcomeError).outcome).toBe('settled_not_delivered');
    expect((error as PaymentOutcomeError).payment?.transaction).toBe('0xfeed');
    expect((error as Error).message).toMatch(/was paid \(transaction 0xfeed\).*Contact the gateway operator/);
  });

  it('the gateway\'s "unknown" transaction placeholder is not reported as a transaction', async () => {
    paidAnswers = [
      {
        status: 409,
        headers: { 'X-Payment-Transaction': 'unknown' },
        body: envelope({ code: 'IDEMPOTENCY_KEY_SETTLED_PENDING', message: 'Paid.', transaction: 'unknown' }),
      },
    ];
    const error = await client().upload('hello', { stampId: STAMP }).catch((e: unknown) => e);
    expect((error as PaymentOutcomeError).payment?.transaction).toBeUndefined();
    expect((error as Error).message).not.toContain('transaction unknown');
  });

  it('stop codes carry no retry advice', async () => {
    paidAnswers = [
      { status: 409, body: envelope({ code: 'IDEMPOTENCY_KEY_SETTLEMENT_UNKNOWN', message: 'Unknown.', nonce: '0x1' }) },
    ];
    const error = await client().upload('hello', { stampId: STAMP }).catch((e: unknown) => e);
    expect((error as Error).message).not.toContain('again with idempotencyKey');
  });

  it('SETTLED_PENDING takes the transaction from the body when the header is missing', async () => {
    paidAnswers = [
      { status: 409, body: envelope({ code: 'IDEMPOTENCY_KEY_SETTLED_PENDING', message: 'Paid.', transaction: '0xbeef' }) },
    ];
    const error = await client().upload('hello', { stampId: STAMP }).catch((e: unknown) => e);
    expect((error as PaymentOutcomeError).payment?.transaction).toBe('0xbeef');
  });

  it('DELIVERED_NOT_STORED says the operation succeeded, not that it failed', async () => {
    paidAnswers = [
      {
        status: 409,
        headers: { 'X-Payment-Transaction': '0xd00d' },
        body: envelope({ code: 'IDEMPOTENCY_KEY_DELIVERED_NOT_STORED', message: 'Delivered.', transaction: '0xd00d' }),
      },
    ];
    const error = await client().upload('hello', { stampId: STAMP }).catch((e: unknown) => e);

    expect(paid()).toHaveLength(1);
    expect((error as PaymentOutcomeError).outcome).toBe('delivered');
    expect((error as Error).message).toMatch(/succeeded and was paid once \(transaction 0xd00d\)/);
    expect((error as Error).message).toMatch(/Do not pay for it again/);
  });

  it('a stop code on pool acquisition stays a PaymentOutcomeError, not a StampError', async () => {
    poolPaid = true;
    paidAnswers = [
      { status: 409, body: envelope({ code: 'IDEMPOTENCY_KEY_SETTLED_PENDING', message: 'Paid.', transaction: '0x1' }) },
    ];
    const error = await client(PAY_FOR_POOL).acquireStamp().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentOutcomeError);
    expect(error).not.toBeInstanceOf(StampError);
  });

  it('a stop code on a notary upload stays a PaymentOutcomeError', async () => {
    paidAnswers = [
      { status: 409, body: envelope({ code: 'IDEMPOTENCY_KEY_DELIVERED_NOT_STORED', message: 'Delivered.', transaction: '0x2' }) },
    ];
    const error = await client().upload('hello', { stampId: STAMP, sign: 'notary' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentOutcomeError);
  });
});

describe('paid attempt timeout', () => {
  it('paid attempts are not bounded by the read timeout', async () => {
    paidAnswers = [{ status: 200, delayMs: 150 }];
    const result = await client({ timeout: 50 }).upload('hello', { stampId: STAMP });
    expect(result.reference).toBe(REFERENCE);
  });

  it('paidTimeout bounds a paid attempt', async () => {
    paidAnswers = [{ status: 200, delayMs: 500 }];
    const error = await client({ paidTimeout: 50 }).upload('hello', { stampId: STAMP }).catch((e: unknown) => e);
    expect((error as GatewayConnectionError).code).toBe('TIMEOUT');
  });
});
