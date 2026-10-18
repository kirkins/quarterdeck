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
	await page.goto('/decisions');
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
		await row.locator('button.toggle').click();
		await row.evaluate((el) =>
			window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 120)
		);
		await page.mouse.move(0, 0);
		await page.screenshot({ path: `${dir}/triage-phone-hands.png` });
	});

	test('dismiss confirm step', async ({ page }) => {
		await openTriage(page, 'light');
		const row = page.locator('[data-row="f0022-backup-verified"]');
		await row.locator('button.toggle').click();
		await row.locator('details.dismiss > summary').click();
		await row.locator('details.dismiss textarea[name="note"]').fill('Checked on the dashboard.');
		await row.evaluate((el) =>
			window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 120)
		);
		await page.mouse.move(0, 0);
		await page.screenshot({ path: `${dir}/triage-phone-dismiss.png` });
	});
});

test.describe('triage desktop', () => {
	test.use({ viewport: { width: 1280, height: 900 } });

	test('triage, light', async ({ page }) => {
		await openTriage(page, 'light');
		await page.screenshot({ path: `${dir}/triage-desktop.png` });
	});
});

async function openFleet(page: Page, theme: 'light' | 'dark') {
	await page.context().addCookies([
		{
			name: 'qd_theme',
			value: theme,
			url: test.info().project.use.baseURL ?? 'http://127.0.0.1:4173'
		}
	]);
	await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
	await page.goto('/fleet');
	await expect(page.getByRole('heading', { level: 1, name: 'Fleet' })).toBeVisible();
	await page.evaluate(() => document.fonts.ready);
}

test.describe('fleet phone', () => {
	test.use({
		viewport: { width: 390, height: 844 },
		deviceScaleFactor: 2,
		isMobile: true,
		hasTouch: true
	});

	for (const theme of ['light', 'dark'] as const) {
		test(`fleet, ${theme}`, async ({ page }) => {
			await openFleet(page, theme);
			await page.screenshot({ path: `${dir}/fleet-phone-${theme}.png` });
		});
	}
});

test.describe('fleet desktop', () => {
	test.use({ viewport: { width: 1280, height: 900 } });

	test('fleet, light', async ({ page }) => {
		await openFleet(page, 'light');
		await page.screenshot({ path: `${dir}/fleet-desktop.png` });
	});
});

async function openSpend(page: Page, theme: 'light' | 'dark') {
	await page.context().addCookies([
		{
			name: 'qd_theme',
			value: theme,
			url: test.info().project.use.baseURL ?? 'http://127.0.0.1:4173'
		}
	]);
	await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
	await page.goto('/spend?period=7d&group=route');
	await expect(page.getByRole('heading', { level: 1, name: 'Spend' })).toBeVisible();
	await page.evaluate(() => document.fonts.ready);
}

test.describe('spend phone', () => {
	test.use({
		viewport: { width: 390, height: 844 },
		deviceScaleFactor: 2,
		isMobile: true,
		hasTouch: true
	});

	for (const theme of ['light', 'dark'] as const) {
		test(`spend, ${theme}`, async ({ page }) => {
			await openSpend(page, theme);
			await page.screenshot({ path: `${dir}/spend-phone-${theme}.png` });
		});
	}
});

test.describe('spend desktop', () => {
	test.use({ viewport: { width: 1280, height: 900 } });

	test('spend, light', async ({ page }) => {
		await openSpend(page, 'light');
		await page.screenshot({ path: `${dir}/spend-desktop.png` });
	});
});

/** The report reader: a Markdown report with two comments, then the comments sheet or side panel. */
const REPORT = `/report/${encodeURIComponent('archive-sync\u0000f0010-archive-review')}`;

async function openReport(page: Page, theme: 'light' | 'dark') {
	await page.context().addCookies([
		{
			name: 'qd_theme',
			value: theme,
			url: test.info().project.use.baseURL ?? 'http://127.0.0.1:4173'
		}
	]);
	await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
	await page.goto(REPORT);
	await expect(
		page.getByRole('heading', { level: 1, name: 'Archive migration: review' })
	).toBeVisible();
	await page.evaluate(() => document.fonts.ready);
}

/** Comment on a passage from the frame, as the captain does. */
async function comment(page: Page, text: string, words: string) {
	// On a phone the comments sheet may cover the report: close it while the passage is chosen.
	const toggle = page.getByRole('button', { name: /Comments/ });
	if ((await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) === 'true') {
		await toggle.click();
	}
	const handle = await page.locator('iframe.frame').elementHandle();
	const frame = await handle?.contentFrame();
	if (!frame) throw new Error('no report frame');
	await frame.evaluate((needle) => {
		const p = [...document.querySelectorAll('p, li')].find((el) =>
			el.textContent?.includes(needle)
		);
		p?.scrollIntoView({ block: 'center' });
		const range = document.createRange();
		range.selectNodeContents(p as Node);
		const selection = getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
	}, text);
	await frame.getByRole('button', { name: 'Comment', exact: true }).click();
	await page.getByRole('textbox', { name: 'Your comment' }).fill(words);
	await page.getByRole('button', { name: 'Save comment' }).click();
}

