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

/**
 * Load older pages, as a captain scrolling up would, until the message is on the page.
 * Each click waits for more messages to render. Waiting for a response registered
 * before the click can hang: a page a scroll already asked for may land first.
 */
async function reveal(page: Page, message: Locator) {
	for (let i = 0; i < 4 && (await message.count()) === 0; i++) {
		const before = await page.locator('li.msg').count();
		await page.getByRole('button', { name: 'Load older messages' }).click();
		await expect
			.poll(() => page.locator('li.msg').count(), { timeout: 10_000 })
			.toBeGreaterThan(before);
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

test('the newest page is read first, and two older pages load by cursor', async ({ page }) => {
	await openFeed(page);
	// Every backward page the thread asks Privateer for, and the cursor it asked with.
	const cursors: string[] = [];
	page.on('request', (request) => {
		const url = new URL(request.url());
		if (url.pathname === '/feed/data' && url.searchParams.has('before')) {
			cursors.push(url.searchParams.get('before') ?? '');
		}
	});

	const old = page.locator('li.msg[data-entry="a-402"]');
	await expect(old).toHaveCount(0);

	// Scrolling up is how the captain pages back. The button is not clicked: the feed is live,
	// so it is re-rendered while a test is reaching for it.
	for (let i = 0; i < 3 && cursors.length < 2; i++) {
		const asked = cursors.length;
		await page.evaluate(() => window.scrollTo(0, 0));
		await expect.poll(() => cursors.length, { timeout: 10_000 }).toBeGreaterThan(asked);
	}

	// Two pages back, each asked for with a cursor of its own, so paging moved on.
	expect(cursors.length).toBeGreaterThanOrEqual(2);
	expect(new Set(cursors).size).toBe(cursors.length);
	await expect(old).toBeAttached();
});

test('Only waiting on me asks Privateer, so an old open ask appears without paging', async ({
	page
}) => {
	await openFeed(page);
	// An open ask that is older than the page the feed opened on: it can only be here
	// if Privateer was asked for the open items over the whole history.
	const ask = page.locator('li.msg[data-entry="m-605"]');
	await expect(ask).toHaveCount(0);

	const asked = page.waitForRequest(
		(r) => r.url().includes('/feed/data') && r.url().includes('open_only=1')
	);
	await page.getByLabel('Only waiting on me').check();
	// A reload of the newest open items sends no cursor: Privateer's newest bound is the server's to set.
	expect(new URL((await asked).url()).searchParams.has('after')).toBe(false);
	await expect(ask).toBeVisible();
});

test('the open refresh merges by key and leaves the captain where they were', async ({ page }) => {
	await openFeed(page);
	// Read one message, and remember where it sits on the screen.
	const reading = page.locator('li.msg[data-entry="a-406"]');
	await reading.scrollIntoViewIfNeeded();
	const top = await reading.evaluate((row) => row.getBoundingClientRect().top);

	// Coming back to the tab re-reads the open items, which is how a desk copy
	// collected late from another machine is found.
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(page.locator('li.msg[data-entry="f0012-late-desk-copy"]')).toHaveCount(1);

	const ids = await page
		.locator('li.msg')
		.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-entry')));
	expect(new Set(ids).size).toBe(ids.length);
	// Merging older asks in above the view is anchored by the browser, so the message the
	// captain was reading stays put even though the scroll position moves.
	const after = await reading.evaluate((row) => row.getBoundingClientRect().top);
	expect(Math.abs(after - top)).toBeLessThan(4);
});

test('an open ask is a short message until Answer opens its form, and a half-written answer survives', async ({
	page
}) => {
	await openFeed(page);
	const ask = page.locator('li.msg[data-entry="f0008-listing-offline"]');
	const answer = ask.getByRole('button', { name: 'Answer', exact: true });
	await expect(ask.getByText('Waiting on you')).toBeVisible();
	await expect(ask.getByLabel('Your answer')).toBeHidden();

	await answer.click();
	await ask.getByLabel('Your answer').fill('Half a thought');
	await ask.getByRole('button', { name: 'Collapse' }).click();
	await expect(ask.getByLabel('Your answer')).toBeHidden();

	await answer.click();
	await expect(ask.getByLabel('Your answer')).toHaveValue('Half a thought');
});

test('a decision is answered in place, with a confirm step, and the reply appears', async ({
	page
}) => {
	await openFeed(page);
	const ask = page.locator('li.msg[data-entry="f0007-onboarding-android"]');
	await ask.getByRole('button', { name: 'Answer', exact: true }).click();
	const send = ask.getByRole('button', { name: 'Send answer' });
	await expect(send).toBeHidden();

	await ask.getByRole('radio', { name: /Android first/ }).check();
	await expect(send).toBeVisible();
	await send.click();

	await expect(ask).toHaveAttribute('data-open', 'false');
	await expect(ask.locator('.outcome')).toHaveText('You chose Android first');
	const reply = page.locator('li.msg.mine').filter({ hasText: 'Android first' });
	await expect(reply).toBeVisible();
	await expect(reply).toContainText('Logged, not sent');
});

test('a request takes a written reply in place', async ({ page }) => {
	await openFeed(page);
	const ask = page.locator('li.msg[data-entry="f0008-listing-offline"]');
	await ask.getByRole('button', { name: 'Answer', exact: true }).click();
	await ask.getByLabel('Your answer').fill('Yes, before review.');
	await ask.getByRole('button', { name: 'Send answer' }).click();

	await expect(ask).toHaveAttribute('data-open', 'false');
	await expect(ask.locator('.outcome')).toHaveText('You answered: Yes, before review.');
	await expect(
		page.locator('li.msg.mine').filter({ hasText: 'Yes, before review.' })
	).toBeVisible();
});

test('a needs-hands step is copied, then closed with Done, nothing to add', async ({
	page,
	context
}) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await openFeed(page);
	const step = page.locator('li.msg[data-entry="f0002-status-move"]');
	await reveal(page, step);
	await step.getByRole('button', { name: 'Answer', exact: true }).click();
	await expect(step.getByText('Needs your hands')).toBeVisible();

	const text = (await step.locator('.hands p').first().innerText()).trim();
	await step.getByRole('button', { name: 'Copy step' }).click();
	await expect(step.getByRole('button', { name: 'Copied' })).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);

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
	// Asking again reads the newest page with ship mail in it, which can put the older mail
	// past the page's end: load older pages the way the captain would, until it is there.
	const mail = page.locator('li.msg.s2s').filter({ hasText: 'Refund totals match the ledger' });
	await reveal(page, mail);
	await expect(mail).toBeVisible();
	await expect(mail).toContainText('billing → chandlery');
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

test('a captain reply with comments says how many, and the report it answers is one link away', async ({
	page
}) => {
	await openFeed(page);
	const reply = page.locator('li.msg[data-entry="c-701"]');
	await reveal(page, reply);
	await expect(reply.locator('.comments')).toHaveText('2 comments on Onboarding guide, draft 2');
	// Under the comments line, the captain's own note shows; the summary line does not repeat.
	await expect(reply.locator('.body')).toHaveText(
		'Two changes before the tag, both in the comments.'
	);

	const report = page.locator('li.msg[data-entry="d-701"]');
	await expect(
		report.getByRole('link', { name: 'Open report: Onboarding guide, draft 2' })
	).toBeVisible();
});
