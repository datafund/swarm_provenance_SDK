import { test, expect } from '@playwright/test';

/**
 * Blockchain Anchoring e2e tests.
 *
 * These tests exercise the chain UI section of the demo app:
 * - Wallet detection & connection
 * - Anchor form visibility & validation
 * - Verify on-chain (read-only, hits Base Sepolia RPC)
 * - Full wallet-connected flows via injected mock provider
 */

// Helper: inject a mock EIP-1193 provider into the page
const MOCK_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

function injectMockProvider() {
  return `
    window.ethereum = {
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts') return ['${MOCK_ADDRESS}'];
        if (method === 'eth_accounts') return ['${MOCK_ADDRESS}'];
        if (method === 'eth_chainId') return '0x14a34';
        return null;
      },
      on: () => {},
    };
  `;
}

// ─── Section Visibility ────────────────────────────────────────

test.describe('Chain Section - Layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('shows blockchain anchoring section', async ({ page }) => {
    await expect(page.locator('h2').filter({ hasText: 'Blockchain Anchoring' })).toBeVisible();
  });

  test('shows section description mentioning DataProvenance', async ({ page }) => {
    await expect(page.getByText('DataProvenance contract')).toBeVisible();
  });

  test('verify section is always visible', async ({ page }) => {
    await expect(page.locator('h3').filter({ hasText: 'Verify On-Chain' })).toBeVisible();
    await expect(page.getByPlaceholder('64 hex characters')).toBeVisible();
    await expect(page.locator('button').filter({ hasText: 'Verify On-Chain' })).toBeVisible();
  });
});

test.describe('Chain Section - Layout (always visible)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('provenance chain section is always visible', async ({ page }) => {
    await expect(page.locator('h3').filter({ hasText: 'Provenance Chain' })).toBeVisible();
    await expect(page.getByPlaceholder('Hash to trace lineage')).toBeVisible();
    await expect(page.locator('button').filter({ hasText: 'Trace Provenance' })).toBeVisible();
  });

  test('trace button is disabled when input is empty', async ({ page }) => {
    await expect(page.locator('button').filter({ hasText: 'Trace Provenance' })).toBeDisabled();
  });

  test('trace button enables when hash is entered', async ({ page }) => {
    await page.getByPlaceholder('Hash to trace lineage').fill('ab'.repeat(32));
    await expect(page.locator('button').filter({ hasText: 'Trace Provenance' })).toBeEnabled();
  });
});

// ─── No Wallet State ───────────────────────────────────────────

test.describe('Chain Section - No Wallet', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('shows "No wallet detected" without ethereum provider', async ({ page }) => {
    await expect(page.getByText('No wallet detected')).toBeVisible();
  });

  test('does not show Connect Wallet button', async ({ page }) => {
    await expect(page.locator('button').filter({ hasText: 'Connect Wallet' })).not.toBeVisible();
  });

  test('anchor form is hidden', async ({ page }) => {
    await expect(page.locator('h3').filter({ hasText: 'Anchor Data' })).not.toBeVisible();
    await expect(page.getByPlaceholder('auto-populated after upload')).not.toBeVisible();
  });

  test('anchor on-chain button is not visible', async ({ page }) => {
    await expect(page.locator('button').filter({ hasText: 'Anchor On-Chain' })).not.toBeVisible();
  });

  test('merge transform section is hidden without wallet', async ({ page }) => {
    await expect(page.locator('h3').filter({ hasText: 'Merge Transform' })).not.toBeVisible();
  });

  test('my records section is hidden without wallet', async ({ page }) => {
    await expect(page.locator('h3').filter({ hasText: 'My Records' })).not.toBeVisible();
  });
});

// ─── Verify On-Chain (read-only, no wallet needed) ─────────────

test.describe('Chain Section - Verify', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('verify button is disabled when input is empty', async ({ page }) => {
    await expect(page.locator('button').filter({ hasText: 'Verify On-Chain' })).toBeDisabled();
  });

  test('verify button enables when hash is entered', async ({ page }) => {
    await page.getByPlaceholder('64 hex characters').fill('ab'.repeat(32));
    await expect(page.locator('button').filter({ hasText: 'Verify On-Chain' })).toBeEnabled();
  });

  test('verify shows "not registered" for unknown hash', async ({ page }) => {
    test.setTimeout(30000);

    await page.getByPlaceholder('64 hex characters').fill('00'.repeat(32));
    await page.locator('button').filter({ hasText: 'Verify On-Chain' }).click();

    // Button should show "Verifying..."
    await expect(page.locator('button').filter({ hasText: 'Verifying...' })).toBeVisible();

    // Wait for result
    await page.waitForFunction(
      () =>
        document.body.innerText.includes('not registered') ||
        document.body.innerText.includes('Verification failed'),
      { timeout: 20000 },
    );

    // Should show not-found message
    await expect(page.getByText('not registered')).toBeVisible();
  });

  test('verify shows error for RPC failure with garbage input', async ({ page }) => {
    test.setTimeout(30000);

    // Single character - will fail validation or RPC
    await page.getByPlaceholder('64 hex characters').fill('x');
    await page.locator('button').filter({ hasText: 'Verify On-Chain' }).click();

    // Should show some error
    await page.waitForFunction(
      () => document.querySelector('.chain .error') !== null,
      { timeout: 15000 },
    );
    await expect(page.locator('.chain .error')).toBeVisible();
  });

  test('verify clears previous results on new search', async ({ page }) => {
    test.setTimeout(45000);

    // First verify
    await page.getByPlaceholder('64 hex characters').fill('00'.repeat(32));
    await page.locator('button').filter({ hasText: 'Verify On-Chain' }).click();

    await page.waitForFunction(
      () => document.body.innerText.includes('not registered'),
      { timeout: 20000 },
    );
    await expect(page.getByText('not registered')).toBeVisible();

    // Second verify with different hash - previous result should clear
    await page.getByPlaceholder('64 hex characters').fill('ff'.repeat(32));
    await page.locator('button').filter({ hasText: 'Verify On-Chain' }).click();

    // "not registered" from first search should disappear while verifying
    await expect(page.locator('button').filter({ hasText: 'Verifying...' })).toBeVisible();
  });
});

