/**
 * The fleet map against a production build serving fixtures (see playwright.config.ts).
 * Read-only: nothing here changes the fleet. The numbers come from
 * fixtures/fleet-snapshot.json: 3 machines (one unreachable), 9 ships, 5 crew
 * jobs and 3 needs.
 */
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function openFleet(page: Page) {
	await page.goto('/fleet');
	await expect(page.getByRole('heading', { level: 1, name: 'Fleet' })).toBeVisible();
}

test('summarises the fleet and lists machines, busiest first', async ({ page }) => {
	await openFleet(page);

	await expect(page.getByRole('link', { name: 'Fleet' })).toHaveAttribute('aria-current', 'page');
	const summary = page.locator('p.summary');
	await expect(summary).toContainText('2 of 3 machines reachable');
	await expect(summary).toContainText('4 ships awake');
	await expect(summary).toContainText('5 crew running');
	await expect(summary).toContainText('3 items need you');

	const names = await page.locator('section.machine .machine-name').allTextContents();
	expect(names).toEqual(['atlas', 'boreas', 'calypso']);
});

test('an unreachable machine is dimmed, with its ship names and no live counts', async ({
	page
}) => {
	await openFleet(page);

	const calypso = page.locator('section.machine', {
		has: page.getByText('calypso', { exact: true })
	});
	await expect(calypso).toHaveClass(/unreachable/);
	await expect(calypso).toContainText('unreachable');
	await expect(calypso).toContainText('Not reachable from here');
	await expect(calypso.locator('.ship-names li', { hasText: 'mobile-app' })).toBeVisible();
	await expect(calypso.locator('[data-ship]')).toHaveCount(0);
});

test('a ship with needs links to triage filtered to that ship', async ({ page }) => {
	await openFleet(page);

	const search = page.locator('[data-ship="search-index"]');
	await expect(search.locator('.presence')).toHaveText('hosted');
	await expect(search.locator('.job-title')).toHaveText('Nightly index rebuild');
	await expect(search.locator('.job.heavy')).toHaveCount(1);

	await search.getByRole('link', { name: /item needs you/ }).click();
	await expect(page).toHaveURL(/\/triage\?ship=search-index$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Triage' })).toBeVisible();
	await expect(
		page
			.getByRole('group', { name: 'Filter by ship' })
			.getByRole('button', { name: 'search-index' })
	).toHaveAttribute('aria-pressed', 'true');
});

test('a collapsed machine stays collapsed across a refresh', async ({ page }) => {
	await openFleet(page);

	const head = page.getByRole('button', { name: /^atlas/ });
	await expect(head).toHaveAttribute('aria-expanded', 'true');
	await head.click();
	await expect(head).toHaveAttribute('aria-expanded', 'false');
	await expect(page.locator('[data-ship="billing"]')).toHaveCount(0);

	await page.getByRole('button', { name: 'Refresh fleet' }).click();
	await expect(page.getByRole('button', { name: 'Refresh fleet' })).toBeEnabled();
	await expect(head).toHaveAttribute('aria-expanded', 'false');
	await expect(page.locator('[data-ship="billing"]')).toHaveCount(0);

	await head.click();
	await expect(page.locator('[data-ship="billing"]')).toHaveCount(1);
});

test('crew rows show what each job is doing, its elapsed time and any wait', async ({ page }) => {
	await openFleet(page);

	const billing = page.locator('[data-ship="billing"]');
	const heavy = billing.locator('.job.heavy');
	await expect(heavy).toContainText('Retry policy for failed card payments');
	await expect(heavy).toContainText('Replaying');
	await expect(heavy).toContainText('running');
	await expect(heavy.locator('.tag.waits')).toHaveText('waiting for capacity');
});

test('no horizontal overflow on a 375px phone', async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 812 });
	await openFleet(page);
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(0);
});
