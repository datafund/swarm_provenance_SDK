# Changelog

Release notes for `@datafund/swarm-provenance`. Versions before 0.7.0 have no entries here; see
the git tags (`v0.1.0` to `v0.6.1`).

## 0.7.0

This release contains the fixes from the 2026-09 audit. Version 0.6.1 was published on
2026-04-08 and has none of them. The full list of behavior changes, with details, is in the
README section [Behavior changes since v0.6.1](README.md#behavior-changes-since-v061).

### Breaking changes

- In x402 mode, `payment.maxAmount` is required on any network other than Base Sepolia test
  USDC. On Base Sepolia it defaults to `'1'`. (#106)
- `PaymentWallet` is now a type, not an interface. It requires `address` or `account.address`.
  Code that has `interface X extends PaymentWallet` must use an intersection type. (#106)
- `download()` and `downloadDocument()` report `verified: false` for documents that 0.6.1
  reported as verified. This covers empty, missing or invalid signatures, signatures by other
  keys, and every document when no notary address is available. (#113)
- `verifySignature()` and `verifyAllSignatures()` are invalid without an expected signer.
  `verifyAllSignatures([])` returns `allValid: false` (it returned `true`). `verifyDataHash()`
  accepts only `hashed_fields: ['data']`. (#113)
- Raw documents (`raw: true`) use SHA-256 of canonical JSON as `content_hash`. This version
  still reads the old form. SDK 0.6.x rejects documents uploaded with this version. (#114)
- `ChainSigner` requires `getChainId()`. (#115)
- A config with only `payment.network: 'eip155:8453'` now pays in mainnet USDC on the
  gateway's x402 v1 path too. Before, it paired with Base Sepolia for v1. (#108)
- In x402 mode, `acquireStamp()` and `upload()` without `stampId` no longer pay for pool
  stamps unless `payment.payForPool` is `true`. Without it, a 402 from the pool throws
  `StampError`. (#109)
- Reads use the free tier instead of being paid. Set `payForReads` to pay for them. (#106)
- `download()` and `downloadDocument()` throw `INVALID_INPUT` for a `reference` that is not 64
  or 128 hex characters (with an optional `0x` prefix). (#123)
- `fromPrivateKey` is not in browser builds of `@datafund/swarm-provenance/chain`. Any runtime
  or bundler that resolves the `browser` export condition gets the build without it. (#123)
- The `@x402/fetch` and `@x402/evm` peer range is `>=2.5.0 <2.29.0`. (#106, #110)
- `ChainClient.healthCheck()` makes a real `eth_call` to the contract
  (`getUserDataRecordsCount`) instead of `eth_chainId`. It returns `false` for a wrong contract
  address. (#101, PR #105)
- `BASE_SEPOLIA`, `BASE_MAINNET` and `CHAIN_PRESETS` are frozen and typed `Readonly`. Code that
  changes them fails. (#101, PR #105)
- For the three idempotency stop codes, `acquireStamp()` and notary uploads throw the new
  `PaymentOutcomeError` instead of `StampError` or `NotaryError`. (#102)

### Payments (x402 mode)

- The SDK checks every 402 before anything is signed: amount up to `maxAmount`, USDC only
  (or `asset` with `assetDecimals`), scheme `exact` with EIP-3009 only, validity up to
  `payment.maxTimeoutSeconds` (default 600), and optional `payTo` and `onBeforePayment`. A refused payment throws
  `PaymentRefusedError`. (#106)
- An attempt that sent a payment is not retried. Its error carries `error.payment`. (#107)
  The one exception is a paid write answered `IDEMPOTENCY_KEY_IN_PROGRESS` (409) or
  `IDEMPOTENCY_UNAVAILABLE` (503). It is retried with the same key and a new authorization, at
  most 3 signatures per request. (#102)
- On `@x402/*` 2.23 and later, `maxAmount` replaces the library's $1 default cap. (#110)
- `payment.network: 'base' | 'base-sepolia'` sets both x402 network identifiers. Settings that
  disagree are a configuration error. The default stays Base Sepolia. (#108)
- Paid writes send an `Idempotency-Key`, so a retry with the same key does not pay twice.
  Paid attempts use `paidTimeout`. Its default is the larger of `timeout` and 120 seconds.
  (#102)
- Paid results carry the payment receipt in `payment`, and `stampPayment` when `upload()` paid
  for its pool stamp. (#111)
- A paid request that times out says it may have been charged and is not retried. (#119)
- In `'free'` and `'none'` modes, a pool 402 is still a `StampError`. Its code is now the
  gateway's code, or `PAYMENT_REQUIRED`. (#109)

### Verification

- Notary signatures are checked cryptographically. Download results gain `verification`.
  `DownloadOptions` gains `notaryAddress`. (#113)
- `downloadDocument()` accepts genuine notary signatures that 0.6.1 rejected. (#114)
- The README and docs state only the guarantees the code gives. The content-hash check is a
  self-consistency check only. (#122, #123)

### Chain

- Writes refuse a wrong RPC or signer chain and a contract address without code. (#115)
- `ChainSigner` may implement `switchChain()`. (#115)
- A write succeeds only when the contract's event is in the receipt. Otherwise it throws
  `ChainTransactionError` with `txHash`. (#116)
- A missing receipt throws `ReceiptTimeoutError` with `txHash`. Resume with
  `waitForTransaction()`. (#117)
- Error messages no longer contain RPC URLs or request bodies. (#118)
- `ChainTransactionError.originalError` is not enumerable. (#118)
- RPC read errors in the pre-checks before a write (already registered, duplicate
  transformation) are thrown instead of ignored. (#115-#118)
- `ChainClient` fails over between RPC endpoints. The `base-sepolia` default RPC is
  `base-sepolia-rpc.publicnode.com` with fallbacks, not `sepolia.base.org`. (#101, #86)
- `getProvenanceChain()` records carry `parents`. (#100)
- `getProvenanceChain()` fails closed. An RPC error on any node throws
  `ChainConnectionError`, and an unregistered linked hash throws `DataNotRegisteredError`.
  Before, the branch was dropped and the partial graph returned. (#100, PR #132)
- `getProvenanceChain()` throws `ChainValidationError` for a `NaN` `maxDepth`. Before, `NaN`
  turned off the depth limit. (#100, PR #132)
- The CommonJS `/chain` entry throws an error that names `viem` when viem is missing. (#99)
- Chain writes no longer retry "replacement underpriced". (#123)
- For wallet signers, "replacement underpriced" and "already known" throw
  `ChainTransactionError` that says the transaction may still confirm. (#123)
- For `fromPrivateKey` signers, "already known" returns the hash of the signed transaction, and
  the write waits for its receipt. (#123)
- `fromPrivateKey` signers prepare, sign and send the raw transaction themselves, with the same
  steps as viem's `sendTransaction` for a local account. (#123)
- Writes check their input and throw `ChainValidationError` before any network call, instead of
  sending a transaction the contract reverts. `mergeTransform()` checks `newDataType` like the
  other data types. (#123)
- `getUserDataRecordsPaginated()` throws `ChainValidationError` for a negative or non-integer
  `offset` or `limit`. It threw `ChainConnectionError`. (#123)
- `new ChainClient()` throws `ChainConfigurationError` for a malformed `contractAddress` or a
  `gasLimit` that is not a positive integer. (#123)
- A mixed-case address with a wrong EIP-55 checksum throws `ChainValidationError` before any
  network call. An all-uppercase address is accepted and sent in lowercase. (#123)
- `getProvenanceChainResult()` is new. It says whether `maxDepth` cut the lineage off. (#123)
- `DataAlreadyRegisteredError` gains `ownedBySigner`. (#123)

### Errors and retries

- Gateway errors show the gateway's message, keep the response in `error.body`, and a 402
  message names the price. (#112)
- A 429 for a daily quota is not retried and keeps its code. (#112)
- `health()` returns `false` when the gateway reports `status: 'critical'`. (#112)
- `upload()` refuses metadata over `maxUploadBytes` (default 10485760) before it acquires a
  stamp. (#112)
- A signature declined in the wallet throws `PaymentRefusedError`. (#112)
- A `Retry-After` header given as an HTTP date is honoured. (#123)
- `isValidSwarmReference()` accepts 128-character encrypted references and the `0x` prefix.
  (#123)

PR #170 merged the #112 fix.

### New

- `pricing()` returns the gateway's price quotes. (#124)
- `UploadOptions.ownerSigner` uploads to a stamp you own with a signed owner proof instead of a
  payment. (#124)
- Upload results and `AcquiredStamp` gain `expiresAt`. (#112)
- New exports from `@datafund/swarm-provenance`:
  - Errors: `PaymentOutcomeError` (#102), `PaymentRefusedError` (#106).
  - Payment types: `PaymentReceipt` (#111), `PaymentRequest` (#106), the type `PaymentAttempt` (#107).
  - Notary verification: `recoverSigner`, `computeNotaryDataHash`, `NOTARY_MESSAGE_FORMAT`,
    and the types `SignatureCheck` and `SignatureVerification` (#113).
  - Canonical JSON: `canonicalizeJsonText`, `canonicalizeJsonValue` (#114).
  - Pricing and owner proof: `Pricing`, `PricingOptions`, `PriceQuote`, `OwnerSigner`,
    `ownerProofMessage` (#124).
- New exports from `@datafund/swarm-provenance/chain`: `PRESET_RPC_FALLBACKS` (#101),
  `ReceiptTimeoutError` (#117), `ProvenanceChainResult` (#123), `rpcErrorMessage` (#118), and
  the type `ExpectedEvent` (#116).

### CI and repository

- CI fails the build when new commits add a secret. (#121)
- A local editor settings file is removed from the repository and ignored. (#103, #121)
- CI runs the payment tests against `@x402/*` 2.23.0 and 2.28.0. (#110)
- Integration tests use the dev gateway by default. (#119)

### Release gate gaps

The release gate in #129 is not fully met. These items are open:

- The paid staging test has not been run. It is the test described in the #142 comment: a
  paid `upload()` against the staging gateway, retried with the same `idempotencyKey` and
  `stampId`. The retry must return the first reference, cause one USDC transfer on-chain, and
  carry `Idempotent-Replayed: true`. The unit tests only use a stubbed gateway. The owner will
  run this test.
- #120 is open. These of its items are not done:
  - The `viem` peer range is still `^2.0.0`. The `@x402/*` range is narrowed.
  - `publish.yml` pins its actions by tag, not by SHA.
  - `ci.yml` has no `permissions:` block.
  - CI checks are not required on `main`. Its protection has no required status checks, so a
    merge to `main` can run `publish.yml` before the `ci.yml` matrix has passed.
  - `development` is not a protected branch.
  - `.mcp.json` and `.claude/settings.json` run `@plur-ai` packages without a pinned version.
- `publish.yml` installs without `--frozen-lockfile` and runs only on Node 24. It does not run
  the Node 18 and 20 matrix or the `@x402` 2.23.0 and 2.28.0 tests. The CI run of the
  `development` to `main` pull request must cover them.
