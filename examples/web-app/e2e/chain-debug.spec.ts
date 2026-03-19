import { test, expect } from '@playwright/test';

/**
 * Chain integration tests using a mock EIP-1193 provider
 * that proxies to a local Hardhat node.
 *
 * These tests require Hardhat running at http://127.0.0.1:8545
 * with the DataProvenance contract deployed.
 *
 * Skip gracefully if Hardhat is not available.
 */

const HARDHAT_RPC = 'http://127.0.0.1:8545';
const HARDHAT_CONTRACT = '0xD42912755319665397FF090fBB63B1a31aE87Cee';
const HARDHAT_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

async function isHardhatRunning(): Promise<boolean> {
  try {
    const resp = await fetch(HARDHAT_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    const json = await resp.json();
    return json.result === '0x7a69'; // 31337
  } catch {
    return false;
  }
}

// Inject a mock provider that proxies RPC to Hardhat
function injectHardhatProvider() {
  return (opts: { rpc: string; account: string }) => {
    let nonce = 0;
    (window as any).ethereum = {
      request: async ({ method, params }: { method: string; params?: any[] }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
          return [opts.account];
        }
        if (method === 'eth_chainId') {
          return '0x7a69'; // 31337
        }
        // Proxy to Hardhat
        const resp = await fetch(opts.rpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++nonce, method, params: params || [] }),
        });
        const json = await resp.json();
        if (json.error) throw new Error(json.error.message);
        return json.result;
      },
      on: () => {},
    };
  };
}

test.describe('Chain Integration - Hardhat', () => {
  test.beforeAll(async () => {
    const running = await isHardhatRunning();
    if (!running) {
      test.skip();
    }
  });

  test('full anchor and verify flow via mock provider', async ({ page }) => {
    test.setTimeout(30000);

    const logs: string[] = [];
    page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));

    await page.addInitScript(injectHardhatProvider(), { rpc: HARDHAT_RPC, account: HARDHAT_ACCOUNT });
    await page.goto('/');

    // Connect wallet
    await page.locator('button').filter({ hasText: 'Connect Wallet' }).click();
    await expect(page.getByText('Connected:')).toBeVisible({ timeout: 5000 });

    // Generate unique hash and anchor
    const timestamp = Date.now().toString(16).padStart(16, '0');
    const testHash = `${timestamp}${'b'.repeat(48)}`;

    await page.getByPlaceholder('auto-populated after upload').fill(testHash);
    await page.locator('button').filter({ hasText: 'Anchor On-Chain' }).click();

    // Should show "Anchoring..."
    await expect(page.locator('button').filter({ hasText: 'Anchoring...' })).toBeVisible({ timeout: 3000 });

    // Wait for success
    await expect(page.getByText('Anchored Successfully')).toBeVisible({ timeout: 20000 });

    // Verify the anchor result details
    await expect(page.getByText('Tx Hash:')).toBeVisible();
    await expect(page.getByText('Block:')).toBeVisible();
    await expect(page.getByText('Gas Used:')).toBeVisible();
    await expect(page.getByText('Owner:')).toBeVisible();

    // Now verify on-chain
    await page.getByPlaceholder('64 hex characters', { exact: true }).fill(testHash);
    await page.locator('button').filter({ hasText: 'Verify On-Chain' }).click();

    // Wait for verification result
    await expect(page.getByText('On-Chain Record')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('dataset')).toBeVisible();
    await expect(page.getByText('Active')).toBeVisible();
  });

  test('anchor shows error for duplicate hash', async ({ page }) => {
    test.setTimeout(30000);

    await page.addInitScript(injectHardhatProvider(), { rpc: HARDHAT_RPC, account: HARDHAT_ACCOUNT });
    await page.goto('/');

    // Connect wallet
    await page.locator('button').filter({ hasText: 'Connect Wallet' }).click();
    await expect(page.getByText('Connected:')).toBeVisible({ timeout: 5000 });

    // Anchor a hash
    const timestamp = Date.now().toString(16).padStart(16, '0');
    const testHash = `${timestamp}${'c'.repeat(48)}`;

    await page.getByPlaceholder('auto-populated after upload').fill(testHash);
    await page.locator('button').filter({ hasText: 'Anchor On-Chain' }).click();
    await expect(page.getByText('Anchored Successfully')).toBeVisible({ timeout: 20000 });

    // Try to anchor the same hash again - should fail
    await page.getByPlaceholder('auto-populated after upload').fill(testHash);
    await page.locator('button').filter({ hasText: 'Anchor On-Chain' }).click();

    // Should show error (contract reverts on duplicate)
    await expect(page.locator('.chain .error')).toBeVisible({ timeout: 20000 });
  });

  test('verify shows not registered for unknown hash', async ({ page }) => {
    test.setTimeout(15000);

    await page.addInitScript(injectHardhatProvider(), { rpc: HARDHAT_RPC, account: HARDHAT_ACCOUNT });
    await page.goto('/');

    await page.getByPlaceholder('64 hex characters').fill('00'.repeat(32));
    await page.locator('button').filter({ hasText: 'Verify On-Chain' }).click();

    await expect(page.getByText('not registered')).toBeVisible({ timeout: 10000 });
  });
});

// ─── v2 Contract Features (merge, provenance chain, records) ─────

