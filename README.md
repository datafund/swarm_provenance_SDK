# @datafund/swarm-provenance

TypeScript SDK for storing and retrieving provenance data via the Swarm network.

## Installation

```bash
# From GitHub (current)
pnpm add datafund/swarm_provenance_SDK

# From npm (coming soon)
pnpm add @datafund/swarm-provenance
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

## Features

- **Simple API**: High-level `upload()` and `download()` methods handle the full workflow
- **Automatic stamp management**: Acquires stamps from the pool automatically
- **Notary signing**: Optional cryptographic signatures for data authenticity
- **Content verification**: Automatic SHA256 hash verification on download
- **Browser + Node.js**: Works in both environments with native `fetch`
- **TypeScript first**: Full type definitions included

## API

### `ProvenanceClient`

```typescript
const client = new ProvenanceClient({
  gatewayUrl?: string,  // default: https://provenance-gateway.datafund.io
  timeout?: number,     // default: 30000ms
});
```

### Upload

```typescript
const result = await client.upload(content, {
  sign?: 'notary',                         // Enable notary signing
  standard?: string,                       // Provenance standard identifier
  stampId?: string,                        // Use existing stamp (skip pool)
  poolSize?: 'small' | 'medium' | 'large', // Pool size preset
  contentType?: string,                    // Content type
});

// Returns:
// {
//   reference: string,           // Swarm hash
//   metadata: ProvenanceMetadata,
//   signedDocument?: SignedDocument,
// }
```

### Download

```typescript
const result = await client.download(reference, {
  verify?: boolean,  // Verify notary signature (default: true)
});

// Returns:
// {
//   file: Uint8Array,            // Decoded content
//   metadata: ProvenanceMetadata,
//   verified?: boolean,
//   signatures?: NotarySignature[],
// }
```

### Other Methods

```typescript
// Health check
await client.health(); // => boolean

// Notary info
await client.notaryInfo();
// => { enabled: boolean, available: boolean, address?: string }

// Pool status
await client.poolStatus();
// => { enabled: boolean, available: Record<string, number>, reserve: Record<string, number> }

// Acquire stamp directly
await client.acquireStamp('small');
// => { batchId: string, depth: number, sizeName: string, fallbackUsed: boolean }
```

## Error Handling

```typescript
import {
  ProvenanceError,
  GatewayConnectionError,
  StampError,
  NotaryError,
  VerificationError,
} from '@datafund/swarm-provenance';

try {
  await client.upload(content);
} catch (error) {
  if (error instanceof StampError) {
    console.error('Stamp acquisition failed:', error.message);
  } else if (error instanceof GatewayConnectionError) {
    console.error('Gateway error:', error.statusCode, error.message);
  }
}
```

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
// => { valid: boolean, dataHashValid: boolean, signerValid?: boolean }
```

## Demo App

A reference React app is available at `examples/web-app/`:

```bash
cd examples/web-app
pnpm install
pnpm dev
```

Open http://localhost:5173 to try uploading and downloading with the SDK.

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Test
pnpm test

# Type check
pnpm typecheck

# Lint
pnpm lint
```

## License

MIT
