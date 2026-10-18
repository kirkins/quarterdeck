/**
 * The spend view against a production build serving fixtures (see playwright.config.ts).
 * Read-only. The numbers come from fixtures/fleet-snapshot.json, routes-show.json and
 * usage-records.json: three routes, the free one backing off, and a harness (ferry)
 * that reports no usage.
 */
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function openSpend(page: Page, query = '') {
	await page.goto(`/spend${query}`);
	await expect(page.getByRole('heading', { level: 1, name: 'Spend' })).toBeVisible();
}

const totalTokens = (page: Page) =>
	page.locator('dl.totals div', { hasText: 'Total tokens' }).locator('dd').innerText();

test('routes show the throttled one first, with its relative time', async ({ page }) => {
	await openSpend(page);

	const names = await page
		.locator('li.route')
		.evaluateAll((els) => els.map((el) => el.getAttribute('data-route')));
	expect(names).toEqual(['free-pool', 'plan-main', 'credits-reserve']);

	const free = page.locator('li.route[data-route="free-pool"]');
	await expect(free).toHaveAttribute('data-throttled', 'true');
	await expect(free.locator('.cost')).toHaveText('Free');
	await expect(free.locator('.state-line[data-machine="atlas"] .kind')).toContainText(
		/backing off, back in \d+m/
	);
	await expect(free.locator('details.error-detail summary')).toHaveText('Last error');
	await expect(free.locator('.state-line[data-machine="boreas"] .kind')).toContainText('idle');

	const plan = page.locator('li.route[data-route="plan-main"]');
	await expect(plan.locator('.state-line[data-machine="boreas"] .kind')).toContainText(
		/capped, resets in \d+h/
	);
	await expect(plan.locator('.state-line[data-machine="atlas"] .kind')).toContainText('available');
	// boreas reports the plan's allowance, so the row shows its shares instead of "not reported".
	await expect(plan.locator('.budget')).toHaveCount(0);
	const boreas = plan.locator('.state-line[data-machine="boreas"]');
	await expect(boreas.locator('.allowance')).toHaveText(
		/^allowance: window 40% used, resets in \S+ · week 87% used, resets in \S+$/
	);
	await expect(boreas.locator('.identity')).toHaveText('route tidewater large');

	const credits = page.locator('li.route[data-route="credits-reserve"]');
	await expect(credits.locator('.budget')).toHaveText('Credit balance: not reported');
});

test('changing the period changes the totals, and the link says which period it is', async ({
	page
}) => {
	await openSpend(page);
	await expect(page.getByRole('link', { name: '7 days' })).toHaveAttribute('aria-current', 'true');
	const week = await totalTokens(page);

	await page.getByRole('link', { name: '24 h' }).click();
	await expect(page).toHaveURL(/\?period=24h&group=route$/);
	await expect(page.getByRole('link', { name: '24 h' })).toHaveAttribute('aria-current', 'true');
	await expect(page.locator('p.period')).toContainText('the last 24 hours');
	const day = await totalTokens(page);

	await page.getByRole('link', { name: '30 days' }).click();
	await expect(page.locator('p.period')).toContainText('the last 30 days');
	const month = await totalTokens(page);

	expect(day).not.toEqual(week);
	expect(month).not.toEqual(day);
});

test('grouping by ship ranks ships, and by day draws the day chart', async ({ page }) => {
	await openSpend(page, '?period=30d&group=route');
	await expect(page.locator('ol.ranked li.rank')).toHaveCount(3);

	await page.getByRole('link', { name: 'Ship', exact: true }).click();
	await expect(page).toHaveURL(/group=ship$/);
	const ships = await page
		.locator('ol.ranked li.rank')
		.evaluateAll((els) => els.map((el) => el.getAttribute('data-key')));
	expect(ships).toContain('billing');
	expect(ships).toContain('analytics');
	// The ranked list is largest first; billing is among the largest ships in the fixture.
	expect(ships.indexOf('billing')).toBeLessThan(ships.indexOf('docs-site'));

	await page.getByRole('link', { name: 'Day', exact: true }).click();
	await expect(page.locator('ol.days')).toBeVisible();
	await expect(page.locator('ol.days li.day')).toHaveCount(30);
	await expect(page.locator('ol.ranked')).toHaveCount(0);
});

test('a harness that reports no usage is named next to the numbers', async ({ page }) => {
	await openSpend(page, '?group=ship');
	const note = page.getByRole('note').filter({ hasText: 'ferry reports no usage' });
	await expect(note).toBeVisible();
	await expect(page.locator('li.rank[data-key="analytics"]')).toContainText('not reported');
});

test('a machine not reached is named as partial, and listed by machine with no numbers', async ({
	page
}) => {
	await openSpend(page);
	const notice = page.locator('p.partial[data-machine="laptop"]');
	await expect(notice).toContainText(
		'Partial: laptop not included (nothing carried from laptop lately; data as of'
	);
	await expect(page.locator('p.period')).toContainText('from the machines reached');
	await expect(page.locator('dl.totals')).toContainText('Total tokens');

	await openSpend(page, '?group=machine');
	const laptop = page.locator('li.rank[data-key="laptop"]');
	await expect(laptop).toHaveAttribute('data-not-reached', 'true');
	await expect(laptop.locator('.rank-value')).toHaveText('not reached');
	await expect(page.locator('li.rank[data-key="atlas"]')).toHaveAttribute(
		'data-not-reached',
		'false'
	);
});

test('a collected machine shows its data as of when it was read, and trimmed logs are named', async ({
	page
}) => {
	await openSpend(page, '?period=7d&group=machine');
	await expect(page.locator('ul.machines li[data-machine="calypso"]')).toContainText(
		/as of \S+ ago/
	);
	await expect(page.locator('p.trimmed')).toHaveText('Some logs were trimmed; totals may be low.');
});

test('cache tokens are labelled apart from input and output', async ({ page }) => {
	await openSpend(page);
	await expect(page.locator('p.cache', { hasText: 'Cache tokens' })).toContainText(
		'Cache tokens are reported apart'
	);
});

test('fits a 375 px phone with no horizontal scroll, and the nav reaches Spend', async ({
	page
}) => {
	await page.setViewportSize({ width: 375, height: 800 });
	await openSpend(page);
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(0);

	await page.goto('/fleet');
	await page.getByRole('link', { name: 'Spend' }).click();
	await expect(page).toHaveURL(/\/spend$/);
	await expect(page.getByRole('link', { name: 'Spend' })).toHaveAttribute('aria-current', 'page');
});
