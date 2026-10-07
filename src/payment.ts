import type { PaymentRequest, PaymentWallet, X402PaymentConfig } from './types.js';
import { PaymentConfigurationError, PaymentRefusedError } from './errors.js';
import { isAddress } from './utils.js';

/**
 * USDC per network, as in @x402/evm's default asset table. x402 v2 names
 * networks in CAIP-2, v1 by name.
 */
export const USDC_BY_NETWORK: Readonly<Record<string, string>> = Object.freeze({
  'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
});

const MAINNETS = new Set(['eip155:8453', 'base']);
const DEFAULT_TESTNET_MAX_AMOUNT = '1';
const DEFAULT_MAX_TIMEOUT_SECONDS = 600;

/** The checks every payment must pass before the SDK signs it (#106). */
export interface PaymentPolicy {
  /** Networks the SDK pays on, with the asset expected there (undefined: none known, so refuse) */
  networks: ReadonlyMap<string, string | undefined>;
  maxAmount: string;
  maxAtomic: bigint;
  decimals: number;
  payTo: ReadonlySet<string> | undefined;
  maxTimeoutSeconds: number;
  onBeforePayment: X402PaymentConfig['onBeforePayment'];
}

/**
 * Validate the x402 config into a policy. Throws PaymentConfigurationError, so
 * ProvenanceClient can reject a bad config at construction, before any request.
 */
export function resolvePaymentPolicy(config: X402PaymentConfig): PaymentPolicy {
  const network = config.network ?? 'eip155:84532';
  const v1Network = config.v1Network ?? 'base-sepolia';
  const mainnet = MAINNETS.has(network) || MAINNETS.has(v1Network);

  if (config.maxAmount === undefined && mainnet) {
    throw new PaymentConfigurationError(
      'payment.maxAmount is required on Base mainnet: the largest single payment to sign, e.g. maxAmount: "0.50"'
    );
  }
  const maxAmount = config.maxAmount ?? DEFAULT_TESTNET_MAX_AMOUNT;

  const decimals = config.assetDecimals ?? 6;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new PaymentConfigurationError(`payment.assetDecimals must be an integer 0-36, got ${String(decimals)}`);
  }
  const maxAtomic = toAtomic(maxAmount, decimals);

  if (config.asset !== undefined && !isAddress(config.asset)) {
    throw new PaymentConfigurationError(`payment.asset must be a token address, got ${JSON.stringify(config.asset)}`);
  }
  const networks = new Map<string, string | undefined>();
  for (const n of [network, v1Network]) networks.set(n, config.asset ?? USDC_BY_NETWORK[n]);

  let payTo: Set<string> | undefined;
  if (config.payTo !== undefined) {
    const bad = config.payTo.filter((a) => !isAddress(a));
    if (config.payTo.length === 0 || bad.length > 0) {
      throw new PaymentConfigurationError(
        `payment.payTo must be a non-empty list of addresses${bad.length ? `; invalid: ${bad.join(', ')}` : ''}`
      );
    }
    payTo = new Set(config.payTo.map((a) => a.toLowerCase()));
  }

  const maxTimeoutSeconds = config.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
  if (!Number.isInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
    throw new PaymentConfigurationError(
      `payment.maxTimeoutSeconds must be a positive integer, got ${String(maxTimeoutSeconds)}`
    );
  }

  return { networks, maxAmount, maxAtomic, decimals, payTo, maxTimeoutSeconds, onBeforePayment: config.onBeforePayment };
}

/** '1.50' with 6 decimals -> 1500000n. Rejects negatives, exponents and excess precision. */
function toAtomic(amount: string, decimals: number): bigint {
  const match = typeof amount === 'string' ? /^(\d+)(?:\.(\d+))?$/.exec(amount) : null;
  if (!match) {
    throw new PaymentConfigurationError(
      `payment.maxAmount must be a decimal string such as "0.50", got ${JSON.stringify(amount)}`
    );
  }
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) {
    throw new PaymentConfigurationError(`payment.maxAmount has more than ${decimals} decimal places: ${amount}`);
  }
  return BigInt(match[1]! + fraction.padEnd(decimals, '0'));
}

