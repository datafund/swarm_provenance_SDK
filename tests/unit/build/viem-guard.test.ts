import { describe, it, expect } from 'vitest';
import { VIEM_REQUIRE_GUARDED } from '../../../tsup.config.js';

// Evaluates the exact guard line the build writes into dist/chain/index.cjs,
// with a stand-in `require`.
function runGuard(fakeRequire: (id: string) => unknown): unknown {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('require', `${VIEM_REQUIRE_GUARDED}\nreturn viem;`)(fakeRequire);
}

const notFound = (message: string) => () => {
  throw Object.assign(new Error(message), { code: 'MODULE_NOT_FOUND' });
};

describe('CJS viem guard', () => {
  it('returns viem when it resolves', () => {
    const viem = { createPublicClient: () => undefined };
    expect(runGuard(() => viem)).toBe(viem);
  });

  it('rewrites a missing viem into ChainConfigurationError / CHAIN_CONFIGURATION, keeping the cause', () => {
    const original = Object.assign(new Error("Cannot find module 'viem'\nRequire stack:\n- /app/x.cjs"), {
      code: 'MODULE_NOT_FOUND',
    });
    let thrown: unknown;
    try {
      runGuard(() => {
        throw original;
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({ name: 'ChainConfigurationError', code: 'CHAIN_CONFIGURATION' });
    expect((thrown as Error).message).toContain('npm install viem');
    expect((thrown as Error).cause).toBe(original);
  });

  it.each([
    ['a missing dependency of viem (CJS stack names viem)', "Cannot find module '@noble/curves'\nRequire stack:\n- /app/node_modules/viem/_cjs/index.js"],
    ['a broken viem install (missing file inside it)', "Cannot find module '/app/node_modules/viem/_cjs/index.js'"],
    ['a different package containing "viem"', "Cannot find module '@acme/viem-adapter'"],
    ['a different package containing "viem" (hyphen)', "Cannot find module 'viem-utils'"],
  ])('rethrows %s unchanged', (_label, message) => {
    expect(() => runGuard(notFound(message))).toThrow(message.split('\n')[0]);
    expect(() => runGuard(notFound(message))).not.toThrow(/npm install viem/);
  });

  it('rethrows non-MODULE_NOT_FOUND errors unchanged', () => {
    const err = new SyntaxError('Unexpected token');
    expect(() =>
      runGuard(() => {
        throw err;
      }),
    ).toThrow(err);
  });
});
