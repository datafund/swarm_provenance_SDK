import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import {
  verifyDataHash,
  verifySignature,
  verifyAllSignatures,
  reconstructSignedMessage,
  recoverSigner,
  computeNotaryDataHash,
} from '../../src/notary.js';
import { canonicalizeJsonText } from '../../src/canonical-json.js';
import { VerificationError } from '../../src/errors.js';
import type { NotarySignature } from '../../src/types.js';

// Signed by the gateway's own ProvenanceService (see tests/fixtures/notary/generate.py)
// with Hardhat account #0, a publicly known test key.
const FIXTURES = new URL('../fixtures/notary/', import.meta.url);
const NOTARY = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const OTHER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // Hardhat #1

interface SignedDoc {
  data: string | Record<string, unknown>;
  content_hash: string;
  stamp_id: string;
  signatures: NotarySignature[];
}

function fixture(name: string): { text: string; doc: SignedDoc; sig: NotarySignature; canonical: string } {
  const text = readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8');
  const doc = JSON.parse(text) as SignedDoc;
  return { text, doc, sig: doc.signatures[0]!, canonical: canonicalizeJsonText(text, ['data'])! };
}

/** A signature over `${data_hash}|${timestamp}` made with an arbitrary key */
async function signWith(key: `0x${string}`, dataHash: string, timestamp: string): Promise<string> {
  return privateKeyToAccount(key).signMessage({ message: `${dataHash}|${timestamp}` });
}

describe('recoverSigner', () => {
  it('recovers the notary from a gateway signature (hex without 0x, v = 27/28)', () => {
    const { sig } = fixture('base64-document');
    expect(sig.signature.startsWith('0x')).toBe(false);
    expect(recoverSigner(`${sig.data_hash}|${sig.timestamp}`, sig.signature)).toBe(NOTARY.toLowerCase());
  });

  it('accepts a 0x prefix and v as 0/1', () => {
    const { sig } = fixture('base64-document');
    const v = parseInt(sig.signature.slice(128), 16) - 27;
    const zeroOne = `0x${sig.signature.slice(0, 128)}${v.toString(16).padStart(2, '0')}`;
    expect(recoverSigner(`${sig.data_hash}|${sig.timestamp}`, zeroOne)).toBe(NOTARY.toLowerCase());
  });

  it.each([
    ['empty', ''],
    ['placeholder', '0xsignature'],
    ['too short', '0x' + 'ab'.repeat(64)],
    ['bad v', '0x' + 'ab'.repeat(64) + '05'],
    ['not hex', 'zz'.repeat(65)],
  ])('throws INVALID_SIGNATURE for a %s signature', (_label, signature) => {
    expect(() => recoverSigner('msg', signature)).toThrow(VerificationError);
    expect(() => recoverSigner('msg', signature)).toThrow(/Invalid signature/);
  });

  it('rejects a high-s (malleated) signature', () => {
    const { sig } = fixture('base64-document');
    const n = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
    const s = BigInt('0x' + sig.signature.slice(64, 128));
    const v = parseInt(sig.signature.slice(128), 16);
    const malleated =
      sig.signature.slice(0, 64) + (n - s).toString(16).padStart(64, '0') + (v === 27 ? '1c' : '1b');
    expect(() => recoverSigner(`${sig.data_hash}|${sig.timestamp}`, malleated)).toThrow(/high s/);
  });
});

describe('reconstructSignedMessage', () => {
  it('builds data_hash|timestamp for the gateway format', () => {
    const { sig } = fixture('base64-document');
    expect(reconstructSignedMessage(sig)).toBe(`${sig.data_hash}|${sig.timestamp}`);
  });

  it('refuses any other format (it would let a forger choose what the notary signed)', () => {
    const { sig } = fixture('base64-document');
    expect(() => reconstructSignedMessage({ ...sig, signed_message_format: 'anything the notary signed' })).toThrow(
      /Unsupported signed_message_format/,
    );
  });
});

describe('computeNotaryDataHash / verifyDataHash', () => {
  it('matches the gateway for a base64 document', () => {
    const { doc, sig } = fixture('base64-document');
    expect(computeNotaryDataHash(doc)).toBe(sig.data_hash);
    expect(verifyDataHash(sig, doc)).toBe(true);
  });

  it('matches the gateway for a raw document when given the canonical text (floats, big ints)', () => {
    const { doc, sig, canonical } = fixture('raw-document');
    expect(computeNotaryDataHash(doc, canonical)).toBe(sig.data_hash);
    // The parsed value has lost "2.0" and the 30-digit integer: it cannot match
    expect(computeNotaryDataHash(doc)).not.toBe(sig.data_hash);
  });

  it('rejects hashed_fields other than ["data"]', () => {
    const { doc, sig } = fixture('base64-document');
    expect(verifyDataHash({ ...sig, hashed_fields: ['data', 'stamp_id'] }, doc)).toBe(false);
  });
});

