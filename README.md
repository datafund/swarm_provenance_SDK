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

For x402 paid gateway access (higher rate limits), also install:

```bash
pnpm add @datafund/swarm-provenance @x402/fetch @x402/evm viem
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

### x402 Payment Mode

By default, the SDK uses the free tier (`X-Payment-Mode: free`), which is rate-limited. For higher throughput, configure x402 automatic USDC payments.

**Network:** payments default to **Base Sepolia** (`eip155:84532`, testnet USDC). Set
`payment.network` / `payment.v1Network` for another network.

**Read before enabling:** the SDK currently pays whatever the gateway's 402 response asks
for. There is no amount cap and no recipient or asset pinning yet (#106), and the payment
receipt is not returned to you (#111). Use a dedicated wallet holding only what you are
prepared to spend, and only with a gateway you trust.

**Server (Node.js):** load the key from the environment or a secret store, never from source code:

```typescript
import { ProvenanceClient } from '@datafund/swarm-provenance';
import { createWalletClient, http, publicActions } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const key = process.env.PAYER_PRIVATE_KEY;
if (!key?.startsWith('0x')) throw new Error('Set PAYER_PRIVATE_KEY (0x-prefixed hex)');

const wallet = createWalletClient({
  account: privateKeyToAccount(key as `0x${string}`),
  chain: baseSepolia,
  transport: http(),
}).extend(publicActions);

const client = new ProvenanceClient({ payment: { wallet } });

// Requests that receive 402 responses are automatically paid via USDC
const result = await client.upload('Hello, World!');
```

**Browser:** use the user's injected wallet. Never put a private key in browser code:
anything shipped to the browser is public.

```typescript
import { ProvenanceClient } from '@datafund/swarm-provenance';
import { createWalletClient, custom, publicActions, type EIP1193Provider } from 'viem';
import { baseSepolia } from 'viem/chains';

const provider = (window as { ethereum?: EIP1193Provider }).ethereum;
if (!provider) throw new Error('No injected wallet found');

const walletClient = createWalletClient({ chain: baseSepolia, transport: custom(provider) });
const [account] = await walletClient.requestAddresses();
// The payment authorization is signed for the payment network: put the wallet on it
try {
  await walletClient.switchChain({ id: baseSepolia.id });
} catch (error) {
  // 4902: the wallet does not know the chain yet (some wallets nest the code)
  const e = error as { code?: number; cause?: { code?: number } };
  if ((e.code ?? e.cause?.code) !== 4902) throw error;
  await walletClient.addChain({ chain: baseSepolia });
  await walletClient.switchChain({ id: baseSepolia.id }); // not every wallet switches on add
}

const wallet = createWalletClient({
  account: account!,
  chain: baseSepolia,
  transport: custom(provider),
}).extend(publicActions);

const client = new ProvenanceClient({ payment: { wallet } });
```

Payment modes:
- `'free'` (default) — sends `X-Payment-Mode: free` header, rate-limited
- `'none'` — no payment header, gets raw 402 responses
- `{ wallet }` — automatic x402 USDC payments via `@x402/fetch`

### Blockchain Anchoring

Requires `viem` (an optional peer dependency, not installed automatically): `npm install viem`.

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

// With private key (Node.js only; load it from the environment or a secret store)
const signer = await fromPrivateKey(process.env.ANCHOR_PRIVATE_KEY as `0x${string}`, 'https://base-sepolia-rpc.publicnode.com');
const chain = new ChainClient({ chain: 'base-sepolia', signer });
await chain.anchor(contentHash, 'dataset');
```

## Features

