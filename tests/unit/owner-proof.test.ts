import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createWalletClient, http, publicActions, recoverMessageAddress } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { ProvenanceClient } from '../../src/client.js';
import { GatewayConnectionError, NotaryError, ProvenanceError } from '../../src/errors.js';
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

const mockFetch = vi.fn<[string, RequestInit | undefined], Promise<Response>>();
vi.stubGlobal('fetch', (url: string, init?: RequestInit) => mockFetch(url, init));
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
    expect(new URL(mockFetch.mock.calls[0]![0]).searchParams.get('stamp_id')).toBe(STAMP);
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
