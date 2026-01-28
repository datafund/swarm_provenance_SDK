/**
 * Upload with notary signing example
 *
 * Run with: npx tsx examples/with-notary.ts
 */

import { ProvenanceClient, NotaryError } from '../src/index.js';

async function main() {
  const client = new ProvenanceClient();

  // Check if notary is available
  const notaryInfo = await client.notaryInfo();
  console.log('Notary status:');
  console.log('  Enabled:', notaryInfo.enabled);
  console.log('  Available:', notaryInfo.available);
  if (notaryInfo.address) {
    console.log('  Signer address:', notaryInfo.address);
  }

  if (!notaryInfo.available) {
    console.log('\nNotary service is not available. Uploading without signature...');
    const result = await client.upload('Test content', { poolSize: 'small' });
    console.log('Reference:', result.reference);
    return;
  }

  // Upload with notary signing
  const content = `Notary-signed content. Timestamp: ${new Date().toISOString()}`;

  console.log('\nUploading with notary signing...');

  try {
    const result = await client.upload(content, {
      poolSize: 'small',
      sign: 'notary',
      standard: 'notary-example-v1',
    });

    console.log('Upload successful!');
    console.log('Reference:', result.reference);

    if (result.signedDocument) {
      console.log('\nSigned document:');
      console.log('  Signatures:', result.signedDocument.signatures.length);

      for (const sig of result.signedDocument.signatures) {
        console.log(`\n  Signature:`);
        console.log('    Type:', sig.type);
        console.log('    Signer:', sig.signer);
        console.log('    Timestamp:', sig.timestamp);
        console.log('    Data hash:', sig.data_hash);
      }
    }

    // Verify by downloading
    console.log('\nVerifying by re-downloading...');
    const downloaded = await client.download(result.reference);

    console.log('Signature verified:', downloaded.verified);
  } catch (error) {
    if (error instanceof NotaryError) {
      console.error('Notary error:', error.message);
    } else {
      throw error;
    }
  }
}

main().catch(console.error);
