/**
 * The report reader against a production build serving fixtures (see
 * playwright.config.ts). Comments are logged by the server, never sent. The
 * fixtures hold an inline Markdown notice from archive-sync (in the feed, as
 * captain.waiting does not carry notices), an HTML request held by id from
 * metrics-rollup, and a notice by id from ledger, which is on another machine,
 * so report.get here does not hold it. Only the request is sent, and sending it
 * answers it; a notice's comments go back as its annotations, but that is not
 * sent here. That test is the last in this file, and runs before triage, which
 * reads the same fixtures.
 */
import { createServer, type Server } from 'node:http';
import { expect, test, type Frame, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const MARKDOWN = `/report/${encodeURIComponent('archive-sync\u0000f0010-archive-review')}`;
const HTML = `/report/${encodeURIComponent('metrics-rollup\u0000f0011-rollup-report')}`;
const ELSEWHERE = `/report/${encodeURIComponent('ledger\u0000f0020-ledger-reconcile')}`;

/**
 * A local listener the HTML fixture's links and its encoded meta refresh point
 * at (fixtures/report.get.json). If the frame ever follows one, it lands here.
 */
const TRAP_PORT = 4179;
const trapped: string[] = [];
let trap: Server;

test.beforeAll(async () => {
	trap = createServer((request, response) => {
		trapped.push(request.url ?? '');
		// A page that tries to talk to the portal as if it were the annotator, without the token.
		response.setHeader('content-type', 'text/html');
		response.end(
			`<p>Elsewhere</p><script>parent.postMessage({ type: 'block', token: 'guess', anchor: { selector: '0', quote: 'Injected' } }, '*');</script>`
		);
	});
	await new Promise<void>((done) => trap.listen(TRAP_PORT, '127.0.0.1', done));
});

test.afterAll(async () => {
	await new Promise((done) => trap.close(done));
});

/** The report's frame, as a Playwright frame: its text can be selected and clicked. */
async function frameOf(page: Page): Promise<Frame> {
	const handle = await page.locator('iframe.frame').elementHandle();
	const frame = await handle?.contentFrame();
	if (!frame) throw new Error('the report frame is not there');
	return frame;
}

/** Select every word of the first paragraph that contains `text`, inside the frame. */
async function selectParagraph(frame: Frame, text: string) {
	await frame.evaluate((needle) => {
		const p = [...document.querySelectorAll('p')].find((el) => el.textContent?.includes(needle));
		if (!p) throw new Error(`no paragraph with ${needle}`);
		const range = document.createRange();
		range.selectNodeContents(p);
		const selection = getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
	}, text);
}

/** Comment on the first paragraph containing `text`, from the frame's Comment pop-up. */
async function commentOn(page: Page, text: string, comment: string) {
	const frame = await frameOf(page);
	await selectParagraph(frame, text);
	await frame.getByRole('button', { name: 'Comment', exact: true }).click();
	await page.getByRole('textbox', { name: 'Your comment' }).fill(comment);
	await page.getByRole('button', { name: 'Save comment' }).click();
	await expect(page.getByRole('list').getByText(comment)).toBeVisible();
}

test('a report is read, and a passage in it is commented on', async ({ page }) => {
	await page.goto(MARKDOWN);
	await expect(
		page.getByRole('heading', { level: 1, name: 'Archive migration: review' })
	).toBeVisible();

	const frame = await frameOf(page);
	await expect(
		frame.getByRole('heading', { level: 1, name: 'Archive migration: review' })
	).toBeVisible();
	await expect(frame.locator('table')).toBeVisible();

	await commentOn(page, 'The cold tier moved', 'Keep the old bucket read-only for 30 days.');
	await expect(page.getByRole('heading', { name: 'Your comments' })).toBeVisible();
});

test('a report stored on another machine reads as a calm state, not an error', async ({ page }) => {
	await page.goto(ELSEWHERE);
	await expect(
		page.getByText("This report is stored on another machine and can't be opened here yet.")
	).toBeVisible();
	await expect(page.getByRole('alert')).toHaveCount(0);
	await expect(page.locator('iframe.frame')).toHaveCount(0);
});

test('the marks follow the comment into the report', async ({ page }) => {
	await page.goto(MARKDOWN);
	await commentOn(page, 'The cold tier moved', 'Keep the old bucket read-only for 30 days.');

	// The frame paints the comment's passage with the CSS highlight, where the browser has the API.
	const frame = await frameOf(page);
	await expect
		.poll(() => frame.evaluate(() => (CSS.highlights ? CSS.highlights.has('qd-comment') : true)))
		.toBe(true);
	await expect(page.getByRole('button', { name: 'Show in report' })).toBeVisible();
});

test('the draft survives a reload', async ({ page }) => {
	await page.goto(MARKDOWN);
	await commentOn(page, 'The cold tier moved', 'Keep the old bucket read-only for 30 days.');

	await page.reload();
	await expect(
		page.getByRole('list').getByText('Keep the old bucket read-only for 30 days.')
	).toBeVisible();
});

test('a comment can be edited and deleted', async ({ page }) => {
	await page.goto(MARKDOWN);
	await commentOn(page, 'The cold tier moved', 'Keep the old bucket read-only for 30 days.');

	await page.getByRole('button', { name: 'Edit' }).click();
	await page.getByRole('textbox', { name: 'Your comment' }).fill('Keep it for 60 days.');
	await page.getByRole('button', { name: 'Save comment' }).click();
	await expect(page.getByRole('list').getByText('Keep it for 60 days.')).toBeVisible();

	await page.getByRole('button', { name: 'Delete' }).click();
	await expect(page.getByRole('list').getByText('Keep it for 60 days.')).toHaveCount(0);
	await expect(page.getByText('Nothing yet.')).toBeVisible();
});

test('a link in a report does nothing and a script in an HTML report does not run', async ({
	page
}) => {
	// Chromium still reports a blocked image as a request, but the frame's CSP fails it: nothing is answered.
	const answered: string[] = [];
	page.on('response', (response) => {
		if (response.url().includes('example.invalid')) answered.push(response.url());
	});

	await page.goto(HTML);
	const frame = await frameOf(page);
	await expect(frame.getByRole('heading', { level: 1, name: 'Rollup audit' })).toBeVisible();

	// The fixture script sets a flag and a title; neither may happen.
	expect(
		await frame.evaluate(() => (window as unknown as { __qdRan?: boolean }).__qdRan)
	).toBeUndefined();
	expect(await frame.evaluate(() => document.title)).not.toBe('ran');

	// The external image is never loaded.
	await expect
		.poll(() => frame.evaluate(() => [...document.images].every((img) => img.naturalWidth === 0)))
		.toBe(true);
	expect(answered).toEqual([]);
});

test('the report cannot take the frame away: an encoded refresh, SVG links and a link', async ({
	page
}) => {
	trapped.length = 0;
	const requests: string[] = [];
	page.on('request', (request) => {
		if (request.url().includes(`:${TRAP_PORT}/`)) requests.push(request.url());
	});

	await page.goto(HTML);
	let frame = await frameOf(page);
	await expect(frame.getByRole('heading', { level: 1, name: 'Rollup audit' })).toBeVisible();

	// The refresh was written as re&#102;resh, with a one-second delay: it must be gone.
	expect(await frame.locator('meta[http-equiv]').count()).toBe(1); // the frame's own CSP
	await frame.getByText('see the full chart').click();
	await frame.getByText('raw numbers').click();
	await frame.getByRole('link', { name: 'audit page' }).click();
	await frame.getByRole('link', { name: 'audit page' }).press('Enter');
	await page.waitForTimeout(1500);

	frame = await frameOf(page);
	await expect(frame.getByRole('heading', { level: 1, name: 'Rollup audit' })).toBeVisible();
	await expect(page.getByRole('alert').filter({ hasText: 'tried to leave' })).toHaveCount(0);
	expect(requests).toEqual([]);
	expect(trapped).toEqual([]);
});

test('a frame that is navigated anyway is closed, its messages ignored, and can be loaded again', async ({
	page
}) => {
	trapped.length = 0;
	await page.goto(HTML);
	const frame = await frameOf(page);
	await expect(frame.getByRole('heading', { level: 1, name: 'Rollup audit' })).toBeVisible();

	// Stand in for a way out not yet thought of: navigate the frame from outside its sandbox.
	await frame
		.evaluate((url) => {
			location.href = url;
		}, `http://127.0.0.1:${TRAP_PORT}/elsewhere`)
		.catch(() => {
			// The frame may already be gone when the call returns.
		});

	const warning = page.getByRole('alert').filter({ hasText: 'tried to leave the page' });
	await expect(warning).toBeVisible();
	await expect(page.locator('iframe.frame')).toHaveCount(0);
	// The portal's CSP (frame-src 'self') refuses the navigation before it leaves, so the
	// trap's page, which would post a request without the token, never loads. The frame
	// shows an error page instead, and that second load is what closes it. Dropping a
	// message without the token is covered in src/lib/report.spec.ts.
	expect(trapped).toEqual([]);
	await expect(page.getByRole('textbox', { name: 'Your comment' })).toHaveCount(0);

	await warning.getByRole('button', { name: 'Load the report again' }).click();
	await expect(warning).toHaveCount(0);
	const again = await frameOf(page);
	await expect(again.getByRole('heading', { level: 1, name: 'Rollup audit' })).toBeVisible();
});

test.describe('on a phone', () => {
	test.use({ viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true });

	test('a paragraph longer than a quote can be tapped and commented on', async ({ page }) => {
		await page.goto(HTML);
		const frame = await frameOf(page);
		const long = frame.locator('p', { hasText: 'Each series needs an owner' });
		await expect(long).toBeVisible();

		await long.tap();
		await frame.getByRole('button', { name: 'Comment on this' }).tap();
		await page.getByRole('textbox', { name: 'Your comment' }).fill('Name the owner for each one.');
		await page.getByRole('button', { name: 'Save comment' }).click();
		await expect(page.getByRole('list').getByText('Name the owner for each one.')).toBeVisible();
	});

	test('tapping a paragraph comments on it, and the page does not scroll sideways', async ({
		page
	}) => {
		await page.goto(HTML);
		const frame = await frameOf(page);
		await expect(frame.getByRole('heading', { level: 1, name: 'Rollup audit' })).toBeVisible();

		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow).toBeLessThanOrEqual(0);

		await frame.locator('p', { hasText: 'Tell me which of these' }).tap();
		await frame.getByRole('button', { name: 'Comment on this' }).tap();

		await page.getByRole('textbox', { name: 'Your comment' }).fill('Keep the query-volume series.');
		await page.getByRole('button', { name: 'Save comment' }).click();
		await expect(page.getByRole('list').getByText('Keep the query-volume series.')).toBeVisible();
	});
});

