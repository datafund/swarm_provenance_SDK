import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type AbiEvent, type Hex } from 'viem';
import { ChainClient } from '../../../src/chain/client.js';
import { fromEip1193Provider } from '../../../src/chain/signer.js';
import {
  ChainConfigurationError,
  ChainConnectionError,
  ChainTransactionError,
  ReceiptTimeoutError,
  rpcErrorMessage,
} from '../../../src/chain/errors.js';
import { DATA_PROVENANCE_ABI } from '../../../src/chain/abi.js';
import { BASE_SEPOLIA } from '../../../src/chain/constants.js';
import type { Address, ChainSigner } from '../../../src/chain/types.js';

const mockReadContract = vi.fn();
const mockWaitForTransactionReceipt = vi.fn();
const mockGetChainId = vi.fn();
const mockGetBytecode = vi.fn();

vi.mock('viem', async () => {
  const actual = await vi.importActual('viem');
  return {
    ...actual,
    createPublicClient: () => ({
      readContract: mockReadContract,
      waitForTransactionReceipt: mockWaitForTransactionReceipt,
      getChainId: mockGetChainId,
      getBytecode: mockGetBytecode,
    }),
  };
});

const ADDRESS: Address = '0x1234567890abcdef1234567890abcdef12345678';
const TX: Hex = `0x${'bb'.repeat(32)}`;
const HASH = 'ab'.repeat(32);
const ZERO = `0x${'00'.repeat(32)}`;

/** A DataRegistered log as the contract emits it */
function registeredLog(address: string = BASE_SEPOLIA.contractAddress) {
  const event = DATA_PROVENANCE_ABI.find((i) => i.type === 'event' && i.name === 'DataRegistered') as AbiEvent;
  const topics = encodeEventTopics({
    abi: [event],
    eventName: 'DataRegistered',
    args: { dataHash: `0x${HASH}`, owner: ADDRESS },
  } as never) as Hex[];
  return { address, topics, data: encodeAbiParameters([{ type: 'string' }], ['dataset']) };
}

function signer(chainId = 84532, extra: Partial<ChainSigner> = {}): ChainSigner & { sent: number } {
  const s = {
    sent: 0,
    getAddress: () => Promise.resolve(ADDRESS),
    getChainId: () => Promise.resolve(chainId),
    sendTransaction: () => {
      s.sent++;
      return Promise.resolve(TX);
    },
    ...extra,
  };
  return s;
}