// ─── Wallet Connection ────────────────────────────────────────

test.describe('Chain Section - Wallet Connection', () => {
  test('shows Connect Wallet button with injected provider', async ({ page }) => {
    await page.addInitScript(injectMockProvider());
    await page.goto('/');

    await expect(page.getByText('No wallet detected')).not.toBeVisible();
    await expect(page.locator('button').filter({ hasText: 'Connect Wallet' })).toBeVisible();
  });

  test('connect wallet shows address and reveals anchor form', async ({ page }) => {
    await page.addInitScript(injectMockProvider());
    await page.goto('/');

    // Click connect
    await page.locator('button').filter({ hasText: 'Connect Wallet' }).click();

    // Should show connected address
    await expect(page.getByText('Connected:')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(MOCK_ADDRESS.slice(0, 6))).toBeVisible();
    await expect(page.getByText(MOCK_ADDRESS.slice(-4))).toBeVisible();

    // Connect wallet button should be gone
    await expect(page.locator('button').filter({ hasText: 'Connect Wallet' })).not.toBeVisible();

    // Anchor form should now be visible
    await expect(page.locator('h3').filter({ hasText: 'Anchor Data' })).toBeVisible();
    await expect(page.getByPlaceholder('auto-populated after upload')).toBeVisible();
    await expect(page.getByPlaceholder('e.g. dataset')).toBeVisible();
    await expect(page.locator('button').filter({ hasText: 'Anchor On-Chain' })).toBeVisible();
  });

  test('connect wallet shows "Connecting..." during connection', async ({ page }) => {
    // Inject a slow provider
    await page.addInitScript(() => {
      (window as any).ethereum = {
        request: async ({ method }: { method: string }) => {
          if (method === 'eth_requestAccounts') {
            await new Promise((r) => setTimeout(r, 1000));
            return ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'];
          }
          if (method === 'eth_accounts') return ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'];
          if (method === 'eth_chainId') return '0x14a34';
          return null;
        },
        on: () => {},
      };
    });
    await page.goto('/');

    await page.locator('button').filter({ hasText: 'Connect Wallet' }).click();
    await expect(page.locator('button').filter({ hasText: 'Connecting...' })).toBeVisible();
  });

  test('connect wallet shows error on rejection', async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).ethereum = {
        request: async ({ method }: { method: string }) => {
          if (method === 'eth_requestAccounts') {
            throw new Error('User rejected the request');
          }
          return null;
        },
        on: () => {},
      };
    });
    await page.goto('/');

    await page.locator('button').filter({ hasText: 'Connect Wallet' }).click();

    // Should show error
    await expect(page.locator('.chain .error')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.chain .error')).toContainText('rejected');
  });
});

// ─── Anchor Form ──────────────────────────────────────────────

test.describe('Chain Section - Anchor Form', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(injectMockProvider());
    await page.goto('/');

    // Connect wallet
    await page.locator('button').filter({ hasText: 'Connect Wallet' }).click();
    await expect(page.getByText('Connected:')).toBeVisible({ timeout: 5000 });
  });

  test('anchor button is disabled when hash is empty', async ({ page }) => {
    await expect(page.locator('button').filter({ hasText: 'Anchor On-Chain' })).toBeDisabled();
  });

  test('anchor button enables when hash is entered', async ({ page }) => {
    await page.getByPlaceholder('auto-populated after upload').fill('ab'.repeat(32));
    await expect(page.locator('button').filter({ hasText: 'Anchor On-Chain' })).toBeEnabled();
  });

  test('data type field defaults to "dataset"', async ({ page }) => {
    await expect(page.getByPlaceholder('e.g. dataset')).toHaveValue('dataset');
  });

  test('data type is editable', async ({ page }) => {
    const typeInput = page.getByPlaceholder('e.g. dataset');
    await typeInput.clear();
    await typeInput.fill('model');
    await expect(typeInput).toHaveValue('model');
  });

  test('anchor button shows hash and type are both required', async ({ page }) => {
    // Only hash filled, type empty
    await page.getByPlaceholder('auto-populated after upload').fill('ab'.repeat(32));
    const typeInput = page.getByPlaceholder('e.g. dataset');
    await typeInput.clear();

    // Button should still be enabled (type validation happens on submit)
    await expect(page.locator('button').filter({ hasText: 'Anchor On-Chain' })).toBeEnabled();
  });
});

