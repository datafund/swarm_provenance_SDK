import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encodeFunctionResult } from 'viem';
import { ChainClient } from '../../../src/chain/client.js';
import { ChainConnectionError } from '../../../src/chain/errors.js';
import { BASE_SEPOLIA } from '../../../src/chain/constants.js';
import { DATA_PROVENANCE_ABI } from '../../../src/chain/abi.js';

// Unlike client.test.ts, viem is NOT mocked here: these tests drive the real
// viem transports through a stubbed fetch, so they exercise actual failover.

const USER = '0x1234567890abcdef1234567890abcdef12345678';
const COUNT_RESULT = encodeFunctionResult({
  abi: DATA_PROVENANCE_ABI,
  functionName: 'getUserDataRecordsCount',
  result: 5n,
});

interface RpcCall {
  url: string;
  method: string;
}

type Responder = (method: string) => { status: number; body: unknown } | undefined;

/** The partial outage seen on sepolia.base.org: cached methods answer, state methods 503. */
const degraded: Responder = (method) =>
  method === 'eth_chainId' || method === 'eth_blockNumber'
    ? { status: 200, body: { result: '0x14a34' } }
    : { status: 503, body: { error: { code: -32011, message: 'no backend is currently healthy to serve traffic' } } };

const healthy: Responder = (method) => {
  if (method === 'eth_call') return { status: 200, body: { result: COUNT_RESULT } };
  if (method === 'eth_gasPrice') return { status: 200, body: { result: '0x5b8d80' } };
  return { status: 200, body: { result: '0x14a34' } };
};

const reverting: Responder = () => ({
  status: 200,
  body: { error: { code: 3, message: 'execution reverted' } },
});

let calls: RpcCall[];

function stubRpc(endpoints: Record<string, Responder>): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = raw.replace(/\/$/, ''); // viem normalises URLs with a trailing slash
      const req = JSON.parse(String(init?.body)) as { id: number; method: string };
      calls.push({ url, method: req.method });
      const responder = endpoints[url];
      const res = responder?.(req.method) ?? { status: 404, body: {} };
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...(res.body as object) }), {
          status: res.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}

const [FALLBACK_1, FALLBACK_2] = BASE_SEPOLIA.rpcFallbacks ?? [];

describe('ChainClient RPC fallback', () => {
  beforeEach(() => {
    calls = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('base-sepolia preset ships a primary plus fallbacks, with sepolia.base.org last', () => {
    expect(BASE_SEPOLIA.rpcUrl).toBe('https://base-sepolia-rpc.publicnode.com');
    expect(BASE_SEPOLIA.rpcFallbacks).toEqual([
      'https://base-sepolia.gateway.tenderly.co',
      'https://sepolia.base.org',
    ]);
  });

  it('fails over to the next preset URL when the primary returns 503 / -32011', async () => {
    stubRpc({ [BASE_SEPOLIA.rpcUrl]: degraded, [FALLBACK_1!]: healthy });
    const client = new ChainClient({ chain: 'base-sepolia' });

    await expect(client.getUserDataRecordsCount(USER)).resolves.toBe(5);

    const ethCalls = calls.filter((c) => c.method === 'eth_call').map((c) => c.url);
    expect(ethCalls[0]).toBe(BASE_SEPOLIA.rpcUrl);
    expect(ethCalls.at(-1)).toBe(FALLBACK_1);
    expect(ethCalls).not.toContain(FALLBACK_2);
  });

  it('reaches the last fallback when every earlier URL is down', async () => {
    stubRpc({ [BASE_SEPOLIA.rpcUrl]: degraded, [FALLBACK_1!]: degraded, [FALLBACK_2!]: healthy });
    const client = new ChainClient({ chain: 'base-sepolia' });

    await expect(client.getUserDataRecordsCount(USER)).resolves.toBe(5);
    expect(calls.filter((c) => c.method === 'eth_call').at(-1)?.url).toBe(FALLBACK_2);
  });

  it('surfaces ChainConnectionError when all URLs fail', async () => {
    stubRpc({ [BASE_SEPOLIA.rpcUrl]: degraded, [FALLBACK_1!]: degraded, [FALLBACK_2!]: degraded });
    const client = new ChainClient({ chain: 'base-sepolia', retry: { maxRetries: 0 } });

    await expect(client.getUserDataRecordsCount(USER)).rejects.toThrow(ChainConnectionError);
  });

  it('does not fail over on a contract revert', async () => {
    stubRpc({ [BASE_SEPOLIA.rpcUrl]: reverting, [FALLBACK_1!]: healthy });
    const client = new ChainClient({ chain: 'base-sepolia' });

    await expect(client.getUserDataRecordsCount(USER)).rejects.toThrow(ChainConnectionError);
    expect(calls.map((c) => c.url)).not.toContain(FALLBACK_1);
  });

  it('an explicit rpcUrl disables the preset fallbacks', async () => {
    const custom = 'https://rpc.example.com';
    stubRpc({ [custom]: degraded, [FALLBACK_1!]: healthy, [FALLBACK_2!]: healthy });
    const client = new ChainClient({ chain: 'base-sepolia', rpcUrl: custom });

    await expect(client.getUserDataRecordsCount(USER)).rejects.toThrow(ChainConnectionError);
    expect(new Set(calls.map((c) => c.url))).toEqual(new Set([custom]));
  });

  it('an explicit rpcUrl with explicit rpcFallbacks uses only those', async () => {
    const custom = 'https://rpc.example.com';
    const backup = 'https://backup.example.com';
    stubRpc({ [custom]: degraded, [backup]: healthy, [FALLBACK_1!]: healthy });
    const client = new ChainClient({ chain: 'base-sepolia', rpcUrl: custom, rpcFallbacks: [backup] });

    await expect(client.getUserDataRecordsCount(USER)).resolves.toBe(5);
    expect(calls.map((c) => c.url)).not.toContain(FALLBACK_1);
    expect(calls.at(-1)?.url).toBe(backup);
  });

  it('rpcFallbacks: [] turns the preset fallbacks off', async () => {
    stubRpc({ [BASE_SEPOLIA.rpcUrl]: degraded, [FALLBACK_1!]: healthy });
    const client = new ChainClient({ chain: 'base-sepolia', rpcFallbacks: [] });

    await expect(client.getUserDataRecordsCount(USER)).rejects.toThrow(ChainConnectionError);
    expect(new Set(calls.map((c) => c.url))).toEqual(new Set([BASE_SEPOLIA.rpcUrl]));
  });

  describe('healthCheck', () => {
    it('reports an endpoint that answers eth_chainId but not state methods as unhealthy', async () => {
      const custom = 'https://rpc.example.com';
      stubRpc({ [custom]: degraded });
      const client = new ChainClient({ chain: 'base-sepolia', rpcUrl: custom });

      await expect(client.healthCheck()).resolves.toBe(false);
    });

    it('reports healthy when a fallback can serve state methods', async () => {
      stubRpc({ [BASE_SEPOLIA.rpcUrl]: degraded, [FALLBACK_1!]: healthy });
      const client = new ChainClient({ chain: 'base-sepolia' });

      await expect(client.healthCheck()).resolves.toBe(true);
    });
  });
});
