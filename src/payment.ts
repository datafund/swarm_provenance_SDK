import type { PaymentRequest, PaymentWallet, X402PaymentConfig } from './types.js';
import { PaymentConfigurationError, PaymentRefusedError } from './errors.js';
import { isAddress, base64ToBytes, bytesToBase64 } from './utils.js';

/**
 * The networks the SDK knows, one record each: the x402 v1 name, the v2
 * CAIP-2 ID, the EVM chain ID, USDC (from @x402/evm's default asset table)
 * and whether it is a testnet. Everything per-network derives from this.
 */
const NETWORKS = Object.freeze([
  Object.freeze({
    name: 'base-sepolia',
    v2: 'eip155:84532' as const,
    chainId: 84532,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    testnet: true,
  }),
  Object.freeze({
    name: 'base',
    v2: 'eip155:8453' as const,
    chainId: 8453,
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    testnet: false,
  }),
]);

/** USDC per network identifier (v1 name and v2 CAIP-2) */
export const USDC_BY_NETWORK: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(NETWORKS.flatMap((n) => [[n.name, n.usdc], [n.v2, n.usdc]]))
);

const DEFAULT_TESTNET_MAX_AMOUNT = '1';

/** CAIP-2: namespace 3-8 of [-a-z0-9], reference 1-32 of [-_a-zA-Z0-9] */
const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;

/** EVM chain ID of a network identifier: from `eip155:<id>`, or a known v1 name */
function chainIdOf(id: string): number | undefined {
  const eip155 = /^eip155:(\d+)$/.exec(id);
  if (eip155) return Number(eip155[1]);
  return NETWORKS.find((n) => n.name === id)?.chainId;
}

/**
 * The x402 v2 (CAIP-2) and v1 network identifiers for a config. The gateway
 * speaks v1 today, so both must name the same chain: a mismatch would fail
 * every payment, so it is a configuration error.
 */
function resolveNetworks(config: X402PaymentConfig): { network: `${string}:${string}`; v1Network: string } {
  if (config.v1Network !== undefined && (typeof config.v1Network !== 'string' || !/^[-a-z0-9]+$/.test(config.v1Network))) {
    throw new PaymentConfigurationError(
      `payment.v1Network must be an x402 v1 network name such as 'base', got ${JSON.stringify(config.v1Network)}`
    );
  }
  // Only v1Network set (the old way to pick mainnet): follow it
  const fromV1 = config.network === undefined && config.v1Network !== undefined
    ? NETWORKS.find((n) => n.name === config.v1Network)?.v2
    : undefined;
  const requested = config.network ?? fromV1 ?? 'base-sepolia';
  const known = NETWORKS.find((n) => n.name === requested);
  const network = known ? known.v2 : requested;
  if (!known && !(typeof network === 'string' && CAIP2.test(network))) {
    throw new PaymentConfigurationError(
      `payment.network must be 'base', 'base-sepolia' or a CAIP-2 ID such as 'eip155:8453', got ${JSON.stringify(requested)}`
    );
  }
  const v1Network = config.v1Network ?? NETWORKS.find((n) => n.v2 === network)?.name;
  if (v1Network === undefined) {
    throw new PaymentConfigurationError(
      `payment.v1Network is required for ${network}: the gateway names networks the x402 v1 way (e.g. 'base')`
    );
  }
  const chainA = chainIdOf(network);
  const chainB = chainIdOf(v1Network);
  if (chainA !== undefined && chainB !== undefined && chainA !== chainB) {
    const networkSetting = config.network === undefined ? `the default network ${network}` : `payment.network ${requested}`;
    throw new PaymentConfigurationError(
      `${networkSetting} and payment.v1Network ${v1Network} are different chains; set one network: 'base' or 'base-sepolia'`
    );
  }
  return { network: network as `${string}:${string}`, v1Network };
}

const DEFAULT_MAX_TIMEOUT_SECONDS = 600;

/** The checks every payment must pass before the SDK signs it (#106). */
export interface PaymentPolicy {
  /** The network the SDK pays on per x402 version (2: CAIP-2, 1: name) */
  networkByVersion: ReadonlyMap<number, string>;
  /** Asset expected per network (undefined: none known, so refuse) */
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
  const { network, v1Network } = resolveNetworks(config);
  const isTestnet = (id: string) => NETWORKS.some((n) => n.testnet && (n.name === id || n.v2 === id));
  const testnetOnly = isTestnet(network) && isTestnet(v1Network) && config.asset === undefined;

  if (config.maxAmount === undefined && !testnetOnly) {
    throw new PaymentConfigurationError(
      'payment.maxAmount is required except on Base Sepolia with test USDC: the largest single payment to sign, e.g. maxAmount: "0.50"'
    );
  }
  const maxAmount = config.maxAmount ?? DEFAULT_TESTNET_MAX_AMOUNT;