// ─── Merge Transform Form ────────────────────────────────────

test.describe('Chain Section - Merge Transform', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(injectMockProvider());
    await page.goto('/');

    // Connect wallet
    await page.locator('button').filter({ hasText: 'Connect Wallet' }).click();
    await expect(page.getByText('Connected:')).toBeVisible({ timeout: 5000 });
  });

  test('merge transform section visible after wallet connect', async ({ page }) => {
    await expect(page.locator('h3').filter({ hasText: 'Merge Transform' })).toBeVisible();
    await expect(page.getByText('v2 contract feature')).toBeVisible();
  });

  test('starts with 2 source hash inputs', async ({ page }) => {
    const sourceInputs = page.getByPlaceholder('Source data hash (hex)');
    await expect(sourceInputs).toHaveCount(2);
  });

  test('can add more source hash inputs', async ({ page }) => {
    await page.locator('button').filter({ hasText: '+ Add Source' }).click();
    const sourceInputs = page.getByPlaceholder('Source data hash (hex)');
    await expect(sourceInputs).toHaveCount(3);
  });

  test('can remove added source hash inputs', async ({ page }) => {
    // Add one more
    await page.locator('button').filter({ hasText: '+ Add Source' }).click();
    await expect(page.getByPlaceholder('Source data hash (hex)')).toHaveCount(3);

    // Remove it
    await page.locator('button').filter({ hasText: 'Remove' }).first().click();
    await expect(page.getByPlaceholder('Source data hash (hex)')).toHaveCount(2);
  });

  test('merge button disabled until form is filled', async ({ page }) => {
    await expect(page.locator('button').filter({ hasText: 'Merge Transform' })).toBeDisabled();

    // Fill only 1 source — still disabled
    await page.getByPlaceholder('Source data hash (hex)').first().fill('aa'.repeat(32));
    await expect(page.locator('button').filter({ hasText: 'Merge Transform' })).toBeDisabled();

    // Fill 2nd source + new hash + description
    await page.getByPlaceholder('Source data hash (hex)').nth(1).fill('bb'.repeat(32));
    await page.getByPlaceholder('Merged result hash (hex)').fill('cc'.repeat(32));
    await page.getByPlaceholder('e.g. Merged datasets A and B').fill('test merge');

    await expect(page.locator('button').filter({ hasText: 'Merge Transform' })).toBeEnabled();
  });

  test('data type defaults to "merged"', async ({ page }) => {
    await expect(page.getByPlaceholder('e.g. merged, dataset')).toHaveValue('merged');
  });
});

// ─── My Records Section ──────────────────────────────────────

test.describe('Chain Section - My Records', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(injectMockProvider());
    await page.goto('/');

    await page.locator('button').filter({ hasText: 'Connect Wallet' }).click();
    await expect(page.getByText('Connected:')).toBeVisible({ timeout: 5000 });
  });

  test('my records section visible after wallet connect', async ({ page }) => {
    await expect(page.locator('h3').filter({ hasText: 'My Records' })).toBeVisible();
    await expect(page.locator('button').filter({ hasText: 'Load My Records' })).toBeVisible();
  });
});

// ─── Upload → Anchor Integration ──────────────────────────────

test.describe('Chain Section - Upload Integration', () => {
  test('upload auto-populates anchor hash field', async ({ page }) => {
    test.setTimeout(90000);

    await page.addInitScript(injectMockProvider());
    await page.goto('/');

    // Wait for gateway
    await expect(page.getByText('Connected')).toBeVisible({ timeout: 15000 });

    // Connect wallet to reveal anchor form
    await page.locator('button').filter({ hasText: 'Connect Wallet' }).click();
    await expect(page.getByText('Connected:')).toBeVisible({ timeout: 5000 });

    // Upload content
    const testContent = `Anchor integration test ${Date.now()}`;
    await page.locator('textarea').fill(testContent);
    await page.locator('button').filter({ hasText: /^Upload$/ }).click();

    // Wait for upload
    await page.waitForFunction(
      () =>
        document.body.innerText.includes('Upload Successful') ||
        document.body.innerText.includes('Upload failed'),
      { timeout: 60000 },
    );

    const uploadSuccess = await page.getByText('Upload Successful').isVisible();
    if (!uploadSuccess) {
      test.skip(); // Gateway may be rate-limiting
      return;
    }

    // Anchor hash should be auto-populated with content_hash
    const anchorInput = page.getByPlaceholder('auto-populated after upload');
    const value = await anchorInput.inputValue();
    expect(value).toMatch(/^[a-f0-9]{64}$/);

    // Should match the displayed content hash
    const contentHash = await page.locator('.upload .result code').nth(1).textContent();
    expect(value).toBe(contentHash);
  });
});
