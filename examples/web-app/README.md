# Swarm Provenance Demo

A simple React app demonstrating the `@datafund/swarm-provenance` SDK.

## Features

- Gateway health check and notary status
- Upload text or files to Swarm
- Optional notary signing with signature verification
- Download by reference with metadata display
- Blockchain anchoring (Base Sepolia) — connect wallet, anchor hashes, verify on-chain records
- Merge transformations — combine multiple source hashes into a merged result (v2 contract)
- Provenance chain traversal — trace full lineage of any data hash
- Wallet balance display
- User records browser — view all records owned by the connected wallet

## Quick Start

```bash
# From the web-app directory
pnpm install
pnpm dev
```

Open http://localhost:5173

## How It Works

### Upload & Download

```typescript
import { ProvenanceClient } from '@datafund/swarm-provenance';

const client = new ProvenanceClient();

// Upload
const result = await client.upload('Hello, World!', {
  sign: 'notary',  // optional
  standard: 'demo-v1',
});

// Download
const downloaded = await client.download(result.reference);
```

### Blockchain Anchoring

Requires a browser wallet (MetaMask) on Base Sepolia:

```typescript
import { ChainClient, fromEip1193Provider } from '@datafund/swarm-provenance/chain';

// Connect wallet
const signer = await fromEip1193Provider(window.ethereum);
const chain = new ChainClient({ chain: 'base-sepolia', signer, txTimeout: 120_000 });

// Anchor content hash on-chain
const result = await chain.anchor(contentHash, 'dataset');

// Verify (no wallet needed)
const readOnly = new ChainClient({ chain: 'base-sepolia' });
const record = await readOnly.getDataRecord(contentHash);
```

### Merge Transform (v2)

Combine multiple data sources into a single merged result:

```typescript
await chain.mergeTransform(
  [sourceHash1, sourceHash2],
  mergedHash,
  'combined datasets A and B',
);
```

### Provenance Chain

Trace the full lineage of a data hash (ancestors + descendants):

```typescript
const readOnly = new ChainClient({ chain: 'base-sepolia' });
const records = await readOnly.getProvenanceChain(dataHash);
// Returns ChainProvenanceRecord[] via BFS traversal
```

The demo app auto-populates the anchor hash after a successful upload. Verify On-Chain and Provenance Chain work without a wallet connection.

## Testing

End-to-end tests using Playwright:

```bash
# Run all tests
pnpm test

# Run tests with browser visible
pnpm test:headed

# Run tests with Playwright UI
pnpm test:ui
```

### Test Coverage (57 tests)

**Core — app.spec.ts (15 tests):**
- Page loads correctly, no console/CORS errors
- Gateway health check displays status
- Upload/download UI elements and validation
- Full upload and download cycle
- Notary signing and signature verification

**Chain — chain.spec.ts (34 tests):**
- Chain section layout and description
- Provenance Chain section visibility and button states
- "No wallet detected" state without provider
- Merge Transform and My Records hidden without wallet
- Verify On-Chain button states and validation
- Verify shows "not registered" for unknown hashes
- Wallet connection with injected mock provider
- Connect wallet reveals anchor, merge, and records sections
- Connection error handling (user rejection)
- Anchor form defaults and validation
- Merge Transform form: add/remove sources, validation, defaults
- My Records section visibility
- Upload auto-populates anchor hash field

**Chain Integration — chain-debug.spec.ts (8 tests):**
- Full anchor and verify flow via Hardhat
- Duplicate anchor error handling
- Verify unknown hash on Hardhat
- Merge transform: anchor sources, merge, verify result
- Verify shows transformation links after merge
- Provenance chain traversal after merge
- User records after anchoring
- Wallet balance displayed after connect

## Development

```bash
pnpm install      # Install dependencies
pnpm dev          # Start dev server
pnpm build        # Build for production
pnpm test         # Run e2e tests
```

## Prerequisites

- **Node.js** 18+ and **pnpm**
- **MetaMask** (or compatible wallet) for chain features
- Wallet must be connected to **Base Sepolia** testnet
- Get testnet ETH from [Base Sepolia Faucet](https://www.coinbase.com/faucets/base-ethereum-goerli-faucet)

## Layout

```
┌─────────────────────────────────────────┐
│  Swarm Provenance Demo                  │
├─────────────────────────────────────────┤
│  Gateway Status                         │
│  Health: Connected                      │
│  Notary: Available (0x1234...)          │
├─────────────────────────────────────────┤
│  Upload                                 │
│  [Text input area]                      │
│  [File selector]                        │
│  [x] Sign with Notary                   │
│  [Upload]                               │
├─────────────────────────────────────────┤
│  Download                               │
│  [Reference input]                      │
│  [Download]                             │
├─────────────────────────────────────────┤
│  Blockchain Anchoring                   │
│  Connected: 0x1234...5678 (0.05 ETH)   │
│                                         │
│  Anchor Data:                           │
│    [Data hash]  [Data type]             │
│    [Anchor On-Chain]                    │
│                                         │
│  Merge Transform:                       │
│    [Source 1] [Source 2] [+ Add Source]  │
│    [New hash] [Description] [Type]      │
│    [Merge Transform]                    │
│                                         │
│  Verify On-Chain:                       │
│    [Hash to verify]                     │
│    [Verify On-Chain]                    │
│    → Record details + transformation    │
│      links with descriptions            │
│                                         │
│  Provenance Chain:                      │
│    [Hash to trace]                      │
│    [Trace Provenance]                   │
│    → Chain of records (BFS traversal)   │
│                                         │
│  My Records:                            │
│    [Load My Records]                    │
│    → List with Verify/Trace buttons     │
└─────────────────────────────────────────┘
```
