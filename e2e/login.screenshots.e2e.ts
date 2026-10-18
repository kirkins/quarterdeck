/**
 * Screenshots of the login for docs/screenshots and the PR description, from
 * the `login` project's server. Run with `npm run screenshots`.
 */
import { expect, test, type Page } from '@playwright/test';
import { TEST_PASSPHRASE } from './login-secret.ts';

const dir = 'docs/screenshots';

async function open(page: Page, theme: 'light' | 'dark') {
	await page
		.context()
		.addCookies([{ name: 'qd_theme', value: theme, url: test.info().project.use.baseURL ?? '' }]);
	await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
	await page.goto('/login?next=%2Ftriage');
	await expect(page.getByRole('heading', { level: 1, name: 'Come aboard' })).toBeVisible();
	await page.evaluate(() => document.fonts.ready);
}

test.describe('phone', () => {
	test.use({
		viewport: { width: 390, height: 844 },
		deviceScaleFactor: 2,
		isMobile: true,
		hasTouch: true
	});

	for (const theme of ['light', 'dark'] as const) {
		test(`login, ${theme}`, async ({ page }) => {
			await open(page, theme);
			await page.getByLabel('Passphrase', { exact: true }).fill('a long passphrase');
			await page.getByLabel('Passphrase', { exact: true }).blur();
			await page.screenshot({ path: `${dir}/login-phone-${theme}.png` });
		});
	}

	test('login, wrong passphrase', async ({ page }) => {
		await open(page, 'light');
		await page.getByLabel('Passphrase', { exact: true }).fill('not it');
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page.getByRole('alert')).toBeVisible();
		await page.getByLabel('Passphrase', { exact: true }).blur();
		await page.screenshot({ path: `${dir}/login-phone-error.png` });
	});

	test('signed in: Sign out beside the theme button', async ({ page }) => {
		await open(page, 'dark');
		await page.getByLabel('Passphrase', { exact: true }).fill(TEST_PASSPHRASE);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(/\/triage$/);
		await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
		await page.evaluate(() => document.fonts.ready);
		await page.screenshot({ path: `${dir}/login-signed-in-phone-dark.png` });
	});
});

test.describe('desktop', () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test('login, light', async ({ page }) => {
		await open(page, 'light');
		await page.screenshot({ path: `${dir}/login-desktop-light.png` });
	});

	test('signed in: the sidebar says so, with Sign out', async ({ page }) => {
		await open(page, 'light');
		await page.getByLabel('Passphrase', { exact: true }).fill(TEST_PASSPHRASE);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(/\/triage$/);
		await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
		await page.evaluate(() => document.fonts.ready);
		await page.screenshot({ path: `${dir}/login-signed-in-desktop.png` });
	});
});
