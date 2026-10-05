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

#### `poolStatus(): Promise<PoolStatus>`

Get stamp pool status.

```typescript
const status = await client.poolStatus();
// { enabled: true, available: { '17': 5 }, reserve: { '17': 10 } }
```

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
| `stampId` | `string` | - | Use existing stamp (skip pool) |
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
check `verified === true`, never `verified !== false`. A malformed `notaryAddress` throws
`ProvenanceError` with code `INVALID_INPUT`.

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

All errors extend `ProvenanceError`.

### ProvenanceError

Base error class.

```typescript
class ProvenanceError extends Error {
  code?: string;
}
```

### GatewayConnectionError

Error connecting to or communicating with the gateway.

```typescript
class GatewayConnectionError extends ProvenanceError {
  statusCode?: number;
}
```

### StampError

Error related to postage stamps.

### NotaryError

Error related to notary signing service.

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
