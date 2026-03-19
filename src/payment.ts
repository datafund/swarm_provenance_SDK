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

  let x402EvmV1: typeof import('@x402/evm/v1');
  try {
    x402EvmV1 = await import('@x402/evm/v1');
  } catch {
    throw new PaymentConfigurationError(
      '@x402/evm is required for x402 payment mode. Install it: pnpm add @x402/evm'
    );
  }

  // Viem's WalletClient.extend(publicActions) puts address at account.address,
  // not at the top level. The x402 schemes need address directly on the signer.
  const wallet = config.wallet;
  const address = wallet.address
    ?? (wallet as unknown as { account?: { address: `0x${string}` } }).account?.address;
  if (!address) {
    throw new PaymentConfigurationError(
      'Wallet must have an address. Pass a viem WalletClient created with an account, or use toClientEvmSigner().'
    );
  }
  const signer = address !== wallet.address ? { ...wallet, address } : wallet;

  const network = config.network ?? 'eip155:84532';
  const client = new x402Fetch.x402Client();
  const scheme = new x402Evm.ExactEvmScheme(signer);
  client.register(network, scheme);

  // Also register for v1: the gateway currently returns x402Version 1 with simple
  // network names (e.g. "base-sepolia") instead of CAIP-2 (e.g. "eip155:84532").
  const v1Network = config.v1Network ?? 'base-sepolia';
  const v1Scheme = new x402EvmV1.ExactEvmSchemeV1(signer);
  client.registerV1(v1Network, v1Scheme);

  // Normalize 402 responses: the gateway wraps x402 payload inside FastAPI's
  // "detail" field, but @x402/fetch expects x402Version at the top level.
  const normalizingFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (response.status === 402) {
      const body = (await response.json()) as Record<string, unknown>;
      const detail = body?.detail;
      const payload = detail && typeof detail === 'object' && 'x402Version' in (detail as Record<string, unknown>)
        ? detail
        : body;
      return new Response(JSON.stringify(payload), {
        status: 402,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    return response;
  };

  return x402Fetch.wrapFetchWithPayment(normalizingFetch, client);
}
