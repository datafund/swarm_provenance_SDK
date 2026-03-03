import { defineConfig } from 'tsup';

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
});
