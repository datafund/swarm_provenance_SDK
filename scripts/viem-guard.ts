// Kept apart from tsup.config.ts so unit tests can import it without loading tsup.

/**
 * #99: in the CJS chain entry, wrap the real `require('viem')` so a missing viem
 * throws an actionable message instead of Node's bare "Cannot find module".
 * It stays a literal require('viem'), so bundlers that inline viem follow it.
 * Same line, so line numbers and the source map are unchanged.
 *
 * Only MODULE_NOT_FOUND whose first message line quotes exactly 'viem' is
 * rewritten (only require('viem') is wrapped, so no subpath can appear). A missing dependency of viem, or a broken
 * viem install (a missing file inside it), names a different specifier and is
 * rethrown unchanged. The rewritten error carries the documented
 * name/code (ChainConfigurationError / CHAIN_CONFIGURATION) and the original as
 * `cause`. It cannot be a real ChainConfigurationError: the class is defined
 * later in the bundle. Unit-tested in tests/unit/build/viem-guard.test.ts.
 *
 * Applied after the build (tsup.config.ts) because treeshake makes tsup emit
 * CJS via rollup, out of reach of esbuild plugins. ESM cannot be guarded at
 * all: imports are linked before any code runs (see README "Troubleshooting").
 */
export const VIEM_REQUIRE_GUARDED =
  "var viem = (() => { try { return require('viem'); } catch (e) { " +
  "if (e && e.code === 'MODULE_NOT_FOUND' && /'viem'/.test(String(e.message).split('\\n')[0])) { " +
  'throw Object.assign(new Error(' +
  JSON.stringify(
    "@datafund/swarm-provenance/chain requires the optional peer dependency 'viem'. Install it: npm install viem (or pnpm add viem)",
  ) +
  ", { cause: e }), { name: 'ChainConfigurationError', code: 'CHAIN_CONFIGURATION' }); } throw e; } })();";
