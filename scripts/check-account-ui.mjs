import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const vite = await createServer({ server: { host: '127.0.0.1', port: 1420, strictPort: true } });
await vite.listen();
const browser = await chromium.launch({ headless: true });
await mkdir('artifacts/account-ui', { recursive: true });
try {
  for (const [width, mode, signedIn] of [[390, 'light', false], [390, 'dark', true], [1000, 'light', true], [1000, 'dark', false]]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: mode });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ signedIn }) => {
      window.__accountFixture = {
        account: signedIn ? { id: 'owner', email: 'owner@example.com', sharingEpoch: 1 } : null,
        loading: false, status: signedIn ? 'connected' : 'disconnected', message: null, progress: null,
        lastSyncedAt: null, canSync: signedIn, conflicts: [], login: async () => {}, disconnect: async () => {},
        runSync: async () => {}, refreshShared: async () => {}, resolveConflict: async () => {},
        sharedTodos: signedIn ? [{ recordId: 'shared', shareId: 'share', ownerEmail: 'partner@example.com', payload: { date: '2026-10-23', content: 'Plan dinner together', completed: 0 } }] : [],
      };
    }, { signedIn });
    await page.route('**/src/hooks/useSync.ts*', route => route.fulfill({ contentType: 'application/javascript', body: 'export function useSync() { return window.__accountFixture; }' }));
    await page.route('**/src/lib/store.ts*', route => route.fulfill({ contentType: 'application/javascript', body: 'export const appStore = { get: async () => null, set: async () => {} };' }));
    await page.route('**/src/services/account/client.ts*', route => route.fulfill({ contentType: 'application/javascript', body: `export const SERVER_URL='https://journai.example.com'; export async function apiRequest() { return {shares:[], invitations:[]}; }` }));
    await page.goto('http://127.0.0.1:1420/scripts/account-preview.html');
    await page.getByText('JournAi Account', { exact: true }).waitFor();
    if (signedIn) {
      await page.getByText('Plan dinner together', { exact: false }).waitFor();
      assert.equal(await page.getByRole('checkbox').count(), 0);
      await page.getByLabel('Their JournAi account email').fill('partner@example.com');
    } else {
      await page.getByLabel('Email', { exact: true }).fill('owner@example.com');
      await page.getByRole('button', { name: 'Create an account', exact: true }).click();
      await page.getByText(/cannot be recovered/).waitFor();
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, 'Page must not overflow horizontally');
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `artifacts/account-ui/${width}-${mode}-${signedIn ? 'connected' : 'signup'}.png`, fullPage: true });
    await page.close();
  }
  console.log('Account UI checked at 390px and 1000px in light and dark themes; no horizontal overflow or browser errors.');
} finally {
  await browser.close(); await vite.close();
}