/** Atomic units back to a decimal string, for messages: 1500000n, 6 -> '1.5' */
export function formatAtomic(atomic: bigint, decimals: number): string {
  const s = atomic.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const fraction = s.slice(s.length - decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** One offered option from a 402, normalised across x402 v1 and v2 */
export function toPaymentRequest(x402Version: number, requirement: Record<string, unknown>): PaymentRequest {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    x402Version,
    network: str(requirement['network']),
    scheme: str(requirement['scheme']),
    asset: str(requirement['asset']),
    // v2: amount; v1: maxAmountRequired
    amount: str(requirement['amount'] ?? requirement['maxAmountRequired']),
    payTo: str(requirement['payTo']),
    maxTimeoutSeconds: typeof requirement['maxTimeoutSeconds'] === 'number' ? requirement['maxTimeoutSeconds'] : NaN,
  };
}

/** Why a requested payment breaks the policy; empty if it may be signed. */
export function checkPaymentRequest(
  request: PaymentRequest,
  extra: Record<string, unknown> | undefined,
  policy: PaymentPolicy
): string[] {
  const reasons: string[] = [];
  if (request.scheme !== 'exact') reasons.push(`scheme ${JSON.stringify(request.scheme)} is not 'exact'`);

  if (!policy.networks.has(request.network)) {
    reasons.push(`network ${JSON.stringify(request.network)} is not configured (${[...policy.networks.keys()].join(', ')})`);
  } else {
    const expected = policy.networks.get(request.network);
    if (expected === undefined) {
      reasons.push(`no known USDC on ${request.network}: set payment.asset`);
    } else if (request.asset.toLowerCase() !== expected.toLowerCase()) {
      reasons.push(`asset ${request.asset || '(none)'} is not the expected ${expected}`);
    }
  }

  if (!/^\d+$/.test(request.amount)) {
    reasons.push(`amount ${JSON.stringify(request.amount)} is not an integer`);
  } else if (BigInt(request.amount) > policy.maxAtomic) {
    reasons.push(`amount ${formatAtomic(BigInt(request.amount), policy.decimals)} exceeds maxAmount ${policy.maxAmount}`);
  }

  if (policy.payTo && !policy.payTo.has(request.payTo.toLowerCase())) {
    reasons.push(`recipient ${request.payTo || '(none)'} is not in payment.payTo`);
  }

  if (!(request.maxTimeoutSeconds > 0 && request.maxTimeoutSeconds <= policy.maxTimeoutSeconds)) {
    reasons.push(`validity ${String(request.maxTimeoutSeconds)}s exceeds maxTimeoutSeconds ${policy.maxTimeoutSeconds}`);
  }

  // Permit2 (the other v2 transfer method) can sign a standing token approval
  const method = extra?.['assetTransferMethod'];
  if (method !== undefined && method !== 'eip3009') {
    reasons.push(`transfer method ${JSON.stringify(method)} is not 'eip3009'`);
  }
  return reasons;
}

/** Responses to requests that carried a payment (see isPaidResponse) */
const paidResponses = new WeakSet<Response>();

/**
 * Whether this response answers a request that carried a payment, i.e. a
 * payment may have been settled for it even if the response is an error.
 */
export function isPaidResponse(response: Response): boolean {
  return paidResponses.has(response);
}

function isRequest(input: unknown): input is Request {
  return typeof Request !== 'undefined' && input instanceof Request;
}

/**
 * Create an x402-wrapped fetch function that automatically handles 402 payment responses.
 *
 * Every payment passes the policy from `resolvePaymentPolicy` before it is
 * signed, on any @x402 version: the 402 is filtered before the library sees it,
 * and the library's before-payment hook re-checks the option it selected.
 *
 * Dynamically imports @x402/fetch and @x402/evm — throws PaymentConfigurationError
 * if they are not installed.
 */
export async function createX402Fetch(config: X402PaymentConfig): Promise<typeof fetch> {
  const policy = resolvePaymentPolicy(config);

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
  // Typed as one or the other, but plain JS callers may pass anything
  const loose = wallet as { address?: unknown; account?: { address?: unknown } | null };
  const address = (typeof loose.address === 'string' ? loose.address : loose.account?.address) as
    | `0x${string}`
    | undefined;
  if (!address) {
    throw new PaymentConfigurationError(
      'Wallet must have an address. Pass a viem WalletClient created with an account, or use toClientEvmSigner().'
    );
  }
  // Pass the wallet through unchanged when it already carries the address
  const signer = hasAddress(wallet) ? wallet : { ...wallet, address };

  const network = config.network ?? 'eip155:84532';
  const client = new x402Fetch.x402Client();
  const scheme = new x402Evm.ExactEvmScheme(signer);
  client.register(network, scheme);

  // Also register for v1: the gateway currently returns x402Version 1 with simple
  // network names (e.g. "base-sepolia") instead of CAIP-2 (e.g. "eip155:84532").
  const v1Network = config.v1Network ?? 'base-sepolia';
  const v1Scheme = new x402EvmV1.ExactEvmSchemeV1(signer);
  client.registerV1(v1Network, v1Scheme);

  // Final gate, inside the library, right before it signs: the selected option
  // must still pass the policy (the 402 was already narrowed by policedFetch).
  client.onBeforePaymentCreation((context) => {
    const requirement = context.selectedRequirements as unknown as Record<string, unknown>;
    const reasons = checkPaymentRequest(
      toPaymentRequest(context.paymentRequired.x402Version, requirement),
      requirement['extra'] as Record<string, unknown> | undefined,
      policy
    );
    return Promise.resolve(
      reasons.length ? { abort: true as const, reason: `Payment refused: ${reasons.join('; ')}` } : undefined
    );
  });

  // @x402/core 2.23+ caps payments at $1 by default (#110). The policy is the
  // cap: align the library's spend control with it, so it neither refuses
  // payments the policy allows nor allows more. Older versions have no such API.
  const setSpendControls = (client as unknown as { setSpendControls?: (controls: unknown) => unknown })
    .setSpendControls;
  if (typeof setSpendControls === 'function') {
    const allowedAssets = [...policy.networks]
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([n, asset]) => ({ network: n, asset, maxAmountPerPayment: policy.maxAtomic.toString() }));
    setSpendControls.call(client, { maxAmountPerPayment: false, allowedAssets });
  }

  // The SDK's own transport, under the library's paying fetch: it enforces the
  // policy on every offered option before the library can choose one, and
  // marks responses to paid requests.
  const policedFetch: typeof fetch = async (input, init) => {
    const paid = isRequest(input) && (input.headers.has('PAYMENT-SIGNATURE') || input.headers.has('X-PAYMENT'));
    const response = await fetch(input, init);
    if (paid) {
      paidResponses.add(response);
      return response;
    }
    if (response.status !== 402) return response;
    return policePaymentRequired(response, policy);
  };

  return x402Fetch.wrapFetchWithPayment(policedFetch, client);
}