test.describe('report phone', () => {
	test.use({
		viewport: { width: 390, height: 844 },
		deviceScaleFactor: 2,
		isMobile: true,
		hasTouch: true
	});

	for (const theme of ['light', 'dark'] as const) {
		test(`report with comments, ${theme}`, async ({ page }) => {
			await openReport(page, theme);
			await comment(page, 'The cold tier moved', 'Keep the old bucket read-only for 30 days.');
			await comment(
				page,
				'Do the 2019 exports',
				'Yes, re-encrypt them before retiring the bucket.'
			);
			await expect(page.locator('.notes.open')).toBeVisible();
			await page.screenshot({ path: `${dir}/report-phone-${theme}.png` });
		});
	}
});

test.describe('report desktop', () => {
	test.use({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });

	test('report with the comments column', async ({ page }) => {
		await openReport(page, 'light');
		await comment(page, 'The cold tier moved', 'Keep the old bucket read-only for 30 days.');
		await comment(page, 'Do the 2019 exports', 'Yes, re-encrypt them before retiring the bucket.');
		await page.mouse.move(0, 0);
		await page.screenshot({ path: `${dir}/report-desktop.png` });
	});
});

async function openFeed(page: Page, theme: 'light' | 'dark') {
	await page.context().addCookies([
		{
			name: 'qd_theme',
			value: theme,
			url: test.info().project.use.baseURL ?? 'http://127.0.0.1:4173'
		}
	]);
	await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
	await page.goto('/feed');
	await expect(page.getByRole('heading', { level: 1, name: 'Feed' })).toBeVisible();
	await expect(page.locator('li.msg').last()).toBeInViewport();
	await page.evaluate(() => document.fonts.ready);
}

test.describe('feed phone', () => {
	test.use({
		viewport: { width: 390, height: 844 },
		deviceScaleFactor: 2,
		isMobile: true,
		hasTouch: true
	});

	for (const theme of ['light', 'dark'] as const) {
		test(`feed, ${theme}`, async ({ page }) => {
			await openFeed(page, theme);
			await page.screenshot({ path: `${dir}/feed-phone-${theme}.png` });
		});
	}

	test('a decision answered in place', async ({ page }) => {
		await openFeed(page, 'light');
		const ask = page.locator('li.msg[data-entry="f0007-onboarding-android"]');
		await ask.getByRole('button', { name: 'Answer', exact: true }).click();
		await ask.getByRole('radio', { name: /Android first/ }).check();
		await ask.evaluate((el) =>
			window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 120)
		);
		await page.mouse.move(0, 0);
		await page.screenshot({ path: `${dir}/feed-phone-answer-in-place.png` });
	});
});

test.describe('feed desktop', () => {
	test.use({ viewport: { width: 1280, height: 900 } });

	test('feed, light', async ({ page }) => {
		await openFeed(page, 'light');
		await page.screenshot({ path: `${dir}/feed-desktop-light.png` });
	});
});

async function openShip(page: Page, name: string, theme: 'light' | 'dark', query = '') {
	await page.context().addCookies([
		{
			name: 'qd_theme',
			value: theme,
			url: test.info().project.use.baseURL ?? 'http://127.0.0.1:4173'
		}
	]);
	await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
	await page.goto(`/ship/${name}${query}`);
	await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
	await page.evaluate(() => document.fonts.ready);
}

test.describe('ship phone', () => {
	test.use({
		viewport: { width: 390, height: 844 },
		deviceScaleFactor: 2,
		isMobile: true,
		hasTouch: true
	});

	for (const theme of ['light', 'dark'] as const) {
		test(`ship conversation, ${theme}`, async ({ page }) => {
			await openShip(page, 'billing', theme);
			await page.screenshot({ path: `${dir}/ship-phone-${theme}.png` });
		});

		test(`ship tools, ${theme}`, async ({ page }) => {
			await openShip(page, 'billing', theme, '?tab=tools');
			await page.screenshot({ path: `${dir}/ship-tools-phone-${theme}.png` });
		});
	}
});

test.describe('ship desktop', () => {
	test.use({ viewport: { width: 1280, height: 900 } });

	test('ship conversation and tools, light', async ({ page }) => {
		await openShip(page, 'billing', 'light');
		await page.screenshot({ path: `${dir}/ship-desktop-light.png` });
		await page.goto('/ship/billing?tab=tools');
		await expect(page.getByRole('tab', { name: 'Tools' })).toHaveAttribute('aria-selected', 'true');
		await page.screenshot({ path: `${dir}/ship-tools-desktop-light.png` });
	});
});
