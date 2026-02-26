# CLAUDE.md - Swarm Provenance SDK

## Overview

TypeScript SDK (`@datafund/swarm-provenance`) for storing and retrieving provenance data via the Swarm Provenance Gateway. First consumer: Fairdrop v3 (React 18 + TS + Vite).

## Architecture

```
Application (Fairdrop, Verity, etc.)
        │
        ├──────────────────────┐
        ▼                      ▼
   ProvenanceClient       ChainClient
   (gateway ops)          (on-chain anchoring)
        │                      │
        ▼                      ▼
   Provenance Gateway     DataProvenance Contract
   (swarm_connect)        (Base Sepolia)
        │
        ▼
     Swarm Network
```

## Gateway API Endpoints

Base URL: `https://provenance-gateway.dev.datafund.io` (default)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check |
| `/api/v1/notary/info` | GET | Notary service status |
| `/api/v1/pool/status` | GET | Stamp pool status |
| `/api/v1/pool/acquire` | POST | Acquire stamp from pool |
| `/api/v1/data/` | POST | Upload data |
| `/api/v1/data/{reference}` | GET | Download data |

## Data Flow

### Upload
1. Content → `toBytes()` conversion
2. Build `ProvenanceMetadata` (base64 data + SHA256 hash + stamp_id)
3. Acquire stamp from pool (or use provided stampId)
4. POST metadata as JSON to gateway
5. Gateway uploads to Swarm, returns reference
6. Optionally: notary signs the document

### Download
1. GET reference from gateway
2. Parse response as ProvenanceMetadata (+ optional signatures)
3. Verify content_hash matches decoded data
4. If signed, verify signatures against notary address
5. Return decoded file content

## Type System

```
ProvenanceMetadata
├── data: string (base64)
├── content_hash: string (SHA256 hex)
├── stamp_id: string
├── provenance_standard?: string
└── encryption?: string

NotarySignature
├── type: string (eip191)
├── signer: string (0x address)
├── timestamp: string (ISO 8601)
├── data_hash: string (SHA256 of hashed_fields)
├── signature: string
├── hashed_fields: string[]
└── signed_message_format: string

SignedDocument
├── metadata: ProvenanceMetadata
└── signatures: NotarySignature[]
```

## Module Structure

```
src/
├── index.ts      # Public API exports
├── client.ts     # ProvenanceClient class
├── types.ts      # TypeScript interfaces
├── errors.ts     # Error class hierarchy
├── metadata.ts   # Metadata builder/parser
├── notary.ts     # Signature verification
├── utils.ts      # SHA256, base64, helpers
└── chain/        # Blockchain anchoring (sub-path: ./chain)
    ├── index.ts      # Public exports for @datafund/swarm-provenance/chain
    ├── client.ts     # ChainClient class
    ├── contract.ts   # ABI encode/decode via viem
    ├── types.ts      # Chain types (ChainProvenanceRecord, AnchorResult, etc.)
    ├── errors.ts     # ChainError hierarchy (extends ProvenanceError)
    ├── abi.ts        # Embedded DataProvenance contract ABI
    ├── constants.ts  # Chain presets (Base Sepolia, Base mainnet)
    ├── signer.ts     # ChainSigner interface + factory helpers
    └── validation.ts # Hash normalization, input validation
```

## Testing Strategy

- **Unit tests** (`tests/unit/`): Mock fetch, test each module in isolation (155 tests)
- **Integration tests** (`tests/integration/`): Real gateway, full round-trips
- **E2E tests** (`examples/web-app/e2e/`): Playwright browser tests (11 tests)

Run unit tests: `pnpm test`
Run integration tests: `pnpm test:integration`
Run e2e tests: `cd examples/web-app && pnpm test`

## Demo App

Reference React app at `examples/web-app/`:

```bash
cd examples/web-app
pnpm install
pnpm dev          # Start dev server at http://localhost:5173
pnpm test         # Run Playwright e2e tests
```

Features: upload text/files, download by reference, notary signing, metadata display.

## Dependencies

- `@noble/hashes` - SHA256 (same as Fairdrop v3)
- `viem` - Optional peer dependency for blockchain anchoring (`./chain` entry point)

## Build Output

Main entry (`@datafund/swarm-provenance`):
- ESM: `dist/index.js`
- CJS: `dist/index.cjs`
- Types: `dist/index.d.ts`

Chain entry (`@datafund/swarm-provenance/chain`):
- ESM: `dist/chain/index.js`
- CJS: `dist/chain/index.cjs`
- Types: `dist/chain/index.d.ts`

Built with tsup for dual ESM/CJS output. viem is externalized.

## Dev Commands

