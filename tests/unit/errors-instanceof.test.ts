import { describe, it, expect, vi, beforeAll } from 'vitest';
import { ProvenanceError, StampError, PaymentError, PaymentRefusedError } from '../../src/errors.js';
import { ChainError, ChainConfigurationError, ChainConnectionError, ReceiptTimeoutError } from '../../src/chain/errors.js';

// #205: the main entry and each chain entry are separate bundles, each with its
// own copy of ProvenanceError. A fresh module graph gives a second copy of the
// classes here, the same situation as two bundles.
type ErrorsModule = typeof import('../../src/errors.js');
type ChainErrorsModule = typeof import('../../src/chain/errors.js');
let other: ErrorsModule;
let otherChain: ChainErrorsModule;

beforeAll(async () => {
  vi.resetModules();
  other = await import('../../src/errors.js');
  otherChain = await import('../../src/chain/errors.js');
});

describe('instanceof ProvenanceError across copies of the class (#205)', () => {
  it('uses a separate copy of the classes', () => {
    expect(other.ProvenanceError).not.toBe(ProvenanceError);
    expect(otherChain.ChainError).not.toBe(ChainError);
    expect(Object.getPrototypeOf(new otherChain.ChainError('x'))).not.toBe(ChainError.prototype);
  });

  it('matches a chain error from the other copy', () => {
    const error = new otherChain.ChainConfigurationError('Unknown chain');
    expect(error instanceof ProvenanceError).toBe(true);
    expect(error instanceof other.ProvenanceError).toBe(true);
  });

  it('matches in both directions', () => {
    expect(new ProvenanceError('a') instanceof other.ProvenanceError).toBe(true);
    expect(new other.ProvenanceError('b') instanceof ProvenanceError).toBe(true);
    expect(new StampError('c') instanceof other.ProvenanceError).toBe(true);
    expect(new other.PaymentRefusedError('d') instanceof ProvenanceError).toBe(true);
  });

  it('keeps subclasses strict: they match by prototype only', () => {
    const chainError = new otherChain.ChainConfigurationError('x');
    expect(chainError instanceof StampError).toBe(false);
    expect(chainError instanceof ChainError).toBe(false);
    expect(chainError instanceof ChainConfigurationError).toBe(false);
    expect(new StampError('x') instanceof otherChain.ChainError).toBe(false);
    expect(new other.StampError('x') instanceof StampError).toBe(false);
    expect(new other.PaymentRefusedError('x') instanceof PaymentError).toBe(false);
  });

  it('does not cross-match subclasses within one copy', () => {
    expect(new ChainConfigurationError('x') instanceof ChainConnectionError).toBe(false);
    expect(new ChainConnectionError('x') instanceof ChainConfigurationError).toBe(false);
    expect(new ChainError('x') instanceof StampError).toBe(false);
    expect(new StampError('x') instanceof ChainError).toBe(false);
    expect(new ReceiptTimeoutError('x', '0x1') instanceof ChainConnectionError).toBe(true);
    expect(new ReceiptTimeoutError('x', '0x1') instanceof ChainError).toBe(true);
    expect(new PaymentRefusedError('x') instanceof PaymentError).toBe(true);
  });

  it('does not match values without the brand', () => {
    expect(new Error('x') instanceof ProvenanceError).toBe(false);
    expect({ name: 'ProvenanceError', code: 'X' } instanceof ProvenanceError).toBe(false);
    expect((null as unknown) instanceof ProvenanceError).toBe(false);
    expect(('ProvenanceError' as unknown) instanceof ProvenanceError).toBe(false);
  });

  it('keeps the brand out of keys, JSON and default inspection', async () => {
    const error = new ChainConfigurationError('x');
    expect(Object.keys(error)).not.toContain(Symbol.for('@datafund/swarm-provenance/ProvenanceError'));
    expect(Object.getOwnPropertySymbols(error).every((s) => !Object.getOwnPropertyDescriptor(error, s)?.enumerable)).toBe(true);
    expect(JSON.stringify(error)).toBe(JSON.stringify({ code: 'CHAIN_CONFIGURATION', name: 'ChainConfigurationError' }));
    const { inspect } = await import('node:util');
    expect(inspect(error)).not.toContain('swarm-provenance/ProvenanceError');
  });

  it('keeps TypeScript narrowing for subclasses', () => {
    const error: unknown = new other.StampError('x', 'STAMP');
    if (error instanceof ProvenanceError) {
      // Narrowed to ProvenanceError: `code` is typed
      const code: string | undefined = error.code;
      expect(code).toBe('STAMP');
    } else {
      expect.unreachable();
    }
    const timeout: unknown = new ReceiptTimeoutError('x', '0xabc');
    if (timeout instanceof ReceiptTimeoutError) {
      // Narrowed to the subclass, not only to ProvenanceError: `txHash` is typed
      const txHash: string = timeout.txHash;
      expect(txHash).toBe('0xabc');
    } else {
      expect.unreachable();
    }
  });
});
