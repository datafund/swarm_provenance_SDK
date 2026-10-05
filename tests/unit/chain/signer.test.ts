import { describe, it, expect, vi } from 'vitest';
import { fromViemWalletClient, isMissingViem } from '../../../src/chain/signer.js';
import { ChainConfigurationError } from '../../../src/chain/errors.js';
import type { Address, Hex } from '../../../src/chain/types.js';

const MOCK_ADDRESS: Address = '0x1234567890abcdef1234567890abcdef12345678';
const MOCK_TX_HASH: Hex = `0x${'aa'.repeat(32)}`;

describe('fromViemWalletClient', () => {
  it('should create signer from wallet client with account', async () => {
    const mockWalletClient = {
      account: { address: MOCK_ADDRESS },
      sendTransaction: () => Promise.resolve(MOCK_TX_HASH),
    };

    const signer = fromViemWalletClient(mockWalletClient);
    const address = await signer.getAddress();
    expect(address).toBe(MOCK_ADDRESS);
  });

  it('should throw when wallet client has no account', () => {
    const mockWalletClient = {
      account: null,
      sendTransaction: () => Promise.resolve(MOCK_TX_HASH),
    };

    expect(() => fromViemWalletClient(mockWalletClient)).toThrow(ChainConfigurationError);
  });

  it('should delegate sendTransaction to wallet client', async () => {
    const mockWalletClient = {
      account: { address: MOCK_ADDRESS },
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

describe('isMissingViem', () => {
  const notFound = (code: string, message: string) => Object.assign(new Error(message), { code });

  it('matches Node CJS and ESM not-found errors for viem', () => {
    expect(isMissingViem(notFound('MODULE_NOT_FOUND', "Cannot find module 'viem'\nRequire stack:\n- /app/x.js"))).toBe(true);
    expect(
      isMissingViem(notFound('ERR_MODULE_NOT_FOUND', "Cannot find package 'viem' imported from /app/dist/chain/index.js")),
    ).toBe(true);
  });

  it('does not match a missing dependency of viem, whose require stack names viem', () => {
    const err = notFound(
      'MODULE_NOT_FOUND',
      "Cannot find module '@noble/curves/secp256k1'\nRequire stack:\n- /app/node_modules/viem/_cjs/index.js",
    );
    expect(isMissingViem(err)).toBe(false);
  });

  it('does not match other errors', () => {
    expect(isMissingViem(notFound('ERR_PACKAGE_PATH_NOT_EXPORTED', "Package subpath './accounts' is not defined by viem"))).toBe(false);
    expect(isMissingViem(new SyntaxError('Unexpected token'))).toBe(false);
    expect(isMissingViem(undefined)).toBe(false);
  });
});
