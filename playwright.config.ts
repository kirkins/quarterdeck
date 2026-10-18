import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;
const port = Number(process.env.QD_PORT ?? 4173);

export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.e2e.ts',
	// Screenshots are a manual step (`npm run screenshots`), not part of the smoke run.
	testIgnore: process.env.QD_SCREENSHOTS ? [] : ['**/screenshots.e2e.ts'],
	// Answers are kept in the server's memory, so tests share state: run in order.
	workers: 1,
	fullyParallel: false,
	forbidOnly: CI,
	retries: CI ? 1 : 0,
	reporter: CI ? [['github'], ['html', { open: 'never' }]] : 'list',
	use: {
		baseURL: `http://127.0.0.1:${port}`,
		trace: 'retain-on-failure'
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		command: `npm run build && npm run preview -- --port ${port} --strictPort`,
		url: `http://127.0.0.1:${port}`,
		reuseExistingServer: false,
		timeout: 180_000,
		// Fixtures only, and never send: tests must not reach a fleet.
		env: { QD_SOURCE: 'fixtures', QD_ALLOW_SEND: '0', HOST: '127.0.0.1' }
	}
});
