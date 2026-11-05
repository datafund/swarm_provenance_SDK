# API Reference

## ProvenanceClient

The main client for interacting with the Swarm Provenance Gateway.

### Constructor

```typescript
new ProvenanceClient(config?: ProvenanceClientConfig)
```

#### ProvenanceClientConfig

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `gatewayUrl` | `string` | `https://provenance-gateway.datafund.io` | Gateway URL |
| `timeout` | `number` | `30000` | Request timeout in milliseconds |
| `paidTimeout` | `number` | `120000`, or `timeout` if that is longer | Timeout in milliseconds for an attempt that may pay (x402 mode: the 402, signing, and the paid request), and for an owner-proof upload |
| `payment` | `'free' \| 'none' \| X402PaymentConfig` | `'free'` | Payment mode (see below) |
| `retry` | `{ maxRetries?, baseDelayMs? }` | `{ 2, 1000 }` | Retries on 502/503, and on 429 unless the request used the free tier (then `PaymentRateLimitError`). A 429 retry waits `Retry-After` up to 60 s; above that the error is thrown at once, with `retryAfterSeconds`. A delta-seconds value above `Number.MAX_SAFE_INTEGER` cannot be read, so the 429 is retried with the normal backoff, not thrown at once. A 429 whose code is not a rate limit (such as `DAILY_STAMP_ALLOWANCE_EXHAUSTED`) is not retried. An x402 attempt that sent a payment is not retried, except as described under X402PaymentConfig; unpaid attempts are |
| `maxUploadBytes` | `number` | `10485760` | Largest upload, in bytes of the uploaded metadata JSON. A larger upload throws `FILE_TOO_LARGE` before a stamp is acquired. With base64, that is about 7.5 MiB of content. A value that is not a positive integer throws `INVALID_INPUT` in the constructor |

#### X402PaymentConfig

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `wallet` | `PaymentWallet` | required | Signs payment authorizations (viem `WalletClient` with an account, or `toClientEvmSigner()`) |
| `network` | `'base' \| 'base-sepolia' \| CAIP-2` | `'base-sepolia'` | Network to pay on; selects both x402 identifiers. `'base'` (mainnet) requires `maxAmount` |
| `v1Network` | `string` | implied by `network` | x402 v1 name. Optional for Base and Base Sepolia: derived from `network`, given as a v1 name or a CAIP-2 ID. Required for any other chain (configuration error without it). Alone, a known name (`'base'`) also selects `network`; it must not contradict a known `network` |
| `maxAmount` | `string` | `'1'` on Base Sepolia with test USDC; **required** elsewhere | Largest single payment, in tokens (`'0.50'`) |
| `payTo` | `string[]` | any | Allowed recipients |
| `asset` | `string` | the network's USDC | Token to pay with |
| `assetDecimals` | `number` | `6`; **required** with `asset` | Decimals of `asset` |
| `assetDomain` | `{ name: string; version: string }` | known for the network's USDC; **required** with `asset` | EIP-712 domain of `asset` (its `name()` and `version()` on chain). A 402 whose `extra.name` or `extra.version` differs, or is missing, is refused |
| `maxTimeoutSeconds` | `number` | `600` | Longest authorization validity accepted |
| `onBeforePayment` | `(p: PaymentRequest) => boolean \| void \| Promise<…>` | none | Return `false` (or throw) to refuse a payment. A payment may still not follow (signing fails, timeout) |
| `payForReads` | `boolean` | `false` | Pay for GET/HEAD too; otherwise reads use the free tier |
| `payForPool` | `boolean` | `false` | Pay for pool stamps (`acquireStamp()`, and `upload()` without `stampId`) when the pool answers 402. Otherwise that 402 is not paid and the call throws `StampError`. The policy above still applies |

