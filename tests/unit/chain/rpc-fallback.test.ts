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
  /** URL exactly as fetched, before trailing-slash normalisation */
  raw: string;
  method: string;
}

type Responder = (method: string) => { status: number; body: unknown } | undefined;

/** The partial outage seen on sepolia.base.org: cached methods answer, state methods 503. */
const degraded: Responder = (method) =>
  method === 'eth_chainId' || method === 'eth_blockNumber'
    ? { status: 200, body: { result: '0x14a34' } }
    : { status: 503, body: { error: { code: -32011, message: 'no backend is currently healthy to serve traffic' } } };

/** Worse case a reviewer raised: gas price also answered (cached/oracle), only eth_call fails. */
const callsOnlyFail: Responder = (method) =>
  method === 'eth_call'
    ? { status: 503, body: { error: { code: -32011, message: 'no backend is currently healthy to serve traffic' } } }
    : { status: 200, body: { result: method === 'eth_gasPrice' ? '0x5b8d80' : '0x14a34' } };

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
      calls.push({ url, raw, method: req.method });
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

  it('surfaces ChainConnectionError when all URLs fail, after two passes over the list', async () => {
    stubRpc({ [BASE_SEPOLIA.rpcUrl]: degraded, [FALLBACK_1!]: degraded, [FALLBACK_2!]: degraded });
    const client = new ChainClient({ chain: 'base-sepolia' });

    await expect(client.getUserDataRecordsCount(USER)).rejects.toThrow(ChainConnectionError);
    // retryCount 1: one retry pass; viem's default (3) would make 12 requests
    const pass = [BASE_SEPOLIA.rpcUrl, FALLBACK_1, FALLBACK_2];
    expect(calls.map((c) => c.url)).toEqual([...pass, ...pass]);
  });

  it('a renamed or cloned custom preset with its own rpcUrl does not inherit the public fallbacks', async () => {
    const custom = 'https://private-rpc.example.com';
    stubRpc({ [custom]: degraded, [FALLBACK_1!]: healthy, [FALLBACK_2!]: healthy });
    const renamed = { ...BASE_SEPOLIA, name: 'my-sepolia', rpcUrl: custom };
    const cloned = JSON.parse(JSON.stringify(renamed)) as typeof renamed;

    for (const chain of [renamed, cloned]) {
      await expect(new ChainClient({ chain }).getUserDataRecordsCount(USER)).rejects.toThrow(ChainConnectionError);
    }
    expect(new Set(calls.map((c) => c.url))).toEqual(new Set([custom]));
  });

  it('an explicit rpcUrl equal to the preset URL keeps the preset fallbacks', async () => {
    stubRpc({ [BASE_SEPOLIA.rpcUrl]: degraded, [FALLBACK_1!]: healthy });
    const client = new ChainClient({ chain: 'base-sepolia', rpcUrl: BASE_SEPOLIA.rpcUrl });

    await expect(client.getUserDataRecordsCount(USER)).resolves.toBe(5);
  });

  it('a preset spread from BASE_SEPOLIA onto another chain does not inherit the Sepolia fallbacks', async () => {
    const custom = 'https://private-base-mainnet.example.com';
    stubRpc({ [custom]: degraded, [FALLBACK_1!]: healthy, [FALLBACK_2!]: healthy, [BASE_SEPOLIA.rpcUrl]: healthy });
    const chain = { ...BASE_SEPOLIA, chainId: 8453, name: 'base', rpcUrl: custom };

    await expect(new ChainClient({ chain }).getUserDataRecordsCount(USER)).rejects.toThrow(ChainConnectionError);
    expect(new Set(calls.map((c) => c.url))).toEqual(new Set([custom]));
  });

  it("an explicit rpcUrl that is one of the preset's own URLs keeps failover to the others", async () => {
    stubRpc({ [FALLBACK_2!]: degraded, [BASE_SEPOLIA.rpcUrl]: healthy });
    // sepolia.base.org: the default older docs told users to pass explicitly
    const client = new ChainClient({ chain: 'base-sepolia', rpcUrl: FALLBACK_2! });

    await expect(client.getUserDataRecordsCount(USER)).resolves.toBe(5);
    expect(calls.map((c) => c.url)).toEqual([FALLBACK_2, BASE_SEPOLIA.rpcUrl]);
  });

  it('drops blank rpcFallbacks entries (e.g. from splitting an empty env var)', async () => {
    const backup = 'https://backup.example.com';
    stubRpc({ [BASE_SEPOLIA.rpcUrl]: degraded, [backup]: healthy });
    const client = new ChainClient({ chain: 'base-sepolia', rpcFallbacks: ['', ' ', backup] });

    await expect(client.getUserDataRecordsCount(USER)).resolves.toBe(5);
  });

  it("an empty rpcUrl means 'not set'", async () => {
    stubRpc({ [BASE_SEPOLIA.rpcUrl]: healthy });
    const client = new ChainClient({ chain: 'base-sepolia', rpcUrl: '' });

    await expect(client.getUserDataRecordsCount(USER)).resolves.toBe(5);
  });

  it('passes a URL with a meaningful trailing slash to viem unchanged', async () => {
    const custom = 'https://host.example.com/rpc/';
    stubRpc({ 'https://host.example.com/rpc': healthy });
    const client = new ChainClient({ chain: 'base-sepolia', rpcUrl: custom });

    await expect(client.getUserDataRecordsCount(USER)).resolves.toBe(5);
    expect(calls[0]?.raw).toBe(custom);
  });

  it('a custom preset spread from BASE_SEPOLIA with its own rpcUrl does not inherit the public fallbacks', async () => {
    const custom = 'https://private-rpc.example.com';
    stubRpc({ [custom]: degraded, [FALLBACK_1!]: healthy, [FALLBACK_2!]: healthy });
    const client = new ChainClient({ chain: { ...BASE_SEPOLIA, rpcUrl: custom } });

    await expect(client.getUserDataRecordsCount(USER)).rejects.toThrow(ChainConnectionError);
    expect(new Set(calls.map((c) => c.url))).toEqual(new Set([custom]));
  });

  it('a custom preset with its own rpcFallbacks keeps them', async () => {
    const custom = 'https://private-rpc.example.com';
    const backup = 'https://backup.example.com';
    stubRpc({ [custom]: degraded, [backup]: healthy });
    const client = new ChainClient({ chain: { ...BASE_SEPOLIA, rpcUrl: custom, rpcFallbacks: [backup] } });

    await expect(client.getUserDataRecordsCount(USER)).resolves.toBe(5);
  });

  it('treats URLs differing only by a trailing slash as one endpoint', async () => {
    const custom = 'https://rpc.example.com';
    const backup = 'https://backup.example.com';
    stubRpc({ [custom]: degraded, [backup]: healthy });
    const client = new ChainClient({ chain: 'base-sepolia', rpcUrl: custom, rpcFallbacks: [`${custom}/`, backup] });

    await expect(client.getUserDataRecordsCount(USER)).resolves.toBe(5);
    expect(calls.map((c) => c.url)).toEqual([custom, backup]);
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

    it('reports unhealthy when chain id and gas price answer but eth_call fails', async () => {
      const custom = 'https://rpc.example.com';
      stubRpc({ [custom]: callsOnlyFail });
      const client = new ChainClient({ chain: 'base-sepolia', rpcUrl: custom });

      await expect(client.healthCheck()).resolves.toBe(false);
    });

    it('probes with an eth_call to the configured contract', async () => {
      stubRpc({ [BASE_SEPOLIA.rpcUrl]: healthy });
      const client = new ChainClient({ chain: 'base-sepolia', rpcFallbacks: [] });

      await expect(client.healthCheck()).resolves.toBe(true);
      expect(calls.map((c) => c.method)).toEqual(['eth_call']);
    });

    it('reports healthy when a fallback can serve state methods', async () => {
      stubRpc({ [BASE_SEPOLIA.rpcUrl]: degraded, [FALLBACK_1!]: healthy });
      const client = new ChainClient({ chain: 'base-sepolia' });

      await expect(client.healthCheck()).resolves.toBe(true);
    });
  });
});
