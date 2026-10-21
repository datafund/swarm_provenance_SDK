import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { defineConfig } from 'tsup';
import { VIEM_REQUIRE_GUARDED } from './scripts/viem-guard.js';

/** CJS chain builds that require('viem'): the Node entry and the browser entry (#123) */
const CJS_CHAIN_FILES = ['dist/chain/index.cjs', 'dist/chain/browser.cjs'];
const VIEM_REQUIRE = "var viem = require('viem');";

export default defineConfig([{
  // chain/browser: the /chain entry without fromPrivateKey, for the "browser"
  // export condition (#123). Its types are built by the second config below.
  entry: ['src/index.ts', 'src/chain/index.ts', 'src/chain/browser.ts'],
  format: ['esm', 'cjs'],
  dts: { entry: ['src/index.ts', 'src/chain/index.ts'] },
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  minify: false,
  target: 'es2022',
  outDir: 'dist',
  external: ['viem', '@x402/fetch', '@x402/evm', '@x402/evm/exact/client'],
  // Wrap require('viem') in the CJS chain entries (#99, see scripts/viem-guard.ts)
  async onSuccess() {
    for (const file of CJS_CHAIN_FILES) {
      // Partial builds (e.g. `tsup --format esm`) produce no CJS chain entry: nothing
      // to guard. CI's "Verify dist" step fails if a full build ever lacks the file.
      if (!existsSync(file)) continue;
      const code = await readFile(file, 'utf8');
      const count = code.split(VIEM_REQUIRE).length - 1;
      if (count !== 1) {
        throw new Error(`${file}: expected exactly one "${VIEM_REQUIRE}", found ${count}; update the viem guard`);
      }
      // Function replacer: no `$&`-style pattern expansion in the inserted text
      await writeFile(file, code.replace(VIEM_REQUIRE, () => VIEM_REQUIRE_GUARDED));
    }
  },
}, {
  // Types of the browser entry, built on their own: in one declaration build
  // with chain/index the shared declarations would land in browser.d.ts, which
  // then re-exports fromPrivateKey under a generated alias
  entry: { 'chain/browser': 'src/chain/browser.ts' },
  format: ['esm', 'cjs'],
  dts: { only: true },
  clean: false,
  target: 'es2022',
  outDir: 'dist',
  external: ['viem', '@x402/fetch', '@x402/evm', '@x402/evm/exact/client'],
}]);
