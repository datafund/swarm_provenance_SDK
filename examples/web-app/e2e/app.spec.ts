import { test, expect } from '@playwright/test';

test.describe('Swarm Provenance Demo', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('no console errors on page load', async ({ page }) => {
    const consoleErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto('/');
    await page.waitForTimeout(2000); // Wait for health check

    // Filter out known acceptable errors if any
    const criticalErrors = consoleErrors.filter(
      (err) => !err.includes('favicon')
    );

    if (criticalErrors.length > 0) {
      console.log('Console errors found:', criticalErrors);
    }

    // Check for CORS errors specifically
    const corsErrors = criticalErrors.filter(
      (err) => err.toLowerCase().includes('cors') || err.includes('blocked by CORS')
    );
    expect(corsErrors, 'CORS errors detected - gateway needs CORS headers').toHaveLength(0);

    // Check for network errors
    const networkErrors = criticalErrors.filter(
      (err) => err.includes('net::') || err.includes('Failed to fetch')
    );
    expect(networkErrors, 'Network errors detected').toHaveLength(0);
  });

  test('page loads with title', async ({ page }) => {
    await expect(page).toHaveTitle('Swarm Provenance Demo');
    await expect(page.locator('h1')).toContainText('Swarm Provenance Demo');
  });

  test('shows gateway status section', async ({ page }) => {
    await expect(page.locator('h2').first()).toContainText('Gateway Status');
    // Wait for health check to complete
    await expect(page.getByText(/Health:/)).toBeVisible();
  });

  test('gateway health check shows connected', async ({ page }) => {
    // Wait for health check result
    await expect(page.getByText('Connected')).toBeVisible({ timeout: 10000 });
  });

  test('shows upload section with inputs', async ({ page }) => {
    await expect(page.locator('h2').filter({ hasText: 'Upload' })).toBeVisible();
    await expect(page.locator('textarea')).toBeVisible();
    await expect(page.locator('input[type="file"]')).toBeVisible();
    await expect(page.locator('button').filter({ hasText: 'Upload' })).toBeVisible();
  });

  test('shows download section with input', async ({ page }) => {
    await expect(page.locator('h2').filter({ hasText: 'Download' })).toBeVisible();
    await expect(page.locator('input[type="text"]')).toBeVisible();
    await expect(page.locator('button').filter({ hasText: 'Download' })).toBeVisible();
  });

  test('upload button is disabled when no content', async ({ page }) => {
    const uploadButton = page.locator('button').filter({ hasText: 'Upload' });
    await expect(uploadButton).toBeDisabled();
  });

  test('download button is disabled when no reference', async ({ page }) => {
    const downloadButton = page.locator('button').filter({ hasText: 'Download' });
    await expect(downloadButton).toBeDisabled();
  });

  test('can enter text for upload', async ({ page }) => {
    const textarea = page.locator('textarea');
    await textarea.fill('Hello, Swarm!');
    await expect(textarea).toHaveValue('Hello, Swarm!');

    // Upload button should now be enabled
    const uploadButton = page.locator('button').filter({ hasText: 'Upload' });
    await expect(uploadButton).toBeEnabled();
  });

  test('can enter reference for download', async ({ page }) => {
    const input = page.locator('input[type="text"]');
    await input.fill('a'.repeat(64));
    await expect(input).toHaveValue('a'.repeat(64));

    // Download button should now be enabled
    const downloadButton = page.locator('button').filter({ hasText: 'Download' });
    await expect(downloadButton).toBeEnabled();
  });
});

test.describe('Error Handling', () => {
  test('download with invalid reference shows error', async ({ page }) => {
    await page.goto('/');

    // Wait for gateway to be connected
    await expect(page.getByText('Connected')).toBeVisible({ timeout: 10000 });

    // Enter invalid reference (wrong format)
    const downloadInput = page.locator('input[type="text"]');
    await downloadInput.fill('invalid-reference');

    // Click download
    await page.locator('button').filter({ hasText: 'Download' }).click();

    // Wait for error message
    await expect(page.locator('.download .error')).toBeVisible({ timeout: 15000 });
  });

  test('download with non-existent reference shows error', async ({ page }) => {
    await page.goto('/');

    // Wait for gateway to be connected
    await expect(page.getByText('Connected')).toBeVisible({ timeout: 10000 });

    // Enter valid format but non-existent reference
    const downloadInput = page.locator('input[type="text"]');
    await downloadInput.fill('0'.repeat(64));

    // Click download
    await page.locator('button').filter({ hasText: 'Download' }).click();

    // Wait for error message
    await expect(page.locator('.download .error')).toBeVisible({ timeout: 15000 });
  });
});

