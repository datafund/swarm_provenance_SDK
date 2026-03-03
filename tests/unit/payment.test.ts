import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('createX402Fetch', () => {
  const mockWallet = {
    address: '0x1234567890abcdef1234567890abcdef12345678' as `0x${string}`,
    signTypedData: vi.fn().mockResolvedValue('0xsig' as `0x${string}`),
    readContract: vi.fn().mockResolvedValue(0n),
  };

  beforeEach(() => {
    vi.resetModules();
  });

  it('should throw PaymentConfigurationError when @x402/fetch is missing', async () => {
    vi.doMock('@x402/fetch', () => {
      throw new Error('Cannot find module');
    });

    const { createX402Fetch } = await import('../../src/payment.js');

    try {
      await createX402Fetch({ wallet: mockWallet });
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as Error).name).toBe('PaymentConfigurationError');
      expect((error as Error).message).toContain('@x402/fetch is required');
    }
  });

  it('should throw PaymentConfigurationError when @x402/evm is missing', async () => {
    vi.doMock('@x402/fetch', () => ({
      x402Client: class {
        register() { return this; }
      },
      wrapFetchWithPayment: vi.fn(),
    }));
    vi.doMock('@x402/evm', () => {
      throw new Error('Cannot find module');
    });

    const { createX402Fetch } = await import('../../src/payment.js');

    try {
      await createX402Fetch({ wallet: mockWallet });
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as Error).name).toBe('PaymentConfigurationError');
      expect((error as Error).message).toContain('@x402/evm is required');
    }
  });

  it('should create wrapped fetch when both packages are available', async () => {
    const mockWrappedFetch = vi.fn();
    const mockRegister = vi.fn().mockReturnThis();

    vi.doMock('@x402/fetch', () => ({
      x402Client: class {
        register = mockRegister;
      },
      wrapFetchWithPayment: vi.fn().mockReturnValue(mockWrappedFetch),
    }));
    vi.doMock('@x402/evm', () => ({
      ExactEvmScheme: class {
        constructor(public signer: unknown) {}
      },
    }));

    const { createX402Fetch } = await import('../../src/payment.js');
    const result = await createX402Fetch({ wallet: mockWallet });

    expect(result).toBe(mockWrappedFetch);
    expect(mockRegister).toHaveBeenCalledWith('eip155:84532', expect.any(Object));
  });

  it('should use custom network when provided', async () => {
    const mockRegister = vi.fn().mockReturnThis();

    vi.doMock('@x402/fetch', () => ({
      x402Client: class {
        register = mockRegister;
      },
      wrapFetchWithPayment: vi.fn().mockReturnValue(vi.fn()),
    }));
    vi.doMock('@x402/evm', () => ({
      ExactEvmScheme: class {
        constructor(public signer: unknown) {}
      },
    }));

    const { createX402Fetch } = await import('../../src/payment.js');
    await createX402Fetch({ wallet: mockWallet, network: 'eip155:8453' });

    expect(mockRegister).toHaveBeenCalledWith('eip155:8453', expect.any(Object));
  });

  it('should pass wallet to ExactEvmScheme constructor', async () => {
    let capturedSigner: unknown;

    vi.doMock('@x402/fetch', () => ({
      x402Client: class {
        register() { return this; }
      },
      wrapFetchWithPayment: vi.fn().mockReturnValue(vi.fn()),
    }));
    vi.doMock('@x402/evm', () => ({
      ExactEvmScheme: class {
        constructor(signer: unknown) {
          capturedSigner = signer;
        }
      },
    }));

    const { createX402Fetch } = await import('../../src/payment.js');
    await createX402Fetch({ wallet: mockWallet });

    expect(capturedSigner).toBe(mockWallet);
  });
});
