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
- `PaymentWallet` changed from an interface to a type: the wallet methods
  (`PaymentWalletMethods`) combined with either `address` or `account.address`. It still accepts
  a wallet with `address`, and now also one with `account.address`, such as a viem
  `WalletClient`. Code that
  has `interface X extends PaymentWallet` must use an intersection type. (#122, PR #136)
- `download()` and `downloadDocument()` report `verified: false` for documents that 0.6.1
  reported as verified. This covers signature entries whose signature value is empty, missing
  or invalid, signatures by other keys, and every document when no notary address is available.
  A document with no signatures still gets `verified: undefined`, as in 0.6.1. (#113)
- `verified` is now `true` when at least one signature by the expected notary is valid
  (`anyValid`). 0.6.1 required every signature to pass (`allValid`), but it never checked the
  signature bytes, only the data hash and the signer field. So a document with one valid notary
  signature and one with a wrong data hash or a different signer changed from
  `verified: false` to `true`. Check `verification.results` to see each signature.
  (#113, PR #135)
- When the notary address lookup fails, the download returns `verified: false` with
  `verification.error`. In 0.6.1 the download rejected. (#113, PR #135)
- `verifySignature()` and `verifyAllSignatures()` report every signature as invalid without an
  expected signer. `verifyAllSignatures([])` returns `allValid: false` (it returned `true`).
  `verifyDataHash()` and `verifySignature()` accept only the gateway's notary scheme: `type`
  `'notary'`, `hashed_fields: ['data']`, the message format `'{data_hash}|{timestamp}'`, a
  non-empty `timestamp`, and string `signer` and `signature` values. Other signature types are
  invalid. (#113)
- Raw documents (`raw: true`) use SHA-256 of canonical JSON as `content_hash`. This version
  still reads the old form. SDK 0.6.x hashed `JSON.stringify(data)`. The canonical form also
  sorts keys, escapes every non-ASCII character as `\uXXXX`, and prints floats the way Python's
  `repr` does. So SDK 0.6.x rejects a document uploaded with this version unless its keys are
  sorted, its strings are plain ASCII, and its numbers print the same in both forms. (#114)
- `ChainSigner` requires `getChainId()`, and `sendTransaction()` receives an optional
  `chainId`. The parameter type of `fromViemWalletClient()` now requires `getChainId()`, so
  hand-typed mocks without it no longer typecheck. (#115, PR #139)
- A config with only `payment.network: 'eip155:8453'` now pays in mainnet USDC on the
  gateway's x402 v1 path too. Before, it paired with Base Sepolia for v1. (#108)
- A config with only a known `payment.v1Network` now also sets `network`. In 0.6.1, a config with
  only `v1Network: 'base'` paid x402 v2 on Base Sepolia and v1 on mainnet. In 0.7.0 it pays on
  mainnet on both paths, and so requires `maxAmount`. A lone unknown `v1Network` is a
  configuration error. (#108, PR #140)
- An unknown CAIP-2 `payment.network` without `payment.v1Network` is a configuration error.
  0.6.1 used `'base-sepolia'` for v1. (#108, PR #140)
- In x402 mode, `new ProvenanceClient()` throws `PaymentConfigurationError` for an invalid
  payment config, such as a mainnet config without `maxAmount`. In 0.6.1 the constructor threw
  nothing. (#106, PR #138)
- `new ProvenanceClient()` throws `INVALID_INPUT` when `maxUploadBytes` is not a positive
  integer. (#112)
- In x402 mode, `acquireStamp()` and `upload()` without `stampId` no longer pay for pool
  stamps unless `payment.payForPool` is `true`. Without it, a 402 from the pool throws
  `StampError`. (#109)
- In x402 mode, reads use the free tier instead of being paid. Set `payForReads` to pay for
  them. (#106)
- In x402 mode, a rate-limited read now throws `PaymentRateLimitError` with a `payForReads`
  hint. In 0.6.1, x402 mode retried a 429. (#106)
- `download()` and `downloadDocument()` throw `INVALID_INPUT` for a `reference` that is not 64
  or 128 hex characters (with an optional `0x` prefix). (#123)
- `fromPrivateKey` is not in browser builds of `@datafund/swarm-provenance/chain`. Any runtime
  or bundler that resolves the `browser` export condition gets the build without it. (#123)
- The `@x402/fetch` and `@x402/evm` peer range is `>=2.5.0 <2.29.0`. (#106, #110)
- `ChainClient.healthCheck()` makes a real `eth_call` to the contract
  (`getUserDataRecordsCount`) instead of `eth_chainId`. It returns `false` for a wrong contract
  address. (#101, PR #105)
- `BASE_SEPOLIA`, `BASE_MAINNET` and `CHAIN_PRESETS` are frozen and typed `Readonly`. TypeScript
  and strict-mode code reject changes to them. Sloppy-mode CommonJS code ignores the change
  silently. (#101, PR #105)
- For the three idempotency stop codes (`IDEMPOTENCY_KEY_SETTLEMENT_UNKNOWN`,
  `IDEMPOTENCY_KEY_SETTLED_PENDING`, `IDEMPOTENCY_KEY_DELIVERED_NOT_STORED`), `acquireStamp()`
  and notary uploads throw the new `PaymentOutcomeError` instead of `StampError` or
  `NotaryError`. (#102)
- In `'free'` mode, a 429 whose code is not a rate limit no longer throws
  `PaymentRateLimitError`. The call throws an error with the gateway's code instead. Examples
  are `DAILY_STAMP_ALLOWANCE_EXHAUSTED`, `DAILY_SPEND_BUDGET_EXHAUSTED` and
  `FREE_QUOTA_EXCEEDED`. In every mode, such a 429 is not retried. (#112)
- In x402 mode, failures inside the payment library are no longer `GatewayConnectionError`
  (`CONNECTION_FAILED`). A failure before the payment is sent throws `PaymentError` with code
  `PAYMENT_FAILED`. A failure after the payment is sent throws `PaymentError` with code
  `PAYMENT_UNCONFIRMED` and carries `error.payment`. A signature rejected in the wallet throws
  `PaymentRefusedError`. Code that catches `GatewayConnectionError` around x402 calls no longer
  catches these. (#106, #107, PR #138; #112)
- In any mode, a success response whose body is not valid JSON throws `GatewayConnectionError`
  with code `INVALID_RESPONSE` and the HTTP status. This applies to `pricing()`, `acquireStamp()`,
  `upload()`, `download()`, `downloadDocument()`, `notaryInfo()` and `poolStatus()`. Before, a
  raw `SyntaxError` escaped. `download()`, `downloadDocument()`, `notaryInfo()` and
  `poolStatus()` also throw it for a success body that cannot be read, is not a JSON object, or
  lacks the fields the method needs. Before, a raw `TypeError` escaped or `notaryInfo()` returned
  empty values. `downloadDocument()` reports a record with no `data` field or no `content_hash`
  as `INVALID_RESPONSE`, not `CONTENT_HASH_MISMATCH`. If the request was paid, the error carries
  `error.payment`. (#107, PR #138; #173, #179)
- `fromEip1193Provider` and `fromViemWalletClient` signers implement `switchChain()`. A write
  on the wrong chain now asks the wallet to switch. Wallet users see a new prompt.
  `fromViemWalletClient` does this only when the client has `switchChain`. (#115, PR #139)
- If the wallet does not know the chain, it is asked to add it. This happens only for the
  built-in presets, and with `fromViemWalletClient` only when the client has `addChain`. A
  custom preset's chain must be added to the wallet by hand. (#115, PR #139)

### Payments (x402 mode)

- The SDK checks every 402 before anything is signed: amount up to `maxAmount`, USDC only
  (or `asset` with `assetDecimals`), scheme `exact` with EIP-3009 only, validity up to
  `payment.maxTimeoutSeconds` (default 600), and optional `payTo` and `onBeforePayment`. A
  refused payment throws `PaymentRefusedError`. (#106)
- An attempt that sent a payment is not retried. Its error carries `error.payment`. (#107)
  The one exception is a paid write answered `IDEMPOTENCY_KEY_IN_PROGRESS` (409) or
  `IDEMPOTENCY_UNAVAILABLE` (503). It is retried with the same key and a new authorization, at
  most 3 signatures per request. (#102)
- On `@x402/*` 2.23 and later, `maxAmount` replaces the library's $1 default cap. (#110)
- `payment.network: 'base' | 'base-sepolia'` sets both x402 network identifiers. Settings that
  disagree are a configuration error. The default stays Base Sepolia. (#108)
- Paid writes send an `Idempotency-Key`, so a retry with the same key does not pay twice.
  `upload()` and `acquireStamp()` take your own key in the `idempotencyKey` option. (#102)
- Errors after a payment carry `payment.idempotencyKey`, and `payment.stampId` for uploads.
  (#102)
- Attempts that may pay, and owner-proof uploads, use the new `paidTimeout` option instead of
  `timeout`. Its default is the larger of `timeout` and 120 seconds. (#102, #124)
- Paid results carry the payment receipt in `payment`, and `stampPayment` when `upload()` paid
  for its pool stamp. (#111)
- Errors from `upload()` after a pool acquisition carry `stampId`, and `stampPayment` when the
  stamp was paid for. (#111)
- `error.payment` gains `network`, `payer`, `amount`, `amountDecimal` and `asset` when the
  gateway sent a receipt header, and `replayed` on an idempotent replay. (#111)
- The policy reads the 402's top-level payment request before the deprecated `detail` copy.
  (#112)
- A paid request that times out says it may have been charged and is not retried. (#119)
- In `'free'` and `'none'` modes, a pool 402 is still a `StampError`. Its code is now the
  gateway's code, or `PAYMENT_REQUIRED`. (#109)
- An unpaid pool acquisition carries no `Idempotency-Key`. The pool's `StampError` message says
  how to continue. (#109)
- x402 mode on Node 18 without Web Crypto throws `PaymentConfigurationError` that says how to
  fix it. Before, the library failed with an unclear error. (#106, PR #138)

### Verification

- Notary signatures are checked cryptographically. Download results gain `verification`.
  `DownloadOptions` gains `notaryAddress`. (#113)
- A malformed `notaryAddress` throws `INVALID_INPUT`. (#113)
- `verifyAllSignatures()` also returns `anyValid`. (#113)
- `recoverSigner()` works and is exported. In 0.6.1 it threw `NOT_IMPLEMENTED`. (#113, PR #135)
- New runtime dependency: `@noble/curves` `^1.9.1`, used for signature recovery.
  (#113, PR #135)
- `downloadDocument()` accepts genuine notary signatures that 0.6.1 rejected. (#114)
- The README and docs state only the guarantees the code gives. The content-hash check is a
  self-consistency check only. (#122, #123)

### Chain

- Writes refuse a wrong RPC or signer chain and a contract address without code. (#115)
- `ChainSigner` may implement `switchChain()`. The built-in wallet signers do; see Breaking
  changes. (#115)
- A write succeeds only when the contract's event is in the receipt. Otherwise it throws
  `ChainTransactionError` with `txHash`. (#116)
- A missing receipt throws `ReceiptTimeoutError` with `txHash`. Resume with the new
  `ChainClient.waitForTransaction()` method. (#117)
- Error messages no longer contain RPC URLs or request bodies. (#118)
- `ChainTransactionError.originalError` is not enumerable. (#118)
- RPC read errors in the pre-checks before a write (already registered, duplicate
  transformation) are thrown instead of ignored. (#116, PR #139)
- `ChainClient` fails over between RPC endpoints. The new `ChainClientConfig.rpcFallbacks`
  option sets the fallback list. An explicit `rpcUrl` that is not one of the preset's URLs gets
  no public fallbacks unless you set `rpcFallbacks`. (#101, PR #105)
- `ChainPreset` has a new optional `rpcFallbacks` field for custom presets. (#101, PR #105)
- The `base-sepolia` primary RPC is `base-sepolia-rpc.publicnode.com`. `sepolia.base.org` is no
  longer the primary; it is the last fallback. (#101, #86)
- `getProvenanceChain()` records carry `parents`. (#100)
- `getProvenanceChain()` fails closed. An RPC error in a node's child or parent lookup now
  throws `ChainConnectionError` naming the node. A linked hash that reads as unregistered throws
  `DataNotRegisteredError`. 0.6.1 already threw an RPC error from a node's own record read, but
  it ignored errors from the child and parent lookups and skipped unregistered linked hashes.
  It then returned the partial graph. (#100, PR #132)
- `getProvenanceChain()` throws `ChainValidationError` for a `NaN` `maxDepth`. Before, `NaN`
  turned off the depth limit. (#100, PR #132)
- A fractional `maxDepth` is floored. Before, it was used as given. (#100, PR #132)
- The CommonJS `/chain` entry throws an error that names `viem` when viem is missing. (#99)
- Chain writes no longer retry "replacement underpriced". (#123)
- For every signer, a send that fails with "replacement underpriced" or "already known" throws
  `ChainTransactionError` that says the transaction may still confirm. (#123)
- A `fromPrivateKey` signer handles "already known" itself: it returns the hash of the signed
  transaction, and the write waits for its receipt. Its "replacement underpriced" still throws
  the error above. (#123)
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
- Write results that echo an input address (`anchorFor().owner`,
  `transferOwnership().newOwner`, `setDelegate().delegate`) hold the address that was sent. An
  all-uppercase input comes back in lowercase. (#123)
- `getProvenanceChainResult()` is new. It says whether `maxDepth` cut the lineage off. (#123)
- `DataAlreadyRegisteredError` gains `ownedBySigner`. (#123)

### Errors and retries

- Gateway errors show the gateway's message, keep the response in `error.body`, and a 402
  message names the price. PR #170 merged this and the other #112 changes. (#112)
- Gateway error messages use the envelope's top-level `message`, except for validation errors
  (a `detail` list), which still list the fields. A `detail` text, or `detail.detail`, that the
  message lacks is appended. 0.6.1 never read the top-level `message`: it used the `detail`
  string, the `detail` list or `detail.message`, and otherwise the HTTP status. (#102, #112)
- A non-JSON 413 from the gateway's proxy throws with code `FILE_TOO_LARGE` and the message
  "Upload too large: the gateway's proxy refused the request body". (#112)
- `error.body` holds parsed JSON up to 16384 characters. A larger or non-JSON body is kept as
  text, cut to 4096 characters. Gateway messages are cut to 4096 characters. (#112)
- `health()` returns `false` when the gateway reports `status: 'critical'`. (#112)
- `upload()` refuses metadata over `maxUploadBytes` (default 10485760) with `FILE_TOO_LARGE`
  before it acquires a stamp. It also refuses invalid raw input before that. (#112)
- A signature declined in the wallet throws `PaymentRefusedError`. (#112)
- A `Retry-After` header given as an HTTP date is honoured. (#123)
- A `Retry-After` value that is neither whole seconds nor a date, such as `"1.5"`, falls back to
  the normal backoff. Before, `"1.5"` was read as 1 second. (#123)
- `isValidSwarmReference()` accepts 128-character encrypted references and the `0x` prefix.
  (#123)
- New error codes from the SDK: `PAYMENT_REFUSED` (`PaymentRefusedError`), `PAYMENT_FAILED`,
  `PAYMENT_UNCONFIRMED`, `PAYMENT_REQUIRED` (pool `StampError` without a gateway code),
  `INVALID_RESPONSE`, `FILE_TOO_LARGE` (also before any request), `OWNER_PROOF_FAILED`, and
  `INVALID_SIGNATURE` (`recoverSigner()`). (#102, #106, #107, #109, #112, #113, #124)
- Gateway codes the SDK now handles: `IDEMPOTENCY_KEY_IN_PROGRESS` and
  `IDEMPOTENCY_UNAVAILABLE` (retried), `IDEMPOTENCY_KEY_REUSED` and `IDEMPOTENCY_KEY_INVALID`
  (thrown with the gateway's code), and the three stop codes above. (#102)
- The code `NOT_IMPLEMENTED` is no longer used. (#113)
- A record in the other download method's format names the right method in the error message:
  `download()` on a raw upload says to use `downloadDocument()`, and `downloadDocument()` on a
  base64 upload says to use `download()`. The hint is given only when the record's hash proves
  its format. The codes stay `INVALID_RESPONSE` or `CONTENT_HASH_MISMATCH`. A record whose hash
  matches neither format gets no hint: the #179 message for non-string `data` in `download()`,
  else "Content hash verification failed". In browsers, `download()` reports `data` that is not
  valid base64 as `CONTENT_HASH_MISMATCH`, as in Node.js; before, a raw `InvalidCharacterError`
  escaped. A `CONTENT_HASH_MISMATCH` after a paid read now carries `error.payment`, as
  `INVALID_RESPONSE` does. (#190)

### New

- `pricing()` returns the gateway's price quotes. (#124)
- `UploadOptions.ownerSigner` uploads to a stamp you own with a signed owner proof instead of a
  payment. An owner-proof upload uses the free tier and never pays, in any payment mode. (#124)
- Upload results and `AcquiredStamp` gain `expiresAt`. (#112)
- New client options: `paidTimeout` (#102) and `maxUploadBytes` (#112). New x402 options:
  `maxAmount`, `asset`, `assetDecimals`, `payTo`, `maxTimeoutSeconds`, `onBeforePayment`,
  `payForReads` (#106) and `payForPool` (#109).
- Errors gain `body` (#112), `payment` (#107, #111), and on upload errors `stampId` and
  `stampPayment` (#111). `PaymentRefusedError` has `refusals`, `PaymentOutcomeError` has
  `outcome`, and `ReceiptTimeoutError` has `txHash`, `explorerUrl` and `expected`.
- New exports from `@datafund/swarm-provenance`:
  - Errors: `PaymentOutcomeError` (#102), `PaymentRefusedError` (#106).
  - Payment types: `PaymentReceipt` (#111), `PaymentRequest` (#106), and the type
    `PaymentAttempt` (#107).
  - Notary verification: `recoverSigner`, `computeNotaryDataHash`, `NOTARY_MESSAGE_FORMAT`,
    and the types `SignatureCheck` and `SignatureVerification` (#113).
  - Canonical JSON: `canonicalizeJsonText`, `canonicalizeJsonValue` (#114).
  - Pricing and owner proof: `Pricing`, `PricingOptions`, `PriceQuote`, `OwnerSigner`,
    `ownerProofMessage` (#124).
- New exports from `@datafund/swarm-provenance/chain`: `PRESET_RPC_FALLBACKS` (#101),
  `ReceiptTimeoutError` (#117), `rpcErrorMessage` (#118), and the types `ProvenanceChainResult`
  (#123) and `ExpectedEvent` (#116).

### CI and repository

- CI fails the build when new commits add a secret. (#121)
- A local editor settings file is removed from the repository and ignored. (#121, PR #103)
- CI runs the payment tests against `@x402/*` 2.23.0 and 2.28.0. (#110)
- Integration tests use the dev gateway by default. (#119)
- `publish.yml` publishes to npm only after the `ci.yml` matrix passes for the same commit:
  Node 18 and 20, and the payment tests against `@x402/*` 2.23.0 and 2.28.0. It installs with
  `--frozen-lockfile`. `ci.yml` runs with read-only repository access. (#174)
- `publish.yml` publishes to npm only after the secret scan passes for the pushed commits, and
  runs only one publish job at a time. The secret scan runs with read-only repository access.
  (#176)
- `publish.yml` publishes and tags only if the commit is still the tip of `main`, so an older
  push whose checks finish later cannot move npm `latest` back. If a version is on npm but its
  tag is missing on origin, a later run from the tip of `main` pushes the tag without publishing
  again. (#188, #187)

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
  - CI checks are not required on `main`. Its protection has no required status checks, so a
    pull request can be merged to `main` before its `ci.yml` checks have passed. `publish.yml`
    still publishes only after the `ci.yml` matrix passes for the merged commit (#174).
  - `development` is not a protected branch.
  - `.mcp.json` and `.claude/settings.json` run `@plur-ai` packages without a pinned version.
- `publish.yml` publishes only from the tip of `main`. A superseded version is not published,
  even when both commits pass, if the newer commit is pushed before the older commit's
  tip-check step runs: if commit A sets 0.7.0 and commit B sets 0.7.1, 0.7.0 then never reaches
  npm. A later commit with the same version publishes that version, from its own code. If the
  newest commit was pushed before the older commit's tip-check step ran, and it fails its
  checks or its push starts no run (a skip marker such as `[skip ci]`, or a push made with
  `GITHUB_TOKEN`), nothing publishes. `publish.yml` has no `workflow_dispatch`, and branch
  protection rejects a direct push to `main`. So the recovery is a new commit that a user merges
  to `main` through a pull request, without a skip marker: for example, an empty commit on a
  branch cut from `main`, merged to `main` by pull request with a merge commit (not squash or
  rebase). A `development` → `main` pull request also works, but it also releases what is on
  `development`. If a failure was flaky, re-run the failed run instead. (#188)
- A publish run from before this change has no tip check. Do not re-run it. (#188)
- If a version is on npm but its tag push failed, a later run tags the tip of `main` only if the
  tip has the same version, so the tag can land on a later commit than the one that published.
  If the tip has a different version, push the tag by hand. (#188)
- `publish.yml` does not compare versions with npm. If the tip of `main` sets an unpublished
  version lower than `latest` (for example a 0.6.2 hotfix after 0.7.0), that version publishes
  and moves `latest` back. The same happens if `main` is force-moved back to an older commit
  with an unpublished version; branch protection disables force pushes to `main` today, so this
  needs a protection change first. The workflow cannot publish such a hotfix under another tag.
  (#188)
- GitHub keeps at most one pending publish job and cancels it by queue order, not by commit. An
  older commit's job can cancel the tip commit's pending job, and then the tip check skips the
  older one, so nothing publishes. If the tip commit's publish run was cancelled, re-run it
  within GitHub's 30-day re-run window; this is safe because of the tip check. After that, merge
  a new commit to `main` through a pull request, without a skip marker. `queue: max` would
  prevent this case. It is not used because GitHub accepting the key is not checked on a real
  run, and an invalid `publish.yml` would stop both publishing and the secret scan of pushes to
  `main`. (#187)
