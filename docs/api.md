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
| `payment` | `'free' \| 'none' \| X402PaymentConfig` | `'free'` | Payment mode (see below) |
| `retry` | `{ maxRetries?, baseDelayMs? }` | `{ 2, 1000 }` | Retries on 502/503, and on 429 unless the request used the free tier (then `PaymentRateLimitError`). A 429 retry waits `Retry-After` up to 60 s; above that the error is thrown at once, with `retryAfterSeconds`. An x402 attempt that sent a payment is never retried; unpaid attempts are |

#### X402PaymentConfig

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `wallet` | `PaymentWallet` | required | Signs payment authorizations (viem `WalletClient` with an account, or `toClientEvmSigner()`) |
| `network` | `'base' \| 'base-sepolia' \| CAIP-2` | `'base-sepolia'` | Network to pay on; selects both x402 identifiers. `'base'` (mainnet) requires `maxAmount` |
| `v1Network` | `string` | implied by `network` | x402 v1 name; only needed for chains other than Base / Base Sepolia. Alone, a known name (`'base'`) also selects `network`; it must not contradict a known `network` |
| `maxAmount` | `string` | `'1'` on Base Sepolia with test USDC; **required** elsewhere | Largest single payment, in tokens (`'0.50'`) |
| `payTo` | `string[]` | any | Allowed recipients |
| `asset` | `string` | the network's USDC | Token to pay with |
| `assetDecimals` | `number` | `6`; **required** with `asset` | Decimals of `asset` |
| `assetDomain` | `{ name: string; version: string }` | known for the network's USDC; **required** with `asset` | EIP-712 domain of `asset` (its `name()` and `version()` on chain). A 402 whose `extra.name` or `extra.version` differs, or is missing, is refused |
| `maxTimeoutSeconds` | `number` | `600` | Longest authorization validity accepted |
| `onBeforePayment` | `(p: PaymentRequest) => boolean \| void \| Promise<…>` | none | Return `false` (or throw) to refuse a payment. A payment may still not follow (signing fails, timeout) |
| `payForReads` | `boolean` | `false` | Pay for GET/HEAD too; otherwise reads use the free tier |

A payment outside this policy, of a scheme other than `exact`, or using a transfer method
other than EIP-3009 is refused before anything is signed (`PaymentRefusedError`). An invalid
config throws `PaymentConfigurationError` in the constructor. Reads use the free tier unless
`payForReads`. An attempt that sent a payment is never retried; unpaid attempts retry as usual.

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

#### `notaryInfo(): Promise<NotaryInfo>`

Get notary service information.

```typescript
const info = await client.notaryInfo();
// { enabled: true, available: true, address: '0x...' }
```