/** Hash not registered yet, so anchor() proceeds to the write */
function hashIsFree() {
  mockReadContract.mockResolvedValue({
    dataHash: ZERO,
    owner: '0x' + '00'.repeat(20),
    timestamp: 0n,
    dataType: '',
    storageRef: ZERO,
    transformationLinks: [],
    accessors: [],
    status: 0,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReadContract.mockReset();
  mockWaitForTransactionReceipt.mockReset();
  mockGetChainId.mockResolvedValue(84532);
  mockGetBytecode.mockResolvedValue('0x6080');
  hashIsFree();
});

describe('chain ID checks before writing (#115)', () => {
  it('refuses when the RPC is on another chain, before sending', async () => {
    mockGetChainId.mockResolvedValue(8453);
    const s = signer();
    const error = await new ChainClient({ chain: 'base-sepolia', signer: s }).anchor(HASH, 'dataset').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainConfigurationError);
    expect((error as Error).message).toMatch(/RPC is on chain 8453.*chain 84532/);
    expect(s.sent).toBe(0);
  });

  it('refuses when the signer is on another chain, before sending', async () => {
    const s = signer(1);
    const error = await new ChainClient({ chain: 'base-sepolia', signer: s }).anchor(HASH, 'dataset').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainConfigurationError);
    expect((error as Error).message).toMatch(/signer is on chain 1/);
    expect(s.sent).toBe(0);
  });

  it('asks a wallet that can switch to switch, then writes', async () => {
    let chain = 1;
    const switchChain = vi.fn((id: number) => {
      chain = id;
      return Promise.resolve();
    });
    const s = signer(0, { getChainId: () => Promise.resolve(chain), switchChain });
    mockWaitForTransactionReceipt.mockResolvedValue({ status: 'success', blockNumber: 1n, gasUsed: 1n, logs: [registeredLog()] });

    await new ChainClient({ chain: 'base-sepolia', signer: s }).anchor(HASH, 'dataset');
    expect(switchChain).toHaveBeenCalledWith(84532, expect.objectContaining({ name: 'base-sepolia' }));
    expect(s.sent).toBe(1);
  });

  it('refuses when the user declines the switch', async () => {
    const s = signer(1, { switchChain: () => Promise.reject(new Error('User rejected the request')) });
    const error = await new ChainClient({ chain: 'base-sepolia', signer: s }).anchor(HASH, 'dataset').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainConfigurationError);
    expect(s.sent).toBe(0);
  });

  it('fromEip1193Provider reports eth_chainId and switches with wallet_switchEthereumChain', async () => {
    const calls: Array<{ method: string; params?: unknown[] }> = [];
    const provider = {
      request: (args: { method: string; params?: unknown[] }) => {
        calls.push(args);
        if (args.method === 'eth_requestAccounts') return Promise.resolve([ADDRESS]);
        if (args.method === 'eth_chainId') return Promise.resolve('0x14a34');
        return Promise.resolve(null);
      },
    };
    const s = await fromEip1193Provider(provider);
    expect(await s.getChainId()).toBe(84532);
    await s.switchChain!(8453);
    expect(calls.at(-1)).toEqual({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x2105' }] });
  });
});

describe('writes report success only when something was recorded (#116)', () => {
  it('refuses to write to an address without contract code', async () => {
    mockGetBytecode.mockResolvedValue(undefined);
    const s = signer();
    const error = await new ChainClient({ chain: 'base-sepolia', signer: s }).anchor(HASH, 'dataset').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainConfigurationError);
    expect((error as Error).message).toMatch(/No contract code/);
    expect(s.sent).toBe(0);
  });

  it('a successful receipt without the expected event is an error carrying the tx hash', async () => {
    mockWaitForTransactionReceipt.mockResolvedValue({ status: 'success', blockNumber: 1n, gasUsed: 1n, logs: [] });
    const error = await new ChainClient({ chain: 'base-sepolia', signer: signer() }).anchor(HASH, 'dataset').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainTransactionError);
    expect((error as ChainTransactionError).txHash).toBe(TX);
    expect((error as Error).message).toMatch(/0 of 1 expected DataRegistered/);
  });

  it('the event must come from the contract itself', async () => {
    mockWaitForTransactionReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 1n,
      gasUsed: 1n,
      logs: [registeredLog('0x9999999999999999999999999999999999999999')],
    });
    await expect(new ChainClient({ chain: 'base-sepolia', signer: signer() }).anchor(HASH, 'dataset')).rejects.toThrow(
      ChainTransactionError,
    );
  });

  it('the expected event from the contract is success', async () => {
    mockWaitForTransactionReceipt.mockResolvedValue({ status: 'success', blockNumber: 7n, gasUsed: 1n, logs: [registeredLog()] });
    const result = await new ChainClient({ chain: 'base-sepolia', signer: signer() }).anchor(HASH, 'dataset');
    expect(result.txHash).toBe(TX);
    expect(result.blockNumber).toBe(7);
  });

  it('a failed "already registered?" pre-check is surfaced, not ignored', async () => {
    mockReadContract.mockReset();
    mockReadContract.mockRejectedValue(new Error('HTTP request failed'));
    const s = signer();
    await expect(new ChainClient({ chain: 'base-sepolia', signer: s }).anchor(HASH, 'dataset')).rejects.toThrow(
      ChainConnectionError,
    );
    expect(s.sent).toBe(0);
  });
});

