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

Base URL: `https://provenance-gateway.datafund.io` (default)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check |
| `/api/v1/notary/info` | GET | Notary service status |
| `/api/v1/pool/status` | GET | Stamp pool status |
| `/api/v1/pool/acquire` | POST | Acquire stamp from pool |
| `/api/v1/data/` | POST | Upload data |
| `/api/v1/data/{reference}` | GET | Download data |

## Data Flow

### Upload (default)
1. Content → `toBytes()` conversion
2. Build `ProvenanceMetadata` (base64 data + SHA256 hash + stamp_id)
3. Acquire stamp from pool (or use provided stampId)
4. POST metadata as JSON to gateway
5. Gateway uploads to Swarm, returns reference
6. Optionally: notary signs the document

### Upload (raw mode)
1. Content is a JSON object or JSON string — no base64 wrapping
2. Build `DocumentMetadata` (raw JSON data + SHA256 of JSON.stringify(data) + stamp_id)
3. Acquire stamp from pool (or use provided stampId)
4. POST metadata as JSON to gateway
5. Gateway uploads to Swarm, returns reference
6. Use `client.upload(jsonObj, { raw: true })` or `client.upload(jsonStr, { raw: true })`

### Download (default)
1. GET reference from gateway
2. Parse response as ProvenanceMetadata (+ optional signatures)
3. Verify content_hash matches decoded data (base64)
4. If signed, verify signatures against notary address
5. Return decoded file content as `Uint8Array`

### Download (document)
1. GET reference from gateway
2. Parse response — `data` field is raw JSON object (not base64)
3. Verify content_hash matches `JSON.stringify(data)`
4. If signed, verify signatures
5. Return `document` as `Record<string, unknown>`
6. Use `client.downloadDocument(reference)` for this mode

## Type System

```
ProvenanceMetadata
├── data: string (base64)
├── content_hash: string (SHA256 hex)
├── stamp_id: string
├── provenance_standard?: string
└── encryption?: string

DocumentMetadata (raw JSON uploads)
├── data: Record<string, unknown> (raw JSON, not base64)
├── content_hash: string (SHA256 of JSON.stringify(data))
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

- **Unit tests** (`tests/unit/`): Mock fetch, test each module in isolation (272 tests)
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
- `@x402/fetch` - Optional peer dependency for x402 payment mode
- `@x402/evm` - Optional peer dependency for x402 EVM payment signing

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

## Git Workflow & Releases

### Branching

- **`main`** — Protected. Requires 1 PR review, enforced for admins. No direct pushes.
- **`development`** — Integration branch. All feature work merges here first.
- **Feature branches** — Created from `development`: `feature/<name>`, `fix/<name>`, `chore/<name>`.

### Flow

1. Create feature branch from `development`
2. Do work, commit, push, create PR to `development`
3. Merge to `development` after CI passes
4. When ready to release: bump version in `package.json`, create PR from `development` → `main`
5. After merge to `main`, CI auto-publishes to npm and creates a git tag

### Releasing to npm

Publishing is automated via `.github/workflows/publish.yml`:
- Triggers on push to `main`
- Checks if `package.json` version is already published
- If new version: runs tests, builds, publishes to npm, tags `vX.Y.Z`
- If version unchanged: skips publish (safe for non-release merges)

To release a new version:
1. On `development`, bump version: edit `package.json` `"version"` field
2. Commit: `chore: bump version to X.Y.Z`
3. Create PR `development` → `main`
4. After merge, npm publish happens automatically

### CI

- `.github/workflows/ci.yml` — Runs on all PRs and pushes to `main`/`development`
- Matrix: Node 18.x + 20.x
- Steps: typecheck → lint → test → build → verify dist

## Gateway URLs

| Environment | URL |
|-------------|-----|
| Production (default) | `https://provenance-gateway.datafund.io` |
| Dev | `https://provenance-gateway.dev.datafund.io` |
| Local | `http://localhost:8000` (swarm_connect) |

## Payment Modes (x402)