  // A custom token's decimals cannot be assumed: '1' means 10^6 units only for USDC.
  // And decimals without a token would rescale the cap on the default USDC.
  if (config.asset !== undefined && config.assetDecimals === undefined) {
    throw new PaymentConfigurationError('payment.assetDecimals is required with payment.asset');
  }
  if (config.asset === undefined && config.assetDecimals !== undefined) {
    throw new PaymentConfigurationError('payment.assetDecimals is only valid together with payment.asset');
  }
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
    if (!Array.isArray(config.payTo)) {
      throw new PaymentConfigurationError('payment.payTo must be an array of addresses');
    }
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

  const networkByVersion = new Map<number, string>([
    [2, network],
    [1, v1Network],
  ]);
  return {
    networkByVersion,
    networks,
    maxAmount,
    maxAtomic,
    decimals,
    payTo,
    maxTimeoutSeconds,
    onBeforePayment: config.onBeforePayment,
  };
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

/**
 * One offered option from a 402, normalised across x402 v1 and v2. The amount
 * is the field the scheme for that version actually signs: v1
 * `maxAmountRequired`, v2 `amount` (see amountConflict for options carrying both).
 */
export function toPaymentRequest(x402Version: number, requirement: Record<string, unknown>): PaymentRequest {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    x402Version,
    network: str(requirement['network']),
    scheme: str(requirement['scheme']),
    asset: str(requirement['asset']),
    amount: str(x402Version === 1 ? requirement['maxAmountRequired'] : requirement['amount']),
    payTo: str(requirement['payTo']),
    maxTimeoutSeconds: typeof requirement['maxTimeoutSeconds'] === 'number' ? requirement['maxTimeoutSeconds'] : NaN,
  };
}

/**
 * An option carrying both amount fields with different values is refused: the
 * policy must check exactly the value that gets signed, and a gateway should
 * not send two.
 */
function amountConflict(requirement: Record<string, unknown> | undefined): boolean {
  const a = requirement?.['amount'];
  const m = requirement?.['maxAmountRequired'];
  return a !== undefined && m !== undefined && a !== m;
}