describe('verifySignature', () => {
  it('a genuine notary signature is valid', () => {
    const { doc, sig } = fixture('base64-document');
    const result = verifySignature(sig, doc, NOTARY);
    expect(result).toEqual({ valid: true, dataHashValid: true, signerValid: true, recoveredAddress: NOTARY.toLowerCase() });
  });

  it('a genuine raw-document signature is valid with the canonical text (#114)', () => {
    const { doc, sig, canonical } = fixture('raw-document');
    expect(verifySignature(sig, doc, NOTARY, canonical).valid).toBe(true);
  });

  it('compares addresses case-insensitively', () => {
    const { doc, sig } = fixture('base64-document');
    expect(verifySignature(sig, doc, NOTARY.toUpperCase().replace('0X', '0x')).valid).toBe(true);
  });

  it('without an expected signer the result is invalid, even for a genuine signature', () => {
    const { doc, sig } = fixture('base64-document');
    for (const expected of [undefined, '']) {
      const result = verifySignature(sig, doc, expected);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/No expected signer/);
    }
    // A malformed address is named as such, not reported as missing
    expect(verifySignature(sig, doc, 'not-an-address')).toMatchObject({
      valid: false,
      error: 'Expected signer is not a valid address: "not-an-address"',
    });
  });

  it.each([
    ['empty signature', { signature: '' }],
    ['placeholder signature', { signature: '0xsignature' }],
    ['missing signature', { signature: undefined }],
    ['invalid recovery bit', { signature: 'ab'.repeat(64) + '05' }],
  ])('%s is invalid (the published 0.6.1 reported these as verified)', (_label, patch) => {
    const { doc, sig } = fixture('base64-document');
    const tampered = { ...sig, ...patch } as unknown as NotarySignature;
    expect(verifySignature(tampered, doc, NOTARY).valid).toBe(false);
  });

  it('a well-formed signature from another key that declares the notary as signer is invalid', async () => {
    const { doc, sig } = fixture('base64-document');
    const forged = { ...sig, signature: await signWith(OTHER_KEY, sig.data_hash, sig.timestamp) };
    const result = verifySignature(forged, doc, NOTARY);
    expect(result.valid).toBe(false);
    expect(result.recoveredAddress).toBe(privateKeyToAccount(OTHER_KEY).address.toLowerCase());
  });

  it('a genuine notary signature with a different declared signer is invalid', () => {
    const { doc, sig } = fixture('base64-document');
    const result = verifySignature({ ...sig, signer: privateKeyToAccount(OTHER_KEY).address }, doc, NOTARY);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Declared signer/);
  });

  it('a genuine signature on different data is invalid', () => {
    const { doc, sig } = fixture('base64-document');
    expect(verifySignature(sig, { ...doc, data: 'dGFtcGVyZWQ=' }, NOTARY)).toMatchObject({
      valid: false,
      dataHashValid: false,
    });
  });

  it('a changed timestamp is invalid', () => {
    const { doc, sig } = fixture('base64-document');
    expect(verifySignature({ ...sig, timestamp: '2030-01-01T00:00:00+00:00' }, doc, NOTARY).valid).toBe(false);
  });

  it.each([
    ['type', { type: 'eip191' }],
    ['hashed_fields', { hashed_fields: ['data', 'content_hash'] }],
    ['signed_message_format', { signed_message_format: '{timestamp}|{data_hash}' }],
    ['empty timestamp', { timestamp: '' }],
  ])('a different %s is invalid', (_label, patch) => {
    const { doc, sig } = fixture('base64-document');
    expect(verifySignature({ ...sig, ...patch } as NotarySignature, doc, NOTARY).valid).toBe(false);
  });
});

describe('verifyAllSignatures', () => {
  it('is valid when every signature verifies', () => {
    const { doc, sig } = fixture('base64-document');
    expect(verifyAllSignatures([sig, sig], doc, NOTARY).allValid).toBe(true);
  });

  it('is invalid when any signature fails, and reports which', () => {
    const { doc, sig } = fixture('base64-document');
    const result = verifyAllSignatures([sig, { ...sig, signature: '' }], doc, NOTARY);
    expect(result.allValid).toBe(false);
    expect(result.results.map((r) => r.valid)).toEqual([true, false]);
    expect(result.results[1]!.error).toMatch(/Invalid signature/);
  });

  it('is invalid for an empty list', () => {
    const { doc } = fixture('base64-document');
    expect(verifyAllSignatures([], doc, NOTARY).allValid).toBe(false);
  });

  it('is invalid without an expected signer', () => {
    const { doc, sig } = fixture('base64-document');
    expect(verifyAllSignatures([sig], doc).allValid).toBe(false);
  });
});

describe('fails closed instead of throwing (review round 1)', () => {
  it('verifySignature on metadata without data returns invalid', () => {
    const { sig } = fixture('base64-document');
    expect(verifySignature(sig, {} as { data: string }, NOTARY)).toMatchObject({ valid: false, dataHashValid: false });
  });

  it('verifyAllSignatures reports anyValid separately from allValid', () => {
    const { doc, sig } = fixture('base64-document');
    const result = verifyAllSignatures([{ ...sig, signature: '' }, sig], doc, NOTARY);
    expect(result).toMatchObject({ allValid: false, anyValid: true });
  });
});

describe('review round 3', () => {
  it('an unsupported scheme over the right data is not reported as tampered data', () => {
    const { doc, sig } = fixture('base64-document');
    expect(verifySignature({ ...sig, type: 'eip191' }, doc, NOTARY)).toMatchObject({ valid: false, dataHashValid: true });
  });
});
