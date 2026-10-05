import { readFile, writeFile } from 'node:fs/promises';
import { defineConfig } from 'tsup';

const MISSING_VIEM_MESSAGE =
  "@datafund/swarm-provenance/chain requires the optional peer dependency 'viem'. Install it with: npm install viem";

// CJS evaluates requires in order, so a guard placed before require('viem')
// replaces Node's bare "Cannot find module 'viem'" with an actionable message.
// It goes on the 'use strict' line so the directive stays first and line
// numbers (and the source map) are unchanged. ESM cannot be guarded this way:
// imports are linked before any code runs (see README "Troubleshooting").
const CJS_VIEM_GUARD = `try { require.resolve('viem'); } catch { throw new Error(${JSON.stringify(MISSING_VIEM_MESSAGE)}); }`;

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
    const file = 'dist/chain/index.cjs';
    const code = await readFile(file, 'utf8');
    if (!code.startsWith("'use strict';\n")) {
      throw new Error(`${file}: expected 'use strict' on line 1, cannot insert the viem guard`);
    }
    await writeFile(file, code.replace("'use strict';", `'use strict'; ${CJS_VIEM_GUARD}`));
  },
});
