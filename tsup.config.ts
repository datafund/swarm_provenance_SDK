import { readFile, writeFile } from 'node:fs/promises';
import { defineConfig } from 'tsup';

const CJS_CHAIN = 'dist/chain/index.cjs';
const VIEM_REQUIRE = "var viem = require('viem');";

/**
 * #99: in the CJS chain entry, wrap the real `require('viem')` so a missing viem
 * throws an actionable message instead of Node's bare "Cannot find module".
 * It stays a literal require('viem'), so bundlers that inline viem follow it.
 * Same line, so line numbers and the source map are unchanged.
 *
 * Only MODULE_NOT_FOUND whose first message line quotes exactly 'viem' (or a
 * 'viem/...' subpath) is rewritten. A missing dependency of viem, or a broken
 * viem install (a missing file inside it), names a different specifier and is
 * rethrown unchanged. The rewritten error carries the documented
 * name/code (ChainConfigurationError / CHAIN_CONFIGURATION) and the original as
 * `cause`. Unit-tested in tests/unit/build/viem-guard.test.ts.
 *
 * Done after the build because treeshake makes tsup emit CJS via rollup, out of
 * reach of esbuild plugins. The path follows tsup's own outDir, which is also
 * resolved against the working directory. ESM cannot be guarded at all: imports
 * are linked before any code runs (see README "Troubleshooting").
 */
export const VIEM_REQUIRE_GUARDED =
  "var viem = (() => { try { return require('viem'); } catch (e) { " +
  "if (e && e.code === 'MODULE_NOT_FOUND' && /'viem(\\/[^']*)?'/.test(String(e.message).split('\\n')[0])) { " +
  'throw Object.assign(new Error(' +
  JSON.stringify(
    "@datafund/swarm-provenance/chain requires the optional peer dependency 'viem'. Install it: npm install viem (or pnpm add viem)",
  ) +
  ", { cause: e }), { name: 'ChainConfigurationError', code: 'CHAIN_CONFIGURATION' }); } throw e; } })();";

export default defineConfig({
  entry: ['src/index.ts', 'src/chain/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  minify: false,
  target: 'es2022',
  outDir: 'dist',
  external: ['viem', '@x402/fetch', '@x402/evm', '@x402/evm/exact/client'],
  async onSuccess() {
    const code = await readFile(CJS_CHAIN, 'utf8');
    const count = code.split(VIEM_REQUIRE).length - 1;
    if (count !== 1) {
      throw new Error(`${CJS_CHAIN}: expected exactly one "${VIEM_REQUIRE}", found ${count}; update the viem guard`);
    }
    // Function replacer: no `$&`-style pattern expansion in the inserted text
    await writeFile(CJS_CHAIN, code.replace(VIEM_REQUIRE, () => VIEM_REQUIRE_GUARDED));
  },
});
