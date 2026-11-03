import { describe, it, expect, vi } from 'vitest';
import { inspect } from 'node:util';
import { fromViemWalletClient, fromEip1193Provider } from '../../../src/chain/signer.js';
import { ChainConfigurationError } from '../../../src/chain/errors.js';
import type { Address, Hex } from '../../../src/chain/types.js';

const MOCK_ADDRESS: Address = '0x1234567890abcdef1234567890abcdef12345678';
const MOCK_TX_HASH: Hex = `0x${'aa'.repeat(32)}`;

describe('fromViemWalletClient', () => {
  it('should create signer from wallet client with account', async () => {
    const mockWalletClient = {
      account: { address: MOCK_ADDRESS },
      getChainId: () => Promise.resolve(84532),
      sendTransaction: () => Promise.resolve(MOCK_TX_HASH),
    };

    const signer = fromViemWalletClient(mockWalletClient);
    const address = await signer.getAddress();
    expect(address).toBe(MOCK_ADDRESS);
  });

  it('should throw when wallet client has no account', () => {
    const mockWalletClient = {
      account: null,
      getChainId: () => Promise.resolve(84532),
      sendTransaction: () => Promise.resolve(MOCK_TX_HASH),
    };

    expect(() => fromViemWalletClient(mockWalletClient)).toThrow(ChainConfigurationError);
  });

  it('should delegate sendTransaction to wallet client', async () => {
    const mockWalletClient = {
      account: { address: MOCK_ADDRESS },
      getChainId: () => Promise.resolve(84532),
      sendTransaction: (args: { to: Address; data: Hex }) => {
        expect(args.to).toBe('0xD4a724CD7f5C4458cD2d884C2af6f011aC3Af80a');
        expect(args.data).toMatch(/^0x/);
        return Promise.resolve(MOCK_TX_HASH);
      },
    };

    const signer = fromViemWalletClient(mockWalletClient);
    const result = await signer.sendTransaction({
      to: '0xD4a724CD7f5C4458cD2d884C2af6f011aC3Af80a',
      data: '0xabcdef',
    });
    expect(result).toBe(MOCK_TX_HASH);
  });

  it('should forward gas param to wallet client when provided', async () => {
    const sendTransaction = vi.fn().mockResolvedValue(MOCK_TX_HASH);
    const mockWalletClient = {
      account: { address: MOCK_ADDRESS },
      getChainId: () => Promise.resolve(84532),
      sendTransaction,
    };

    const signer = fromViemWalletClient(mockWalletClient);
    await signer.sendTransaction({
      to: '0xD4a724CD7f5C4458cD2d884C2af6f011aC3Af80a',
      data: '0xabcdef',
      gas: BigInt(500_000),
    });

    expect(sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ gas: BigInt(500_000) }),
    );
  });

  it('should not include gas when not provided', async () => {
    const sendTransaction = vi.fn().mockResolvedValue(MOCK_TX_HASH);
    const mockWalletClient = {
      account: { address: MOCK_ADDRESS },
      getChainId: () => Promise.resolve(84532),
      sendTransaction,
    };

    const signer = fromViemWalletClient(mockWalletClient);
    await signer.sendTransaction({
      to: '0xD4a724CD7f5C4458cD2d884C2af6f011aC3Af80a',
      data: '0xabcdef',
    });

    expect(sendTransaction).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(sendTransaction.mock.calls[0][0]).not.toHaveProperty('gas');
  });
});

describe('fromEip1193Provider() account access errors (#202)', () => {
  const ADDRESS: Address = '0x1234567890abcdef1234567890abcdef12345678';
  const provider = (accounts: () => Promise<unknown>) => ({
    request: (args: { method: string }) => (args.method === 'eth_requestAccounts' ? accounts() : Promise.resolve(null)),
  });

  it('wraps a refused eth_requestAccounts (EIP-1193 code 4001) in ChainConfigurationError without a cause', async () => {
    // Wallets reject with a plain object, not an Error
    const refusal = { code: 4001, message: 'User rejected the request.' };
    const error = await fromEip1193Provider(provider(() => Promise.reject(refusal))).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainConfigurationError);
    expect((error as ChainConfigurationError).code).toBe('CHAIN_CONFIGURATION');
    expect((error as Error).message).toBe('The wallet did not give access to an account: User rejected the request.');
    // A raw wallet error is not kept as cause: it can carry an RPC URL (#118)
    expect((error as Error).cause).toBeUndefined();
  });

  it('redacts a URL in the provider error message', async () => {
    const error = await fromEip1193Provider(provider(() => Promise.reject(new Error('failed at https://rpc.example/key123'))))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainConfigurationError);
    expect((error as Error).message).not.toContain('key123');
  });

  it('does not print a key from the URL in the wallet error when the error is inspected', async () => {
    const walletError = new Error('request to https://u:SECRETKEY@rpc.x/ failed');
    const error = await fromEip1193Provider(provider(() => Promise.reject(walletError))).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainConfigurationError);
    expect(inspect(error)).not.toContain('SECRETKEY');
  });

  it.each([
    ['null', null],
    ['an object', {}],
    ['an empty list', []],
    ['a list without a string', [42]],
  ])('refuses an eth_requestAccounts answer that is %s with ChainConfigurationError', async (_label, answer) => {
    const error = await fromEip1193Provider(provider(() => Promise.resolve(answer))).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainConfigurationError);
    expect((error as Error).message).toBe('No accounts available from provider');
  });

  it.each([
    ['a word', ['foo']],
    ['a short hex string', ['0x1234']],
  ])('refuses a first account that is %s with ChainConfigurationError', async (_label, answer) => {
    const error = await fromEip1193Provider(provider(() => Promise.resolve(answer))).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainConfigurationError);
    expect((error as Error).message).toBe('The wallet returned an account that is not an address');
  });

  it('still returns the first account', async () => {
    const signer = await fromEip1193Provider(provider(() => Promise.resolve([ADDRESS])));
    expect(await signer.getAddress()).toBe(ADDRESS);
  });
});