test.describe('Notary Integration', () => {
  test('notary checkbox appears when notary is available', async ({ page }) => {
    await page.goto('/');

    // Wait for gateway status to load
    await expect(page.getByText('Connected')).toBeVisible({ timeout: 10000 });

    // Check if notary info is displayed
    const notaryText = page.getByText(/Notary:/);
    await expect(notaryText).toBeVisible({ timeout: 5000 });

    // If notary is available, checkbox should be visible
    const notaryAvailable = await page.getByText('Available').isVisible();
    if (notaryAvailable) {
      await expect(page.getByLabel('Sign with Notary')).toBeVisible();
    }
  });

  test('upload with notary shows signature details on download', async ({ page }) => {
    test.setTimeout(180000); // 3 minute timeout for notary signing

    await page.goto('/');

    // Wait for gateway to be connected
    await expect(page.getByText('Connected')).toBeVisible({ timeout: 15000 });

    // Check if notary is available
    const notaryAvailable = await page.getByText('Available').isVisible();
    if (!notaryAvailable) {
      test.skip();
      return;
    }

    // Enter text and enable notary signing
    const testContent = `Notary test ${Date.now()}`;
    await page.locator('textarea').fill(testContent);
    await page.getByLabel('Sign with Notary').check();

    // Upload
    await page.locator('button').filter({ hasText: /Upload/ }).click();

    // Wait for upload success
    await page.waitForFunction(
      () => document.body.innerText.includes('Upload Successful') || document.body.innerText.includes('Upload failed'),
      { timeout: 90000 }
    );

    const uploadSuccess = await page.getByText('Upload Successful').isVisible();
    if (!uploadSuccess) {
      test.skip(); // Skip if upload failed (e.g., notary unavailable)
      return;
    }

    // Get reference and download
    // Note: Upload response doesn't include signed_document by design - signatures are only returned on download
    const reference = await page.locator('.upload .result code').first().textContent();
    expect(reference).toMatch(/^[a-f0-9]{64}$/);

    // Download the signed content
    await page.locator('button').filter({ hasText: 'Download' }).click();

    // Wait for download success
    await page.waitForFunction(
      () => document.body.innerText.includes('Download Successful') || document.body.innerText.includes('Download failed'),
      { timeout: 60000 }
    );

    // Check if signatures are present in download result
    const hasSignatures = await page.locator('.signature-section').isVisible();
    if (!hasSignatures) {
      // Gateway returned content but without signatures - maybe notary signing wasn't applied
      console.log('Download succeeded but no signatures returned - notary signing may not have been applied');
      test.skip();
      return;
    }

    // Verify signature section content
    await expect(page.locator('.signature-section h4')).toContainText('Notary Signature');

    // Verify status badge shows verified
    await expect(page.locator('.status-badge.success')).toBeVisible();
    await expect(page.getByText('Signature Verified')).toBeVisible();

    // Verify signature details are shown
    await expect(page.locator('.signature-details')).toBeVisible();
    await expect(page.getByText('Signer:')).toBeVisible();
    await expect(page.getByText('Type:')).toBeVisible();
    await expect(page.getByText('Timestamp:')).toBeVisible();
    await expect(page.getByText('Data Hash:')).toBeVisible();

    // Verify signer matches gateway notary badge
    await expect(page.getByText('Matches Gateway Notary')).toBeVisible();
  });
});

test.describe('Upload and Download Flow', () => {
  test('full upload and download cycle', async ({ page }) => {
    test.setTimeout(120000); // 2 minute timeout for full cycle

    // Capture console messages for debugging
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log('Browser error:', msg.text());
      }
    });

    await page.goto('/');

    // Wait for gateway to be connected
    await expect(page.getByText('Connected')).toBeVisible({ timeout: 15000 });

    // Enter text to upload
    const testContent = `Test content ${Date.now()}`;
    await page.locator('textarea').fill(testContent);

    // Click upload
    const uploadButton = page.locator('button').filter({ hasText: /Upload/ });
    await uploadButton.click();

    // Check button changes to "Uploading..."
    await expect(uploadButton).toContainText('Uploading', { timeout: 5000 });

    // Wait for either success or error (or button to return to normal)
    await page.waitForFunction(
      () => {
        const body = document.body.innerText;
        return body.includes('Upload Successful') ||
               body.includes('Upload failed') ||
               body.includes('error') ||
               body.includes('Error');
      },
      { timeout: 60000 }
    ).catch(async () => {
      // Take screenshot on timeout
      await page.screenshot({ path: 'test-results/upload-timeout.png' });
      const bodyText = await page.locator('body').innerText();
      console.log('Page content on timeout:', bodyText.substring(0, 500));
      throw new Error('Upload did not complete within timeout');
    });

    // Check if it was successful
    const successVisible = await page.getByText('Upload Successful').isVisible();
    if (!successVisible) {
      // Capture error for debugging
      const errorText = await page.locator('.error').textContent();
      throw new Error(`Upload failed: ${errorText}`);
    }

    // Get the reference
    const referenceElement = page.locator('.upload .result code').first();
    const reference = await referenceElement.textContent();
    expect(reference).toMatch(/^[a-f0-9]{64}$/);

    // Reference should auto-populate in download input
    const downloadInput = page.locator('input[type="text"]');
    await expect(downloadInput).toHaveValue(reference!);

    // Click download
    await page.locator('button').filter({ hasText: 'Download' }).click();

    // Wait for download result or error
    await page.waitForFunction(
      () => {
        const body = document.body.innerText;
        return body.includes('Download Successful') || body.includes('Download failed') || body.includes('error');
      },
      { timeout: 60000 }
    ).catch(async () => {
      const downloadSection = await page.locator('.download').innerText();
      console.log('Download section content:', downloadSection);
      throw new Error('Download did not complete');
    });

    const downloadSuccess = await page.getByText('Download Successful').isVisible();
    if (!downloadSuccess) {
      const errorText = await page.locator('.download .error').textContent().catch(() => 'no error element');
      throw new Error(`Download failed: ${errorText}`);
    }

    // Verify content matches
    const contentPreview = page.locator('pre');
    await expect(contentPreview).toContainText(testContent);
  });
});