- **Simple API**: High-level `upload()` and `download()` methods handle the full workflow
- **Automatic stamp management**: Acquires stamps from the pool automatically
- **Notary signing**: Optional gateway signature (EIP-191) over the data hash and a timestamp; `download()` verifies it against the notary address (see [What `verified` means](#what-verified-means))
- **Content check**: Automatic SHA-256 check on download (self-consistency only, see [Security model](#security-model))
- **Blockchain anchoring**: Register data hashes on-chain for immutable provenance
- **Browser + Node.js**: Works in both environments with native `fetch`
- **TypeScript first**: Full type definitions included

## Security model

What the SDK checks, and what it does not:

- **`content_hash`** is recomputed on every download. It proves the content matches the hash
  stored next to it, not who wrote either: anyone can compute it.
- **Notary signatures** prove that the notary key signed this exact `data` together with a
  timestamp. The timestamp is the gateway's claim, not independent proof of time: whoever
  holds the notary key can sign any timestamp. For time you can verify, anchor the hash
  on-chain. By default the expected notary address comes from the gateway that served the
  document; pass `notaryAddress` to `download()` to verify independently of the gateway.
  See [What `verified` means](#what-verified-means).
- **On-chain anchoring** (`/chain`) proves that an address registered a hash at a block time.
  It does not prove anything about content the hash was not computed from.
- **Keys:** in browsers use the injected wallet: `fromEip1193Provider(window.ethereum)` for
  `/chain` writes, and a viem wallet client over `custom(window.ethereum)` for x402 payments
  (see [x402 Payment Mode](#x402-payment-mode)). On servers load keys from the environment or a
  secret store. A private key in browser code is public.
- **Default gateway is production:** `https://provenance-gateway.datafund.io`. Pass
  `gatewayUrl` to use another (e.g. `https://provenance-gateway.dev.datafund.io` for testing).
- **Data expires.** Swarm storage is rented: data stays available only while the postage stamp
  it was uploaded with is valid. Pool stamps come with roughly a day left; extend the stamp
  through the gateway (`PATCH /api/v1/stamps/{id}/extend`) if you need it longer. A Swarm
  reference is not a permanent archive.

## API

### `ProvenanceClient`

```typescript
const client = new ProvenanceClient({
  gatewayUrl?: string,          // default: https://provenance-gateway.datafund.io
  timeout?: number,             // default: 30000ms
  payment?: PaymentMode,        // default: 'free' (see x402 Payment Mode)
  retry?: GatewayRetryConfig,   // auto-retry on 502/503/429 (default: 2 retries, 1s backoff)
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
// }
```

### Download

```typescript
const result = await client.download(reference, {
  verify?: boolean,         // Verify notary signatures (default: true)
  notaryAddress?: string,   // Notary to trust; default: the address the gateway reports
});

// Returns:
// {
//   file: Uint8Array,            // Decoded content
//   metadata: ProvenanceMetadata,
//   verified?: boolean,          // see "What verified means" below
//   verification?: SignatureVerification,  // expected signer, its source, per-signature results
//   signatures?: NotarySignature[],
// }
```

#### What `verified` means

`verified: true` means at least one signature on the document is an EIP-191 signature
that recovers to the expected notary address over `sha256(canonical JSON of data) | timestamp`
(the gateway's scheme). Each such signature binds the exact data on its own; other
signatures (an uploader's own, or one by an earlier notary key, which the gateway keeps
when it appends its signature) do not affect it, and every signature's result is in
`verification.results`. It fails closed: if no signature is a valid one by the expected
notary (empty, missing or malformed signatures, other keys, changed data, or no expected
address), `verified` is `false`. It is `undefined` when the document carries no signatures
or with `verify: false`, so check `verified === true` rather than `!== false`.
A malformed `notaryAddress` throws `ProvenanceError` (`INVALID_INPUT`).

The expected address is `notaryAddress` if you pass it, otherwise the one the gateway
reports at `/api/v1/notary/info` (`verification.expectedSignerSource` says which). The
default therefore trusts the gateway that served the document; pin `notaryAddress` to
verify independently of it.

Canonical JSON is the convention shared with the gateway and the Python tools:
`json.dumps(data, sort_keys=True, separators=(',', ':'))`. It is also what `content_hash`
covers for raw documents (`raw: true`); documents from SDK 0.6.x, which hashed
`JSON.stringify(data)`, still pass the content-hash check. `content_hash` alone proves
nothing about who wrote the data: anyone can compute it.

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
  PaymentError,
  PaymentConfigurationError,
  PaymentRateLimitError,
} from '@datafund/swarm-provenance';

try {
  await client.upload(content);
} catch (error) {
  if (error instanceof PaymentRateLimitError) {
    console.error('Rate limited, retry after:', error.retryAfterSeconds, 'seconds');
  } else if (error instanceof PaymentConfigurationError) {
    console.error('Missing @x402 packages:', error.message);
  } else if (error instanceof StampError) {
    // error.code may be 'POOL_EXHAUSTED' when pool is empty
    console.error('Stamp acquisition failed:', error.message);
  } else if (error instanceof GatewayConnectionError) {
    console.error('Gateway error:', error.statusCode, error.message);
    if (error.suggestion) {
      console.error('Suggestion:', error.suggestion);
    }
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
// => { valid, dataHashValid, signerValid?, recoveredAddress?, error? }
// valid is false without an expectedSigner. For raw documents with floats or
// integers beyond 2^53, pass the canonical text of `data` as a 4th argument:
// canonicalizeJsonText(responseText, ['data']), or ['metadata', 'data'] for a
// wrapped {metadata: {...}, signatures: [...]} response.
```

## Blockchain Anchoring (`/chain`)

The chain module provides on-chain data provenance via a DataProvenance smart contract. It uses [viem](https://viem.sh) as an optional peer dependency (see [Installation](#installation)).

### `ChainClient`

```typescript
import { ChainClient } from '@datafund/swarm-provenance/chain';

const chain = new ChainClient({
  chain: 'base-sepolia',     // or a custom ChainPreset ('base' exists but has no contract yet: it throws)
  rpcUrl?: string,            // override RPC endpoint; a URL outside the preset's list disables its fallbacks
  rpcFallbacks?: string[],    // tried in order on any error but a revert; defaults to the preset's, [] disables
  signer?: ChainSigner,       // required for write operations
  retry?: RetryConfig,        // auto-retry on nonce errors (default: 2 retries, 1s backoff)
});
```

Reads fail over to the next RPC URL on any error except a contract revert or a user rejection
(that includes HTTP 4xx such as 401/429, so a bad API key on your primary is masked by the
fallbacks; check `healthCheck()` against a client built with `rpcFallbacks: []` if that matters).
With fallbacks the list is tried at most twice per call (a single URL keeps viem's default 3 retries).
`chain: 'base-sepolia'` (or `chain: BASE_SEPOLIA`) tries `base-sepolia-rpc.publicnode.com`, then `base-sepolia.gateway.tenderly.co`,
then `sepolia.base.org` (`PRESET_RPC_FALLBACKS`). Setting `rpcUrl` to one of those keeps failover to
the others; any other URL disables the preset's fallbacks, so reads meant for a private endpoint never
go to public ones. Built-in fallbacks are not on the preset objects, so a spread copy
(`{ ...BASE_SEPOLIA, rpcUrl }`) has none unless you give it `rpcFallbacks`. Presets and `CHAIN_PRESETS` are
frozen and typed `Readonly` (assigning to them was possible before; spread a copy instead).

`healthCheck()` now makes a real `eth_call` to the configured contract (previously `eth_chainId`):
it returns false for a wrong or undeployed contract address, and with fallbacks returns true if any
URL can serve the call.
Sending transactions goes through the signer's own transport and does not fail over; waiting
for the receipt uses the read client and does.

### Read Operations (no signer required)

```typescript
// Check if a hash is registered on-chain
await chain.verifyOnChain(dataHash);  // => boolean

// Get full provenance record
await chain.getDataRecord(dataHash);
// => { dataHash, owner, timestamp, dataType, status, accessors, transformationLinks }

// Get all records owned by an address
await chain.getUserDataRecords('0x...');  // => string[]
await chain.getUserDataRecordsCount('0x...');  // => number
await chain.getUserDataRecordsPaginated('0x...', 0, 10);  // => string[]

// Check if an address has accessed a hash
await chain.hasAddressAccessed(dataHash, '0x...');  // => boolean

// Check delegate authorization
await chain.isAuthorizedDelegate(owner, delegate);  // => boolean

// Transformation links and parents (v2 contract)
await chain.getTransformationLinks(dataHash);
// => TransformationLink[] ({ newDataHash, description })
await chain.getTransformationParents(dataHash);  // => string[]
await chain.getChildHashes(dataHash);  // => string[]

// Traverse full provenance chain (BFS, bidirectional)
await chain.getProvenanceChain(dataHash, 10);
// => ChainProvenanceRecord[]: ancestors + descendants up to maxDepth, in BFS order (not topological).
//    Edges: transformationLinks (children) and parents. Rejects if any lookup fails.

// Detect v2 contract support
await chain.supportsTransformationLinks();  // => boolean

// Health check and balance
await chain.healthCheck();  // => boolean (never throws); a real eth_call to the contract, via any fallback
await chain.getBalance();  // => { address, balanceWei, balanceEth, chain }
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

// Record 1-to-1 transformation
await chain.recordTransformation(originalHash, newHash, 'filtered PII');

// Record N-to-1 merge transformation (v2 contract)
await chain.mergeTransform(
  [sourceHash1, sourceHash2],
  mergedHash,
  'combined datasets',
  'merged',  // data type (default: 'merged')
);

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

// Private key (Node.js / scripts; from the environment, never hard-coded)
const signer = await fromPrivateKey(process.env.ANCHOR_PRIVATE_KEY as `0x${string}`, 'https://base-sepolia-rpc.publicnode.com');

// Existing viem WalletClient
const signer = fromViemWalletClient(walletClient);
```

### Chain Error Handling

```typescript
import {
  ChainConfigurationError,
  ChainTransactionError,
  ReceiptTimeoutError,
  SignerRequiredError,
} from '@datafund/swarm-provenance/chain';

try {
  await chain.anchor(hash, 'dataset');
} catch (error) {
  if (error instanceof SignerRequiredError) {
    console.error('Connect a wallet first');
  } else if (error instanceof ChainConfigurationError) {
    // Before anything was sent: wrong chain (RPC or wallet), or no contract at the address
    console.error(error.message);
  } else if (error instanceof ReceiptTimeoutError) {
    // Sent, but no receipt yet: it may still confirm. Do not resend; resume instead.
    // (If the tx was sped up and the original has left the mempool, viem cannot
    // see the replacement: look up the new hash in the wallet and wait on that.)
    await chain.waitForTransaction(error.txHash as `0x${string}`, error.expected);
  } else if (error instanceof ChainTransactionError) {
    // Reverted, or succeeded without the contract's event (nothing recorded); error.txHash is set
    console.error('Transaction failed:', error.message);
    // error.originalError has the full viem error (not enumerable: it may contain the RPC URL)
  }
}
```

**Write safety.** Before the first write a client checks that its RPC is on the preset's chain
and that the contract address holds code; before every write it checks the signer's chain
(`fromEip1193Provider` asks the wallet to switch, adding the chain if it does not know it, and sends with `chainId` so the wallet refuses another network). A write counts as done only if the receipt
contains the contract's event (`DataRegistered`, `DataAccessed`, ...; one per item for batch
writes); a transaction sped up in the wallet reports the hash that landed, a cancelled one is an error. Pre-checks that fail on an RPC error are reported, not skipped. Chain error messages
never include RPC URLs (they often embed API keys).

### Troubleshooting: `Cannot find package 'viem'`

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'viem' imported from .../@datafund/swarm-provenance/dist/chain/index.js
```

The `/chain` entry point needs the optional peer dependency `viem`, which npm does not install
automatically. Fix: `npm install viem` (>= 2.0.0). The CommonJS build (`require`) says this
directly. The ESM build cannot: Node resolves every `import` before any SDK code runs, so the
message comes from Node itself.

### Supported Networks

| Network | Preset | Contract | RPC (primary, then fallbacks) |
|---------|--------|----------|-------------------------------|
| Base Sepolia (testnet) | `base-sepolia` | `0x3945aDfd5Df9ab2F5cB4Ca0eb3D4384CC3650322` | publicnode → tenderly → sepolia.base.org |
| Base (mainnet) | `base` | Not yet deployed: `new ChainClient({ chain: 'base' })` throws `ChainConfigurationError` | mainnet.base.org |

### Behavior changes since v0.6.1

- `getProvenanceChain()` fails closed: an RPC error on any node rejects the call with
  `ChainConnectionError` naming the node, and a linked hash that reads as unregistered
  rejects with `DataNotRegisteredError`. Before, either case silently dropped the branch
  and returned the partial graph as if complete.
- `getProvenanceChain()` rejects a `NaN` `maxDepth` (`ChainValidationError`); before, NaN
  disabled the depth limit. Fractional depths are floored.
- Records from `getProvenanceChain()` carry `parents` (new, optional; additive).
- `healthCheck()` makes a real `eth_call` to the configured contract instead of `eth_chainId`
  (false for a wrong contract address; true if any fallback RPC serves the call).
- The `base-sepolia` default RPC is `base-sepolia-rpc.publicnode.com` with fallbacks (see above);
  presets and `CHAIN_PRESETS` are frozen and typed `Readonly`.
- The CommonJS `/chain` entry throws a `CHAIN_CONFIGURATION` error naming `viem` when it is missing.
- `download()` / `downloadDocument()` verify notary signatures cryptographically (#113).
  `verified` is now `false` for documents 0.6.1 reported as verified: empty, missing or
  invalid signatures, signatures by other keys, and any document when no notary address is
  available. Results gain `verification`; `DownloadOptions` gains `notaryAddress`
  (a malformed one throws `INVALID_INPUT`).
- `verifySignature` / `verifyAllSignatures` are invalid without an expected signer;
  `verifyAllSignatures([])` gives `allValid: false` (was `true`) and now also returns
  `anyValid`. `verifyDataHash` accepts only `hashed_fields: ['data']`.
- Raw documents (`raw: true`): `content_hash` is SHA-256 of canonical JSON (the gateway and
  Python tools' convention) instead of `JSON.stringify(data)` (#114). This version still
  accepts the old form; SDK 0.6.x rejects documents uploaded with this version.
- Chain writes (#115-#118): `ChainSigner` requires `getChainId()` (and may implement
  `switchChain()`); writes refuse a wrong RPC or signer chain and an address without contract
  code; success requires the contract's event in the receipt (else `ChainTransactionError`
  with `txHash`); a missing receipt is `ReceiptTimeoutError` (a `ChainConnectionError`) with
  `txHash`, resumable with `waitForTransaction()`; RPC read errors in pre-checks (already
  registered? duplicate transformation?) are thrown instead of ignored; error messages no
  longer contain RPC URLs, and `ChainTransactionError.originalError` is not enumerable.
- `PaymentWallet` is a type, not an interface: it requires `address` or `account.address`.
  A viem `WalletClient` typechecks without casts; `interface X extends PaymentWallet` needs
  to become an intersection type.

### Breaking Changes in v0.5.0

The v2 contract update changes the `ChainProvenanceRecord` type:

```typescript
// Before (v0.4.x)
record.transformations  // string[]

// After (v0.5.0)
record.transformationLinks  // TransformationLink[] ({ newDataHash, description })
```

The `ChainTransformation` type is deprecated — use `TransformationLink` instead.

## Demo App

A reference React app is available at `examples/web-app/` with upload, download, notary signing, blockchain anchoring, merge transformations, and provenance chain traversal:

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
