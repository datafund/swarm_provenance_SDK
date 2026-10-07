// Node 18 has no global `crypto` by default; the x402 library needs
// crypto.getRandomValues. The SDK refuses x402 mode without it (see
// createX402Transport); tests install Node's WebCrypto so the payment tests
// still run on Node 18 in CI.
import { webcrypto } from 'node:crypto';

if (typeof globalThis.crypto?.getRandomValues !== 'function') {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}
