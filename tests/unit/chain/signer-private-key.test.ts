import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { keccak256, parseTransaction, type Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { fromPrivateKey } from '../../../src/chain/signer.js';
import { ChainClient } from '../../../src/chain/client.js';
import { ChainConfigurationError } from '../../../src/chain/errors.js';
import { BASE_SEPOLIA } from '../../../src/chain/constants.js';

/**
 * fromPrivateKey against a stubbed JSON-RPC endpoint (no network, no real key:
 * the key is generated per run). Each URL gets its own chain ID and an optional
 * answer for eth_sendRawTransaction.
 */
type Node = { chainId: number; sendRaw?: (raw: Hex) => { result?: unknown; error?: { code: number; message: string } } };
const nodes = new Map<string, Node>();
const calls: Array<{ url: string; method: string; params: unknown[] }> = [];

function answer(url: string, method: string, params: unknown[]): { result?: unknown; error?: { code: number; message: string } } {
  const node = nodes.get(url);
  if (!node) return { error: { code: -32000, message: `no node at ${url}` } };
  switch (method) {
    case 'eth_chainId':
      return { result: `0x${node.chainId.toString(16)}` };
    case 'eth_getTransactionCount':
      return { result: '0x7' };
    case 'eth_estimateGas':
      return { result: '0x5208' };
    case 'eth_maxPriorityFeePerGas':
      return { result: '0x3b9aca00' };
    case 'eth_gasPrice':
      return { result: '0x3b9aca00' };
    case 'eth_getBlockByNumber':
      return { result: { baseFeePerGas: '0x3b9aca00', number: '0x1', hash: `0x${'11'.repeat(32)}`, transactions: [] } };
    case 'eth_getCode':
      return { result: '0x6080' };
    case 'eth_sendRawTransaction':
      return node.sendRaw ? node.sendRaw(params[0] as Hex) : { result: keccak256(params[0] as Hex) };
    default:
      return { error: { code: -32601, message: `method ${method} not supported` } };
  }
}

beforeEach(() => {
  nodes.clear();
  calls.length = 0;
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = raw.replace(/\/+$/, '');
    const body = JSON.parse(String(init?.body)) as
      | { id: number; method: string; params: unknown[] }
      | Array<{ id: number; method: string; params: unknown[] }>;
    const one = (req: { id: number; method: string; params: unknown[] }) => {
      calls.push({ url, method: req.method, params: req.params });
      return { jsonrpc: '2.0', id: req.id, ...answer(url, req.method, req.params) };
    };
    const payload = Array.isArray(body) ? body.map(one) : one(body);
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const TO = BASE_SEPOLIA.contractAddress;
const DATA: Hex = '0x12345678';

describe('fromPrivateKey (#123)', () => {
  it('returns the hash of the signed transaction when the node answers "already known"', async () => {
    let sent: Hex | undefined;
    nodes.set('https://rpc.test', {
      chainId: 84532,
      sendRaw: (raw) => {
        sent = raw;
        return { error: { code: -32000, message: 'already known' } };
      },
    });
    const signer = await fromPrivateKey(generatePrivateKey(), 'https://rpc.test');

    const hash = await signer.sendTransaction({ to: TO, data: DATA, chainId: 84532 });

    expect(sent).toBeDefined();
    expect(hash).toBe(keccak256(sent!));
    // Still signed for the requested chain (EIP-155)
    expect(parseTransaction(sent!).chainId).toBe(84532);
  });

  it('returns the node\'s hash on success, signed for the requested chain', async () => {
    nodes.set('https://rpc.test', { chainId: 84532 });
    const signer = await fromPrivateKey(generatePrivateKey(), 'https://rpc.test');

    const hash = await signer.sendTransaction({ to: TO, data: DATA, chainId: 84532, gas: 100_000n });

    const raw = calls.find((c) => c.method === 'eth_sendRawTransaction')!.params[0] as Hex;
    expect(hash).toBe(keccak256(raw));
    const tx = parseTransaction(raw);
    expect(tx).toMatchObject({ chainId: 84532, to: TO.toLowerCase(), data: DATA, gas: 100_000n, nonce: 7 });
  });

  it('still throws any other send error', async () => {
    nodes.set('https://rpc.test', {
      chainId: 84532,
      sendRaw: () => ({ error: { code: -32000, message: 'insufficient funds for gas * price + value' } }),
    });
    const signer = await fromPrivateKey(generatePrivateKey(), 'https://rpc.test');

    await expect(signer.sendTransaction({ to: TO, data: DATA, chainId: 84532 })).rejects.toThrow(/insufficient funds/);
  });

  it('a write is still refused when the key\'s RPC is on another chain, and nothing is sent', async () => {
    nodes.set('https://read.test', { chainId: 84532 }); // ChainClient's RPC: right chain, contract code
    nodes.set('https://signer.test', { chainId: 1 }); // the key's RPC: mainnet
    const signer = await fromPrivateKey(generatePrivateKey(), 'https://signer.test');
    const client = new ChainClient({ chain: 'base-sepolia', rpcUrl: 'https://read.test', signer });

    const error = await client.recordAccess(`0x${'ab'.repeat(32)}`).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ChainConfigurationError);
    expect((error as Error).message).toContain('The signer is on chain 1');
    expect(calls.some((c) => c.method === 'eth_sendRawTransaction')).toBe(false);
  });
});