test.describe('Chain Integration v2 - Hardhat', () => {
  test.beforeAll(async () => {
    const running = await isHardhatRunning();
    if (!running) {
      test.skip();
    }
  });

  /** Helper: connect wallet and wait for "Connected:" */
  async function connectWallet(page: import('@playwright/test').Page) {
    await page.addInitScript(injectHardhatProvider(), { rpc: HARDHAT_RPC, account: HARDHAT_ACCOUNT });
    await page.goto('/');
    await page.locator('button').filter({ hasText: 'Connect Wallet' }).click();
    await expect(page.getByText('Connected:')).toBeVisible({ timeout: 5000 });
  }

  /** Helper: anchor a hash and wait for success */
  async function anchorHash(page: import('@playwright/test').Page, hash: string) {
    await page.getByPlaceholder('auto-populated after upload').fill(hash);
    await page.locator('button').filter({ hasText: 'Anchor On-Chain' }).click();
    await expect(page.getByText('Anchored Successfully')).toBeVisible({ timeout: 20000 });
  }

  /** Generate unique hash from timestamp + filler char */
  function uniqueHash(filler: string): string {
    const ts = Date.now().toString(16).padStart(16, '0');
    return `${ts}${filler.repeat(48)}`;
  }

  test('merge transform: anchor sources, merge, verify result', async ({ page }) => {
    test.setTimeout(60000);

    await connectWallet(page);

    const src1 = uniqueHash('a');
    const src2 = uniqueHash('b');
    // Small delay to ensure unique timestamps
    await page.waitForTimeout(10);
    const merged = uniqueHash('d');

    // Anchor both sources
    await anchorHash(page, src1);
    await anchorHash(page, src2);

    // Fill merge form
    await page.getByPlaceholder('Source data hash (hex)').first().fill(src1);
    await page.getByPlaceholder('Source data hash (hex)').nth(1).fill(src2);
    await page.getByPlaceholder('Merged result hash (hex)').fill(merged);
    await page.getByPlaceholder('e.g. Merged datasets A and B').fill('merge test');

    await page.locator('button').filter({ hasText: 'Merge Transform' }).click();

    // Should show "Merging..."
    await expect(page.locator('button').filter({ hasText: 'Merging...' })).toBeVisible({ timeout: 3000 });

    // Wait for merge success
    await expect(page.getByText('Merge Successful')).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('2 hashes merged')).toBeVisible();
  });

  test('verify shows transformation links after merge', async ({ page }) => {
    test.setTimeout(60000);

    await connectWallet(page);

    const src1 = uniqueHash('e');
    const src2 = uniqueHash('f');
    await page.waitForTimeout(10);
    const merged = uniqueHash('1');

    // Anchor sources and merge
    await anchorHash(page, src1);
    await anchorHash(page, src2);

    await page.getByPlaceholder('Source data hash (hex)').first().fill(src1);
    await page.getByPlaceholder('Source data hash (hex)').nth(1).fill(src2);
    await page.getByPlaceholder('Merged result hash (hex)').fill(merged);
    await page.getByPlaceholder('e.g. Merged datasets A and B').fill('links test');
    await page.locator('button').filter({ hasText: 'Merge Transform' }).click();
    await expect(page.getByText('Merge Successful')).toBeVisible({ timeout: 20000 });

    // Verify source hash — should show transformation links to merged
    await page.getByPlaceholder('64 hex characters', { exact: true }).fill(src1);
    await page.locator('button').filter({ hasText: 'Verify On-Chain' }).click();

    await expect(page.getByText('On-Chain Record')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Transforms:')).toBeVisible();
    await expect(page.getByText('links test')).toBeVisible();
  });

  test('provenance chain traversal after merge', async ({ page }) => {
    test.setTimeout(60000);

    await connectWallet(page);

    const src1 = uniqueHash('2');
    const src2 = uniqueHash('3');
    await page.waitForTimeout(10);
    const merged = uniqueHash('4');

    // Anchor sources and merge
    await anchorHash(page, src1);
    await anchorHash(page, src2);

    await page.getByPlaceholder('Source data hash (hex)').first().fill(src1);
    await page.getByPlaceholder('Source data hash (hex)').nth(1).fill(src2);
    await page.getByPlaceholder('Merged result hash (hex)').fill(merged);
    await page.getByPlaceholder('e.g. Merged datasets A and B').fill('chain test');
    await page.locator('button').filter({ hasText: 'Merge Transform' }).click();
    await expect(page.getByText('Merge Successful')).toBeVisible({ timeout: 20000 });

    // Trace provenance from merged hash
    await page.getByPlaceholder('Hash to trace lineage').fill(merged);
    await page.locator('button').filter({ hasText: 'Trace Provenance' }).click();

    // Should show provenance records
    await expect(page.getByText(/Provenance Chain \(\d+ record/)).toBeVisible({ timeout: 15000 });
    // Merged + 2 sources = 3 records
    const records = page.locator('.chain-record');
    await expect(records).toHaveCount(3, { timeout: 5000 });
  });

  test('user records after anchoring', async ({ page }) => {
    test.setTimeout(45000);

    await connectWallet(page);

    const hash = uniqueHash('5');
    await anchorHash(page, hash);

    // Load My Records
    await page.locator('button').filter({ hasText: 'Load My Records' }).click();

    // Should show records
    await expect(page.getByText(/\d+ Record/)).toBeVisible({ timeout: 15000 });
    // Our hash should appear in the list (use first() since other tests may have anchored with same timestamp prefix)
    await expect(page.getByText(hash).first()).toBeVisible();
  });

  test('wallet balance is displayed after connect', async ({ page }) => {
    test.setTimeout(15000);

    await connectWallet(page);

    // Hardhat default account has ~10000 ETH
    await expect(page.getByText('ETH)')).toBeVisible({ timeout: 5000 });
  });
});
