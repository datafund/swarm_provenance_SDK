/**
 * Download and verify example
 *
 * Run with: npx tsx examples/download-verify.ts <reference>
 */

import { ProvenanceClient, isValidSwarmReference } from '../src/index.js';

async function main() {
  const reference = process.argv[2];

  if (!reference) {
    console.error('Usage: npx tsx examples/download-verify.ts <reference>');
    console.error('Example: npx tsx examples/download-verify.ts abcd1234...');
    process.exit(1);
  }

  if (!isValidSwarmReference(reference)) {
    console.error('Invalid Swarm reference. Expected 64 hex characters.');
    process.exit(1);
  }

  const client = new ProvenanceClient();

  console.log('Downloading reference:', reference);

  const result = await client.download(reference);

  // Decode content as text (assuming it's text)
  const content = new TextDecoder().decode(result.file);

  console.log('\n--- Content ---');
  console.log(content);
  console.log('--- End ---\n');

  console.log('Metadata:');
  console.log('  Content hash:', result.metadata.content_hash);
  console.log('  Stamp ID:', result.metadata.stamp_id);
  if (result.metadata.provenance_standard) {
    console.log('  Standard:', result.metadata.provenance_standard);
  }

  if (result.signatures && result.signatures.length > 0) {
    console.log('\nSignatures:');
    for (const sig of result.signatures) {
      console.log('  - Signer:', sig.signer);
      console.log('    Timestamp:', sig.timestamp);
      console.log('    Type:', sig.type);
    }
    console.log('\nSignature verified:', result.verified);
  } else {
    console.log('\nNo notary signatures on this document.');
  }
}

main().catch(console.error);
