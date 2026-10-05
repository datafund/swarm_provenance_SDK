import { readFile, writeFile } from 'node:fs/promises';
import { defineConfig } from 'tsup';

const CJS_CHAIN = 'dist/chain/index.cjs';
const VIEM_REQUIRE = "var viem = require('viem');";

/**
 * #99: in the CJS chain entry, wrap the real `require('viem')` so a missing viem
 * throws an actionable message instead of Node's bare "Cannot find module".
 * It stays a literal require('viem'), so bundlers that inline viem follow it;
 * only MODULE_NOT_FOUND for viem itself is rewritten, anything else is rethrown.
 * Same line, so line numbers and the source map are unchanged.
 *
 * Done after the build because treeshake makes tsup emit CJS via rollup, out of
 * reach of esbuild plugins. ESM cannot be guarded at all: imports are linked
 * before any code runs (see README "Troubleshooting").
 */
const VIEM_REQUIRE_GUARDED =
  "var viem = (() => { try { return require('viem'); } catch (e) { " +
  "if (e && e.code === 'MODULE_NOT_FOUND' && /'viem'/.test(e.message)) { throw new Error(" +
  JSON.stringify(
    "@datafund/swarm-provenance/chain requires the optional peer dependency 'viem'. Install it: npm install viem (or pnpm add viem)",
  ) +
  ', { cause: e }); } throw e; } })();';

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