describe('a receipt timeout keeps the transaction hash (#117)', () => {
  it('the error keeps the CHAIN_CONNECTION code and what to wait for', async () => {
    mockWaitForTransactionReceipt.mockRejectedValue(new Error('Timed out while waiting for transaction'));
    const error = (await new ChainClient({ chain: 'base-sepolia', signer: signer() })
      .batchAnchor([{ dataHash: HASH, dataType: 'a' }, { dataHash: 'cd'.repeat(32), dataType: 'b' }])
      .catch((e: unknown) => e)) as ReceiptTimeoutError;
    expect(error.code).toBe('CHAIN_CONNECTION');
    expect(error.expected).toEqual({ event: 'DataRegistered', count: 2 });
  });

  it('throws ReceiptTimeoutError with txHash and explorer URL', async () => {
    mockWaitForTransactionReceipt.mockRejectedValue(new Error('Timed out while waiting for transaction'));
    const error = await new ChainClient({ chain: 'base-sepolia', signer: signer() }).anchor(HASH, 'dataset').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReceiptTimeoutError);
    expect(error).toBeInstanceOf(ChainConnectionError); // existing catch blocks still match
    expect((error as ReceiptTimeoutError).txHash).toBe(TX);
    expect((error as ReceiptTimeoutError).explorerUrl).toBe(`${BASE_SEPOLIA.explorerUrl}/tx/${TX}`);
  });

  it('waitForTransaction resumes on a known hash', async () => {
    mockWaitForTransactionReceipt.mockResolvedValue({ status: 'success', blockNumber: 9n, gasUsed: 1n, logs: [registeredLog()] });
    const client = new ChainClient({ chain: 'base-sepolia', signer: signer() });
    const result = await client.waitForTransaction(TX, { event: 'DataRegistered' });
    expect(result).toMatchObject({ txHash: TX, blockNumber: 9 });
  });
});

describe('errors do not leak RPC URLs (#118)', () => {
  const KEYED_URL = 'https://base-sepolia.g.alchemy.com/v2/SECRET_API_KEY_123';
  const viemLike = Object.assign(
    new Error(`HTTP request failed.\n\nURL: ${KEYED_URL}\nRequest body: {"method":"eth_call"}\n\nVersion: viem@2`),
    { shortMessage: 'HTTP request failed.', details: `Status: 503 at ${KEYED_URL}` },
  );

  it('rpcErrorMessage drops viem URL/body sections and redacts any URL left', () => {
    const text = rpcErrorMessage(viemLike);
    expect(text).not.toContain('SECRET_API_KEY_123');
    expect(text).not.toContain('Request body');
    expect(text).toContain('HTTP request failed.');
    expect(rpcErrorMessage(new Error(`boom at ${KEYED_URL}?key=1`))).toBe('boom at <rpc url>');
  });

  it('read errors carry no URL', async () => {
    mockReadContract.mockReset();
    mockReadContract.mockRejectedValue(viemLike);
    const error = await new ChainClient({ chain: 'base-sepolia' }).getDataRecord(HASH).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainConnectionError);
    expect(JSON.stringify(error)).not.toContain('SECRET_API_KEY_123');
    expect((error as Error).message).not.toContain('SECRET_API_KEY_123');
  });

  it('transaction errors keep originalError but do not serialise it', async () => {
    const s = signer(84532, { sendTransaction: () => Promise.reject(viemLike) });
    const error = await new ChainClient({ chain: 'base-sepolia', signer: s }).anchor(HASH, 'dataset').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainTransactionError);
    expect((error as ChainTransactionError).originalError).toBe(viemLike);
    expect(Object.keys(error as object)).not.toContain('originalError');
    expect(JSON.stringify(error)).not.toContain('SECRET_API_KEY_123');
    expect((error as Error).message).not.toContain('SECRET_API_KEY_123');
  });
});

