import { defineConfig, devices } from '@playwright/test';
import { TEST_LOGIN_SECRET } from './e2e/login-secret.ts';

const CI = !!process.env.CI;
const port = Number(process.env.QD_PORT ?? 4173);
// The login tests get their own server: the same build, run by server.js with a login secret set.
const loginPort = port + 1;

// Fixtures only, and never send: tests must not reach a fleet.
const env = { QD_SOURCE: 'fixtures', QD_ALLOW_SEND: '0', HOST: '127.0.0.1' };

// Screenshots are a manual step (`npm run screenshots`), not part of the smoke run.
const screenshots = process.env.QD_SCREENSHOTS ? [] : ['**/*screenshots.e2e.ts'];

export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.e2e.ts',
	// Answers are kept in the server's memory, so tests share state: run in order.
	workers: 1,
	fullyParallel: false,
	forbidOnly: CI,
	retries: CI ? 1 : 0,
	reporter: CI ? [['github'], ['html', { open: 'never' }]] : 'list',
	use: {
		trace: 'retain-on-failure'
	},
	projects: [
		{
			name: 'chromium',
			testIgnore: ['**/login*.e2e.ts', ...screenshots],
			use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${port}` }
		},
		{
			name: 'login',
			testMatch: ['**/login*.e2e.ts'],
			testIgnore: screenshots,
			use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${loginPort}` }
		}
	],
	// Started in order, so the second runs the first one's build.
	webServer: [
		{
			command: `npm run build && npm run preview -- --port ${port} --strictPort`,
			url: `http://127.0.0.1:${port}`,
			reuseExistingServer: false,
			timeout: 180_000,
			env
		},
		{
			// The production entry, as `npm start` runs it: the startup guard, then adapter-node.
			command: 'node server.js',
			url: `http://127.0.0.1:${loginPort}/login`,
			reuseExistingServer: false,
			timeout: 60_000,
			env: {
				...env,
				PORT: String(loginPort),
				ORIGIN: `http://127.0.0.1:${loginPort}`,
				QD_LOGIN_SECRET: TEST_LOGIN_SECRET
			}
		}
	]
});
