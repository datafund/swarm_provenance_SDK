import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { ProvenanceClient } from '../../src/client.js';
import { ProvenanceError } from '../../src/errors.js';
import { sha256Hex, toBytes } from '../../src/utils.js';

// Gateway-signed documents (tests/fixtures/notary/generate.py), Hardhat #0 as notary
const FIXTURES = new URL('../fixtures/notary/', import.meta.url);
const NOTARY = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const OTHER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const REF = 'abcd1234'.repeat(8);

const read = (name: string) => readFileSync(new URL(name, FIXTURES), 'utf8');

type Route = { status: number; body: string };
let routes: Record<string, Route>;
const calls: string[] = [];

function serve(document: string, notary: Record<string, unknown> | 404 = { enabled: true, available: true, address: NOTARY }) {
  routes = {
    [`/api/v1/data/${REF}`]: { status: 200, body: document },
    '/api/v1/notary/info':
      notary === 404 ? { status: 404, body: '{"detail":"Not Found"}' } : { status: 200, body: JSON.stringify(notary) },
  };
}

vi.stubGlobal('fetch', (url: string) => {
  const path = new URL(url).pathname;
  calls.push(path);
  const route = routes[path] ?? { status: 404, body: '{}' };
  return Promise.resolve(new Response(route.body, { status: route.status, headers: { 'content-type': 'application/json' } }));
});

interface FixtureDoc {
  data: string | Record<string, unknown>;
  content_hash: string;
  signatures: Array<Record<string, unknown>>;
}

/** Re-serialise a fixture after editing it (as a malicious uploader would) */
function edit(name: string, change: (doc: FixtureDoc) => void): string {
  const doc = JSON.parse(read(name)) as FixtureDoc;
  change(doc);
  return JSON.stringify(doc);
}

