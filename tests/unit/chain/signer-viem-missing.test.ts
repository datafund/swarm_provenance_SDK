import { describe, it, expect, vi, afterEach } from 'vitest';

/** fromPrivateKey when viem cannot be loaded: a broken install, mocked here */
describe('fromPrivateKey without a loadable viem', () => {
  afterEach(() => {
    vi.doUnmock('viem/utils');
    vi.resetModules();
  });

  it('throws ChainConfigurationError with the import error as a non-enumerable cause', async () => {
    vi.resetModules();
    const importError = new Error('Cannot find module viem/utils');
    vi.doMock('viem/utils', () => {
      throw importError;
    });
    const { fromPrivateKey } = await import('../../../src/chain/signer.js');
    const { ChainConfigurationError } = await import('../../../src/chain/errors.js');
    const error = await fromPrivateKey(`0x${'1'.repeat(64)}`, 'http://rpc.test').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainConfigurationError);
    expect((error as Error).message).toMatch(/^viem is required for private key signing/);
    expect(Object.getOwnPropertyDescriptor(error, 'cause')?.enumerable).toBe(false);
    // vitest wraps the factory's error, so only the type of the cause is checked
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(Object.keys(error as object)).not.toContain('cause');
  });
});
