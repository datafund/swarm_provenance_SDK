# @datafund/swarm-provenance

[![npm version](https://img.shields.io/npm/v/@datafund/swarm-provenance)](https://www.npmjs.com/package/@datafund/swarm-provenance)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

TypeScript SDK for storing and retrieving provenance data via the Swarm network.

## Requirements

- Node.js >= 18.0.0
- [viem](https://viem.sh) >= 2.0.0 (optional, for blockchain anchoring only)

## Installation

```bash
pnpm add @datafund/swarm-provenance
```

For blockchain anchoring features, also install viem:

```bash
pnpm add @datafund/swarm-provenance viem
```

For x402 paid gateway access (higher rate limits), also install:

```bash
pnpm add @datafund/swarm-provenance @x402/fetch @x402/evm viem
```

## Quick Start

```typescript
import { ProvenanceClient } from '@datafund/swarm-provenance';

const client = new ProvenanceClient();

// Upload data
const result = await client.upload('Hello, World!', {
  standard: 'my-provenance-v1',
});

console.log('Uploaded:', result.reference);

// Download data
const downloaded = await client.download(result.reference);
console.log('Content:', new TextDecoder().decode(downloaded.file));
```

### x402 Payment Mode

By default, the SDK uses the free tier (`X-Payment-Mode: free`), which is rate-limited. For higher throughput, configure x402 automatic USDC payments.

**Network:** payments default to **Base Sepolia** (testnet USDC, no real value). One setting picks
the network: `network: 'base'` for Base mainnet (real USDC; `maxAmount` is then required) or
`'base-sepolia'`. It selects both identifiers the x402 protocol uses (v1 `base`, v2 `eip155:8453`),
so it must match the gateway's network: if the gateway asks for payment on another network, the
request fails with `PaymentRefusedError` naming both, before anything is signed.

```typescript
// Base mainnet: the wallet must be on Base too (viem `base` chain, or the
// injected wallet switched to chain 8453), since payments are signed for it
import { base } from 'viem/chains';
const wallet = createWalletClient({ account, chain: base, transport: http() }).extend(publicActions);
const client = new ProvenanceClient({ payment: { wallet, network: 'base', maxAmount: '0.10' } });
```

**Payment policy.** Before signing, every payment the gateway asks for must pass these checks,
or the request fails with `PaymentRefusedError` (`PAYMENT_REFUSED`) and nothing is signed:

| Option | Default | Checks |
|--------|---------|--------|
| `maxAmount` | `'1'` on Base Sepolia with test USDC; **required everywhere else** | Largest single payment, in tokens (`'0.50'` = 50 cents of USDC) |
| `payTo` | any | Allowed recipients |
| `asset` + `assetDecimals` | the network's USDC (6) | Token to pay with; both required on networks without a known USDC |
| `maxTimeoutSeconds` | `600` | Longest authorization validity the gateway may ask for |
| `onBeforePayment` | none | `(payment) => boolean`: sees amount, asset, recipient, network; return `false` to refuse. A payment may still not happen after it (signing fails, timeout): do not count spend here |
| `payForReads` | `false` | Also pay for reads; by default reads use the free tier (`X-Payment-Mode: free`, rate-limited) |
| `payForPool` | `false` | Also pay for pool stamps when the gateway asks for payment; by default that 402 is not paid (see below) |

Scheme `exact` with the EIP-3009 transfer method is the only one accepted (no Permit2
approvals). Only writes (`POST`) are paid unless `payForReads`; reads go to the free tier.

**Pool stamps are not paid unless you set `payForPool`.** `acquireStamp()` and `upload()` without
`stampId` take a stamp from the gateway's pool, which is free within a daily allowance. Callers
without an `Origin` header, such as Node.js servers, share one allowance. When it is spent, the
gateway answers in one of these ways. The first two carry the code
`DAILY_STAMP_ALLOWANCE_EXHAUSTED` (or `DAILY_STAMP_ALLOWANCE_PER_CLIENT_EXHAUSTED`):

| Gateway answer | When | SDK result without `payForPool` | SDK result with `payForPool: true` |
|----------------|------|---------------------------------|------------------------------------|
| 402 with a price | The gateway has x402 payments enabled, and a payment bypasses the allowance there (mainnet, or a testnet the operator enabled it for) | `StampError` with the gateway's code; nothing is paid | Pays, within the payment policy above, and returns the stamp |
| 429 | A payment would not bypass the allowance (testnets by default), or the gateway could not price the stamp | `StampError` with the gateway's code | `StampError` with the gateway's code |
| 409 `REQUESTED_SIZE_UNAVAILABLE` | The requested size is out of stock, and the allowance for the larger size the pool would hand out instead is spent | `StampError` with that code | `StampError` with that code |

The 402 price starts from the gateway's own price for buying a stamp of the requested size, which
already includes its purchase markup, and adds the pool markup. With the default pool markup of
100%, the 402 asks for twice the gateway's purchase price for that stamp. The `StampError` message
says how to continue: pass a `stampId` you own, or set `payForPool`.

A request that sent a payment is never retried automatically (unpaid attempts still retry
on 502/503/429); if it fails after the payment was sent, the error's `payment` field says so
(`{ paymentSent: true, transaction?, idempotencyKey?, stampId?, ... }`). A timeout while the wallet
is still approving the payment is not reported as paid: nothing was sent.

**Payment receipt (#111).** A paid result carries `payment`: `upload()` results (both
`UploadResult` and `DocumentUploadResult`) and `acquireStamp()`. An `upload()` that also paid for
its pool stamp made two payments: the upload's is `payment` and the stamp's is `stampPayment`.
Unpaid results have neither field.

```typescript
const { reference, payment, stampPayment } = await client.upload(data);
// payment: { transaction, network, payer, amount: '10000', amountDecimal: '0.01', asset }
```

| Field | Source |
|-------|--------|
| `transaction` | The gateway's `X-Payment-Transaction` header, else the `transaction` in its `X-PAYMENT-RESPONSE` (v1) or `PAYMENT-RESPONSE` (v2) receipt. Its placeholder `unknown` is never reported |
| `network`, `payer` | The receipt. `network` falls back to the network the SDK signed for |
| `amount` | What the SDK signed, in the token's smallest unit (integer string): v1 `maxAmountRequired`, v2 `amount`. The gateway's receipt has no amount |
| `amountDecimal` | `amount` in tokens, using the policy's decimals (6 for USDC) |
| `asset` | The token contract `amount` is in |
| `replayed` | `true` when the gateway replayed the first result for the Idempotency-Key (see below) |

A browser can read the receipt headers only if the gateway exposes them through CORS. Without
them, `payment` has the signed amount but no `transaction`, `payer` or `replayed`. No `payment`
is reported when the gateway says it answered on the free tier (`X-Payment-Mode: free-tier`) or
its receipt reports `success: false`. Errors after a payment carry the same fields on
`error.payment`. The transaction is set whenever the gateway sent one (header, or the body's
`transaction`, at the top level or in `detail`). Network, payer and amount are set only when the
gateway sent a receipt header: without one the SDK cannot tell whether the payment settled.

When `upload()` took its stamp from the pool and then failed, the error also carries `stampId`
(the stamp it acquired) and, if that stamp was paid for, `stampPayment` (its receipt). This holds
even when the failed request paid nothing itself, such as a `PaymentRefusedError` for the upload:
`error.payment` is then unset, and the message says to pass `stampId` to reuse the paid stamp.

**Retrying without paying twice.** Paid writes carry an `Idempotency-Key`: one random key per
`upload()` or `acquireStamp()` call, or yours (`idempotencyKey` option, 1-255 printable ASCII
characters). A retry with the same key, from the same wallet, within 24 hours, for the same
request is not charged a second time: the gateway returns the first result. For an upload "the
same request" includes the stamp, so a retry must pass the stamp the first attempt used. To
retry an upload that failed after paying (a timeout, a 502), pass both from the error; its
message also names them:

```typescript
import { ProvenanceError, PaymentOutcomeError } from '@datafund/swarm-provenance';

try {
  await client.upload(data);
} catch (error) {
  // PaymentOutcomeError needs a person, not a retry (see below)
  if (
    error instanceof ProvenanceError &&
    !(error instanceof PaymentOutcomeError) &&
    error.code !== 'IDEMPOTENCY_KEY_REUSED' &&
    error.payment?.idempotencyKey
  ) {
    const { idempotencyKey, stampId } = error.payment;
    await client.upload(data, { idempotencyKey, ...(stampId ? { stampId } : {}) });
  }
}
```

The SDK retries by itself only when the gateway asks for it (`IDEMPOTENCY_KEY_IN_PROGRESS` after
`Retry-After`, capped at 30 s; `IDEMPOTENCY_UNAVAILABLE`), signing a new authorization each time
(so `onBeforePayment` runs again), at most 3 signatures per request (an upload that also pays
for its pool stamp, with `payForPool`, makes two paid requests). When the gateway returns the
first result for a key, the response carries `Idempotent-Replayed: true` and `payment.replayed`
is `true`. The charge is then the first attempt's, named by `payment.transaction`.
`payment.amount` describes the retry's own signed authorization, which the gateway did not
settle. Browsers cannot read this header, so `replayed` is set in Node only. The gateway does not charge
those retries, nor `IDEMPOTENCY_KEY_REUSED` (the key was used for a different request: the
upload changed, or its stamp did) and `IDEMPOTENCY_KEY_INVALID`. Three answers need a person and throw `PaymentOutcomeError` instead:

| `code` | `outcome` | What to do |
|--------|-----------|------------|
| `IDEMPOTENCY_KEY_SETTLEMENT_UNKNOWN` | `unknown` | The payment may or may not have been collected: check `payment.nonce` on-chain before paying again |
| `IDEMPOTENCY_KEY_SETTLED_PENDING` | `settled_not_delivered` | Paid (`payment.transaction`), result not available: ask the gateway operator for it or a refund |
| `IDEMPOTENCY_KEY_DELIVERED_NOT_STORED` | `delivered` | It worked and was paid once; the gateway kept no copy of the response. Do not pay again |

An attempt that may pay is bounded by `paidTimeout` (default 120 s, or `timeout` if longer),
not `timeout`: settlement happens on-chain. Tested with `@x402/*` 2.5.0 to 2.28.x.
x402 mode needs Web Crypto (`globalThis.crypto`): Node.js 20+, or Node 18 with it installed.

**Server (Node.js):** load the key from the environment or a secret store, never from source code:

```typescript
import { ProvenanceClient } from '@datafund/swarm-provenance';
import { createWalletClient, http, publicActions } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const key = process.env.PAYER_PRIVATE_KEY;
if (!key?.startsWith('0x')) throw new Error('Set PAYER_PRIVATE_KEY (0x-prefixed hex)');

const wallet = createWalletClient({
  account: privateKeyToAccount(key as `0x${string}`),
  chain: baseSepolia,
  transport: http(),
}).extend(publicActions);

const client = new ProvenanceClient({
  // Optionally also pin the recipient: payTo: ['<the gateway operator's payout address>']
  payment: { wallet, maxAmount: '0.10' },
});

// Requests that receive 402 responses are paid in USDC, within the policy
const result = await client.upload('Hello, World!');
```

**Browser:** use the user's injected wallet. Never put a private key in browser code:
anything shipped to the browser is public.

```typescript
import { ProvenanceClient } from '@datafund/swarm-provenance';
import { createWalletClient, custom, publicActions, type EIP1193Provider } from 'viem';
import { baseSepolia } from 'viem/chains';

const provider = (window as { ethereum?: EIP1193Provider }).ethereum;
if (!provider) throw new Error('No injected wallet found');

const walletClient = createWalletClient({ chain: baseSepolia, transport: custom(provider) });
const [account] = await walletClient.requestAddresses();
// The payment authorization is signed for the payment network: put the wallet on it
try {
  await walletClient.switchChain({ id: baseSepolia.id });
} catch (error) {
  // 4902: the wallet does not know the chain yet (some wallets nest the code)
  const e = error as { code?: number; cause?: { code?: number } };
  if ((e.code ?? e.cause?.code) !== 4902) throw error;
  await walletClient.addChain({ chain: baseSepolia });
  await walletClient.switchChain({ id: baseSepolia.id }); // not every wallet switches on add
}

const wallet = createWalletClient({
  account: account!,
  chain: baseSepolia,
  transport: custom(provider),
}).extend(publicActions);

const client = new ProvenanceClient({ payment: { wallet } });
```

Payment modes:
- `'free'` (default) — sends `X-Payment-Mode: free` header, rate-limited
- `'none'` — no payment header, gets raw 402 responses
- `{ wallet, maxAmount?, payTo?, ... }` — automatic x402 USDC payments via `@x402/fetch`, within the payment policy above

### Blockchain Anchoring

Requires `viem` (an optional peer dependency, not installed automatically): `npm install viem`.

```typescript
import { ChainClient, fromPrivateKey } from '@datafund/swarm-provenance/chain';

// Read-only (no wallet needed)
const chain = new ChainClient({ chain: 'base-sepolia' });
const exists = await chain.verifyOnChain(contentHash);
const record = await chain.getDataRecord(contentHash);

// With wallet (browser)
import { fromEip1193Provider } from '@datafund/swarm-provenance/chain';
const signer = await fromEip1193Provider(window.ethereum);
const chain = new ChainClient({ chain: 'base-sepolia', signer });
const result = await chain.anchor(contentHash, 'dataset');

// With private key (Node.js only; load it from the environment or a secret store)
const signer = await fromPrivateKey(process.env.ANCHOR_PRIVATE_KEY as `0x${string}`, 'https://base-sepolia-rpc.publicnode.com');
const chain = new ChainClient({ chain: 'base-sepolia', signer });
await chain.anchor(contentHash, 'dataset');
```

## Features

- **Simple API**: High-level `upload()` and `download()` methods handle the full workflow
- **Automatic stamp management**: Acquires stamps from the pool automatically
- **Notary signing**: Optional gateway signature (EIP-191) over the data hash and a timestamp; `download()` verifies it against the notary address (see [What `verified` means](#what-verified-means))
- **Content check**: Automatic SHA-256 check on download (self-consistency only, see [Security model](#security-model))
- **Blockchain anchoring**: Register data hashes on-chain for immutable provenance
- **Browser + Node.js**: Works in both environments with native `fetch`
- **TypeScript first**: Full type definitions included

## Security model

What the SDK checks, and what it does not:

- **`content_hash`** is recomputed on every download. It is a self-consistency check: it proves
  the content matches the hash stored next to it in the same response, so it detects
  corruption. It does not prove who wrote either (anyone can compute it), and it does not bind
  the data to the Swarm reference you asked for: a gateway, or anyone between you and an `http`
  gateway URL, can return a different document whose hash matches its own content. Use
  `https`, notary signatures and on-chain anchors for those guarantees.
- **Notary signatures** prove that the notary key signed this exact `data` together with a
  timestamp. The timestamp is the gateway's claim, not independent proof of time: whoever
  holds the notary key can sign any timestamp. For time you can verify, anchor the hash
  on-chain. By default the expected notary address comes from the gateway that served the
  document; pass `notaryAddress` to `download()` to verify independently of the gateway.
  See [What `verified` means](#what-verified-means).
- **On-chain anchoring** (`/chain`) proves that an address registered a hash at a block time.
  It does not prove anything about content the hash was not computed from.
- **Keys:** in browsers use the injected wallet: `fromEip1193Provider(window.ethereum)` for
  `/chain` writes, and a viem wallet client over `custom(window.ethereum)` for x402 payments
  (see [x402 Payment Mode](#x402-payment-mode)). On servers load keys from the environment or a
  secret store. A private key in browser code is public.
- **Default gateway is production:** `https://provenance-gateway.datafund.io`. Pass
  `gatewayUrl` to use another (e.g. `https://provenance-gateway.dev.datafund.io` for testing).
- **Data expires.** Swarm storage is rented: data stays available only while the postage stamp
  it was uploaded with is valid. Pool stamps come with roughly a day left; extend the stamp
  through the gateway (`PATCH /api/v1/stamps/{id}/extend`) if you need it longer. A Swarm
  reference is not a permanent archive.

## API

### `ProvenanceClient`

```typescript
const client = new ProvenanceClient({
  gatewayUrl?: string,          // default: https://provenance-gateway.datafund.io
  timeout?: number,             // default: 30000ms
  paidTimeout?: number,         // attempts that may pay (x402): default 120000ms, or timeout if longer
  payment?: PaymentMode,        // default: 'free' (see x402 Payment Mode)
  retry?: GatewayRetryConfig,   // auto-retry unpaid 502/503, and rate-limit 429s outside the free tier (default: 2 retries, 1s backoff)
  maxUploadBytes?: number,      // largest upload sent, in bytes of metadata JSON (default: 10485760)
});
```

`maxUploadBytes` matches the gateway's default upload limit (`MAX_UPLOAD_SIZE_MB` = 10).
The limit applies to the metadata JSON the SDK sends, with the content base64-encoded,
so the largest content that fits is 7864191 bytes (7.5 MiB); a raw document (`raw: true`)
can be about 10 MiB of JSON. A larger upload throws `ProvenanceError` with code
`FILE_TOO_LARGE` before any request, so no stamp is acquired for it. Set `maxUploadBytes`
for a gateway with another limit; it must be a positive integer.

### Upload

```typescript
const result = await client.upload(content, {
  sign?: 'notary',                         // Enable notary signing
  standard?: string,                       // Provenance standard identifier
  stampId?: string,                        // Use existing stamp (skip pool)
  poolSize?: 'small' | 'medium' | 'large', // Pool size preset
  contentType?: string,                    // Content type
  raw?: boolean,                           // Upload a JSON document without base64 wrapping
  idempotencyKey?: string,                 // x402 mode: see "Retrying without paying twice"; not with ownerSigner
  ownerSigner?: OwnerSigner,               // Upload to your own stamp without paying (see below)
});

// Returns:
// {
//   reference: string,           // Swarm hash
//   metadata: ProvenanceMetadata,
//   expiresAt?: string,          // when the stamp runs out (ISO 8601, UTC), if the gateway knows
// }
```

### Owner-proof uploads

On a gateway with x402 on, a stamp bought with a payment belongs to the paying wallet.
Only that wallet may upload to it. Without an owner proof you prove ownership by paying
for the upload from that wallet, which costs at least the gateway's minimum price
(`minPriceUsd` from `pricing()`, $0.01 by default). An owner proof proves it with a signature instead,
so the upload is free.

Pass the stamp and a signer that owns it. The x402 payment wallet works as the signer:

```typescript
const client = new ProvenanceClient({ payment: { wallet } });

// stampId: the stamp this wallet bought, 64 hex characters without 0x
const result = await client.upload(content, { stampId, ownerSigner: wallet });
```

`ownerSigner` is any object with viem's `signMessage({ message })`: a viem `WalletClient`
with an account (including a browser wallet on `custom(window.ethereum)`), or a
`LocalAccount` from `privateKeyToAccount`.

How it works:

- The SDK signs `swarm-connect-owner-upload:<stampId in lowercase>:<unix seconds>` with
  EIP-191 `personal_sign`. It sends the signature and the timestamp as `X-Owner-Signature`
  and `X-Owner-Timestamp`, with `X-Payment-Mode: free`. `ownerProofMessage(stampId, timestamp)`
  returns this text if you sign elsewhere.
- An owner-proof upload never pays, in any payment mode. It uses the free tier, so the
  free-tier rate limit applies. If the gateway's free tier is off, the gateway answers
  402 and the upload fails with a `GatewayConnectionError` (status 402). The SDK does not fall
  back to paying. To pay instead, upload without `ownerSigner` from the owner wallet.
- The gateway accepts a proof only if its timestamp is within 300 seconds of the
  gateway's clock, in either direction. If your clock is off by more than that, the proof is rejected.
- The gateway accepts each proof once. The SDK signs a new proof for every request
  attempt, including automatic retries. A browser wallet therefore asks you to sign once
  per attempt.
- Each attempt is bounded by one timer, `paidTimeout` (default 120 s), because a person may
  be approving a wallet prompt. The same timer covers the wallet prompt and the upload, so
  time spent approving comes out of the time left for the upload. If the signer does not
  answer in time, `upload()` throws `GatewayConnectionError` (`TIMEOUT`) and sends nothing.
- The timestamp is chosen before the wallet prompt opens. The gateway refuses a timestamp
  more than 300 seconds old, and the timestamp can already be up to 30 seconds ahead of the
  clock (see below). With a `paidTimeout` above about 270 seconds, a slow approval can
  therefore end in 401 `OWNER_PROOF_INVALID` because the proof is stale. For owner-proof
  uploads, keep `paidTimeout` at or below 270000 ms.
- Signing is deterministic, so two proofs for the same stamp, signer and second are
  identical, and the gateway refuses the second. A client therefore gives every proof
  for a stamp and signer a later timestamp than the one before, including concurrent
  uploads. A burst can run this timestamp ahead of the clock. Once it is more than 30
  seconds ahead, the upload waits for the clock. Separate clients or processes do not
  share this state: if they sign for the same stamp in the same second, the second upload
  gets `OWNER_PROOF_INVALID`. Use one client per stamp owner.
- One client signs at most one proof per second for each stamp, up to 30 seconds ahead of
  the clock. Uploads in a larger burst wait for the clock, and they can time out:
  `upload()` then throws `TIMEOUT` with a message that says it was waiting for the clock.
  Limit the number of concurrent owner-proof uploads to each stamp.
- If the free-tier rate limit is reached, `upload()` throws `PaymentRateLimitError` in every
  payment mode, without retrying. Wait for `retryAfterSeconds`, or in x402 mode upload
  without `ownerSigner` to pay instead.
- A proof lets whoever holds it make one upload to your stamp. The SDK never puts it in an
  error message. Do not log it.
- `ownerSigner` requires `stampId`. Without one, or with one that is not 64 hex characters,
  `upload()` throws `ProvenanceError` (`INVALID_INPUT`) before signing anything.
- `ownerSigner` cannot be combined with `idempotencyKey`. The upload is not paid, so the
  gateway does not use the key, and `upload()` throws `INVALID_INPUT` before signing anything.
- If the signer fails (for example, the user rejects the request) or returns anything other
  than a 0x-prefixed hex string, `upload()` throws `OWNER_PROOF_FAILED` and sends nothing.

| Gateway answer | Error | Meaning |
|----------------|-------|---------|
| 401 `OWNER_PROOF_INVALID` | `GatewayConnectionError` | Proof missing a header, stale or in the future, signed before the gateway restarted, already used, or not a valid signature |
| 403 `STAMP_OWNERSHIP_DENIED` | `GatewayConnectionError` | Valid proof, but the signer does not own the stamp |

With `sign: 'notary'` these errors are `NotaryError` with the same code. The SDK has no
manifest upload method, so owner proofs apply to `upload()` only.

### Pricing

`pricing()` returns the gateway's price for each paid operation, without paying
(`GET /api/v1/pricing`):

```typescript
const prices = await client.pricing({
  size?: 'small' | 'medium' | 'large', // stamp size preset
  depth?: number,                      // stamp depth, 16-32
  durationHours?: number,              // stamp duration, at least 24
  uploadBytes?: number,                // upload body size in bytes (gateway default: 4096)
  mb?: number,                         // bandwidth credit top-up in MB
});
// => {
//   x402Enabled: boolean,
//   currency?: 'USDC', network?: string, asset?: string, payTo?: string,
//   minPriceUsd?: number, freeTier?: { enabled: boolean, header: string },
//   quotes: { stampPurchase?, poolAcquire?, dataUpload?, bandwidthCredit? },
// }
// Each quote: { method, path, priceUsd: number, maxAmountRequired: string, description }
```

- Only the options you set are sent. The gateway validates them: an out-of-range value
  throws `GatewayConnectionError` with status 422 (codes `FILE_TOO_LARGE`, `TOPUP_TOO_LARGE`, or a
  validation message). If the chain price is unavailable, it throws status 503 `PRICING_UNAVAILABLE`.
- `maxAmountRequired` is the amount the 402 would ask for, in the asset's smallest unit
  (USDC has 6 decimals). Quotes follow the chain price, so treat them as current, not guaranteed.
- `poolAcquire` and `bandwidthCredit` appear only when the gateway offers them. There are
  no quotes for stamp extension, purchases for another owner, or manifests.
- When x402 is off on the gateway, the result is `{ x402Enabled: false, quotes: {} }`.

`payTo` can seed the payment policy, so the SDK pays only the gateway's own address:

```typescript
const prices = await new ProvenanceClient().pricing({ uploadBytes: 2048 });
if (!prices.x402Enabled || !prices.payTo) throw new Error('This gateway does not charge');
console.log(`An upload costs $${prices.quotes.dataUpload?.priceUsd}`);

const client = new ProvenanceClient({ payment: { wallet, payTo: [prices.payTo] } });
```

Read `payTo` from a gateway you trust. A policy seeded from a gateway's own answer
cannot detect a gateway that lies about its address.

### Download

```typescript
const result = await client.download(reference, {
  verify?: boolean,         // Verify notary signatures (default: true)
  notaryAddress?: string,   // Notary to trust; default: the address the gateway reports
});

// Returns:
// {
//   file: Uint8Array,            // Decoded content
//   metadata: ProvenanceMetadata,
//   verified?: boolean,          // see "What verified means" below
//   verification?: SignatureVerification,  // expected signer, its source, per-signature results
//   signatures?: NotarySignature[],
// }
```

`reference` must be 64 hex characters, or 128 for an encrypted reference, with an optional
`0x` prefix (removed before the request). Any other value throws `ProvenanceError`
(`INVALID_INPUT`) before a request is sent. `downloadDocument()` applies the same check.

#### What `verified` means

`verified: true` means at least one signature on the document is an EIP-191 signature
that recovers to the expected notary address over `sha256(canonical JSON of data) | timestamp`
(the gateway's scheme). Each such signature binds the exact data on its own; other
signatures (an uploader's own, or one by an earlier notary key, which the gateway keeps
when it appends its signature) do not affect it, and every signature's result is in
`verification.results`. It fails closed: if no signature is a valid one by the expected
notary (empty, missing or malformed signatures, other keys, changed data, or no expected
address), `verified` is `false`. It is `undefined` when the document carries no signatures
or with `verify: false`, so check `verified === true` rather than `!== false`.
A malformed `notaryAddress` throws `ProvenanceError` (`INVALID_INPUT`).

The expected address is `notaryAddress` if you pass it, otherwise the one the gateway
reports at `/api/v1/notary/info` (`verification.expectedSignerSource` says which). The
default therefore trusts the gateway that served the document; pin `notaryAddress` to
verify independently of it.

Canonical JSON is the convention shared with the gateway and the Python tools:
`json.dumps(data, sort_keys=True, separators=(',', ':'))`. It is also what `content_hash`
covers for raw documents (`raw: true`); documents from SDK 0.6.x, which hashed
`JSON.stringify(data)`, still pass the content-hash check. `content_hash` alone proves
nothing about who wrote the data: anyone can compute it.

### Other Methods

```typescript
// Health check: false if unreachable, an error status, or status 'critical'
await client.health(); // => boolean

// Notary info
await client.notaryInfo();
// => { enabled: boolean, available: boolean, address?: string }

// Pool status
await client.poolStatus();
// => { enabled: boolean, available: Record<string, number>, reserve: Record<string, number> }

// Acquire stamp directly
await client.acquireStamp('small');
// => { batchId: string, depth: number, sizeName: string, fallbackUsed: boolean, expiresAt?: string }

// Price quotes for paid operations (see Pricing)
await client.pricing({ uploadBytes: 2048 });
```

## Error Handling

```typescript
import {
  ProvenanceError,
  GatewayConnectionError,
  StampError,
  NotaryError,
  VerificationError,
  PaymentError,
  PaymentConfigurationError,
  PaymentRateLimitError,
} from '@datafund/swarm-provenance';

try {
  await client.upload(content);
} catch (error) {
  if (error instanceof PaymentRateLimitError) {
    console.error('Rate limited, retry after:', error.retryAfterSeconds, 'seconds');
  } else if (error instanceof PaymentConfigurationError) {
    console.error('Missing @x402 packages:', error.message);
  } else if (error instanceof StampError) {
    // error.code may be 'POOL_EXHAUSTED' when pool is empty
    console.error('Stamp acquisition failed:', error.message);
  } else if (error instanceof GatewayConnectionError) {
    console.error('Gateway error:', error.statusCode, error.code, error.message);
    if (error.suggestion) {
      console.error('Suggestion:', error.suggestion);
    }
  }
}
```

Errors from a gateway response carry the gateway's `code` (for example
`DAILY_STAMP_ALLOWANCE_EXHAUSTED`) and its message, cut to 4096 characters. `error.body` is
the response body: the parsed JSON when its text is at most 16384 characters, otherwise its
text cut to 4096 characters, and for a body that is not JSON its text, also at most 4096
characters. A cut text ends in `…`, which counts toward the 4096. Characters are UTF-16
code units, as JavaScript counts string length; a cut never splits a surrogate pair. A 402 message names the price asked, for
example `0.01 USDC on base-sepolia`: at most three options, then how many more (all are in
`error.body`). The gateway's message is cut to leave room for the price, so both fit
within the 4096-character cap. A signature declined in the wallet throws
`PaymentRefusedError` (`PAYMENT_REFUSED`).

How a 429 is handled depends on its code and on the request:

| 429 | `'free'` mode, and unpaid reads in x402 mode | `'none'` mode, and x402 writes |
|---|---|---|
| A rate limit: `RATE_LIMIT_EXCEEDED`, `HTTP_429` (the free tier), or no code | `PaymentRateLimitError` after one request, not retried | Retried up to `retry.maxRetries` times, waiting `Retry-After` when sent; then the gateway error with its code (`StampError` from `acquireStamp()` and `upload()`'s pool acquisition, else `GatewayConnectionError`) |
| Any other code, such as `DAILY_STAMP_ALLOWANCE_EXHAUSTED` (a quota) | The gateway error with its code, at once | The gateway error with its code, at once |

A request that sent a payment is never retried for a 429.

## Advanced Usage

### Low-level utilities

```typescript
import {
  buildMetadata,
  extractContent,
  verifyContentHash,
  sha256Hex,
  bytesToBase64,
  base64ToBytes,
} from '@datafund/swarm-provenance';

// Build metadata manually
const metadata = buildMetadata(content, {
  stampId: 'my-stamp',
  standard: 'v1',
});

// Extract and verify
const originalContent = extractContent(metadata);
const isValid = verifyContentHash(metadata);
```

### Signature verification

```typescript
import {
  verifySignature,
  verifyAllSignatures,
} from '@datafund/swarm-provenance';

const result = verifySignature(signature, metadata, expectedSigner);
// => { valid, dataHashValid, signerValid?, recoveredAddress?, error? }
// valid is false without an expectedSigner. For raw documents with floats or
// integers beyond 2^53, pass the canonical text of `data` as a 4th argument:
// canonicalizeJsonText(responseText, ['data']), or ['metadata', 'data'] for a
// wrapped {metadata: {...}, signatures: [...]} response.
```

## Blockchain Anchoring (`/chain`)

The chain module provides on-chain data provenance via a DataProvenance smart contract. It uses [viem](https://viem.sh) as an optional peer dependency (see [Installation](#installation)).

### `ChainClient`

```typescript
import { ChainClient } from '@datafund/swarm-provenance/chain';

const chain = new ChainClient({
  chain: 'base-sepolia',     // or a custom ChainPreset ('base' exists but has no contract yet: it throws)
  rpcUrl?: string,            // override RPC endpoint; a URL outside the preset's list disables its fallbacks
  rpcFallbacks?: string[],    // tried in order on any error but a revert; defaults to the preset's, [] disables
  signer?: ChainSigner,       // required for write operations
  retry?: RetryConfig,        // auto-retry on "nonce too low/high" (default: 2 retries, 1s backoff)
});
```

Reads fail over to the next RPC URL on any error except a contract revert or a user rejection
(that includes HTTP 4xx such as 401/429, so a bad API key on your primary is masked by the
fallbacks; check `healthCheck()` against a client built with `rpcFallbacks: []` if that matters).
With fallbacks the list is tried at most twice per call (a single URL keeps viem's default 3 retries).
`chain: 'base-sepolia'` (or `chain: BASE_SEPOLIA`) tries `base-sepolia-rpc.publicnode.com`, then `base-sepolia.gateway.tenderly.co`,
then `sepolia.base.org` (`PRESET_RPC_FALLBACKS`). Setting `rpcUrl` to one of those keeps failover to
the others; any other URL disables the preset's fallbacks, so reads meant for a private endpoint never
go to public ones. Built-in fallbacks are not on the preset objects, so a spread copy
(`{ ...BASE_SEPOLIA, rpcUrl }`) has none unless you give it `rpcFallbacks`. Presets and `CHAIN_PRESETS` are
frozen and typed `Readonly` (assigning to them was possible before; spread a copy instead).

`healthCheck()` now makes a real `eth_call` to the configured contract (previously `eth_chainId`):
it returns false for a wrong or undeployed contract address, and with fallbacks returns true if any
URL can serve the call.
Sending transactions goes through the signer's own transport and does not fail over; waiting
for the receipt uses the read client and does.

### Read Operations (no signer required)

```typescript
// Check if a hash is registered on-chain
await chain.verifyOnChain(dataHash);  // => boolean

// Get full provenance record
await chain.getDataRecord(dataHash);
// => { dataHash, owner, timestamp, dataType, status, accessors, transformationLinks }

// Get all records owned by an address
await chain.getUserDataRecords('0x...');  // => string[]
await chain.getUserDataRecordsCount('0x...');  // => number
await chain.getUserDataRecordsPaginated('0x...', 0, 10);  // => string[]

// Check if an address has accessed a hash
await chain.hasAddressAccessed(dataHash, '0x...');  // => boolean

// Check delegate authorization
await chain.isAuthorizedDelegate(owner, delegate);  // => boolean

// Transformation links and parents (v2 contract)
await chain.getTransformationLinks(dataHash);
// => TransformationLink[] ({ newDataHash, description })
await chain.getTransformationParents(dataHash);  // => string[]
await chain.getChildHashes(dataHash);  // => string[]

// Traverse full provenance chain (BFS, bidirectional)
await chain.getProvenanceChain(dataHash, 10);
// => ChainProvenanceRecord[]: ancestors + descendants up to maxDepth, in BFS order (not topological).
//    Edges: transformationLinks (children) and parents. Rejects if any lookup fails.

// The same, plus whether maxDepth cut the traversal off
await chain.getProvenanceChainResult(dataHash, 10);
// => { records, complete, truncated }: complete is false if a node at maxDepth has a parent or
//    child that was not visited (or its parents could not be looked up); truncated lists those
//    nodes. A lineage exactly maxDepth deep is complete. Costs one extra call per node at maxDepth.

// Detect v2 contract support
await chain.supportsTransformationLinks();  // => boolean

// Health check and balance
await chain.healthCheck();  // => boolean (never throws); a real eth_call to the contract, via any fallback
await chain.getBalance();  // => { address, balanceWei, balanceEth, chain }
```

### Write Operations (signer required)

```typescript
// Anchor a data hash on-chain
const result = await chain.anchor(dataHash, 'dataset');
// => { txHash, blockNumber, gasUsed, explorerUrl, dataHash, dataType, owner }

// Anchor on behalf of another owner: the owner must first have authorized the signer as a
// delegate (the owner calls setDelegate(signerAddress, true))
await chain.anchorFor(dataHash, 'dataset', ownerAddress);

// Record access
await chain.recordAccess(dataHash);
// => { txHash, blockNumber, gasUsed, explorerUrl, dataHash, accessor }

// Record 1-to-1 transformation
await chain.recordTransformation(originalHash, newHash, 'filtered PII');

// Record N-to-1 merge transformation (v2 contract)
await chain.mergeTransform(
  [sourceHash1, sourceHash2],
  mergedHash,
  'combined datasets',
  'merged',  // data type (default: 'merged')
);

// Set data status (ACTIVE=0, RESTRICTED=1, DELETED=2)
import { DataStatus } from '@datafund/swarm-provenance/chain';
await chain.setDataStatus(dataHash, DataStatus.RESTRICTED);

// Transfer ownership
await chain.transferOwnership(dataHash, newOwnerAddress);

// Manage delegates
await chain.setDelegate(delegateAddress, true);   // authorize
await chain.setDelegate(delegateAddress, false);  // revoke

// Batch operations
await chain.batchAnchor([
  { dataHash: hash1, dataType: 'dataset' },
  { dataHash: hash2, dataType: 'model' },
]);
await chain.batchRecordAccess([hash1, hash2]);
await chain.batchSetDataStatus([
  { dataHash: hash1, status: DataStatus.RESTRICTED },
]);
```

**Input checks.** Writes refuse, with `ChainValidationError` and before any network call, input
the contract would revert on: a zero data hash or merge source hash; a data type that is empty
or over 64 UTF-8 bytes (a data type of only whitespace is refused too: stricter than the
contract, which requires only a non-empty byte string); a transformation description that is empty or over 256 UTF-8 bytes; a `storageRef` equal
to its data hash, or an encrypted (128 hex) Swarm reference, which does not fit the contract's
`bytes32`; duplicate hashes or storage references in one `batchAnchor()` call; duplicate merge
sources, or a merge's new hash among its sources; a transformation from a hash to itself; a
status other than 0, 1 or 2; a hash repeated in one `batchSetDataStatus()` call with the status
its previous entry in that call already sets; the zero address as owner, new owner or delegate;
and the signer's own address as new owner, delegate, or `anchorFor()` owner (use `anchor()` to
register for yourself). The signer checks run after the chain check, still before sending.
Addresses, in reads and writes, may be all lowercase, all uppercase or EIP-55 checksummed; a
mixed-case address with a wrong checksum is refused (`ChainValidationError`, or
`ChainConfigurationError` for `contractAddress`). All-uppercase is sent in lowercase, and results
echo the address as sent.

### Signer Factories

```typescript
import {
  fromEip1193Provider,
  fromPrivateKey,
  fromViemWalletClient,
} from '@datafund/swarm-provenance/chain';

// Browser wallet (MetaMask, etc.)
const signer = await fromEip1193Provider(window.ethereum);

// Private key (Node.js / scripts; from the environment, never hard-coded)
const signer = await fromPrivateKey(process.env.ANCHOR_PRIVATE_KEY as `0x${string}`, 'https://base-sepolia-rpc.publicnode.com');

// Existing viem WalletClient
const signer = fromViemWalletClient(walletClient);
```

`fromPrivateKey` is not exported to browser builds: the `/chain` entry has a `browser` export
condition that points to a build without it, so a bundler that targets the browser fails with
"No matching export" instead of shipping code that expects a raw key. Node `import` and
`require` are unchanged. TypeScript applies the condition only with
`customConditions: ["browser"]`; otherwise the editor still offers `fromPrivateKey`.

### Chain Error Handling

```typescript
import {
  ChainConfigurationError,
  ChainTransactionError,
  DataAlreadyRegisteredError,
  ReceiptTimeoutError,
  SignerRequiredError,
} from '@datafund/swarm-provenance/chain';

try {
  await chain.anchor(hash, 'dataset');
} catch (error) {
  if (error instanceof SignerRequiredError) {
    console.error('Connect a wallet first');
  } else if (error instanceof DataAlreadyRegisteredError) {
    // anchor()/anchorFor(): the hash is registered. Check whose record it is before
    // treating it as done: ownedBySigner is false if another address owns it, and
    // undefined if the owner could not be read (error.owner is then '')
    if (error.ownedBySigner !== true) console.error('Registered by', error.owner || 'unknown owner');
  } else if (error instanceof ChainConfigurationError) {
    // Before anything was sent: wrong chain (RPC or wallet), or no contract at the address
    console.error(error.message);
  } else if (error instanceof ReceiptTimeoutError) {
    // Sent, but no receipt yet: it may still confirm. Do not resend; resume instead.
    // (If the tx was sped up and the original has left the mempool, viem cannot
    // see the replacement: look up the new hash in the wallet and wait on that.)
    await chain.waitForTransaction(error.txHash as `0x${string}`, error.expected);
  } else if (error instanceof ChainTransactionError) {
    // Reverted, or succeeded without the contract's event (nothing recorded); error.txHash is set
    console.error('Transaction failed:', error.message);
    // error.originalError has the full viem error (not enumerable: it may contain the RPC URL)
  }
}
```

**Write safety.** Before the first write a client checks that its RPC is on the preset's chain
and that the contract address holds code; before every write it checks the signer's chain
(`fromEip1193Provider` asks the wallet to switch, adding the chain if it does not know it, and sends with `chainId` so the wallet refuses another network). A write counts as done only if the receipt
contains the contract's event (`DataRegistered`, `DataAccessed`, ...; one per item for batch
writes); a transaction sped up in the wallet reports the hash that landed, a cancelled one is an error. Pre-checks that fail on an RPC error are reported, not skipped. Chain error messages
never include RPC URLs (they often embed API keys).

### Troubleshooting: `Cannot find package 'viem'`

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'viem' imported from .../@datafund/swarm-provenance/dist/chain/index.js
```

The `/chain` entry point needs the optional peer dependency `viem`, which npm does not install
automatically. Fix: `npm install viem` (>= 2.0.0). The CommonJS build (`require`) says this
directly. The ESM build cannot: Node resolves every `import` before any SDK code runs, so the
message comes from Node itself.

### Supported Networks

| Network | Preset | Contract | RPC (primary, then fallbacks) |
|---------|--------|----------|-------------------------------|
| Base Sepolia (testnet) | `base-sepolia` | `0x3945aDfd5Df9ab2F5cB4Ca0eb3D4384CC3650322` | publicnode → tenderly → sepolia.base.org |
| Base (mainnet) | `base` | Not yet deployed: `new ChainClient({ chain: 'base' })` throws `ChainConfigurationError` | mainnet.base.org |

### Behavior changes since v0.6.1

- `download()` and `downloadDocument()` validate `reference` before the request (#123). It must
  be 64 or 128 hex characters with an optional `0x` prefix, which is removed. Other values
  (paths, queries, whitespace, wrong lengths) throw `ProvenanceError` (`INVALID_INPUT`)
  instead of being sent to the gateway. `isValidSwarmReference()` now accepts 128-character
  encrypted references and the `0x` prefix.
- A `Retry-After` header given as an HTTP date is honoured (#123): the RFC 9110 forms only
  (IMF-fixdate such as `Sun, 06 Nov 1994 08:49:37 GMT`, and the obsolete RFC 850 and asctime
  forms), always read as GMT. Before, it was read as `NaN`:
  the 429 retry (`payment: 'none'` and x402 mode) did not wait, and
  `PaymentRateLimitError.retryAfterSeconds` was `NaN`. A value that is neither seconds nor a
  date now falls back to the normal backoff. This includes a non-integer value such as `"1.5"`:
  RFC 9110 allows only whole delta-seconds. Before, `parseInt` read it as 1 second.
- Chain writes no longer retry a send that fails with "replacement underpriced" (#123): a
  transaction with that nonce is already pending, and a resend could write twice. That error and
  "already known" now throw `ChainTransactionError` with "Transaction not confirmed: ... It may
  still confirm ... do not resend" instead of "Transaction failed". Check the wallet's pending
  transactions before sending again.
- `fromPrivateKey` signers return the transaction hash when the node answers "already known"
  (#123): the node already holds that signed transaction, so the write proceeds to wait for its
  receipt instead of failing. The signer now prepares, signs and sends the raw transaction itself,
  the same steps viem's `sendTransaction` takes for a local account (same nonce, gas and fee
  handling, still signed for the preset's chain ID).
- `DataAlreadyRegisteredError` has `ownedBySigner` (new, optional; #123): `true` if the
  registered owner is the signer's address, `false` if another address owns the record,
  `undefined` if the owner could not be read. For `anchorFor()`, compare `error.owner` with the
  owner you passed.
- `getProvenanceChain()` fails closed: an RPC error on any node rejects the call with
  `ChainConnectionError` naming the node, and a linked hash that reads as unregistered
  rejects with `DataNotRegisteredError`. Before, either case silently dropped the branch
  and returned the partial graph as if complete.
- `getProvenanceChain()` rejects a `NaN` `maxDepth` (`ChainValidationError`); before, NaN
  disabled the depth limit. Fractional depths are floored.
- Records from `getProvenanceChain()` carry `parents` (new, optional; additive).
- Chain input checks (#123): the writes listed under "Input checks" now throw
  `ChainValidationError` before any network call, instead of sending a transaction that the
  contract reverts. `mergeTransform()` now validates `newDataType` like the other data types:
  empty, whitespace-only or over 64 UTF-8 bytes is refused. Whitespace-only is stricter than the
  contract, which accepts it; `anchor()`, `anchorFor()` and `batchAnchor()` already refused it.
  `getUserDataRecordsPaginated()` throws `ChainValidationError` for a negative or non-integer
  `offset` or `limit` (was a mislabelled `ChainConnectionError`). `new ChainClient()` throws
  `ChainConfigurationError` for a malformed `contractAddress` or a `gasLimit` that is not a
  positive integer. Reads such as `verifyOnChain()` still accept the zero hash. A mixed-case
  address with a wrong EIP-55 checksum now throws `ChainValidationError` before any network
  call (it used to reach viem and throw a raw `InvalidAddressError`); an all-uppercase address,
  which viem rejected, is now accepted and passed to viem in lowercase. Result fields that echo an
  input address (`anchorFor().owner`, `transferOwnership().newOwner`, `setDelegate().delegate`)
  hold the address that was sent: an all-uppercase input comes back in lowercase, other
  spellings unchanged.
- `fromPrivateKey` is not exported to browser builds (#123). `@datafund/swarm-provenance/chain`
  now has a `browser` export condition, listed first, that resolves to a build without
  `fromPrivateKey`; importing it there fails at bundle time ("No matching export"). Node
  `import`/`require` resolution is unchanged. **Any runtime or bundler that resolves the
  `browser` export condition gets the build without `fromPrivateKey`**, also for server code.
  Examples are Cloudflare Workers and esbuild with `platform: 'browser'`. Code built that way
  must create a viem wallet client with `privateKeyToAccount` and pass it to
  `fromViemWalletClient` instead.
  TypeScript does not apply the `browser` condition unless `customConditions: ["browser"]` is
  set in `tsconfig.json`. Without it, your editor still shows `fromPrivateKey` in browser code,
  and only the bundler reports the error.
- `getProvenanceChainResult()` (new; #123) returns `{ records, complete, truncated }`, so you can
  tell a lineage cut off by `maxDepth` from a whole one. A node at `maxDepth` counts as truncated
  only if it has a parent or child that was not visited, or its parent lookup fails.
  `getProvenanceChain()` is unchanged.
- `healthCheck()` makes a real `eth_call` to the configured contract instead of `eth_chainId`
  (false for a wrong contract address; true if any fallback RPC serves the call).
- The `base-sepolia` default RPC is `base-sepolia-rpc.publicnode.com` with fallbacks (see above);
  presets and `CHAIN_PRESETS` are frozen and typed `Readonly`.
- The CommonJS `/chain` entry throws a `CHAIN_CONFIGURATION` error naming `viem` when it is missing.
- `download()` / `downloadDocument()` verify notary signatures cryptographically (#113).
  `verified` is now `false` for documents 0.6.1 reported as verified: empty, missing or
  invalid signatures, signatures by other keys, and any document when no notary address is
  available. Results gain `verification`; `DownloadOptions` gains `notaryAddress`
  (a malformed one throws `INVALID_INPUT`).
- `verifySignature` / `verifyAllSignatures` are invalid without an expected signer;
  `verifyAllSignatures([])` gives `allValid: false` (was `true`) and now also returns
  `anyValid`. `verifyDataHash` accepts only `hashed_fields: ['data']`.
- Raw documents (`raw: true`): `content_hash` is SHA-256 of canonical JSON (the gateway and
  Python tools' convention) instead of `JSON.stringify(data)` (#114). This version still
  accepts the old form; SDK 0.6.x rejects documents uploaded with this version.
- x402 network (#108): `payment.network: 'base' | 'base-sepolia'` selects both x402 identifiers;
  a known CAIP-2 ID implies its v1 name, and a lone known `v1Network` implies `network`.
  **A config with only `network: 'eip155:8453'` now pays in mainnet USDC on the gateway's v1
  path too** (it used to pair with Base Sepolia for v1, so it never paid on mainnet). `network`
  and `v1Network` that disagree, or a lone unknown `v1Network`, are configuration errors. The
  default stays Base Sepolia.
- x402 mode enforces a payment policy (#106): `maxAmount` (default `'1'` on Base Sepolia test
  USDC, required elsewhere), USDC only (or `asset` + `assetDecimals`), `exact`/EIP-3009 only,
  validity ≤ 600 s, optional `payTo` and `onBeforePayment`. Refusals throw
  `PaymentRefusedError`. Reads use the free tier instead of being paid (`payForReads` opts
  back in), and attempts that sent a payment are not retried (#107); a failure after payment
  carries `error.payment`. On `@x402/*` 2.23+ the library's $1 default cap is
  replaced by `maxAmount` (#110). Peer range narrowed to the tested `>=2.5.0 <2.29.0`.
- Chain writes (#115-#118): `ChainSigner` requires `getChainId()` (and may implement
  `switchChain()`); writes refuse a wrong RPC or signer chain and an address without contract
  code; success requires the contract's event in the receipt (else `ChainTransactionError`
  with `txHash`); a missing receipt is `ReceiptTimeoutError` (a `ChainConnectionError`, code
  `CHAIN_CONNECTION`) with `txHash` and `expected`, resumable with `waitForTransaction()`; RPC read errors in pre-checks (already
  registered? duplicate transformation?) are thrown instead of ignored; error messages no
  longer contain RPC URLs, and `ChainTransactionError.originalError` is not enumerable.
- Paid pool acquisition is opt-in (#109): in x402 mode, `acquireStamp()` and `upload()` without
  `stampId` no longer pay for pool stamps unless `payment.payForPool` is `true`. Without it, a 402
  from `POST /api/v1/pool/acquire` is not paid and the call throws `StampError` (the gateway's
  code, or `PAYMENT_REQUIRED`). The unpaid acquisition carries no `Idempotency-Key`. In `'free'`
  and `'none'` modes, a pool 402 is still a `StampError`. Its message now also says how to
  continue, and its code is the gateway's code, or `PAYMENT_REQUIRED` where it used to have none.
- Paid writes send an `Idempotency-Key` (#102); see "Retrying without paying twice". Attempts that
  may pay use `paidTimeout` (default 120 s, or `timeout` if longer) instead of `timeout`, so a
  short `timeout` no longer cuts off a paid upload. Errors after a payment carry
  `payment.idempotencyKey` (and `payment.stampId` for uploads). The three idempotency answers
  that need a person throw `PaymentOutcomeError`, also from `acquireStamp()` and notary uploads
  (not `StampError` / `NotaryError`). Gateway error messages are read from the top-level
  `message` of the error envelope when `detail` has none.
- Paid results carry the payment receipt (#111): `payment` on `UploadResult`,
  `DocumentUploadResult` and `AcquiredStamp`, and `stampPayment` on upload results when
  `upload()` paid for its pool stamp. Errors from `upload()` after a pool acquisition carry
  `stampId` and, when the stamp was paid for, `stampPayment`. `error.payment` gains `network`, `payer`, `amount`,
  `amountDecimal` and `asset` when the gateway sent a receipt header, and `replayed` on an
  idempotent replay. All fields are new and optional. Unpaid results carry no `payment`.
- New (#124): `pricing()` returns the gateway's price quotes (`GET /api/v1/pricing`), and
  `UploadOptions.ownerSigner` uploads to a stamp you own with a signed owner proof instead of
  a payment. An owner-proof upload uses the free tier and never pays, in any payment mode.
  New exports: `Pricing`, `PricingOptions`, `PriceQuote`, `OwnerSigner`, `ownerProofMessage`.
  Uploads without `ownerSigner` are unchanged.
- Error handling (#112): gateway errors show the envelope's top-level `message` first, and
  `{detail: {error, detail}}` shows both texts. Errors gain `body` (parsed JSON, or text up to
  4096 characters; a JSON body over 16384 characters is kept as text cut to 4096
  characters), and gateway messages are cut to 4096 characters. A 402 message names the price. A 429 whose code is not a rate limit
  (`DAILY_STAMP_ALLOWANCE_EXHAUSTED`, `DAILY_STAMP_ALLOWANCE_PER_CLIENT_EXHAUSTED`,
  `DAILY_SPEND_BUDGET_EXHAUSTED`, `FREE_QUOTA_EXCEEDED`) is no longer retried, and in `'free'`
  mode is reported with its code instead of as `PaymentRateLimitError`. `health()` returns
  `false` when the gateway reports `status: 'critical'`. Upload results and `AcquiredStamp`
  gain `expiresAt`. `upload()` refuses metadata over `maxUploadBytes` (default 10485760) with
  `FILE_TOO_LARGE` before acquiring a stamp, and also refuses invalid raw input before that.
  In x402 mode the policy reads the 402's top-level payment request before the deprecated
  `detail` copy, and a signature declined in the wallet is `PaymentRefusedError` instead of
  `PAYMENT_FAILED`.
- `PaymentWallet` is a type, not an interface: it requires `address` or `account.address`.
  A viem `WalletClient` typechecks without casts; `interface X extends PaymentWallet` needs
  to become an intersection type.

### Breaking Changes in v0.5.0

The v2 contract update changes the `ChainProvenanceRecord` type:

```typescript
// Before (v0.4.x)
record.transformations  // string[]

// After (v0.5.0)
record.transformationLinks  // TransformationLink[] ({ newDataHash, description })
```

The `ChainTransformation` type is deprecated — use `TransformationLink` instead.

## Demo App

A reference React app is available at `examples/web-app/` with upload, download, notary signing, blockchain anchoring, merge transformations, and provenance chain traversal:

```bash
cd examples/web-app
pnpm install
pnpm dev
```

Open http://localhost:5173 to try the full workflow.

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Unit tests
pnpm test

# Integration tests (requires gateway / Hardhat)
pnpm test:integration

# E2E tests (Playwright)
cd examples/web-app && pnpm test

# Type check
pnpm typecheck

# Lint
pnpm lint
```

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

1. Fork the repo
2. Create a feature branch from `development` (`git checkout -b feature/my-feature development`)
3. Commit your changes
4. Push and open a PR against `development`

All PRs to `main` require a review. See the [development](#development) section for build and test commands.

## Related Projects

- [swarm_connect](https://github.com/datafund/swarm_connect) - Provenance Gateway server (Python/FastAPI)
- [swarm_provenance_CLI](https://github.com/datafund/swarm_provenance_CLI) - CLI tool (Python)
- [swarm_provenance_mcp](https://github.com/datafund/swarm_provenance_mcp) - MCP server

## License

MIT
