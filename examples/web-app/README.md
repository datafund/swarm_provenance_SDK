# Swarm Provenance Demo

A simple React app demonstrating the `@datafund/swarm-provenance` SDK.

## Features

- Gateway health check
- Upload text or files to Swarm
- Optional notary signing
- Download by reference
- View metadata and verification status

## Quick Start

```bash
# From the web-app directory
pnpm install
pnpm dev
```

Open http://localhost:5173

## How It Works

The app uses the SDK's `ProvenanceClient`:

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

### Test Coverage

- Page loads correctly
- Gateway health check displays status
- No console errors (including CORS)
- Upload/download UI elements present
- Full upload and download cycle

## Development

```bash
pnpm install      # Install dependencies
pnpm dev          # Start dev server
pnpm build        # Build for production
pnpm test         # Run e2e tests
```

## Screenshot

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
└─────────────────────────────────────────┘
```
