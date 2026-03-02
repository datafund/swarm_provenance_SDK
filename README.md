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

### Blockchain Anchoring

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

// With private key (Node.js)
const signer = await fromPrivateKey('0x...', 'https://sepolia.base.org');
const chain = new ChainClient({ chain: 'base-sepolia', signer });
await chain.anchor(contentHash, 'dataset');
```

## Features

- **Simple API**: High-level `upload()` and `download()` methods handle the full workflow
- **Automatic stamp management**: Acquires stamps from the pool automatically
- **Notary signing**: Optional cryptographic signatures for data authenticity
- **Content verification**: Automatic SHA256 hash verification on download
- **Blockchain anchoring**: Register data hashes on-chain for immutable provenance
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

## Blockchain Anchoring (`/chain`)

The chain module provides on-chain data provenance via a DataProvenance smart contract. It uses [viem](https://viem.sh) as an optional peer dependency (see [Installation](#installation)).

### `ChainClient`

```typescript
import { ChainClient } from '@datafund/swarm-provenance/chain';

const chain = new ChainClient({
  chain: 'base-sepolia',     // or 'base' for mainnet, or a custom ChainPreset
  rpcUrl?: string,            // override RPC endpoint
  signer?: ChainSigner,       // required for write operations
});
```

### Read Operations (no signer required)

```typescript
// Check if a hash is registered on-chain
await chain.verifyOnChain(dataHash);  // => boolean

// Get full provenance record
await chain.getDataRecord(dataHash);
// => { dataHash, owner, timestamp, dataType, status, accessors, transformations }

// Get all records owned by an address
await chain.getUserDataRecords('0x...');  // => string[]

// Check if an address has accessed a hash
await chain.hasAddressAccessed(dataHash, '0x...');  // => boolean

// Check delegate authorization
await chain.isAuthorizedDelegate(owner, delegate);  // => boolean
```

### Write Operations (signer required)

```typescript
// Anchor a data hash on-chain
const result = await chain.anchor(dataHash, 'dataset');
// => { txHash, blockNumber, gasUsed, explorerUrl, dataHash, dataType, owner }

// Anchor on behalf of another owner (operator only)
await chain.anchorFor(dataHash, 'dataset', ownerAddress);

// Record access
await chain.recordAccess(dataHash);
// => { txHash, blockNumber, gasUsed, explorerUrl, dataHash, accessor }

// Record transformation
await chain.recordTransformation(originalHash, newHash, 'filtered PII');

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

### Signer Factories

```typescript
import {
  fromEip1193Provider,
  fromPrivateKey,
  fromViemWalletClient,
} from '@datafund/swarm-provenance/chain';

// Browser wallet (MetaMask, etc.)
const signer = await fromEip1193Provider(window.ethereum);

// Private key (Node.js / scripts)
const signer = await fromPrivateKey('0x...', 'https://sepolia.base.org');

// Existing viem WalletClient
const signer = fromViemWalletClient(walletClient);
```

### Chain Error Handling

```typescript
import {
  ChainConnectionError,
  ChainTransactionError,
  DataNotRegisteredError,
  SignerRequiredError,
} from '@datafund/swarm-provenance/chain';

try {
  await chain.anchor(hash, 'dataset');
} catch (error) {
  if (error instanceof SignerRequiredError) {
    console.error('Connect a wallet first');
  } else if (error instanceof ChainTransactionError) {
    console.error('Transaction failed:', error.txHash);
  }
}
```

### Supported Networks

| Network | Preset | Contract |
|---------|--------|----------|
| Base Sepolia (testnet) | `base-sepolia` | `0x9a3c6F47B69211F05891CCb7aD33596290b9fE64` |
| Base (mainnet) | `base` | Not yet deployed |

## Demo App

A reference React app is available at `examples/web-app/` with upload, download, notary signing, and blockchain anchoring:

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
