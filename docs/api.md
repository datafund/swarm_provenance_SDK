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
| `content` | `Uint8Array \| ArrayBuffer \| string \| File \| Blob` | Content to upload |
| `options` | `UploadOptions` | Upload options |

**UploadOptions:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `sign` | `'notary'` | - | Enable notary signing |
| `standard` | `string` | - | Provenance standard identifier |
| `stampId` | `string` | - | Use existing stamp (skip pool) |
| `poolSize` | `'small' \| 'medium' \| 'large'` | `'small'` | Pool size preset |
| `contentType` | `string` | - | Content type |

**Returns:** `UploadResult`

```typescript
interface UploadResult {
  reference: string;           // Swarm hash (64 hex chars)
  metadata: ProvenanceMetadata;
  signedDocument?: SignedDocument;
}
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
| `verify` | `boolean` | `true` | Verify notary signature if present |

**Returns:** `DownloadResult`

```typescript
interface DownloadResult {
  file: Uint8Array;            // Decoded original content
  metadata: ProvenanceMetadata;
  verified?: boolean;          // Signature verification result
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

### NotarySignature

```typescript
interface NotarySignature {
  type: string;              // Signature type (e.g., 'eip191')
  signer: string;            // Signer's Ethereum address
  timestamp: string;         // ISO 8601 timestamp
  data_hash: string;         // SHA256 of signed data
  signature: string;         // The actual signature
  hashed_fields: string[];   // Fields included in hash
  signed_message_format: string;
}
```

### SignedDocument

```typescript
interface SignedDocument {
  metadata: ProvenanceMetadata;
  signatures: NotarySignature[];
}
```

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

Error when signature verification fails.

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
```

### Signature Verification

```typescript
// Verify a single signature
function verifySignature(
  signature: NotarySignature,
  metadata: ProvenanceMetadata,
  expectedSigner?: string
): { valid: boolean; dataHashValid: boolean; signerValid?: boolean; error?: string };

// Verify all signatures
function verifyAllSignatures(
  signatures: NotarySignature[],
  metadata: ProvenanceMetadata,
  expectedSigner?: string
): { allValid: boolean; results: Array<{ index: number; valid: boolean; error?: string }> };

// Verify data hash matches metadata
function verifyDataHash(signature: NotarySignature, metadata: ProvenanceMetadata): boolean;
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
