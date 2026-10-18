/**
 * Triage against a production build serving fixtures (see playwright.config.ts).
 * Answers and replies are logged by the server, never sent. Tests share the
 * server's memory, so they run in order, and this file runs after decisions:
 * counts are compared with what was there before each action, not fixed.
 */
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

/** The number on the Triage nav link. */
async function badge(page: Page): Promise<number> {
	const text = (await page.getByRole('link', { name: /Triage/ }).textContent()) ?? '';
	return Number(text.match(/\d+/)?.[0] ?? NaN);
}

test('lists everything owed in sections, most urgent first', async ({ page }) => {
	await page.goto('/triage');

	await expect(page.getByRole('heading', { level: 1, name: 'Triage' })).toBeVisible();
	await expect(page.getByRole('link', { name: /Triage/ })).toHaveAttribute('aria-current', 'page');
	expect(await badge(page)).toBeGreaterThan(0);

	const headings = page.locator('section.section h2');
	await expect(headings).toHaveCount(3);
	await expect(headings.nth(0)).toContainText('Needs you now');
	await expect(headings.nth(1)).toContainText('Waiting on you');
	await expect(headings.nth(2)).toContainText('When you have a moment');

	// Urgency high comes first in "Needs you now".
	const first = page.locator('section.section').first().locator('[data-row]').first();
	await expect(first.locator('.flag.high')).toBeVisible();

	// Approvals and blockers are listed too.
	await expect(page.locator('[data-kind="approval"]')).toHaveCount(1);
	await expect(page.locator('[data-kind="blocker"]')).toHaveCount(3);
});

test('filters by ship and remembers the choice', async ({ page }) => {
	await page.goto('/triage');
	const ships = page.getByRole('group', { name: 'Filter by ship' });
	const everything = await page.locator('[data-row]').count();

	await ships.getByRole('button', { name: 'mobile-app' }).click();
	await expect(page.locator('[data-row]').filter({ hasNotText: 'mobile-app' })).toHaveCount(0);
	await expect(page.locator('[data-row]')).not.toHaveCount(everything);

	await page.reload();
	await expect(ships.getByRole('button', { name: 'mobile-app' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);

	await ships.getByRole('button', { name: 'All ships' }).click();
	await expect(page.locator('[data-row]')).toHaveCount(everything);
});

test('a question takes a reply, and drops out of triage', async ({ page }) => {
	await page.goto('/triage');
	const before = await badge(page);
	const row = page.locator('[data-row="f0008-listing-offline"]');
	await row.locator('button.head').click();
	await row.getByLabel('Reply to mobile-app').fill('Not before review. Mention it after.');
	await row.getByRole('button', { name: 'Send reply' }).click();

	await expect(page.locator('[data-row="f0008-listing-offline"]')).toHaveCount(0);
	await expect.poll(() => badge(page)).toBe(before - 1);
});

test('a needs-hands step shows the exact step, and Done replies to the asker', async ({ page }) => {
	await page.goto('/triage');
	const row = page.locator('[data-row="f0002-status-move"]');
	await expect(row.locator('.flag.hands')).toBeVisible();
	await row.locator('button.head').click();
	await expect(row.getByText(/Approve the DNS change at the domain registrar/)).toBeVisible();
	await expect(row.getByRole('button', { name: 'Copy step' })).toBeVisible();
	await row.getByRole('button', { name: 'Done, I did this' }).click();

	await expect(page.locator('[data-row="f0002-status-move"]')).toHaveCount(0);
});

test('a decision opens its card in place and answers like the Decisions page', async ({ page }) => {
	await page.goto('/triage');
	const row = page.locator('[data-row="f0004-autumn-hero"]');
	await row.locator('button.head').click();
	const card = row.locator('[data-card]');
	await card.getByRole('radio', { name: /Product photo in use/ }).check();
	await card.getByRole('button', { name: 'Send answer' }).click();

	await expect(page.locator('[data-row="f0004-autumn-hero"]')).toHaveCount(0);
});

test('approvals and blockers say what Quarterdeck can and cannot do', async ({ page }) => {
	await page.goto('/triage');
	const approval = page.locator('[data-kind="approval"]');
	await approval.locator('button.head').click();
	await expect(approval.getByText(/answered in Privateer/)).toBeVisible();
	await expect(approval.getByRole('button', { name: 'Send reply' })).toHaveCount(0);

	const blocker = page.locator('[data-kind="blocker"]').first();
	await blocker.locator('button.head').click();
	await expect(blocker.getByRole('button', { name: 'Send reply' })).toHaveCount(0);
});

test('works at phone width without horizontal scroll', async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 812 });
	await page.goto('/triage');
	await expect(page.locator('[data-row]').first()).toBeVisible();
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(0);
});