describe('review round 1 (#139)', () => {
  it('a wrong RPC chain is reported as such even when the read pre-check would fail first', async () => {
    mockGetChainId.mockResolvedValue(1);
    mockReadContract.mockReset();
    mockReadContract.mockRejectedValue(new Error('returned no data ("0x")'));
    const error = await new ChainClient({ chain: 'base-sepolia', signer: signer() }).anchor(HASH, 'dataset').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainConfigurationError);
    expect(mockReadContract).not.toHaveBeenCalled();
  });

  it('a sped-up transaction reports the hash that landed', async () => {
    const NEW: Hex = `0x${'cc'.repeat(32)}`;
    mockWaitForTransactionReceipt.mockImplementation((args: { onReplaced?: (r: unknown) => void }) => {
      args.onReplaced?.({ reason: 'repriced', transaction: { hash: NEW } });
      return Promise.resolve({ status: 'success', blockNumber: 2n, gasUsed: 1n, transactionHash: NEW, logs: [registeredLog()] });
    });
    const result = await new ChainClient({ chain: 'base-sepolia', signer: signer() }).anchor(HASH, 'dataset');
    expect(result.txHash).toBe(NEW);
    expect(result.explorerUrl).toContain(NEW);
  });

  it('a transaction cancelled in the wallet is an error, not "no event"', async () => {
    const NEW: Hex = `0x${'cc'.repeat(32)}`;
    mockWaitForTransactionReceipt.mockImplementation((args: { onReplaced?: (r: unknown) => void }) => {
      args.onReplaced?.({ reason: 'cancelled', transaction: { hash: NEW } });
      return Promise.resolve({ status: 'success', blockNumber: 2n, gasUsed: 1n, transactionHash: NEW, logs: [] });
    });
    await expect(new ChainClient({ chain: 'base-sepolia', signer: signer() }).anchor(HASH, 'dataset')).rejects.toThrow(
      /cancelled in the wallet/,
    );
  });

  it('getProvenanceChain errors do not serialise their cause (it may carry the RPC URL)', async () => {
    mockReadContract.mockReset();
    mockReadContract.mockRejectedValue(new Error('HTTP request failed. URL: https://rpc.example/v2/SECRET_KEY_9'));
    const error = await new ChainClient({ chain: 'base-sepolia' }).getProvenanceChain(HASH).catch((e: unknown) => e);
    expect(JSON.stringify(error)).not.toContain('SECRET_KEY_9');
    expect((error as Error).message).not.toContain('SECRET_KEY_9');
  });

  it('fromEip1193Provider adds an unknown chain (4902) and sends with chainId', async () => {
    const calls: Array<{ method: string; params?: unknown[] }> = [];
    let switched = 0;
    const provider = {
      request: (args: { method: string; params?: unknown[] }) => {
        calls.push(args);
        if (args.method === 'eth_requestAccounts') return Promise.resolve([ADDRESS]);
        if (args.method === 'wallet_switchEthereumChain' && switched++ === 0) {
          return Promise.reject(Object.assign(new Error('Unrecognized chain ID'), { code: 4902 }));
        }
        if (args.method === 'eth_sendTransaction') return Promise.resolve(TX);
        return Promise.resolve(null);
      },
    };
    const s = await fromEip1193Provider(provider);
    await s.switchChain!(84532, { name: 'base-sepolia', rpcUrls: ['https://rpc'], explorerUrl: 'https://scan' });
    await s.sendTransaction({ to: ADDRESS, data: '0x', chainId: 84532 });

    expect(calls.map((c) => c.method)).toEqual([
      'eth_requestAccounts',
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'wallet_switchEthereumChain',
      'eth_sendTransaction',
    ]);
    expect((calls.at(-1)!.params![0] as { chainId: string }).chainId).toBe('0x14a34');
  });
});
