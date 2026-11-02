import { defineConfig, devices } from '@playwright/test';

/**
 * E2E against the real Worker (`wrangler dev`) + fake GitHub + the built PWA.
 * `pnpm e2e` starts the stack (scripts/e2e-stack.sh) unless E2E_BASE_URL points at a running one.
 * In sandboxes with a preinstalled Chromium, set PW_CHROMIUM=/opt/pw-browsers/chromium.
 */
const exe = process.env.PW_CHROMIUM;
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8787',
    trace: 'retain-on-failure',
    ...(exe ? { launchOptions: { executablePath: exe } } : {}),
  },
  webServer: process.env.E2E_BASE_URL ? undefined : { command: './scripts/e2e-stack.sh', url: 'http://127.0.0.1:8787/api/health', timeout: 180_000, reuseExistingServer: true },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } }, testIgnore: /mobile\.spec/ },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } }, testMatch: /mobile\.spec/ },
  ],
});