The gateway supports the x402 payment protocol for paid access with higher rate limits.

| Mode | Config | Behavior |
|------|--------|----------|
| Free (default) | `payment: 'free'` | Sends `X-Payment-Mode: free` header. Rate-limited (3 req/min). |
| None | `payment: 'none'` | No payment header. Gets raw 402 responses. |
| x402 paid | `payment: { wallet }` | Automatic USDC payments via `@x402/fetch`. No rate limits. |

**Dependencies for x402 mode**: `@x402/fetch` and `@x402/evm` (optional peer deps, dynamically imported).

**Setup**:
```typescript
import { createWalletClient, http, publicActions } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const wallet = createWalletClient({
  account: privateKeyToAccount('0x...'),
  chain: baseSepolia,
  transport: http(),
}).extend(publicActions);

const client = new ProvenanceClient({ payment: { wallet } });
```

The `PaymentWallet` interface requires `address`, `signTypedData`, and `readContract` — matching viem's `WalletClient.extend(publicActions)` or `@x402/evm`'s `toClientEvmSigner()`.

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
| `POOL_EXHAUSTED` | StampError | Stamp pool is empty, no stamps available |
| `NOTARY_NOT_ENABLED` | NotaryError | Notary service disabled |
| `NOT_IMPLEMENTED` | VerificationError | Feature not yet implemented |
| `CHAIN_CONFIGURATION` | ChainConfigurationError | Missing viem, invalid chain config |
| `CHAIN_CONNECTION` | ChainConnectionError | RPC unreachable |
| `CHAIN_TRANSACTION` | ChainTransactionError | Tx reverted, out of gas (`.originalError` has full details) |
| `CHAIN_VALIDATION` | ChainValidationError | Bad hash format, invalid input |
| `DATA_NOT_REGISTERED` | DataNotRegisteredError | Hash not found on-chain |
| `SIGNER_REQUIRED` | SignerRequiredError | Write op without signer |
| `PAYMENT_CONFIGURATION` | PaymentConfigurationError | Missing @x402 packages or invalid wallet |
| `INVALID_INPUT` | ProvenanceError | Raw mode content is not valid JSON or plain object |
| `PAYMENT_RATE_LIMIT` | PaymentRateLimitError | 429 free tier limit exceeded |

Note: `GatewayConnectionError` may include a `.suggestion` field with recovery hints from the gateway.
Both `ProvenanceClient` and `ChainClient` accept a `retry` config (default: 2 retries, 1s exponential backoff) for transient failures (502/503/nonce errors).

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
await chain.getDataRecord(hash);           // → ChainProvenanceRecord (includes storageRef)
await chain.getDataHashByStorageRef(ref);  // → string | null (reverse lookup)

// With wallet (browser)
const signer = await fromEip1193Provider(window.ethereum);
const chain = new ChainClient({ chain: 'base-sepolia', signer });
await chain.anchor(contentHash, 'dataset', swarmRef);  // → AnchorResult (with storageRef)
await chain.recordAccess(swarmRef);        // → AccessResult

