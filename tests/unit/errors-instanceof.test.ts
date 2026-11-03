import { describe, it, expect, vi, beforeAll } from 'vitest';
import {
  ProvenanceError,
  GatewayConnectionError,
  StampError,
  NotaryError,
  VerificationError,
  PaymentError,
  PaymentConfigurationError,
  PaymentRefusedError,
  PaymentOutcomeError,
  PaymentRateLimitError,
} from '../../src/errors.js';
import {
  ChainError,
  ChainConfigurationError,
  ChainConnectionError,
  ChainTransactionError,
  ChainValidationError,
  DataAlreadyRegisteredError,
  DataNotRegisteredError,
  ReceiptTimeoutError,
  SignerRequiredError,
} from '../../src/chain/errors.js';

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

describe('instanceof ProvenanceError never throws (#205)', () => {
  const boom = () => {
    throw new Error('boom');
  };
  const brand = Symbol.for('@datafund/swarm-provenance/ProvenanceError');

  it.each([
    ['a throwing symbol getter', Object.defineProperty({}, brand, { get: boom })],
    ['a Proxy whose get and getOwnPropertyDescriptor traps throw', new Proxy({}, { get: boom, getOwnPropertyDescriptor: boom })],
    ['a Proxy whose getPrototypeOf trap throws', new Proxy({}, { getPrototypeOf: boom })],
    ['a revoked Proxy', (() => { const p = Proxy.revocable({}, {}); p.revoke(); return p.proxy; })()],
    ['null', null],
    ['undefined', undefined],
    ['a number', 1],
    ['a string', 'ProvenanceError'],
    ['a symbol', brand],
    ['an object with no prototype', Object.create(null)],
  ])('returns false for %s', (_label, value) => {
    expect(() => value instanceof ProvenanceError).not.toThrow();
    expect(value instanceof ProvenanceError).toBe(false);
    expect(value instanceof other.ProvenanceError).toBe(false);
  });

  it('does not call a brand getter', () => {
    const get = vi.fn(() => true);
    expect(Object.defineProperty({}, brand, { get }) instanceof ProvenanceError).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });
});

describe('subclasses keep their own prototype (#205)', () => {
  class MyErr extends ProvenanceError {
    constructor(message: string) {
      super(message, 'MY_ERR');
      this.name = 'MyErr';
    }
    describe(): string {
      return `${this.name}: ${this.message}`;
    }
  }
  class MyStampError extends StampError {}

  it('a consumer subclass is instanceof itself and ProvenanceError, with its methods', () => {
    const error = new MyErr('x');
    expect(error instanceof MyErr).toBe(true);
    expect(error instanceof ProvenanceError).toBe(true);
    expect(error instanceof other.ProvenanceError).toBe(true);
    expect(error instanceof Error).toBe(true);
    expect(error.describe()).toBe('MyErr: x');
    expect(error.name).toBe('MyErr');
    expect(error.code).toBe('MY_ERR');
    const stamp = new MyStampError('y');
    expect(stamp instanceof MyStampError).toBe(true);
    expect(stamp instanceof StampError).toBe(true);
    expect(stamp.name).toBe('StampError');
  });

  it('does not match an unrelated branded error', () => {
    expect(new other.ProvenanceError('x') instanceof MyErr).toBe(false);
    expect(new ProvenanceError('x') instanceof MyErr).toBe(false);
    expect(new StampError('x') instanceof MyErr).toBe(false);
    expect(new MyErr('x') instanceof StampError).toBe(false);
  });

  it.each([
    [new ProvenanceError('x'), [ProvenanceError], 'ProvenanceError'],
    [new GatewayConnectionError('x'), [GatewayConnectionError, ProvenanceError], 'GatewayConnectionError'],
    [new StampError('x'), [StampError, ProvenanceError], 'StampError'],
    [new NotaryError('x'), [NotaryError, ProvenanceError], 'NotaryError'],
    [new VerificationError('x'), [VerificationError, ProvenanceError], 'VerificationError'],
    [new PaymentError('x'), [PaymentError, ProvenanceError], 'PaymentError'],
    [new PaymentConfigurationError('x'), [PaymentConfigurationError, PaymentError, ProvenanceError], 'PaymentConfigurationError'],
    [new PaymentRefusedError('x'), [PaymentRefusedError, PaymentError, ProvenanceError], 'PaymentRefusedError'],
    [new PaymentOutcomeError('x', 'C', 'unknown'), [PaymentOutcomeError, PaymentError, ProvenanceError], 'PaymentOutcomeError'],
    [new PaymentRateLimitError('x'), [PaymentRateLimitError, PaymentError, ProvenanceError], 'PaymentRateLimitError'],
    [new ChainError('x'), [ChainError, ProvenanceError], 'ChainError'],
    [new ChainConfigurationError('x'), [ChainConfigurationError, ChainError, ProvenanceError], 'ChainConfigurationError'],
    [new ChainConnectionError('x'), [ChainConnectionError, ChainError, ProvenanceError], 'ChainConnectionError'],
    [new ChainTransactionError('x'), [ChainTransactionError, ChainError, ProvenanceError], 'ChainTransactionError'],
    [new ReceiptTimeoutError('x', '0x1'), [ReceiptTimeoutError, ChainConnectionError, ChainError, ProvenanceError], 'ReceiptTimeoutError'],
    [new ChainValidationError('x'), [ChainValidationError, ChainError, ProvenanceError], 'ChainValidationError'],
    [new DataNotRegisteredError('0x1'), [DataNotRegisteredError, ChainError, ProvenanceError], 'DataNotRegisteredError'],
    [new DataAlreadyRegisteredError('0x1', '', 0, ''), [DataAlreadyRegisteredError, ChainError, ProvenanceError], 'DataAlreadyRegisteredError'],
    [new SignerRequiredError(), [SignerRequiredError, ChainError, ProvenanceError], 'SignerRequiredError'],
  ] as const)('SDK error %#: instanceof itself and its parents, name unchanged', (error, classes, name) => {
    for (const cls of classes) expect(error instanceof cls).toBe(true);
    expect(error instanceof Error).toBe(true);
    expect(Object.getPrototypeOf(error)).toBe(classes[0].prototype);
    expect(error.name).toBe(name);
  });
});
