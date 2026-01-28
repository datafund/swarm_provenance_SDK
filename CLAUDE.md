# CLAUDE.md - Swarm Provenance SDK

## Overview

TypeScript SDK (`@datafund/swarm-provenance`) for storing and retrieving provenance data via the Swarm Provenance Gateway. First consumer: Fairdrop v3 (React 18 + TS + Vite).

## Architecture

```
Application (Fairdrop, Verity, etc.)
        │
        ▼
   ProvenanceClient (this SDK)
        │
        ▼
   Provenance Gateway (swarm_connect)
        │
        ▼
     Swarm Network
```

## Gateway API Endpoints

Base URL: `https://provenance-gateway.datafund.io`

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
└── utils.ts      # SHA256, base64, helpers
```

## Testing Strategy

- **Unit tests** (`tests/unit/`): Mock fetch, test each module in isolation
- **Integration tests** (`tests/integration/`): Real gateway, full round-trips

Run unit tests: `pnpm test`
Run integration tests: `pnpm test:integration`

## Dependencies

- `@noble/hashes` - SHA256 (same as Fairdrop v3)
- No other runtime dependencies

## Build Output

- ESM: `dist/index.js`
- CJS: `dist/index.cjs`
- Types: `dist/index.d.ts`

Built with tsup for dual ESM/CJS output.

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
| Production | `https://provenance-gateway.datafund.io` |
| Dev | `https://provenance-gateway.dev.datafund.io` (if available) |
| Local | `http://localhost:8000` (swarm_connect) |

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
