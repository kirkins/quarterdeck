/**
 * The Ship page against a production build serving fixtures (see
 * playwright.config.ts). Answers are logged by the server, never sent.
 */
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

/** A fixture secret must never reach the page, in any tab. */
const SECRET = 'fixture-secret-do-not-show';

async function openShip(page: Page, name: string, query = '') {
	await page.goto(`/ship/${name}${query}`);
	await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

test('a ship opens from the Feed, and its conversation shows only that ship', async ({ page }) => {
	await page.goto('/feed');
	await expect(page.getByRole('heading', { level: 1, name: 'Feed' })).toBeVisible();
	await page.locator('li.msg a.who', { hasText: 'billing' }).first().click();

	await expect(page).toHaveURL(/\/ship\/billing$/);
	await expect(page.getByRole('heading', { level: 1, name: 'billing' })).toBeVisible();
	await expect(page.getByRole('tab', { name: 'Conversation' })).toHaveAttribute(
		'aria-selected',
		'true'
	);
	await expect(page.locator('li.msg').first()).toBeAttached();

	// Every sender in this thread is billing or the captain's own replies.
	const senders = await page.locator('li.msg .who').allTextContents();
	expect(senders.length).toBeGreaterThan(0);
	for (const who of senders) expect(['billing', 'You']).toContain(who.trim());
});

test('an open request takes a written reply in place from the ship conversation', async ({
	page
}) => {
	await openShip(page, 'billing');
	// An ask no other spec answers: the server keeps answers for the whole run.
	const ask = page.locator('li.msg[data-entry="f0011-invoice-template"]');
	await expect(ask.getByText('Waiting on you')).toBeVisible();
	await ask.getByRole('button', { name: 'Answer', exact: true }).click();
	const send = ask.getByRole('button', { name: 'Send answer' });
	await expect(send).toBeHidden();

	await ask.getByLabel('Your answer').fill('Keep it for the audit.');
	await send.click();

	await expect(ask).toHaveAttribute('data-open', 'false');
	await expect(ask.locator('.outcome')).toHaveText('You answered: Keep it for the audit.');
});

test('an open notice reads Unread, not Waiting on you', async ({ page }) => {
	await openShip(page, 'billing');
	const notice = page.locator('li.msg[data-entry="b-102"]');
	await expect(notice.getByText('Unread', { exact: true })).toBeVisible();
	await expect(notice.getByText('Waiting on you')).toBeHidden();
});

test('the Fleet and Triage name each ship as a link to its page', async ({ page }) => {
	await page.goto('/fleet');
	await expect(page.getByRole('heading', { level: 1, name: 'Fleet' })).toBeVisible();
	await page.locator('a.ship-name', { hasText: 'chandlery' }).click();
	await expect(page).toHaveURL(/\/ship\/chandlery$/);
	await expect(page.getByRole('heading', { level: 1, name: 'chandlery' })).toBeVisible();

	await page.goto('/triage');
	await expect(page.getByRole('heading', { level: 1, name: 'Triage' })).toBeVisible();
	const link = page.locator('a.ship-name', { hasText: 'billing' }).first();
	await expect(link).toHaveAttribute('href', /\/ship\/billing$/);
	// The row keeps its own toggle: a click on the summary still opens the ask.
	const row = link.locator('xpath=ancestor::li[1]');
	await row.getByRole('button').first().click();
	await expect(row).toHaveClass(/open/);
});

test('the tools tab shows the sections, folds long lists, and never shows a secret', async ({
	page
}) => {
	await openShip(page, 'billing', '?tab=tools');
	await expect(page.getByRole('tab', { name: 'Tools' })).toHaveAttribute('aria-selected', 'true');

	for (const title of [
		'Model routes',
		'Charter',
		'Permissions',
		'Skills',
		'MCP servers',
		'Plugins',
		'Sleep and hosting'
	]) {
		await expect(page.getByRole('heading', { level: 2, name: new RegExp(title) })).toBeVisible();
	}

	const skills = page.locator('#tools-skills');
	await expect(skills.getByText('retry-policy')).toBeVisible();
	await expect(skills.getByText('Show 6 more skills')).toBeVisible();
	await skills.getByText('Show 6 more skills').click();
	await expect(skills.locator('li')).toHaveCount(11);

	const text = await page.locator('main').innerText();
	expect(text).not.toContain(SECRET);
	await expect(page.getByText('not set').first()).toBeHidden();
	await expect(page.getByText('set', { exact: true }).first()).toBeVisible();
});

test('the tools search narrows the tool lists to what matches', async ({ page }) => {
	await openShip(page, 'billing', '?tab=tools');
	await page.getByPlaceholder('Find a skill, server or plugin').fill('stripe');

	await expect(page.locator('#tools-mcp').getByText('stripe-sandbox')).toBeVisible();
	await expect(page.locator('#tools-mcp').getByText('calendar')).toBeHidden();
	await expect(page.locator('#tools-skills').getByText('No skill matches.')).toBeVisible();

	await page.getByPlaceholder('Find a skill, server or plugin').fill('nothing matches this');
	await expect(page.getByText('Nothing matches “nothing matches this”.')).toBeVisible();
});

test('a ship asleep and a ship on another machine show their place', async ({ page }) => {
	await openShip(page, 'docs-site');
	await expect(page.getByText('asleep', { exact: true })).toBeVisible();

	await openShip(page, 'search-index');
	await expect(page.getByText('On boreas', { exact: true })).toBeVisible();
});

test('a ship on another machine says its tools are read there, calmly', async ({ page }) => {
	await openShip(page, 'search-index', '?tab=tools');
	await expect(page.getByText('This ship runs on boreas')).toBeVisible();
	await expect(page.getByRole('alert')).toBeHidden();
	await expect(page.locator('#tools-skills')).toBeHidden();
	// The header still places the ship, and the conversation tab is unaffected.
	await expect(page.getByText('On boreas', { exact: true })).toBeVisible();
});

test('a failed tool plan, a fractional idle time and an unbounded first mate read plainly', async ({
	page
}) => {
	await openShip(page, 'chandlery', '?tab=tools');
	await expect(page.getByText('could not be built: bundle catalogue-pages')).toBeVisible();
	await expect(page.getByText('Sleeps after 7.5 min idle')).toBeVisible();
	await expect(page.getByText('The charter is inactive.')).toBeVisible();

	await openShip(page, 'docs-site', '?tab=tools');
	await expect(
		page.locator('#tools-skills').getByText('Not listed: this first mate loads its own skills.')
	).toBeVisible();
	await expect(page.getByText('No routes', { exact: true }).first()).toBeVisible();
});

test('a name that is not a ship shows a designed not-found state', async ({ page }) => {
	await page.goto('/ship/ghost');
	await expect(page.getByText('No ship called “ghost”')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Open the Fleet' })).toBeVisible();

	await page.goto('/ship/%3Cscript%3E');
	await expect(page.getByText('No ship called “<script>”')).toBeVisible();
});

test('fits a 375 px phone with no horizontal scroll, on both tabs', async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 800 });
	for (const query of ['', '?tab=tools']) {
		await openShip(page, 'billing', query);
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow).toBeLessThanOrEqual(0);
	}
});