beforeEach(() => {
  calls.length = 0;
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe('download() notary verification (#113)', () => {
  it('a genuine notary signature verifies against the gateway-reported address', async () => {
    serve(read('base64-document.json'));
    const result = await new ProvenanceClient().download(REF);

    expect(result.verified).toBe(true);
    expect(result.verification).toMatchObject({ expectedSigner: NOTARY, expectedSignerSource: 'gateway' });
    expect(result.verification?.results[0]?.recoveredAddress).toBe(NOTARY.toLowerCase());
  });

  it('with notaryAddress pinned, it verifies without asking the gateway', async () => {
    serve(read('base64-document.json'), { enabled: true, available: true, address: OTHER.address });
    const result = await new ProvenanceClient().download(REF, { notaryAddress: NOTARY });

    expect(result.verified).toBe(true);
    expect(result.verification?.expectedSignerSource).toBe('option');
    expect(calls).not.toContain('/api/v1/notary/info');
  });

  it('a pinned notaryAddress that did not sign gives verified: false', async () => {
    serve(read('base64-document.json'));
    const result = await new ProvenanceClient().download(REF, { notaryAddress: OTHER.address });
    expect(result.verified).toBe(false);
  });

  it.each([
    ['address: null', { enabled: false, available: false, address: null }],
    ['no address', { enabled: false, available: false }],
    ['notary endpoint missing (404)', 404 as const],
  ])('with no expected signer (%s), verified is false, not true', async (_label, notary) => {
    serve(read('base64-document.json'), notary);
    const result = await new ProvenanceClient().download(REF);

    expect(result.verified).toBe(false);
    expect(result.verification?.expectedSignerSource).toBe('none');
  });

  it.each([
    ['empty signature', (s: Record<string, unknown>) => (s['signature'] = '')],
    ['missing signature', (s: Record<string, unknown>) => delete s['signature']],
    ['invalid signature bytes', (s: Record<string, unknown>) => (s['signature'] = 'ab'.repeat(64) + '05')],
    ['format string pointing elsewhere', (s: Record<string, unknown>) => (s['signed_message_format'] = 'x')],
  ])('%s gives verified: false', async (_label, mutate) => {
    serve(edit('base64-document.json', (doc) => mutate(doc.signatures[0]!)));
    expect((await new ProvenanceClient().download(REF)).verified).toBe(false);
  });

  it('a well-formed signature by another key, declaring the notary, gives verified: false', async () => {
    serve(
      await (async () => {
        const doc = JSON.parse(read('base64-document.json')) as FixtureDoc;
        const sig = doc.signatures[0]!;
        sig['signature'] = await OTHER.signMessage({ message: `${String(sig['data_hash'])}|${String(sig['timestamp'])}` });
        return JSON.stringify(doc);
      })(),
    );
    expect((await new ProvenanceClient().download(REF)).verified).toBe(false);
  });

  it('a forged document (new data, consistent content_hash, copied signature) gives verified: false', async () => {
    const forgedContent = toBytes('forged');
    serve(
      edit('base64-document.json', (doc) => {
        doc.data = Buffer.from(forgedContent).toString('base64');
        doc.content_hash = sha256Hex(forgedContent);
      }),
    );
    const result = await new ProvenanceClient().download(REF);
    expect(result.verified).toBe(false);
    expect(result.verification?.results[0]?.dataHashValid).toBe(false);
  });

  it('verify: false skips the check and the notary lookup', async () => {
    serve(read('base64-document.json'));
    const result = await new ProvenanceClient().download(REF, { verify: false });
    expect(result.verified).toBeUndefined();
    expect(calls).not.toContain('/api/v1/notary/info');
  });
});

describe('downloadDocument() (#114)', () => {
  it('a genuine notary-signed raw document verifies (floats, big ints, unicode, unsorted keys)', async () => {
    serve(read('raw-document.json'));
    const result = await new ProvenanceClient().downloadDocument(REF);

    expect(result.verified).toBe(true);
    expect(result.verification?.results[0]?.dataHashValid).toBe(true);
  });

  it('a document produced by the Python tools passes the content-hash check', async () => {
    // content_hash in the fixture is sha256(json.dumps(data, sort_keys=True, separators=(',', ':')))
    serve(read('raw-document.json'));
    await expect(new ProvenanceClient().downloadDocument(REF, { verify: false })).resolves.toBeDefined();
  });

  it('a document uploaded by SDK 0.6.x (content_hash over JSON.stringify) still passes', async () => {
    const data = { b: 1, a: 'é' };
    serve(JSON.stringify({ data, content_hash: sha256Hex(JSON.stringify(data)), stamp_id: 'c'.repeat(64) }));
    await expect(new ProvenanceClient().downloadDocument(REF)).resolves.toMatchObject({ document: data });
  });

  it('a wrong content_hash is still rejected', async () => {
    serve(edit('raw-document.json', (doc) => (doc.content_hash = '0'.repeat(64))));
    await expect(new ProvenanceClient().downloadDocument(REF)).rejects.toThrow(ProvenanceError);
  });

  it('tampered data under a genuine signature gives verified: false', async () => {
    // Edit the stored text in place (everything else byte-identical) and fix up
    // content_hash, so only the signature check can catch it
    const original = read('raw-document.json');
    expect(original).toContain('"zeta": 1,');
    let text = original.replace('"zeta": 1,', '"zeta": 2,');
    const { canonicalizeJsonText } = await import('../../src/canonical-json.js');
    const oldHash = (JSON.parse(original) as { content_hash: string }).content_hash;
    // content_hash comes first in the text; data_hash in the signature (same value) stays
    text = text.replace(oldHash, sha256Hex(canonicalizeJsonText(text, ['data'])!));
    serve(text);

    const result = await new ProvenanceClient().downloadDocument(REF);
    expect(result.verified).toBe(false);
    expect(result.verification?.results[0]?.dataHashValid).toBe(false);

    // Control: the untouched original verifies
    serve(original);
    expect((await new ProvenanceClient().downloadDocument(REF)).verified).toBe(true);
  });
});
