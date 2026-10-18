/**
 * The Feed against a production build serving fixtures (see playwright.config.ts).
 * Answers are logged by the server, never sent. The first test must be the one
 * that reads the feed first: the fixture's held messages arrive a few seconds
 * after that first read, and the pill test is what watches for them.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function openFeed(page: Page) {
	await page.goto('/feed');
	await expect(page.getByRole('heading', { level: 1, name: 'Feed' })).toBeVisible();
}

/** Load older pages, as a captain scrolling up would, until the message is on the page. */
async function reveal(page: Page, message: Locator) {
	for (let i = 0; i < 4 && (await message.count()) === 0; i++) {
		const loaded = page.waitForResponse((r) => r.url().includes('/feed/data'));
		await page.getByRole('button', { name: 'Load older messages' }).click();
		await loaded;
	}
	await expect(message).toBeAttached();
}

test('a new message shows the pill while scrolled up, and the captain is not moved', async ({
	page
}) => {
	await openFeed(page);
	await expect(page.locator('li.msg').last()).toBeInViewport();
	// Scroll to the top, which also asks for older messages; stay up there.
	await page.evaluate(() => window.scrollTo(0, 0));
	await expect(page.getByRole('button', { name: /new message/ })).toBeVisible({ timeout: 30_000 });
	const away = await page.evaluate(
		() => document.documentElement.scrollHeight - (window.scrollY + window.innerHeight)
	);
	expect(away).toBeGreaterThan(80);
});

test('the feed opens at the newest message, and / leads here', async ({ page }) => {
	await page.goto('/');
	await expect(page).toHaveURL(/\/feed$/);
	await expect(page.getByRole('link', { name: /^Feed/ })).toHaveAttribute('aria-current', 'page');
	const nav = page.getByRole('navigation', { name: 'Sections' });
	await expect(nav.getByRole('link').first()).toHaveText(/Feed/);
	await expect(page.getByText('Fixture data')).toBeVisible();

	await expect(page.locator('li.msg').last()).toBeInViewport();
	await expect(page.locator('li.day').first()).toBeAttached();
	await expect(page.getByText('Waiting on you').first()).toBeVisible();
});

test('scrolling up loads older messages and keeps the place', async ({ page }) => {
	await openFeed(page);
	const before = await page.locator('li.msg').count();
	await page.evaluate(() => window.scrollTo(0, 0));
	await expect
		.poll(() => page.locator('li.msg').count(), { timeout: 10_000 })
		.toBeGreaterThan(before);
	const y = await page.evaluate(() => window.scrollY);
	expect(y).toBeGreaterThan(0);
});

test('a decision is answered in place, with a confirm step, and the reply appears', async ({
	page
}) => {
	await openFeed(page);
	const ask = page.locator('li.msg[data-entry="f0013-shard-count"]');
	const send = ask.getByRole('button', { name: 'Send answer' });
	await expect(send).toBeHidden();

	await ask.getByRole('radio', { name: /Eight shards/ }).check();
	await expect(send).toBeVisible();
	await send.click();

	await expect(ask).toHaveAttribute('data-open', 'false');
	const reply = page.locator('li.msg.mine').filter({ hasText: 'Eight shards' });
	await expect(reply).toBeVisible();
	await expect(reply).toContainText('Logged, not sent');
});

test('a request takes a written reply in place', async ({ page }) => {
	await openFeed(page);
	const ask = page.locator('li.msg[data-entry="f0008-listing-offline"]');
	await ask.getByLabel('Your answer').fill('Yes, before review.');
	await ask.getByRole('button', { name: 'Send answer' }).click();

	await expect(ask).toHaveAttribute('data-open', 'false');
	await expect(
		page.locator('li.msg.mine').filter({ hasText: 'Yes, before review.' })
	).toBeVisible();
});

test('a needs-hands step is closed with Done, nothing to add', async ({ page }) => {
	await openFeed(page);
	const step = page.locator('li.msg[data-entry="f0002-status-move"]');
	await reveal(page, step);
	await expect(step.getByText('Needs your hands')).toBeVisible();
	await step.getByText('Done, nothing to add').first().click();
	await step.getByRole('button', { name: 'Done, nothing to add' }).click();

	await expect(step).toHaveAttribute('data-open', 'false');
	await expect(step.getByText('Dismissed')).toBeVisible();
});

test('ship-to-ship mail is behind a toggle, and drawn apart', async ({ page }) => {
	await openFeed(page);
	const toggle = page.getByLabel('Include ship-to-ship mail');
	await expect(page.getByText('Refund totals match the ledger for March.')).toHaveCount(0);

	await toggle.check();
	const mail = page.locator('li.msg.s2s').filter({ hasText: 'Refund totals match the ledger' });
	await expect(mail).toBeVisible();
	await expect(mail).toContainText('billing → storefront');
});

test('filtering to one ship shows only its mail and its replies', async ({ page }) => {
	await openFeed(page);
	await page.getByRole('combobox').selectOption('analytics');
	await expect(page.locator('li.msg').filter({ hasText: 'Which cohort size' })).toBeVisible();

	const names = await page.locator('li.msg .who').allTextContents();
	expect(names.length).toBeGreaterThan(0);
	for (const name of names) expect(['analytics', 'You']).toContain(name);
});

test('the feed fits a 375 px phone without sideways scrolling', async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 812 });
	await openFeed(page);
	await expect(page.locator('li.msg').last()).toBeAttached();
	const overflows = await page.evaluate(
		() => document.documentElement.scrollWidth > document.documentElement.clientWidth
	);
	expect(overflows).toBe(false);
});