/**
 * Narrow a 402 to the single option the SDK will pay, or throw
 * PaymentRefusedError. Also normalises the gateway's 402: it wraps the x402
 * payload in FastAPI's "detail" field, while @x402/fetch expects it at the top
 * level (v1) or in the PAYMENT-REQUIRED header (v2).
 */
async function policePaymentRequired(response: Response, policy: PaymentPolicy): Promise<Response> {
  const headers = new Headers(response.headers);
  const header = headers.get('PAYMENT-REQUIRED');
  let paymentRequired: Record<string, unknown> | undefined;

  if (header) {
    try {
      paymentRequired = JSON.parse(base64Decode(header)) as Record<string, unknown>;
    } catch {
      paymentRequired = undefined;
    }
  } else {
    let body: Record<string, unknown> | undefined;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      body = undefined;
    }
    const detail = body?.['detail'];
    paymentRequired =
      detail && typeof detail === 'object' && 'x402Version' in detail ? (detail as Record<string, unknown>) : body;
  }

  const accepts = paymentRequired?.['accepts'];
  const x402Version = paymentRequired?.['x402Version'];
  if (!paymentRequired || !Array.isArray(accepts) || typeof x402Version !== 'number') {
    throw new PaymentRefusedError('Payment refused: the 402 response carries no readable payment requirements');
  }

  const refusals: Array<{ request: PaymentRequest; reasons: string[] }> = [];
  let chosen: Record<string, unknown> | undefined;
  for (const option of accepts as Array<Record<string, unknown> | null>) {
    const request = toPaymentRequest(x402Version, option ?? {});
    const reasons = checkPaymentRequest(request, option?.['extra'] as Record<string, unknown> | undefined, policy);
    if (reasons.length === 0 && policy.onBeforePayment) {
      try {
        if ((await policy.onBeforePayment(request)) === false) reasons.push('onBeforePayment refused it');
      } catch (e) {
        reasons.push(`onBeforePayment threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (reasons.length === 0 && option) {
      chosen = option;
      break;
    }
    refusals.push({ request, reasons });
  }

  if (!chosen) {
    const summary = refusals
      .map(({ request, reasons }) => `${request.amount || '?'} on ${request.network || '?'} to ${request.payTo || '?'}: ${reasons.join('; ')}`)
      .join(' | ');
    throw new PaymentRefusedError(`Payment refused before signing: ${summary || 'no payment options offered'}`, refusals);
  }

  // Only the approved option reaches the library, so it cannot select another
  const narrowed = { ...paymentRequired, accepts: [chosen] };
  headers.delete('content-length');
  if (header) {
    headers.set('PAYMENT-REQUIRED', base64Encode(JSON.stringify(narrowed)));
    return new Response(null, { status: 402, statusText: response.statusText, headers });
  }
  return new Response(JSON.stringify(narrowed), { status: 402, statusText: response.statusText, headers });
}

function base64Decode(value: string): string {
  const binary = atob(value);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

function base64Encode(value: string): string {
  return btoa(Array.from(new TextEncoder().encode(value), (b) => String.fromCharCode(b)).join(''));
}

function hasAddress(wallet: PaymentWallet): wallet is PaymentWallet & { address: `0x${string}` } {
  return typeof (wallet as { address?: unknown }).address === 'string';
}