A payment outside this policy, of a scheme other than `exact`, or using a transfer method
other than EIP-3009 is refused before anything is signed (`PaymentRefusedError`). An invalid
config throws `PaymentConfigurationError` in the constructor. Reads use the free tier unless
`payForReads`. An attempt that sent a payment is not retried on 502, 503 or 429; unpaid attempts
retry as usual. The one exception is a paid write that the gateway answers with 409
`IDEMPOTENCY_KEY_IN_PROGRESS` or 503 `IDEMPOTENCY_UNAVAILABLE` (#102). The SDK retries it with
the same Idempotency-Key and a new authorization, so `onBeforePayment` runs again. It does this
at most 2 times, so at most 3 signatures per request. For `IDEMPOTENCY_KEY_IN_PROGRESS` it
waits for `Retry-After`, capped at 30 s, or 5 s without one. For `IDEMPOTENCY_UNAVAILABLE` it
waits `baseDelayMs`, doubled for each further retry. The gateway verifies these new authorizations but
does not settle them.

```typescript
interface PaymentRequest {
  x402Version: number;
  network: string;
  scheme: string;
  asset: string;
  amount: string;            // smallest unit (integer string)
  payTo: string;
  maxTimeoutSeconds: number;
}
```

### Methods

#### `health(): Promise<boolean>`

Check if the gateway is healthy and reachable.

```typescript
const isHealthy = await client.health();
```

It never throws. It returns `false` when the request fails or gets an error status, and when
the gateway reports `status: 'critical'`: the gateway answers 200 even then, so that it stays
reachable. A `degraded` gateway is still healthy, and so is a 200 whose body is not JSON. A 429
whose `Retry-After` asks for more than 60 s returns `false` at once, without a retry (#161).

#### `notaryInfo(): Promise<NotaryInfo>`

Get notary service information.

```typescript
const info = await client.notaryInfo();
// { enabled: true, available: true, address: '0x...' }
```

A 404 returns `{ enabled: false, available: false }`. Another error status throws
`GatewayConnectionError` with the gateway's code and `body`, or `PaymentRateLimitError` for a
rate-limited free-tier request. A success body that cannot be read, is not JSON, or is not an
object with boolean `enabled` and `available` throws `GatewayConnectionError` with code
`INVALID_RESPONSE` (#173, #179). A connection failure or timeout throws `GatewayConnectionError` (`CONNECTION_FAILED` or
`TIMEOUT`). In x402 mode with `payForReads`, the payment errors listed under `download()` also
apply.

#### `poolStatus(): Promise<PoolStatus>`

Get stamp pool status.

```typescript
const status = await client.poolStatus();
// { enabled: true, available: { '17': 5 }, reserve: { '17': 10 }, totalStamps: 5,
//   lowReserveWarning: true }
```

A 404 returns a disabled pool with no stamps. Another error status throws
`GatewayConnectionError` with the gateway's code and `body`, or `PaymentRateLimitError` for a
rate-limited free-tier request. A success body that cannot be read, is not JSON, or is not an
object with boolean `enabled`, number `total_stamps` and objects `current_levels` and
`reserve_config` throws `GatewayConnectionError` with code `INVALID_RESPONSE` (#173, #179). So
does a `low_reserve_warning` that is present but not a boolean. When the gateway leaves it out,
`lowReserveWarning` is `false` (#199). A connection failure or timeout throws `GatewayConnectionError` (`CONNECTION_FAILED` or
`TIMEOUT`). In x402 mode with `payForReads`, the payment errors listed under `download()` also
apply.

#### `pricing(options?): Promise<Pricing>`

Get price quotes for the gateway's paid operations, without paying (`GET /api/v1/pricing`).
Only the options you set are sent; the gateway applies its defaults and validation.

**PricingOptions:**

| Property | Type | Description |
|----------|------|-------------|
| `size` | `'small' \| 'medium' \| 'large'` | Stamp size preset |
| `depth` | `number` | Stamp depth (16-32) |
| `durationHours` | `number` | Stamp duration in hours (at least 24) |
| `uploadBytes` | `number` | Size of the upload request body in bytes (gateway default: 4096) |
| `mb` | `number` | Bandwidth credit top-up in MB (at least 1) |

**Returns:** `Pricing`

```typescript
interface Pricing {
  x402Enabled: boolean;        // false: the gateway does not charge and sends no quotes
  currency?: string;           // e.g. 'USDC'
  network?: string;            // as the gateway's 402 names it
  asset?: string;              // token contract
  payTo?: string;              // can seed payment.payTo
  minPriceUsd?: number;
  freeTier?: { enabled: boolean; header: string };
  quotes: {                    // only operations enabled on the gateway
    stampPurchase?: PriceQuote;    // POST /api/v1/stamps/
    poolAcquire?: PriceQuote;      // POST /api/v1/pool/acquire
    dataUpload?: PriceQuote;       // POST /api/v1/data/
    bandwidthCredit?: PriceQuote;  // POST /api/v1/chunks/credit
  };
}

interface PriceQuote {
  method: string;              // e.g. 'POST'
  path: string;                // e.g. '/api/v1/data/'
  priceUsd: number;
  amount: string;              // smallest unit of the asset (integer string)
  /** @deprecated Use amount (same value). Removed with x402 v1 (#210). */
  maxAmountRequired: string;
  description: string;
}
```

Quotes follow the current chain price: treat them as current, not guaranteed. An error status
throws `GatewayConnectionError` with the gateway's code and `body`, or `PaymentRateLimitError`
for a rate-limited free-tier request. A success body that cannot be read, is not JSON, or does
not have the expected shape throws `GatewayConnectionError` with code `INVALID_RESPONSE` (#173,
#199). The expected shape is an object with boolean `x402_enabled`. Optional fields, `quotes`
included, can be absent or `null`. When present, they
must have the type they are copied as, or the call throws `INVALID_RESPONSE`: string
`currency`, `network`, `asset` and `pay_to`, number `min_price_usd`, `free_tier` with boolean
`enabled` and string `header`, and `quotes` as an object. Each of the four quotes, when
present, must have string `method`, `path` and `description`, number `price_usd`, and the
amount as string `amount` or `max_amount_required` (equal when both are sent). `amount` and
`maxAmountRequired` both get that value. After a paid request (`payForReads`), the error has `error.payment`. A connection failure or timeout throws `GatewayConnectionError` (`CONNECTION_FAILED` or
`TIMEOUT`). In x402 mode with `payForReads`, the payment errors listed under `download()` also
apply.

#### `acquireStamp(size?, options?): Promise<AcquiredStamp>`

Acquire a stamp from the pool.

```typescript
acquireStamp(
  size?: 'small' | 'medium' | 'large',   // default 'small'
  options?: { idempotencyKey?: string }
): Promise<AcquiredStamp>

const stamp = await client.acquireStamp('small');
// { batchId: '...', depth: 17, sizeName: 'small', fallbackUsed: false,
//   expiresAt: '...' }
```

In x402 mode the acquisition is paid only with `payment.payForPool: true`. Without it, a 402
from the pool throws `StampError`. `idempotencyKey` works as in `UploadOptions`; it is sent
only on a paid acquisition. An error status from the pool throws `StampError` (see Errors),
except a rate-limited free-tier request, which throws `PaymentRateLimitError` (`'free'`
mode), and the three idempotency stop codes after a paid acquisition, which throw
`PaymentOutcomeError`. A connection failure or timeout throws `GatewayConnectionError`
(`CONNECTION_FAILED` or `TIMEOUT`). A success body that cannot be read, is not JSON, or does
not have the expected shape throws `GatewayConnectionError` with code `INVALID_RESPONSE`, not
`StampError` (#173, #199). The expected shape is an object with a `batch_id` of 64 hex
characters, number `depth` and string `size_name`, and a boolean `fallback_used` if present.
When `fallback_used` is absent, `fallbackUsed` is `false`. `batchId` is returned in lowercase,
as `upload()` sends a caller's `stampId` (#168). After a paid acquisition, the error has
`error.payment`. When the body was valid JSON of the wrong shape, the message says that a retry
with the same `idempotencyKey` does not return a valid answer (see `upload()`). In x402 mode with `payForPool`, the
payment errors listed under `upload()` also apply.

#### `upload(content, options?): Promise<UploadResult>`

Upload provenance data to Swarm.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `content` | `Uint8Array \| ArrayBuffer \| string \| File \| Blob \| Record<string, unknown>` | Content to upload |
| `options` | `UploadOptions` | Upload options |

**UploadOptions:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `sign` | `'notary'` | - | Enable notary signing |
| `standard` | `string` | - | Provenance standard identifier |
| `stampId` | `string` | - | Use existing stamp (skip pool). 64 hex characters are sent in lowercase |
| `poolSize` | `'small' \| 'medium' \| 'large'` | `'small'` | Pool size preset |
| `contentType` | `string` | - | Content type |
| `raw` | `boolean` | `false` | Upload raw JSON without base64 wrapping |
| `idempotencyKey` | `string` | a new random key per call (x402 mode) | Idempotency-Key for the paid requests of this upload, 1-255 printable ASCII characters (else `INVALID_INPUT`). To retry an upload that failed after paying, pass `error.payment.idempotencyKey` here and `error.payment.stampId` as `stampId`: the gateway returns the first result instead of charging again |
| `ownerSigner` | `OwnerSigner` | - | Prove that you own `stampId` with a signed owner proof instead of a payment. Requires `stampId` (64 hex characters, no `0x`) and cannot be combined with `idempotencyKey` (else `INVALID_INPUT`). The upload uses the free tier and never pays, in any payment mode. Each attempt signs a new proof |

```typescript
interface OwnerSigner {
  signMessage(args: { message: string }): Promise<`0x${string}`>;  // EIP-191 personal_sign
}
```

A viem `LocalAccount` or a viem `WalletClient` with an account can be passed as `OwnerSigner`
directly.

**Returns:** `UploadResult` (default) or `DocumentUploadResult` (when `raw: true`)

```typescript
interface UploadResult {
  reference: string;           // Swarm hash (64 hex chars)
  metadata: ProvenanceMetadata;
  payment?: PaymentReceipt;    // the upload's payment, when it was paid (x402 mode)
  stampPayment?: PaymentReceipt; // the pool stamp's payment, when upload() paid for it
  expiresAt?: string;          // when the stamp runs out (ISO 8601, UTC; gateway estimate)
}

interface DocumentUploadResult {
  reference: string;           // Swarm hash (64 hex chars)
  metadata: DocumentMetadata;  // data is raw JSON, not base64
  payment?: PaymentReceipt;
  stampPayment?: PaymentReceipt;
  expiresAt?: string;
}

interface PaymentReceipt {
  transaction?: string;        // settlement transaction, from the gateway's receipt headers
  network?: string;            // x402 v1 name ('base-sepolia', 'base', or payment.v1Network), for v1 and v2
  payer?: string;
  amount?: string;             // amount signed, in the token's smallest unit
  amountDecimal?: string;      // amount in tokens
  asset?: string;
  replayed?: true;             // the gateway replayed the first result for this key
}
```

A receipt is present only when the request carried a payment the gateway accepted. The
receipt header is `PAYMENT-RESPONSE` (x402 v2), else `X-PAYMENT-RESPONSE` (v1); one over 8192
characters, or that does not decode to a JSON object, counts as absent. `network` is the
receipt's network, else the one the SDK signed for, always named the x402 v1 way: a v2
`eip155:84532` is reported as `'base-sepolia'` (#159). It changes to CAIP-2 with the removal of
x402 v1 (#210).

**Errors:**

| Error | Code | When |
|-------|------|------|
| `ProvenanceError` | `INVALID_INPUT` | Raw content (`raw: true`) is not a JSON string or a non-binary object (a `Uint8Array`, `ArrayBuffer` or `Blob` is refused), or JSON cannot represent it: a circular reference, a `BigInt`, nesting deeper than 1000 levels, a `toJSON()` that returns `undefined`, or a `toJSON()` or getter that throws; `idempotencyKey` is not 1-255 printable ASCII characters; or `ownerSigner` is set without a `stampId` of 64 hex characters, or together with `idempotencyKey`; or a `Blob` or `File` cannot be read (for example a `NotReadableError`). Nothing is sent. For content JSON cannot represent and for a read error, the original error is `error.cause` (#202) |
| `ProvenanceError` | `FILE_TOO_LARGE` | The metadata JSON is larger than `maxUploadBytes`. Checked before a stamp is acquired; nothing is sent. For a base64 upload, the message gives the largest content in bytes that fits with the same options, says that only empty content fits, or says that no content fits (#202) |
| `GatewayConnectionError` | `FILE_TOO_LARGE` | Without `sign: 'notary'`: the gateway's proxy refused the body with a 413 that is not JSON. With `sign: 'notary'`, this is a `NotaryError` with the same code |
| `ProvenanceError` | `OWNER_PROOF_FAILED` | `ownerSigner.signMessage()` threw, or did not return a `0x`-prefixed hex string |
| `StampError` | `POOL_EXHAUSTED`, or the gateway's code | Without `stampId`: the pool is enabled and empty, or the pool acquisition failed (see StampError) |
| `NotaryError` | the gateway's code | With `sign: 'notary'`: the upload request got an error status (see NotaryError) |
| `GatewayConnectionError` | the gateway's code | Without `sign: 'notary'`: the upload request got an error status. `body` holds the response |
| `GatewayConnectionError` | `CONNECTION_FAILED`, `TIMEOUT` | A request could not be sent, got no response, or timed out. With `ownerSigner`, also a timeout while waiting for the signature or the clock |
| `GatewayConnectionError` | `INVALID_RESPONSE` | A success body cannot be read, is not JSON, or does not have the expected shape (#173, #199): for the upload, an object with a `reference` of 64 or 128 hex characters, with an optional `0x` prefix; for the pool acquisition, the fields `acquireStamp()` needs. Also with `sign: 'notary'`. Nothing is uploaded after a malformed pool answer |
| `PaymentRateLimitError` | `PAYMENT_RATE_LIMIT` | A free-tier request (`'free'` mode, or an owner-proof upload) was rate limited |
| `PaymentConfigurationError` | `PAYMENT_CONFIGURATION` | x402 mode: the `@x402` packages, Web Crypto or the wallet address are missing. Checked on the first request that may pay |
| `PaymentRefusedError` | `PAYMENT_REFUSED` | x402 mode: the payment was refused before signing |
| `PaymentError` | `PAYMENT_FAILED`, `PAYMENT_UNCONFIRMED` | x402 mode: the payment could not be created, or was sent and the response could not be processed |
| `PaymentOutcomeError` | an idempotency stop code | x402 mode: a paid retry found that the first attempt needs a person to follow up |

"The gateway's code" is undefined when the error body has none.

An error from the upload request, after `upload()` took a stamp from the pool, has
`stampId`, and `stampPayment` when that stamp was paid for. An error after a paid request
has `payment`, with `payment.idempotencyKey`. `payment.stampId` is set only when the upload
request itself failed; a failed paid pool acquisition inside `upload()` has no
`payment.stampId`. Pass those back as `idempotencyKey` and `stampId` to retry without paying
twice; the error message says how. The exception is `INVALID_RESPONSE` after a paid request
whose 200 body is valid JSON of the wrong shape. That body is the gateway's own answer, so a
retry with the same `idempotencyKey` does not return a valid answer: it gets the same answer
again, or `IDEMPOTENCY_KEY_DELIVERED_NOT_STORED` when the gateway did not store it (a body over
its storage limit, a response it kept no body for, or one it marks as not storable). The payment may
have been taken. The message says to contact the gateway operator with
`payment.transaction`, or with the idempotency key when the transaction is not known (#199).
When `upload()` used a pool stamp, the message also says that the stamp can still be used:
pass `stampId` back with a new `idempotencyKey` to upload without getting another stamp. A
200 body that could not be read or is not JSON is not the gateway's answer: the message advises
the keyed retry, which can recover the result.

**Raw mode example:**

```typescript
// Upload structured JSON without base64 wrapping
const result = await client.upload(
  { file_hash: 'abc123', filename: 'report.pdf' },
  { raw: true, sign: 'notary' }
);
// result.metadata.data is the original object, not base64

// Also accepts JSON strings
const result2 = await client.upload(
  '{"file_hash": "abc123"}',
  { raw: true, stampId: 'myStamp' }
);
```

#### `download(reference, options?): Promise<DownloadResult>`

Download and optionally verify provenance data from Swarm.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `reference` | `string` | Swarm reference hash |
| `options` | `DownloadOptions` | Download options |

**DownloadOptions:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `verify` | `boolean` | `true` | Verify notary signatures if present |
| `notaryAddress` | `string` | gateway's `/api/v1/notary/info` address | Notary address to trust. Pin it to verify independently of the gateway |

**Returns:** `DownloadResult`

```typescript
interface DownloadResult {
  file: Uint8Array;            // Decoded original content
  metadata: ProvenanceMetadata;
  verified?: boolean;          // true if at least one signature verifies (below)
  verification?: SignatureVerification;
  signatures?: NotarySignature[];
}

interface SignatureVerification {
  expectedSigner?: string;                            // address verified against
  expectedSignerSource: 'option' | 'gateway' | 'none';
  results: SignatureCheck[];                          // one per signature, in order
  error?: string;                                     // e.g. the notary lookup failed
}

interface SignatureCheck {
  index: number;
  valid: boolean;              // verifies against the expected signer
  dataHashValid: boolean;      // data_hash matches this document's data
  recoveredAddress?: string;
  error?: string;              // why it is not valid
}
```

`verified` is `true` only if at least one signature is an EIP-191 signature that recovers
to the expected notary over `sha256(canonical JSON of data)|timestamp`; every signature's
result is in `verification.results`. If none is, `verified` is `false`: that covers
signature entries with an empty, missing or malformed `signature` value, other signers,
changed data, and no expected address. `verified` is `undefined` when the document carries
no signatures at all (missing or empty `signatures` list) or with `verify: false`, so
check `verified === true`, never `verified !== false`.

**Errors:**

| Error | Code | When |
|-------|------|------|
| `ProvenanceError` | `INVALID_INPUT` | `reference` is not 64 or 128 hex characters (optional `0x`), or `notaryAddress` is malformed (checked unless `verify: false`). Nothing is sent |
| `GatewayConnectionError` | the gateway's code, if the body has one | The gateway answered with an error status, such as 404. `body` holds the response |
| `PaymentRateLimitError` | `PAYMENT_RATE_LIMIT` | The free-tier read was rate limited |
| `GatewayConnectionError` | `CONNECTION_FAILED`, `TIMEOUT` | The request could not be sent, got no response, or timed out |
| `PaymentConfigurationError` | `PAYMENT_CONFIGURATION` | x402 mode with `payForReads`: the `@x402` packages, Web Crypto or the wallet address are missing |
| `PaymentRefusedError` | `PAYMENT_REFUSED` | x402 mode with `payForReads`: the payment was refused before signing |
| `PaymentError` | `PAYMENT_FAILED`, `PAYMENT_UNCONFIRMED` | x402 mode with `payForReads`: the payment could not be created, or was sent and the response could not be processed |
| `PaymentOutcomeError` | an idempotency stop code | x402 mode with `payForReads`: the gateway answered the paid read with one of the three stop codes |
| `GatewayConnectionError` | `INVALID_RESPONSE` | The success body cannot be read or is not JSON (#173, #179) |
| `GatewayConnectionError` | `INVALID_RESPONSE` | The body is not an object with string `data` and `content_hash`, directly or under `metadata` (#179) |
| `ProvenanceError` | `CONTENT_HASH_MISMATCH` | `content_hash` is not the SHA-256 of the base64-decoded `data`. `data` that is not valid base64 is also this error |

When the record's hash proves that it is a raw upload (`raw: true`), the error message says
to use `downloadDocument()` (#190). The code depends on `data`: `INVALID_RESPONSE` when
`data` is not a string, and `CONTENT_HASH_MISMATCH` when it is a string. A record whose hash
proves neither format gets no hint. After a paid read (`payForReads`), an `INVALID_RESPONSE`
or `CONTENT_HASH_MISMATCH` error carries `error.payment`, and its message says that a
payment was sent (#190).

#### `downloadDocument(reference, options?): Promise<DocumentDownloadResult>`

Download a raw JSON document from Swarm. Use for documents uploaded with `raw: true`.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `reference` | `string` | Swarm reference hash |
| `options` | `DownloadOptions` | Download options |

**Returns:** `DocumentDownloadResult`

```typescript
interface DocumentDownloadResult {
  document: Record<string, unknown>;  // The raw JSON document
  metadata: DocumentMetadata;
  verified?: boolean;                 // as for download()
  verification?: SignatureVerification;
  signatures?: NotarySignature[];
}
```

`verified` works as for `download()`.

**Errors:**

| Error | Code | When |
|-------|------|------|
| `ProvenanceError` | `INVALID_INPUT` | `reference` is not 64 or 128 hex characters (optional `0x`), or `notaryAddress` is malformed (checked unless `verify: false`). Nothing is sent |
| `GatewayConnectionError` | the gateway's code, if the body has one | The gateway answered with an error status, such as 404. `body` holds the response |
| `PaymentRateLimitError` | `PAYMENT_RATE_LIMIT` | The free-tier read was rate limited |
| `GatewayConnectionError` | `CONNECTION_FAILED`, `TIMEOUT` | The request could not be sent, got no response, or timed out |
| `PaymentConfigurationError` | `PAYMENT_CONFIGURATION` | x402 mode with `payForReads`: the `@x402` packages, Web Crypto or the wallet address are missing |
| `PaymentRefusedError` | `PAYMENT_REFUSED` | x402 mode with `payForReads`: the payment was refused before signing |
| `PaymentError` | `PAYMENT_FAILED`, `PAYMENT_UNCONFIRMED` | x402 mode with `payForReads`: the payment could not be created, or was sent and the response could not be processed |
| `PaymentOutcomeError` | an idempotency stop code | x402 mode with `payForReads`: the gateway answered the paid read with one of the three stop codes |
| `GatewayConnectionError` | `INVALID_RESPONSE` | The success body cannot be read or is not JSON (#173, #179) |
| `GatewayConnectionError` | `INVALID_RESPONSE` | The body is not an object with a `data` field and a string `content_hash`, directly or under `metadata` (#179) |
| `ProvenanceError` | `CONTENT_HASH_MISMATCH` | `content_hash` is not the SHA-256 of the canonical JSON of `data`, nor of `JSON.stringify(data)` (SDK 0.6.x) |

When the record's hash proves that it is a base64 upload, the `CONTENT_HASH_MISMATCH`
message says to use `download()` (#190). A record whose hash proves neither format gets no
hint. After a paid read (`payForReads`), an `INVALID_RESPONSE` or `CONTENT_HASH_MISMATCH`
error carries `error.payment`, and its message says that a payment was sent (#190).

---

## Types

### ProvenanceMetadata

```typescript
interface ProvenanceMetadata {
  data: string;              // Base64 encoded file content
  content_hash: string;      // SHA256 of original file
  stamp_id: string;          // Postage stamp ID
  provenance_standard?: string;
  encryption?: string;
}
```

### DocumentMetadata

```typescript
interface DocumentMetadata {
  data: Record<string, unknown>; // Raw JSON (not base64)
  content_hash: string;          // SHA-256 of canonical JSON of data:
                                 // json.dumps(data, sort_keys=True, separators=(',', ':'))
                                 // (JSON.stringify(data) from SDK 0.6.x is also accepted)
  stamp_id: string;
  provenance_standard?: string;
  encryption?: string;
}
```

### NotarySignature

```typescript
interface NotarySignature {
  type: string;              // 'notary' (the gateway's scheme; others do not verify)
  signer: string;            // Signer's Ethereum address
  timestamp: string;         // ISO 8601 timestamp
  data_hash: string;         // SHA-256 of canonical JSON of `data`
  signature: string;         // EIP-191 signature, 65 bytes hex (0x optional)
  hashed_fields: string[];   // ['data']
  signed_message_format: string; // '{data_hash}|{timestamp}'
}
```

### SignedDocument

```typescript
interface SignedDocument {
  metadata: ProvenanceMetadata;
  signatures: NotarySignature[];
}
```

Exported for typing stored documents. `upload()` does not return it: `UploadResult` has no
signatures (see `upload()`); download the reference to get the signatures.

### NotaryInfo

```typescript
interface NotaryInfo {
  enabled: boolean;
  available: boolean;
  address?: string;
  message?: string;
}
```

### PoolStatus

```typescript
interface PoolStatus {
  enabled: boolean;
  available: Record<string, number>;  // stamps per depth
  reserve: Record<string, number>;    // reserve configuration per depth
  totalStamps: number;
  lowReserveWarning: boolean;         // a depth is below its reserve (false when the gateway leaves it out)
}
```

### AcquiredStamp

```typescript
interface AcquiredStamp {
  batchId: string;
  depth: number;
  sizeName: string;
  fallbackUsed: boolean;       // a larger stamp was used as fallback (false when the gateway leaves it out)
  payment?: PaymentReceipt;    // the acquisition's payment, when it was paid (x402 mode)
  expiresAt?: string;          // when the stamp runs out (ISO 8601, UTC; gateway estimate)
}
```

---

## Errors

All errors that the SDK throws for arguments of the documented types extend `ProvenanceError`,
except the errors of `canonicalizeJsonText()` and `canonicalizeJsonValue()`. Those two throw
standard JavaScript errors (see [Signature Verification](#signature-verification)). Input and
content checks throw a plain `ProvenanceError`: `INVALID_INPUT`, `FILE_TOO_LARGE` from the SDK's
own size check, `CONTENT_HASH_MISMATCH` and `OWNER_PROOF_FAILED`. The other errors are the
subclasses below. Only these wrapped errors keep the original error as `error.cause` (not
enumerable): raw `upload()` content, `buildDocumentMetadata()` and `computeNotaryDataHash()`
data that JSON cannot represent; `parseMetadata()` text that is not JSON; base64 that
`base64ToBytes()` cannot decode without `Buffer`; a `Blob` or `File` that `upload()` cannot
read; and a failed `import('viem')` in `fromPrivateKey()`. Errors that can carry an RPC URL
with its key, or a private key, have no `cause`, because consoles print a cause even when it is
not enumerable. Their message is the original message with URLs redacted. This covers the
signer's `getChainId()` and `getAddress()` failures, a declined chain switch,
`fromEip1193Provider()` account access, and `fromPrivateKey()` with an invalid key or `rpcUrl`.
`getProvenanceChain()` traversal errors keep a `cause` only when it is an SDK error.
`ChainTransactionError` keeps the original error as `.originalError` instead, not enumerable.

Errors from the chain entries (`@datafund/swarm-provenance/chain`, including its browser build)
are `instanceof` the `ProvenanceError` that you import from `@datafund/swarm-provenance`, in
ESM and CJS (#205). Each entry is a separate bundle with its own copy of `ProvenanceError`, so
`ProvenanceError` checks a brand instead of only the prototype chain. The constructor sets
the brand: a non-enumerable property keyed by
`Symbol.for('@datafund/swarm-provenance/ProvenanceError')`. Only `ProvenanceError` itself
checks the brand. Subclasses such as `StampError` and `ChainError` match by prototype only, so
a chain error is never `instanceof StampError`.

`Symbol.for` returns the same symbol in every copy of the SDK. As a result, `instanceof
ProvenanceError` is also true for an error from another copy of the SDK in the same process:
the CJS build when you import the ESM build, or another installed version. Such an error may
have fields that this version does not document. `instanceof` checks of a subclass are false
for errors from another copy. Compare `error.name` or `error.code` when your code can receive
errors from several copies.

The brand is not a security boundary. Any object can carry the global symbol and pass
`instanceof ProvenanceError`. If your code receives errors from a source you do not trust,
check `code` or `name`, and do not trust the other fields of such a value. `instanceof
ProvenanceError` never throws: a value whose prototype or brand cannot be read, such as a
`Proxy` whose traps throw, is not a `ProvenanceError`.

A subclass that you define (`class MyError extends ProvenanceError`) keeps its own prototype:
`new MyError('x') instanceof MyError` is `true`, and its methods work.

### ProvenanceError

Base error class.

```typescript
class ProvenanceError extends Error {
  readonly code?: string;
  // Set when the failed request carried an x402 payment: it may have been charged
  payment?: PaymentAttempt;
  // Gateway error responses only: the response body (see below)
  body?: unknown;
  // 429 responses only: the wait the gateway asked for in Retry-After, in seconds
  retryAfterSeconds?: number;
  // upload() only: the stamp it acquired from the pool before this error
  stampId?: string;
  // upload() only: the receipt for the pool stamp it paid for before this error
  stampPayment?: PaymentReceipt;
  // The error this one wraps, when the SDK wrapped one (#202). Declared on the class,
  // so it can be read with a TypeScript lib older than ES2022. Not enumerable
  cause?: unknown;
}
```

- `body` is set on errors from a gateway error response (#112). It is the parsed JSON if the
  body is JSON of at most 16384 characters. A larger JSON body, or one that is not JSON, is
  kept as text. Text longer than 4096 characters is cut to 4096 characters, ending with an
  ellipsis. An empty body leaves `body` unset. Codes and fields that the SDK does not map are
  here, such as the price options of a 402. `PaymentRateLimitError` has no `body`: the SDK
  throws it without reading the response body.
- A 402 message names the price asked, for example `0.01 USDC on base-sepolia`. It is read
  from the `PAYMENT-REQUIRED` header (x402 v2) when that decodes to a payment request, else from
  the body's top level, else its `detail` (#167). For a header that decodes, this is the
  option x402 mode pays. A header that decodes to a JSON object without a readable `x402Version`
  and `accepts` is not a payment request: the message then names the body's price, while x402
  mode refuses that 402 with `PaymentRefusedError` and pays nothing. The network is
  named the x402 v1 way, as in `PaymentReceipt.network`; a CAIP-2 ID with no known v1 name is
  shown as sent, and a network or token that is not well formed shows as `?`. The 402 body
  itself, not the header, is `body`.
- `retryAfterSeconds` is set on errors from a 429 response when the gateway sent a
  `Retry-After` the SDK can read: whole seconds or an HTTP date (#161). It is also set when
  the SDK did not retry because the wait was longer than 60 seconds. A value above
  `Number.MAX_SAFE_INTEGER` is not readable, so `retryAfterSeconds` is not set, and the 429 is
  retried with the normal backoff instead of being thrown at once (#185).
- `stampId` is set on errors from `upload()` after it acquired a stamp from the pool, whether
  or not the failed request paid. Pass it back as `stampId`. `stampPayment` is set when that
  stamp was paid for: that payment succeeded.

```typescript
interface PaymentAttempt {
  paymentSent: true;
  transaction?: string;      // settlement transaction, if the gateway reported one
  status?: string;           // gateway-reported payment status
  network?: string;          // network the payment was made on, as its x402 v1 name
  payer?: string;            // paying address, from the gateway's receipt
  amount?: string;           // amount signed, in the token's smallest unit (not proof of a charge)
  amountDecimal?: string;    // amount in tokens
  asset?: string;            // token contract
  replayed?: true;           // the gateway replayed a stored answer for this Idempotency-Key
  idempotencyKey?: string;   // pass it back as idempotencyKey to retry without paying twice
  nonce?: string;            // authorization nonce, when the gateway cannot tell if it settled
  stampId?: string;          // upload() only: pass it back as stampId with idempotencyKey
}
```

A failed request that carried a payment is not retried automatically. The one exception is a
paid write answered with `IDEMPOTENCY_KEY_IN_PROGRESS` or `IDEMPOTENCY_UNAVAILABLE`, which is
retried with the same Idempotency-Key (see X402PaymentConfig).

### GatewayConnectionError

Error connecting to or communicating with the gateway.

```typescript
class GatewayConnectionError extends ProvenanceError {
  readonly statusCode?: number;   // HTTP status, when there was a response
  readonly suggestion?: string;   // the gateway's detail.suggestion, if it sent one
}
```

| Code | When |
|------|------|
| The gateway's code | The gateway answered with an error status. `body` holds the response. The code is undefined when the body has none |
| `FILE_TOO_LARGE` | The gateway's proxy answered 413 with a body that is not JSON |
| `CONNECTION_FAILED` | The request could not be sent or got no response |
| `TIMEOUT` | The request took longer than `timeout`, or `paidTimeout` for an attempt that may pay or signs an owner proof |
| `INVALID_RESPONSE` | A success response whose body cannot be read or is not JSON (#173, #179). `notaryInfo()`, `poolStatus()`, `download()` and `downloadDocument()` (#179), and `pricing()`, `acquireStamp()` and `upload()` (#199), also throw it for a body that does not have the fields they need. Each method's section lists those fields. `statusCode` is the HTTP status. After a paid request, the error has `payment` |

### PaymentRateLimitError

`code: 'PAYMENT_RATE_LIMIT'`. A request that used the free tier got a 429 rate limit. It is
not retried. A 429 with a code that is not a rate limit, such as
`DAILY_STAMP_ALLOWANCE_EXHAUSTED`, is thrown with that code instead, and is not retried
either.

```typescript
class PaymentRateLimitError extends PaymentError {
  readonly retryAfterSeconds?: number;   // from Retry-After, if readable
  readonly requestsLimit?: number;       // from X-RateLimit-Limit
  readonly requestsRemaining?: number;   // from X-RateLimit-Remaining
}
```

### PaymentRefusedError

`code: 'PAYMENT_REFUSED'`. A payment the gateway asked for was refused before it was signed;
nothing was signed or paid. `refusals` lists each refused option with its reasons. The
causes are:

- The payment broke the payment policy, or `onBeforePayment` vetoed it.
- The 402 response carries no readable payment requirements. `refusals` is empty.
- The signature was declined in the wallet (#112). This covers EIP-1193 code `4001`, viem's
  `UserRejectedRequestError`, and an ethers v6 error with code `ACTION_REJECTED` (#166),
  within the first 8 levels of the error's `cause` chain. Its reason in `refusals` is `'rejected in the wallet'`.
  `refusals` is empty if the SDK did not record which request was being signed.

### PaymentConfigurationError

`code: 'PAYMENT_CONFIGURATION'`. Invalid x402 config, or missing `@x402` packages.

### PaymentError

`code: 'PAYMENT_FAILED'` when the x402 library could not build or sign a payment (nothing was
sent); `code: 'PAYMENT_UNCONFIRMED'` when the payment was sent but the response could not be
processed (`payment` is set).

### PaymentOutcomeError

A retry of a paid request with the same Idempotency-Key found that the first attempt's
payment needs a person to follow up (#102). It is never retried automatically. `payment` is
set.

```typescript
class PaymentOutcomeError extends PaymentError {
  readonly outcome: 'unknown' | 'settled_not_delivered' | 'delivered';
}
```

| Code | `outcome` | Meaning |
|------|-----------|---------|
| `IDEMPOTENCY_KEY_SETTLEMENT_UNKNOWN` | `'unknown'` | The payment may or may not have been collected. Check `payment.nonce` on chain before paying again |
| `IDEMPOTENCY_KEY_SETTLED_PENDING` | `'settled_not_delivered'` | The first attempt was paid (`payment.transaction`) and its result is not available. Ask the gateway operator for the result or a refund |
| `IDEMPOTENCY_KEY_DELIVERED_NOT_STORED` | `'delivered'` | The first attempt succeeded and was paid once, but the gateway kept no copy of its response. Do not pay again |

### StampError

Error related to postage stamps. `acquireStamp()`, and `upload()` without `stampId`, throw it
for a gateway error from the pool. It keeps the gateway's code, `body`, `payment` and
`retryAfterSeconds`. The gateway's code is undefined when the body has none. When the
request was paid, the three idempotency stop codes throw `PaymentOutcomeError` instead.

| Code | When |
|------|------|
| The gateway's code, else `PAYMENT_REQUIRED` | The pool answered 402 and the SDK did not pay it (for example, without `payForPool`). `body` holds the 402 response (#163) |
| `POOL_EXHAUSTED` | `upload()` found the pool enabled and empty before acquiring |
| The gateway's code | Any other pool error |

### NotaryError

Error related to notary signing service. `upload()` with `sign: 'notary'` throws it for a
gateway error, with the gateway's code, `body`, `payment` and `retryAfterSeconds`. The
gateway's code is undefined when the body has none, and `FILE_TOO_LARGE` for a non-JSON 413.
When the request was paid, the three idempotency stop codes throw `PaymentOutcomeError`
instead.

### VerificationError

Thrown by `recoverSigner()` for a malformed or unrecoverable signature
(`INVALID_SIGNATURE`).
`download()` does not throw on a bad signature: it returns `verified: false`.

---

## Utilities

### Metadata Functions

```typescript
// Build metadata from content (base64 data, SHA-256 of the bytes)
function buildMetadata(
  content: Uint8Array | ArrayBuffer | string,
  options: { stampId: string; standard?: string; encryption?: string }  // MetadataBuilderOptions
): ProvenanceMetadata;

// Extract original content from metadata. Without Buffer (browsers), data that is
// not valid base64 throws ProvenanceError INVALID_INPUT
function extractContent(metadata: ProvenanceMetadata): Uint8Array;

// Verify content hash matches (false for data that is not valid base64)
function verifyContentHash(metadata: ProvenanceMetadata): boolean;

// Serialize/parse metadata. parseMetadata throws ProvenanceError INVALID_INPUT for text
// that is not JSON (error.cause is the parse error) or JSON that is not metadata
function serializeMetadata(metadata: ProvenanceMetadata): string;
function parseMetadata(json: string): ProvenanceMetadata;

// Build document metadata (raw JSON, no base64). A document JSON cannot represent
// (circular, BigInt, nesting deeper than 1000 levels, a toJSON() or getter that throws)
// throws ProvenanceError INVALID_INPUT; error.cause is the original error
function buildDocumentMetadata(
  document: Record<string, unknown>,
  options: { stampId: string; standard?: string }  // DocumentMetadataOptions
): DocumentMetadata;

// Verify document content hash (canonical JSON, or JSON.stringify from SDK 0.6.x).
// A self-consistency check only: it does not bind the data to its author or reference.
// canonicalData: canonicalizeJsonText(responseText, ['data']) (['metadata', 'data'] if wrapped)
// for exact floats/big ints
function verifyDocumentHash(metadata: DocumentMetadata, canonicalData?: string): boolean;
```

`MetadataBuilderOptions` and `DocumentMetadataOptions` are not exported from the package;
the option shapes are shown inline.

### Signature Verification

All of these fail closed. Without `expectedSigner` a signature is never valid: a signature
proves who signed, not whether that signer should be trusted.

```typescript
// Verify a single signature (EIP-191 recovery against expectedSigner)
function verifySignature(
  signature: NotarySignature,
  metadata: Pick<ProvenanceMetadata | DocumentMetadata, 'data'>,
  expectedSigner?: string,
  canonicalData?: string        // canonicalizeJsonText(responseText, ['data']),
                                // or ['metadata', 'data'] for a wrapped response
): { valid: boolean; dataHashValid: boolean; signerValid?: boolean; recoveredAddress?: string; error?: string };

// Verify all signatures: anyValid = at least one valid (what download() reports);
// allValid = at least one, and every one valid
function verifyAllSignatures(
  signatures: NotarySignature[],
  metadata: Pick<ProvenanceMetadata | DocumentMetadata, 'data'>,
  expectedSigner?: string,
  canonicalData?: string
): { allValid: boolean; anyValid: boolean; results: SignatureCheck[] };

// Verify data hash matches the document's data (hashed_fields ['data'] only)
function verifyDataHash(
  signature: NotarySignature,
  metadata: Pick<ProvenanceMetadata | DocumentMetadata, 'data'>,
  canonicalData?: string
): boolean;

// SHA-256 of the canonical JSON of data, as the notary computes it (its data_hash).
// Pass canonicalData for an exact result with floats and large integers. Without it,
// data JSON cannot represent throws ProvenanceError INVALID_INPUT (error.cause: the original)
function computeNotaryDataHash(
  metadata: Pick<ProvenanceMetadata | DocumentMetadata, 'data'>,
  canonicalData?: string
): string;

// The notary's signed message format
const NOTARY_MESSAGE_FORMAT = '{data_hash}|{timestamp}';

// Recover the EIP-191 signer address (lowercase); throws VerificationError
function recoverSigner(message: string, signature: string): string;

// Canonical JSON, byte-compatible with Python json.dumps(sort_keys=True, separators=(',', ':')).
// These two throw standard errors, not ProvenanceError:
// canonicalizeJsonText: SyntaxError for text that is not JSON or is nested deeper than 1000 levels.
// canonicalizeJsonValue: TypeError for a value JSON cannot represent (undefined, circular, BigInt)
// and the error of a toJSON() or getter that throws, as JSON.stringify does; SyntaxError for
// nesting deeper than 1000 levels; RangeError when JSON.stringify runs out of stack.
function canonicalizeJsonText(text: string, path?: readonly string[]): string | undefined;
function canonicalizeJsonValue(value: unknown): string;
```

### Hashing and Encoding

```typescript
// Convert to bytes
function toBytes(input: Uint8Array | ArrayBuffer | string): Uint8Array;

// SHA256 hash as hex string
function sha256Hex(data: Uint8Array | ArrayBuffer | string): string;

// Base64 encoding/decoding. Without Buffer (browsers), base64ToBytes throws
// ProvenanceError INVALID_INPUT for text that atob cannot decode (error.cause: the atob
// error). Node.js's Buffer skips characters that are not base64 and does not throw
function bytesToBase64(bytes: Uint8Array): string;
function base64ToBytes(base64: string): Uint8Array;

// Swarm reference validation: 64 or 128 hex characters, optional 0x prefix
function isValidSwarmReference(ref: string): boolean;

// The text an owner signs (EIP-191 personal_sign) for an owner-proof upload (#124):
// 'swarm-connect-owner-upload:<stamp id lowercase>:<timestamp>' (unix seconds)
function ownerProofMessage(stampId: string, timestamp: number): string;
```
