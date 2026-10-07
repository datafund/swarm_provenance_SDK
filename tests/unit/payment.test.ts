import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEvmV1 = () => ({
  ExactEvmSchemeV1: class {
    constructor(public signer: unknown) {}
  },
});


// A 402 option the default policy accepts: Base Sepolia USDC, 0.01, 60 s
const VALID_V1_REQUIREMENT = {
  scheme: 'exact',
  network: 'base-sepolia',
  maxAmountRequired: '10000',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  payTo: '0x1111111111111111111111111111111111111111',
  maxTimeoutSeconds: 60,
  resource: 'http://test.com',
  description: '',
  mimeType: 'application/json',
  extra: {},
};

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
        registerV1() { return this; }
        onBeforePaymentCreation() { return this; }
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
    const mockRegisterV1 = vi.fn().mockReturnThis();

    vi.doMock('@x402/fetch', () => ({
      x402Client: class {
        register = mockRegister;
        registerV1 = mockRegisterV1;
        onBeforePaymentCreation() { return this; }
      },
      wrapFetchWithPayment: vi.fn().mockReturnValue(mockWrappedFetch),
    }));
    vi.doMock('@x402/evm', () => ({
      ExactEvmScheme: class {
        constructor(public signer: unknown) {}
      },
    }));
    vi.doMock('@x402/evm/v1', mockEvmV1);

    const { createX402Fetch } = await import('../../src/payment.js');
    const result = await createX402Fetch({ wallet: mockWallet });

    expect(result).toBeTypeOf('function');
    expect(mockRegister).toHaveBeenCalledWith('eip155:84532', expect.any(Object));
    expect(mockRegisterV1).toHaveBeenCalledWith('base-sepolia', expect.any(Object));
  });

  it('should use custom network when provided', async () => {
    const mockRegister = vi.fn().mockReturnThis();
    const mockRegisterV1 = vi.fn().mockReturnThis();

    vi.doMock('@x402/fetch', () => ({
      x402Client: class {
        register = mockRegister;
        registerV1 = mockRegisterV1;
        onBeforePaymentCreation() { return this; }
      },
      wrapFetchWithPayment: vi.fn().mockReturnValue(vi.fn()),
    }));
    vi.doMock('@x402/evm', () => ({
      ExactEvmScheme: class {
        constructor(public signer: unknown) {}
      },
    }));
    vi.doMock('@x402/evm/v1', mockEvmV1);

    const { createX402Fetch } = await import('../../src/payment.js');
    await createX402Fetch({ wallet: mockWallet, network: 'eip155:8453', maxAmount: '0.50' });

    expect(mockRegister).toHaveBeenCalledWith('eip155:8453', expect.any(Object));
  });

  it('should pass wallet to ExactEvmScheme constructor', async () => {
    let capturedSigner: unknown;

    vi.doMock('@x402/fetch', () => ({
      x402Client: class {
        register() { return this; }
        registerV1() { return this; }
        onBeforePaymentCreation() { return this; }
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
    vi.doMock('@x402/evm/v1', mockEvmV1);

    const { createX402Fetch } = await import('../../src/payment.js');
    await createX402Fetch({ wallet: mockWallet });

    expect(capturedSigner).toBe(mockWallet);
  });

  it.each([undefined, null])('should resolve address from wallet.account when wallet.address is %s', async (missing) => {
    const walletWithoutAddress = {
      address: missing as unknown as `0x${string}`,
      account: { address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}` },
      signTypedData: vi.fn().mockResolvedValue('0xsig' as `0x${string}`),
      readContract: vi.fn().mockResolvedValue(0n),
    };

    let capturedSigner: Record<string, unknown> | undefined;

    vi.doMock('@x402/fetch', () => ({
      x402Client: class {
        register() { return this; }
        registerV1() { return this; }
        onBeforePaymentCreation() { return this; }
      },
      wrapFetchWithPayment: vi.fn().mockReturnValue(vi.fn()),
    }));
    vi.doMock('@x402/evm', () => ({
      ExactEvmScheme: class {
        constructor(signer: Record<string, unknown>) {
          capturedSigner = signer;
        }
      },
    }));
    vi.doMock('@x402/evm/v1', mockEvmV1);

    const { createX402Fetch } = await import('../../src/payment.js');
    await createX402Fetch({ wallet: walletWithoutAddress as never });

    expect(capturedSigner?.address).toBe('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
  });

  it('should normalize 402 responses that wrap x402 payload in detail', async () => {
    let capturedFetch: typeof fetch | undefined;

    vi.doMock('@x402/fetch', () => ({
      x402Client: class {
        register() { return this; }
        registerV1() { return this; }
        onBeforePaymentCreation() { return this; }
      },
      wrapFetchWithPayment: vi.fn().mockImplementation((fetchFn: typeof fetch) => {
        capturedFetch = fetchFn;
        return fetchFn;
      }),
    }));
    vi.doMock('@x402/evm', () => ({
      ExactEvmScheme: class {
        constructor(public signer: unknown) {}
      },
    }));
    vi.doMock('@x402/evm/v1', mockEvmV1);

    const x402Body = { x402Version: 1, accepts: [VALID_V1_REQUIREMENT] };
    const wrappedBody = { detail: x402Body };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(wrappedBody), { status: 402, headers: { 'content-type': 'application/json' } })
    ));

    const { createX402Fetch } = await import('../../src/payment.js');
    await createX402Fetch({ wallet: mockWallet });

    expect(capturedFetch).toBeDefined();
    const response = await capturedFetch!('http://test.com', {});
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['x402Version']).toBe(1);
    expect(body['accepts']).toEqual([VALID_V1_REQUIREMENT]);
    expect(body['detail']).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it('should pass through 402 responses with top-level x402Version unchanged', async () => {
    let capturedFetch: typeof fetch | undefined;

    vi.doMock('@x402/fetch', () => ({
      x402Client: class {
        register() { return this; }
        registerV1() { return this; }
        onBeforePaymentCreation() { return this; }
      },
      wrapFetchWithPayment: vi.fn().mockImplementation((fetchFn: typeof fetch) => {
        capturedFetch = fetchFn;
        return fetchFn;
      }),
    }));
    vi.doMock('@x402/evm', () => ({
      ExactEvmScheme: class {
        constructor(public signer: unknown) {}
      },
    }));
    vi.doMock('@x402/evm/v1', mockEvmV1);

    const x402Body = { x402Version: 1, accepts: [VALID_V1_REQUIREMENT] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(x402Body), { status: 402, headers: { 'content-type': 'application/json' } })
    ));

    const { createX402Fetch } = await import('../../src/payment.js');
    await createX402Fetch({ wallet: mockWallet });

    const response = await capturedFetch!('http://test.com', {});
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['x402Version']).toBe(1);
    expect(body['accepts']).toEqual([VALID_V1_REQUIREMENT]);

    vi.unstubAllGlobals();
  });
});