A 404 returns `{ enabled: false, available: false }`. Another error status throws
`GatewayConnectionError` with the gateway's code and `body`, or `PaymentRateLimitError` for a
rate-limited free-tier request. A success body that cannot be
read, is not JSON, or is not an object with boolean `enabled` and `available` throws
`GatewayConnectionError` with code `INVALID_RESPONSE` (#173, #179).

#### `poolStatus(): Promise<PoolStatus>`

Get stamp pool status.

```typescript
const status = await client.poolStatus();
// { enabled: true, available: { '17': 5 }, reserve: { '17': 10 } }
```

A 404 returns a disabled pool with no stamps. Another error status throws
`GatewayConnectionError` with the gateway's code and `body`, or `PaymentRateLimitError` for a
rate-limited free-tier request. A success body that cannot be
read, is not JSON, or is not an object with boolean `enabled`, number `total_stamps` and
objects `current_levels` and `reserve_config` throws `GatewayConnectionError` with code
`INVALID_RESPONSE` (#173, #179).

#### `acquireStamp(size?: 'small' | 'medium' | 'large'): Promise<AcquiredStamp>`

Acquire a stamp from the pool.

```typescript
const stamp = await client.acquireStamp('small');
// { batchId: '...', depth: 17, sizeName: 'small', fallbackUsed: false }
```

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

**Returns:** `UploadResult` (default) or `DocumentUploadResult` (when `raw: true`)

```typescript
interface UploadResult {
  reference: string;           // Swarm hash (64 hex chars)
  metadata: ProvenanceMetadata;
}

interface DocumentUploadResult {
  reference: string;           // Swarm hash (64 hex chars)
  metadata: DocumentMetadata;  // data is raw JSON, not base64
}
```

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
| `GatewayConnectionError` | the gateway's code | The gateway answered with an error status, such as 404. `body` holds the response |
| `PaymentRateLimitError` | `PAYMENT_RATE_LIMIT` | The free-tier read was rate limited |
| `GatewayConnectionError` | `INVALID_RESPONSE` | The success body cannot be read or is not JSON (#173, #179) |
| `GatewayConnectionError` | `INVALID_RESPONSE` | The body is not an object with string `data` and `content_hash`, directly or under `metadata` (#179) |
| `ProvenanceError` | `CONTENT_HASH_MISMATCH` | `content_hash` is not the SHA-256 of the base64-decoded `data`. In browsers, `data` that is not valid base64 is also this error |

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
| `GatewayConnectionError` | the gateway's code | The gateway answered with an error status, such as 404. `body` holds the response |
| `PaymentRateLimitError` | `PAYMENT_RATE_LIMIT` | The free-tier read was rate limited |
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

Exported for typing stored documents. `upload()` does not return it: `UploadResult` is
`{ reference, metadata }`; download the reference to get the signatures.

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
  available: Record<string, number>;
  reserve: Record<string, number>;
}
```

### AcquiredStamp

```typescript
interface AcquiredStamp {
  batchId: string;
  depth: number;
  sizeName: string;
  fallbackUsed: boolean;
}
```

---

## Errors

All errors extend `ProvenanceError`. Errors the SDK raises itself, such as `INVALID_INPUT`
and `CONTENT_HASH_MISMATCH`, are plain `ProvenanceError` instances.

### ProvenanceError

Base error class.

```typescript
class ProvenanceError extends Error {
  code?: string;
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
}
```

- `body` is set on errors from a gateway error response (#112). It is the parsed JSON if the
  body is JSON of at most 16384 characters. A larger JSON body, or one that is not JSON, is
  kept as text, cut to 4096 characters with an ellipsis. Codes and fields that the SDK does
  not map are here, such as the price options of a 402.
- `retryAfterSeconds` is set on errors from a 429 response when the gateway sent a
  `Retry-After` the SDK can read: whole seconds or an HTTP date (#161). It is also set when
  the SDK did not retry because the wait was longer than 60 seconds. A value above
  `Number.MAX_SAFE_INTEGER` is not readable, so `retryAfterSeconds` is not set (#185).
- `stampId` is set on errors from `upload()` after it acquired a stamp from the pool, whether
  or not the failed request paid. Pass it back as `stampId`. `stampPayment` is set when that
  stamp was paid for: that payment succeeded.

```typescript
interface PaymentAttempt {
  paymentSent: true;
  transaction?: string;      // settlement transaction, if the gateway reported one
  status?: string;           // gateway-reported payment status
  network?: string;          // network the payment was made on
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

A failed request that carried a payment is never retried automatically.

### GatewayConnectionError

Error connecting to or communicating with the gateway.

```typescript
class GatewayConnectionError extends ProvenanceError {
  statusCode?: number;   // HTTP status, when there was a response
  suggestion?: string;   // the gateway's detail.suggestion, if it sent one
}
```

| Code | When |
|------|------|
| The gateway's code | The gateway answered with an error status. `body` holds the response |
| `CONNECTION_FAILED` | The request could not be sent or got no response |
| `TIMEOUT` | The request took longer than `timeout`, or `paidTimeout` for an attempt that may pay or signs an owner proof |
| `INVALID_RESPONSE` | A success response whose body cannot be read, is not JSON, or does not have the fields the method needs (#173, #179). `statusCode` is the HTTP status |

### PaymentRateLimitError

`code: 'PAYMENT_RATE_LIMIT'`. A request that used the free tier got a 429 rate limit. It is
not retried. A 429 with a code that is not a rate limit, such as
`DAILY_STAMP_ALLOWANCE_EXHAUSTED`, is thrown with that code instead, and is not retried
either.

```typescript
class PaymentRateLimitError extends PaymentError {
  retryAfterSeconds?: number;   // from Retry-After, if readable
  requestsLimit?: number;       // from X-RateLimit-Limit
  requestsRemaining?: number;   // from X-RateLimit-Remaining
}
```

### PaymentRefusedError

`code: 'PAYMENT_REFUSED'`. A payment the gateway asked for was refused before it was signed;
nothing was signed or paid. `refusals` lists each refused option with its reasons. The
causes are:

- The payment broke the payment policy, or `onBeforePayment` vetoed it.
- The signature was declined in the wallet (#112). This covers EIP-1193 code `4001`, viem's
  `UserRejectedRequestError`, and an ethers v6 error with code `ACTION_REJECTED` (#166),
  anywhere in the error's `cause` chain. Its reason in `refusals` is `'rejected in the wallet'`.
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
  outcome: 'unknown' | 'settled_not_delivered' | 'delivered';
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
`retryAfterSeconds`. The three idempotency stop codes throw `PaymentOutcomeError` instead.

| Code | When |
|------|------|
| The gateway's code, else `PAYMENT_REQUIRED` | The pool answered 402 and the SDK did not pay it (no x402 mode, or no `payForPool`). `body` holds the 402 response (#163) |
| `POOL_EXHAUSTED` | `upload()` found the pool enabled and empty before acquiring |
| The gateway's code | Any other pool error |

### NotaryError

Error related to notary signing service. `upload()` with `sign: 'notary'` throws it for a
gateway error, with the gateway's code, `body`, `payment` and `retryAfterSeconds`. The three
idempotency stop codes throw `PaymentOutcomeError` instead.

### VerificationError

Thrown by `recoverSigner()` for a malformed or unrecoverable signature
(`INVALID_SIGNATURE`).
`download()` does not throw on a bad signature: it returns `verified: false`.

---

## Utilities

### Metadata Functions

```typescript
// Build metadata from content
function buildMetadata(
  content: Uint8Array | ArrayBuffer | string,
  options: MetadataBuilderOptions
): ProvenanceMetadata;

// Extract original content from metadata
function extractContent(metadata: ProvenanceMetadata): Uint8Array;

// Verify content hash matches
function verifyContentHash(metadata: ProvenanceMetadata): boolean;

// Serialize/parse metadata
function serializeMetadata(metadata: ProvenanceMetadata): string;
function parseMetadata(json: string): ProvenanceMetadata;

// Build document metadata (raw JSON, no base64)
function buildDocumentMetadata(
  document: Record<string, unknown>,
  options: DocumentMetadataOptions
): DocumentMetadata;

// Verify document content hash (canonical JSON, or JSON.stringify from SDK 0.6.x).
// canonicalData: canonicalizeJsonText(responseText, ['data']) (['metadata', 'data'] if wrapped)
// for exact floats/big ints
function verifyDocumentHash(metadata: DocumentMetadata, canonicalData?: string): boolean;
```

### Signature Verification

All of these fail closed. Without `expectedSigner` a signature is never valid: a signature
proves who signed, not whether that signer should be trusted.

```typescript
// Verify a single signature (EIP-191 recovery against expectedSigner)
function verifySignature(
  signature: NotarySignature,
  metadata: { data: unknown },
  expectedSigner?: string,
  canonicalData?: string        // canonicalizeJsonText(responseText, ['data']),
                                // or ['metadata', 'data'] for a wrapped response
): { valid: boolean; dataHashValid: boolean; signerValid?: boolean; recoveredAddress?: string; error?: string };

// Verify all signatures: anyValid = at least one valid (what download() reports);
// allValid = at least one, and every one valid
function verifyAllSignatures(
  signatures: NotarySignature[],
  metadata: { data: unknown },
  expectedSigner?: string,
  canonicalData?: string
): { allValid: boolean; anyValid: boolean; results: SignatureCheck[] };

// Verify data hash matches the document's data (hashed_fields ['data'] only)
function verifyDataHash(signature: NotarySignature, metadata: { data: unknown }, canonicalData?: string): boolean;

// Recover the EIP-191 signer address (lowercase); throws VerificationError
function recoverSigner(message: string, signature: string): string;

// Canonical JSON, byte-compatible with Python json.dumps(sort_keys=True, separators=(',', ':'))
function canonicalizeJsonText(text: string, path?: string[]): string | undefined;
function canonicalizeJsonValue(value: unknown): string;
```

### Hashing and Encoding

```typescript
// Convert to bytes
function toBytes(input: Uint8Array | ArrayBuffer | string): Uint8Array;

// SHA256 hash as hex string
function sha256Hex(data: Uint8Array | ArrayBuffer | string): string;

// Base64 encoding/decoding
function bytesToBase64(bytes: Uint8Array): string;
function base64ToBytes(base64: string): Uint8Array;

// Swarm reference validation
function isValidSwarmReference(ref: string): boolean;
```
