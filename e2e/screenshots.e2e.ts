/**
 * Screenshots for docs/screenshots and the PR description.
 * Run with `npm run screenshots` (fixtures; nothing is sent).
 */
import { test, expect, type Page } from '@playwright/test';

const dir = 'docs/screenshots';

async function open(page: Page, theme: 'light' | 'dark') {
	await page.context().addCookies([
		{
			name: 'qd_theme',
			value: theme,
			url: test.info().project.use.baseURL ?? 'http://127.0.0.1:4173'
		}
	]);
	await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1, name: 'Decisions' })).toBeVisible();
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
		test(`decisions, ${theme}`, async ({ page }) => {
			await open(page, theme);
			await page.screenshot({ path: `${dir}/phone-${theme}.png` });
		});
	}

	test('own answer', async ({ page }) => {
		await open(page, 'light');
		const card = page.locator('[data-card]').filter({ hasText: 'retry policy' });
		await card.getByRole('button', { name: 'Write my own answer' }).click();
		const field = card.getByLabel('Your own answer');
		await field.fill('Retry on payday only, and tell support first.');
		// Frame the own answer and its Send step below the header.
		await field.evaluate((el) =>
			window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 260)
		);
		await page.mouse.move(0, 0);
		await page.screenshot({ path: `${dir}/phone-own-answer.png` });
	});

	test('grouped card', async ({ page }) => {
		await open(page, 'light');
		const card = page.locator('[data-card]').filter({ hasText: 'analytics' });
		await card.evaluate((el) =>
			window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 80)
		);
		await page.mouse.move(0, 0);
		await page.screenshot({ path: `${dir}/phone-group.png` });
	});

	test('legacy card', async ({ page }) => {
		await open(page, 'light');
		const card = page.locator('[data-card]').filter({ hasText: 'mobile-app' });
		await card.evaluate((el) =>
			window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 80)
		);
		await page.mouse.move(0, 0);
		await page.screenshot({ path: `${dir}/phone-legacy.png` });
	});

	test('confirm step', async ({ page }) => {
		await open(page, 'light');
		const card = page.locator('[data-card]').filter({ hasText: 'retry policy' });
		await card.getByRole('radio', { name: /Smart retries over 7 days/ }).check();
		await card.getByLabel('Add a note (optional)').fill('Start after the pricing launch.');
		// Frame the chosen option, the note and the Send step below the header.
		await page.evaluate(() => {
			const option = document.querySelector('input:checked')?.closest('label');
			if (option) window.scrollTo(0, option.getBoundingClientRect().top + window.scrollY - 150);
		});
		await page.mouse.move(0, 0);
		await page.screenshot({ path: `${dir}/phone-confirm.png` });
	});
});

test.describe('desktop', () => {
	test.use({ viewport: { width: 1280, height: 900 } });

	test('decisions, light', async ({ page }) => {
		await open(page, 'light');
		await page.screenshot({ path: `${dir}/desktop-light.png` });
		await page.screenshot({ path: `${dir}/desktop-light-full.png`, fullPage: true });
	});
});

async function openTriage(page: Page, theme: 'light' | 'dark') {
	await page.context().addCookies([
		{
			name: 'qd_theme',
			value: theme,
			url: test.info().project.use.baseURL ?? 'http://127.0.0.1:4173'
		}
	]);
	await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
	await page.goto('/triage');
	await expect(page.getByRole('heading', { level: 1, name: 'Triage' })).toBeVisible();
	await page.evaluate(() => document.fonts.ready);
}

test.describe('triage phone', () => {
	test.use({
		viewport: { width: 390, height: 844 },
		deviceScaleFactor: 2,
		isMobile: true,
		hasTouch: true
	});

	for (const theme of ['light', 'dark'] as const) {
		test(`triage, ${theme}`, async ({ page }) => {
			await openTriage(page, theme);
			await page.screenshot({ path: `${dir}/triage-phone-${theme}.png` });
		});
	}

	test('a needs-hands step, expanded', async ({ page }) => {
		await openTriage(page, 'light');
		const row = page.locator('[data-row="f0002-status-move"]');
		await row.locator('button.head').click();
		await row.evaluate((el) =>
			window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 120)
		);
		await page.mouse.move(0, 0);
		await page.screenshot({ path: `${dir}/triage-phone-hands.png` });
	});
});

test.describe('triage desktop', () => {
	test.use({ viewport: { width: 1280, height: 900 } });

	test('triage, light', async ({ page }) => {
		await openTriage(page, 'light');
		await page.screenshot({ path: `${dir}/triage-desktop.png` });
	});
});