// With private key (Node.js)
import { fromPrivateKey } from '@datafund/swarm-provenance/chain';
const signer = await fromPrivateKey('0x...', 'https://sepolia.base.org');
```

### Contract

- **Contract**: DataProvenance on Base Sepolia
- **Address**: `0x3945aDfd5Df9ab2F5cB4Ca0eb3D4384CC3650322`
- **Explorer**: https://sepolia.basescan.org/address/0x3945aDfd5Df9ab2F5cB4Ca0eb3D4384CC3650322

### Methods

| Method | Type | Signer | Description |
|--------|------|--------|-------------|
| `verifyOnChain(hash)` | Read | No | Check if hash is registered |
| `getDataRecord(hash)` | Read | No | Get full provenance record |
| `getUserDataRecords(address)` | Read | No | Get all hashes owned by address |
| `getUserDataRecordsCount(address)` | Read | No | Get count of records owned by address |
| `getUserDataRecordsPaginated(address, offset, limit)` | Read | No | Get paginated record hashes |
| `hasAddressAccessed(hash, address)` | Read | No | Check if address accessed hash |
| `isAuthorizedDelegate(owner, delegate)` | Read | No | Check delegate authorization |
| `getTransformationLinks(hash)` | Read | No | Get child transformation links (v2) |
| `getTransformationParents(hash)` | Read | No | Get parent hashes (reverse traversal) |
| `getChildHashes(hash)` | Read | No | Get child hashes (lightweight) |
| `getProvenanceChain(hash, maxDepth?)` | Read | No | BFS traversal of provenance DAG |
| `supportsTransformationLinks()` | Read | No | Detect v2 contract support |
| `healthCheck()` | Read | No | Check RPC connectivity |
| `getBalance()` | Read | Yes | Get signer's ETH balance |
| `anchor(hash, type, storageRef?)` | Write | Yes | Register hash on-chain (optionally link storage ref) |
| `anchorFor(hash, type, owner, storageRef?)` | Write | Yes | Register on behalf of owner (optionally link storage ref) |
| `getDataHashByStorageRef(ref)` | Read | No | Reverse lookup: storage ref → data hash |
| `recordAccess(hash)` | Write | Yes | Record access event |
| `recordTransformation(orig, new, desc)` | Write | Yes | Record 1-to-1 data transformation |
| `mergeTransform(sources, new, desc, type?)` | Write | Yes | Record N-to-1 merge transformation (v2) |
| `setDataStatus(hash, status)` | Write | Yes | Set record status |
| `transferOwnership(hash, newOwner)` | Write | Yes | Transfer data ownership |
| `setDelegate(delegate, authorized)` | Write | Yes | Authorize/revoke delegate |
| `batchAnchor(items)` | Write | Yes | Batch register multiple hashes |
| `batchRecordAccess(hashes)` | Write | Yes | Batch record access |
| `batchSetDataStatus(items)` | Write | Yes | Batch set statuses |

## PLUR Domain Scoping

When calling `plur_learn`, always set:
- `domain`: `provenance.sdk`
- `scope`: `project:swarm-provenance-sdk`

This ensures engrams are tagged for retrieval in the right context across the global store.

## PLUR Memory

You have persistent memory via PLUR. Corrections, preferences, and conventions persist across sessions as engrams.

### Session Workflow

1. **Start**: Call `plur_session_start` with task description — injects relevant engrams
2. **Learn**: When corrected or discovering something new, call `plur_learn` immediately
3. **Recall**: Before answering factual questions, call `plur_recall_hybrid` — check memory first
4. **Feedback**: Rate injected engrams with `plur_feedback` (positive/negative) — trains relevance
5. **End**: Call `plur_session_end` with summary + engram_suggestions

Do not ask permission to use these tools — they are your memory system.

### When to check memory

Before reaching for web search, file reads, or guessing — apply this priority:
1. Is the answer already in engrams? → `plur_recall_hybrid`
2. Is the answer in the local filesystem? → Read/Grep/Glob
3. Is the answer derivable from context already loaded? → Just answer
4. Only if 1-3 fail → Use external tools

| Domain | When to recall |
|--------|----------------|
| Decisions | Past design choices, architecture rationale |
| Corrections | API quirks, bugs, wrong assumptions |
| Preferences | Formatting, tone, workflow, tool choices |
| Conventions | Tag formats, file routing, naming rules |
| Infrastructure | Server IPs, SSH configs, deployment targets |

### When corrected

When the user corrects you ("no, use X not Y", "that's wrong"):
1. Call `plur_learn` immediately — before continuing the task
2. Call `plur_feedback` with negative signal on the wrong engram if one was injected
3. Then continue with the corrected approach

### Verification

When recalling facts that will drive actions:
1. State the recalled fact explicitly before acting on it
2. Include the engram ID or search that produced it
3. If no engram matches, say so and verify from the filesystem
4. Never interpolate between two engrams to produce a "probably correct" composite