/** Why a requested payment breaks the policy; empty if it may be signed. */
export function checkPaymentRequest(
  request: PaymentRequest,
  extra: Record<string, unknown> | undefined,
  policy: PaymentPolicy,
  requirement?: Record<string, unknown>
): string[] {
  const reasons: string[] = [];
  if (amountConflict(requirement)) reasons.push('amount and maxAmountRequired disagree');
  if (request.scheme !== 'exact') reasons.push(`scheme ${JSON.stringify(request.scheme)} is not 'exact'`);

  // The network must be the one configured for this x402 version: an option
  // naming the other version's network has no registered scheme
  const configured = policy.networkByVersion.get(request.x402Version);
  if (request.network !== configured) {
    reasons.push(
      `network ${JSON.stringify(request.network)} is not the configured x402 v${request.x402Version} network ${JSON.stringify(configured ?? '(none)')}`
    );
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

/** What happened to one request attempt, recorded by the SDK's own code and hooks */
export interface PaymentAttemptState {
  /** A signed payment was sent to the gateway */
  paid: boolean;
  /** The payment was refused before signing (policy or onBeforePayment) */
  refusal?: PaymentRefusedError;
  /** The x402 library failed to create or sign the payment (nothing sent) */
  creationFailure?: unknown;
  /** An approved 402 was handed to the library to select, sign and send */
  handedToLibrary?: boolean;
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
/**
 * The x402 machinery, set up once, handing out a paying fetch per request
 * attempt. Each attempt's fetch reports into its own state whether it sent a
 * payment, independent of how the library calls the inner fetch.
 */
export async function createX402Transport(
  config: X402PaymentConfig,
  policy: PaymentPolicy = resolvePaymentPolicy(config)
): Promise<{ fetchFor(state: PaymentAttemptState): typeof fetch }> {
  // The x402 library draws payment nonces from Web Crypto. Node 18 does not
  // expose it globally, and the library's own error does not say why.
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new PaymentConfigurationError(
      'x402 payment mode needs globalThis.crypto (Web Crypto): use Node.js 20 or later, ' +
        'or on Node 18 run with --experimental-global-webcrypto or set globalThis.crypto = require("node:crypto").webcrypto'
    );
  }
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

  // The gateway currently answers with x402 v1 and simple network names
  // (e.g. "base-sepolia"); v2 uses CAIP-2 (e.g. "eip155:84532"). Register both,
  // from the policy so the schemes and the checks name the same networks.
  const network = policy.networkByVersion.get(2)! as `${string}:${string}`;
  const v1Network = policy.networkByVersion.get(1)!;
  const scheme = new x402Evm.ExactEvmScheme(signer);
  const v1Scheme = new x402EvmV1.ExactEvmSchemeV1(signer);

  /** A fresh x402 client per attempt, so its hooks report into that attempt's state */
  const clientFor = (state: PaymentAttemptState) => {
    const client = new x402Fetch.x402Client();
    client.register(network, scheme);
    client.registerV1(v1Network, v1Scheme);

    // Final gate, inside the library, right before it signs: the selected
    // option must still pass the policy (the 402 was already narrowed).
    client.onBeforePaymentCreation((context) => {
      const requirement = context.selectedRequirements as unknown as Record<string, unknown>;
      const request = toPaymentRequest(context.paymentRequired.x402Version, requirement);
      const reasons = checkPaymentRequest(request, requirement['extra'] as Record<string, unknown> | undefined, policy, requirement);
      if (reasons.length === 0) return Promise.resolve();
      state.refusal = new PaymentRefusedError(`Payment refused before signing: ${reasons.join('; ')}`, [{ request, reasons }]);
      return Promise.resolve({ abort: true as const, reason: state.refusal.message });
    });
    client.onPaymentCreationFailure((context) => {
      if (!state.refusal) state.creationFailure = context.error;
      return Promise.resolve();
    });

    // @x402/core 2.23+ caps payments at $1 by default (#110). The policy is the
    // cap: align the library's spend control with it, so it neither refuses
    // payments the policy allows nor allows more. Older versions lack the API.
    const setSpendControls = (client as unknown as { setSpendControls?: (controls: unknown) => unknown })
      .setSpendControls;
    if (typeof setSpendControls === 'function') {
      const allowedAssets = [...policy.networks]
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([n, asset]) => ({ network: n, asset, maxAmountPerPayment: policy.maxAtomic.toString() }));
      setSpendControls.call(client, { maxAmountPerPayment: false, allowedAssets });
    }
    return client;
  };

  // The SDK's own transport, under the library's paying fetch: it enforces the
  // policy on every offered option before the library can choose one, and
  // records in the attempt's state whether a payment went out.
  const policedFetchFor =
    (state: PaymentAttemptState): typeof fetch =>
    async (input, init) => {
      const request = isRequest(input) && init === undefined ? input : new Request(input, init);
      const paid = request.headers.has('PAYMENT-SIGNATURE') || request.headers.has('X-PAYMENT');
      // An already aborted request (e.g. the timeout fired while the wallet was
      // signing) is rejected before anything is sent: not a payment.
      if (paid && !request.signal.aborted) state.paid = true;

      const response = await fetch(request);
      if (paid || response.status !== 402) return response;
      try {
        const approved = await policePaymentRequired(response, policy, request.signal);
        state.handedToLibrary = true;
        return approved;
      } catch (error) {
        if (error instanceof PaymentRefusedError) state.refusal = error;
        throw error;
      }
    };

  return { fetchFor: (state) => x402Fetch.wrapFetchWithPayment(policedFetchFor(state), clientFor(state)) };
}

/**
 * Narrow a 402 to the single option the SDK will pay, or throw
 * PaymentRefusedError. Also normalises the gateway's 402: it wraps the x402
 * payload in FastAPI's "detail" field, while @x402/fetch expects it at the top
 * level (v1) or in the PAYMENT-REQUIRED header (v2).
 */
async function policePaymentRequired(response: Response, policy: PaymentPolicy, signal: AbortSignal): Promise<Response> {
  const headers = new Headers(response.headers);
  const header = headers.get('PAYMENT-REQUIRED');
  let paymentRequired: Record<string, unknown> | undefined;
  let fromHeader = false;

  if (header) {
    try {
      paymentRequired = JSON.parse(base64Decode(header)) as Record<string, unknown>;
      fromHeader = true;
    } catch {
      // Undecodable: drop it and fall back to the body
      headers.delete('PAYMENT-REQUIRED');
    }
  }
  if (fromHeader) {
    // The body is not used: release the connection
    await response.body?.cancel().catch(() => undefined);
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
    const reasons = checkPaymentRequest(
      request,
      option?.['extra'] as Record<string, unknown> | undefined,
      policy,
      option ?? undefined
    );
    if (reasons.length === 0 && policy.onBeforePayment) {
      let verdict: boolean | void = undefined;
      try {
        // Bounded by the request's timeout: an unanswered approval must not hang the call
        verdict = await untilAborted(Promise.resolve(policy.onBeforePayment(request)), signal);
      } catch (e) {
        if (signal.aborted) throw e; // the timeout fired while waiting for approval
        reasons.push(`onBeforePayment threw: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (verdict === false && reasons.length === 0) reasons.push('onBeforePayment refused it');
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
  if (fromHeader) {
    headers.set('PAYMENT-REQUIRED', base64Encode(JSON.stringify(narrowed)));
    return new Response(null, { status: 402, statusText: response.statusText, headers });
  }
  return new Response(JSON.stringify(narrowed), { status: 402, statusText: response.statusText, headers });
}

/** base64 of UTF-8 text, as x402 encodes its headers */
export function base64Decode(value: string): string {
  return new TextDecoder().decode(base64ToBytes(value));
}

function base64Encode(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value));
}

function hasAddress(wallet: PaymentWallet): wallet is PaymentWallet & { address: `0x${string}` } {
  return typeof (wallet as { address?: unknown }).address === 'string';
}

/** Settle like `promise`, or reject with an AbortError as soon as `signal` aborts. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('The operation was aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('The operation was aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
