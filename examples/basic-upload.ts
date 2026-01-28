/**
 * Basic upload example
 *
 * Run with: npx tsx examples/basic-upload.ts
 */

import { ProvenanceClient } from '../src/index.js';

async function main() {
  // Create client (uses default gateway)
  const client = new ProvenanceClient();

  // Check gateway health
  const healthy = await client.health();
  console.log('Gateway healthy:', healthy);

  if (!healthy) {
    console.error('Gateway is not available');
    process.exit(1);
  }

  // Upload some content
  const content = `Hello from swarm-provenance SDK! Timestamp: ${new Date().toISOString()}`;

  console.log('Uploading content...');
  const result = await client.upload(content, {
    poolSize: 'small',
    standard: 'example-v1',
  });

  console.log('Upload successful!');
  console.log('Reference:', result.reference);
  console.log('Content hash:', result.metadata.content_hash);
  console.log('Stamp ID:', result.metadata.stamp_id);

  // You can use this reference to download the content later
  console.log(`\nTo download, run:\n  npx tsx examples/download-verify.ts ${result.reference}`);
}

main().catch(console.error);
