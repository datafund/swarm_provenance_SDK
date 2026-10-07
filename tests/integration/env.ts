/**
 * Integration test target. Defaults to the dev gateway: tests that upload
 * (and pay, in x402 mode) must never hit production by accident.
 *
 *   PROVENANCE_GATEWAY_URL   gateway to test (default: dev)
 *   ALLOW_PRODUCTION_WRITES  set to 1 to let write tests run against production
 */
export const PRODUCTION_GATEWAY = 'https://provenance-gateway.datafund.io';
export const DEV_GATEWAY = 'https://provenance-gateway.dev.datafund.io';

export const GATEWAY_URL = (process.env['PROVENANCE_GATEWAY_URL'] || DEV_GATEWAY).replace(/\/+$/, '');

// Compare hosts, so another spelling (case, scheme, port, path) is still production
const isProduction = new URL(GATEWAY_URL).hostname.toLowerCase() === new URL(PRODUCTION_GATEWAY).hostname;

/** Whether tests that write (upload, acquire, pay) may run against GATEWAY_URL */
export const WRITES_ALLOWED = !isProduction || process.env['ALLOW_PRODUCTION_WRITES'] === '1';

if (!WRITES_ALLOWED) {
  console.log(`Write tests skipped: ${GATEWAY_URL} is production. Set ALLOW_PRODUCTION_WRITES=1 to run them.`);
}
