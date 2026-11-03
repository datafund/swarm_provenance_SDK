// #205: errors from every built entry are instanceof the main entry's
// ProvenanceError, in ESM and CJS, and subclasses do not cross-match.
// Run after `pnpm build` (ci.yml "Verify dist"): node scripts/verify-dist-instanceof.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const require = createRequire(import.meta.url);

const loaders = {
  esm: (file) => import(new URL(`../dist/${file}.js`, import.meta.url).href),
  cjs: async (file) => require(`${dist}${file}.cjs`),
};

for (const [format, load] of Object.entries(loaders)) {
  const main = await load('index');
  for (const entry of ['chain/index', 'chain/browser']) {
    const chain = await load(entry);
    const where = `${format} ${entry}`;
    // The case from the issue: a chain error thrown by ChainClient
    let thrown;
    try {
      new chain.ChainClient({ chain: 'nope' });
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof chain.ChainConfigurationError, `${where}: expected a ChainConfigurationError`);
    assert.ok(thrown instanceof main.ProvenanceError, `${where}: chain error is not instanceof the main ProvenanceError`);
    assert.ok(thrown instanceof chain.ChainError, `${where}: chain error is not instanceof ChainError`);
    // A main-entry error
    const stampError = new main.StampError('x');
    assert.ok(stampError instanceof main.ProvenanceError, `${where}: StampError is not instanceof ProvenanceError`);
    // Subclasses do not cross-match
    assert.ok(!(thrown instanceof main.StampError), `${where}: chain error matches StampError`);
    assert.ok(!(thrown instanceof main.PaymentError), `${where}: chain error matches PaymentError`);
    assert.ok(!(thrown instanceof chain.ChainConnectionError), `${where}: ChainConfigurationError matches ChainConnectionError`);
    assert.ok(!(stampError instanceof chain.ChainError), `${where}: StampError matches ChainError`);
    assert.ok(!(new Error('x') instanceof main.ProvenanceError), `${where}: a plain Error matches ProvenanceError`);
  }
}
console.log('instanceof ProvenanceError holds across the built entries (esm, cjs)');
