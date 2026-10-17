/**
 * Smoke test against a production build serving fixtures (see
 * playwright.config.ts). Answers are logged by the server, never sent.
 */
import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test('lists decision cards from fixtures, most urgent first', async ({ page }) => {
	await page.goto('/');

	await expect(page.getByRole('heading', { level: 1, name: 'Decisions' })).toBeVisible();
	await expect(page.getByText('Fixture data')).toBeVisible();
	await expect(page.getByRole('link', { name: /Decisions/ })).toHaveAttribute(
		'aria-current',
		'page'
	);

	const cards = page.locator('[data-card]');
	await expect(cards).toHaveCount(7);
	await expect(cards.first()).toContainText('analytics');
	await expect(cards.first()).toContainText(/Overdue by/);
	await expect(cards.nth(1)).toContainText('Needs your hands');

	// The three search-index questions share one card.
	const group = cards.filter({ hasText: 'search-index' });
	await expect(group.getByRole('heading', { level: 2 })).toHaveCount(3);

	// Older choices-only asks still render, with their choices.
	const legacy = cards.filter({ hasText: 'mobile-app' });
	await expect(legacy.getByRole('radio')).toHaveCount(2);

	// A plain request is not a decision.
	await expect(page.getByText('style guide draft')).toHaveCount(0);

	// The recommendation is marked, never preselected.
	const billing = cards.filter({ hasText: 'retry policy' });
	await expect(billing.getByText('Recommended')).toBeVisible();
	await expect(page.getByRole('radio', { checked: true })).toHaveCount(0);
});

test('answering takes a choice and a confirm, and can be cancelled', async ({ page }) => {
	await page.goto('/');
	const card = page.locator('[data-card]').filter({ hasText: 'retry policy' });
	const send = card.getByRole('button', { name: 'Send answer' });

	await expect(send).toBeHidden();

	await card.getByRole('radio', { name: /Retry 3 times/ }).check();
	await expect(send).toBeVisible();
	await expect(card.getByText('Reply to billing: Retry 3 times, a day apart')).toBeVisible();

	await card.getByRole('button', { name: 'Cancel' }).click();
	await expect(send).toBeHidden();
	await expect(card.getByRole('radio', { checked: true })).toHaveCount(0);

	await card.getByRole('radio', { name: /Smart retries/ }).check();
	await card.getByLabel('Add a note (optional)').fill('Start after the pricing launch.');
	await send.click();

	await expect(card.getByRole('status')).toContainText('Smart retries over 7 days');
	await expect(card.getByRole('status')).toContainText('Logged, not sent');
	await expect(page.getByRole('link', { name: /Decisions/ })).toContainText('8');
	// The answered card sinks to the bottom.
	await expect(page.locator('[data-card]').last()).toContainText('retry policy');
});

test('free-text answers and the keyboard work', async ({ page }) => {
	await page.goto('/');
	const card = page.locator('[data-card]').filter({ hasText: 'workspaces' });

	await card.getByRole('button', { name: 'Or write my own answer' }).click();
	await card.getByLabel('Your own answer').fill('Call them “Crews”.');
	await expect(card.getByText('Reply to docs-site in your own words')).toBeVisible();
	await card.getByRole('button', { name: 'Send answer' }).click();
	await expect(card.getByRole('status')).toContainText('Crews');

	// Keyboard only: focus an option, move with arrows, back out with Escape.
	const hero = page.locator('[data-card]').filter({ hasText: 'autumn sale' });
	await hero.getByRole('radio').first().focus();
	await page.keyboard.press('Space');
	await expect(hero.getByRole('radio').first()).toBeChecked();
	await page.keyboard.press('ArrowDown');
	await expect(hero.getByRole('radio').nth(1)).toBeChecked();
	await page.keyboard.press('Escape');
	await expect(hero.getByRole('radio', { checked: true })).toHaveCount(0);
});

test('every decision takes the captain’s own answer, with no send until there is text', async ({
	page
}) => {
	await page.goto('/');
	const card = page.locator('[data-card]').filter({ hasText: 'analytics' });
	const send = card.getByRole('button', { name: 'Send answer' });

	// Options stay primary; the own answer is one row below them.
	await expect(card.getByRole('radio')).toHaveCount(2);
	await card.getByRole('button', { name: 'Write my own answer' }).click();
	await expect(send).toBeHidden();

	// Spaces alone are not an answer.
	await card.getByLabel('Your own answer').fill('   ');
	await expect(send).toBeHidden();

	await card.getByLabel('Your own answer').fill('Keep 30 days, and say why in the docs.');
	await expect(card.getByText('Reply to analytics in your own words')).toBeVisible();
	await send.click();

	await expect(card.getByRole('status')).toContainText('Keep 30 days, and say why in the docs.');
	await expect(card.getByRole('status')).toContainText('Logged, not sent');
});

test('theme toggle cycles and persists', async ({ page }) => {
	await page.goto('/');
	const html = page.locator('html');
	await expect(html).toHaveAttribute('data-theme', 'system');
	const toggle = page.getByRole('button', { name: /Theme:/ });
	await toggle.click();
	await expect(html).toHaveAttribute('data-theme', 'light');
	await toggle.click();
	await expect(html).toHaveAttribute('data-theme', 'dark');
	await page.reload();
	await expect(html).toHaveAttribute('data-theme', 'dark');
});

test('works at phone width without horizontal scroll', async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 812 });
	await page.goto('/');
	await expect(page.locator('[data-card]').first()).toBeVisible();
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(0);
});