```bash
pnpm install        # Install dependencies
pnpm build          # Build dist/
pnpm test           # Run unit tests
pnpm test:watch     # Watch mode
pnpm test:integration  # Integration tests (requires gateway)
pnpm typecheck      # TypeScript check
pnpm lint           # ESLint
pnpm format         # Prettier
```

## Gateway URLs

| Environment | URL |
|-------------|-----|
| Dev (default) | `https://provenance-gateway.dev.datafund.io` |
| Production | `https://provenance-gateway.datafund.io` |
| Local | `http://localhost:8000` (swarm_connect) |

Note: SDK adds `X-Payment-Mode: free` header by default for x402 compatibility.

## Related Projects

- `swarm_connect` - Gateway server (Python/FastAPI)
- `swarm_provenance_CLI` - CLI tool (Python)
- `swarm_provenance_mcp` - MCP server
- `fairdrop-v3` - First consumer of this SDK

## Error Codes

| Code | Error Class | Meaning |
|------|-------------|---------|
| `TIMEOUT` | GatewayConnectionError | Request timed out |
| `CONNECTION_FAILED` | GatewayConnectionError | Network error |
| `CONTENT_HASH_MISMATCH` | ProvenanceError | Downloaded content doesn't match hash |
| `NOTARY_NOT_ENABLED` | NotaryError | Notary service disabled |
| `NOT_IMPLEMENTED` | VerificationError | Feature not yet implemented |
| `CHAIN_CONFIGURATION` | ChainConfigurationError | Missing viem, invalid chain config |
| `CHAIN_CONNECTION` | ChainConnectionError | RPC unreachable |
| `CHAIN_TRANSACTION` | ChainTransactionError | Tx reverted, out of gas |
| `CHAIN_VALIDATION` | ChainValidationError | Bad hash format, invalid input |
| `DATA_NOT_REGISTERED` | DataNotRegisteredError | Hash not found on-chain |
| `SIGNER_REQUIRED` | SignerRequiredError | Write op without signer |

## Blockchain Anchoring

The `@datafund/swarm-provenance/chain` sub-path provides on-chain provenance anchoring via the DataProvenance smart contract on Base Sepolia.

### Setup

```bash
pnpm add viem  # Required only for chain features
```

### Usage

```typescript
import { ChainClient, fromEip1193Provider } from '@datafund/swarm-provenance/chain';

// Read-only (no wallet needed)
const chain = new ChainClient({ chain: 'base-sepolia' });
await chain.verifyOnChain(hash);           // → boolean
await chain.getDataRecord(hash);           // → ChainProvenanceRecord

// With wallet (browser)
const signer = await fromEip1193Provider(window.ethereum);
const chain = new ChainClient({ chain: 'base-sepolia', signer });
await chain.anchor(swarmRef, 'dataset');   // → AnchorResult
await chain.recordAccess(swarmRef);        // → AccessResult

// With private key (Node.js)
import { fromPrivateKey } from '@datafund/swarm-provenance/chain';
const signer = await fromPrivateKey('0x...', 'https://sepolia.base.org');
```

### Contract

- **Contract**: DataProvenance on Base Sepolia
- **Address**: `0x9a3c6F47B69211F05891CCb7aD33596290b9fE64`
- **Explorer**: https://sepolia.basescan.org/address/0x9a3c6F47B69211F05891CCb7aD33596290b9fE64

### Methods

| Method | Type | Signer | Description |
|--------|------|--------|-------------|
| `verifyOnChain(hash)` | Read | No | Check if hash is registered |
| `getDataRecord(hash)` | Read | No | Get full provenance record |
| `getUserDataRecords(address)` | Read | No | Get all hashes owned by address |
| `hasAddressAccessed(hash, address)` | Read | No | Check if address accessed hash |
| `isAuthorizedDelegate(owner, delegate)` | Read | No | Check delegate authorization |
| `anchor(hash, type)` | Write | Yes | Register hash on-chain |
| `anchorFor(hash, type, owner)` | Write | Yes | Register on behalf of owner (operator) |
| `recordAccess(hash)` | Write | Yes | Record access event |
| `recordTransformation(orig, new, desc)` | Write | Yes | Record data transformation |
| `setDataStatus(hash, status)` | Write | Yes | Set record status |
| `transferOwnership(hash, newOwner)` | Write | Yes | Transfer data ownership |
| `setDelegate(delegate, authorized)` | Write | Yes | Authorize/revoke delegate |
| `batchAnchor(items)` | Write | Yes | Batch register multiple hashes |
| `batchRecordAccess(hashes)` | Write | Yes | Batch record access |
| `batchSetDataStatus(items)` | Write | Yes | Batch set statuses |
