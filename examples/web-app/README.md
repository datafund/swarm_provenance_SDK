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
