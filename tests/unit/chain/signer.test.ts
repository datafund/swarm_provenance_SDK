import { describe, it, expect, vi } from 'vitest';
import { fromViemWalletClient } from '../../../src/chain/signer.js';
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
        expect(args.to).toBe('0x9a3c6F47B69211F05891CCb7aD33596290b9fE64');
        expect(args.data).toMatch(/^0x/);
        return Promise.resolve(MOCK_TX_HASH);
      },
    };

    const signer = fromViemWalletClient(mockWalletClient);
    const result = await signer.sendTransaction({
      to: '0x9a3c6F47B69211F05891CCb7aD33596290b9fE64',
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
      to: '0x9a3c6F47B69211F05891CCb7aD33596290b9fE64',
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
      to: '0x9a3c6F47B69211F05891CCb7aD33596290b9fE64',
      data: '0xabcdef',
    });

    expect(sendTransaction).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(sendTransaction.mock.calls[0][0]).not.toHaveProperty('gas');
  });
});