test('a click on a paragraph offers the block Comment pop-up on desktop', async ({ page }) => {
	await page.goto(HTML);
	const frame = await frameOf(page);
	await frame.locator('p', { hasText: 'Tell me which of these' }).click();
	await expect(frame.getByRole('button', { name: 'Comment on this' })).toBeVisible();
});

// Sending answers the request for the rest of the server's life, so this stays the last test that reads it.
test('sending a request logs the reply and clears the draft', async ({ page }) => {
	await page.goto(HTML);
	// Desktop: a real triple-click selects a visible paragraph, and the Comment pop-up offers itself.
	const frame = await frameOf(page);
	await frame.locator('p', { hasText: 'Tell me which of these' }).click({ clickCount: 3 });
	await frame.getByRole('button', { name: 'Comment', exact: true }).click();
	await page.getByRole('textbox', { name: 'Your comment' }).fill('Keep the query-volume series.');
	await page.getByRole('button', { name: 'Save comment' }).click();
	await expect(page.getByRole('list').getByText('Keep the query-volume series.')).toBeVisible();

	await page.getByRole('button', { name: 'Send 1 comment' }).click();
	await page.getByRole('button', { name: 'Send all' }).click();

	await expect(page.getByRole('status').filter({ hasText: 'Logged, not sent' })).toBeVisible();

	// Answered, so the comment column is gone; the draft in this browser is gone too.
	await page.reload();
	await expect(page.getByRole('status').filter({ hasText: 'Already answered' })).toBeVisible();
	const drafts = await page.evaluate(
		() => Object.keys(localStorage).filter((key) => key.startsWith('quarterdeck.report')).length
	);
	expect(drafts).toBe(0);
});
