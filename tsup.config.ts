import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { defineConfig } from 'tsup';
import { VIEM_REQUIRE_GUARDED } from './scripts/viem-guard.js';

const CJS_CHAIN = 'dist/chain/index.cjs';
const VIEM_REQUIRE = "var viem = require('viem');";

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
  // Wrap require('viem') in the CJS chain entry (#99, see scripts/viem-guard.ts)
  async onSuccess() {
    // Partial builds (e.g. `tsup --format esm`) produce no CJS chain entry: nothing
    // to guard. CI's "Verify dist" step fails if a full build ever lacks the file.
    if (!existsSync(CJS_CHAIN)) return;
    const code = await readFile(CJS_CHAIN, 'utf8');
    const count = code.split(VIEM_REQUIRE).length - 1;
    if (count !== 1) {
      throw new Error(`${CJS_CHAIN}: expected exactly one "${VIEM_REQUIRE}", found ${count}; update the viem guard`);
    }
    // Function replacer: no `$&`-style pattern expansion in the inserted text
    await writeFile(CJS_CHAIN, code.replace(VIEM_REQUIRE, () => VIEM_REQUIRE_GUARDED));
  },
});
