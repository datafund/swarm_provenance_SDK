import type { X402PaymentConfig } from './types.js';
import { PaymentConfigurationError } from './errors.js';

/**
 * Create an x402-wrapped fetch function that automatically handles 402 payment responses.
 *
 * Dynamically imports @x402/fetch and @x402/evm — throws PaymentConfigurationError
 * if they are not installed.
 */
export async function createX402Fetch(config: X402PaymentConfig): Promise<typeof fetch> {
  let x402Fetch: typeof import('@x402/fetch');
  let x402Evm: typeof import('@x402/evm');

  try {
    x402Fetch = await import('@x402/fetch');
  } catch {
    throw new PaymentConfigurationError(
      '@x402/fetch is required for x402 payment mode. Install it: pnpm add @x402/fetch'
    );
  }

  try {
    x402Evm = await import('@x402/evm');
  } catch {
    throw new PaymentConfigurationError(
      '@x402/evm is required for x402 payment mode. Install it: pnpm add @x402/evm'
    );
  }

  const network = config.network ?? 'eip155:84532';
  const client = new x402Fetch.x402Client();
  const scheme = new x402Evm.ExactEvmScheme(config.wallet);
  client.register(network, scheme);

  return x402Fetch.wrapFetchWithPayment(fetch, client);
}
