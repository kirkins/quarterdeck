/**
 * The login, against the same production build as the other tests but on a
 * server started with QD_LOGIN_SECRET set (the `login` project in
 * playwright.config.ts). Fixtures only; nothing is sent. The rate-limit test
 * locks this server's only client out, so it runs last.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { TEST_PASSPHRASE } from './login-secret.ts';

test.describe.configure({ mode: 'serial' });

const REPORT = `/report/${encodeURIComponent('archive-sync\u0000f0010-archive-review')}`;

function origin(): string {
	const base = test.info().project.use.baseURL;
	if (!base) throw new Error('the login project has no baseURL');
	return base;
}

async function signIn(page: Page, passphrase = TEST_PASSPHRASE) {
	await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
	await page.getByRole('button', { name: 'Sign in' }).click();
}

/** A POST to the Decisions answer action, as a browser's enhanced form sends it. */
function postAnswer(
	request: APIRequestContext,
	from: string,
	headers: Record<string, string> = {}
) {
	return request.post('/decisions?/answer', {
		headers: { origin: from, ...headers },
		form: { from: 'billing', id: 'f0001-billing-retry', option_id: 'a' },
		maxRedirects: 0
	});
}

test('a page without a session goes to the login, which remembers where it was going', async ({
	page
}) => {
	await page.goto('/ship/billing?tab=tools');
	await expect(page).toHaveURL(/\/login\?next=%2Fship%2Fbilling%3Ftab%3Dtools$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Come aboard' })).toBeVisible();
	// The login page draws no navigation and reads nothing from the fleet.
	await expect(page.getByRole('navigation', { name: 'Sections' })).toHaveCount(0);
	await expect(page.getByLabel('Passphrase', { exact: true })).toBeFocused();
});

test('endpoints and form actions without a session are refused, not run', async ({ request }) => {
	const data = await request.get('/feed/data');
	expect(data.status()).toBe(401);
	expect(await data.json()).toEqual({ status: 'signed-out', error: 'Signed out. Sign in again.' });

	// A plain client: refused outright.
	const plain = await postAnswer(request, origin());
	expect(plain.status()).toBe(401);

	// An enhanced form: told to go to the login.
	const enhanced = await postAnswer(request, origin(), {
		'x-sveltekit-action': 'true',
		accept: 'application/json'
	});
	expect(enhanced.status()).toBe(200);
	expect(await enhanced.json()).toMatchObject({
		type: 'redirect',
		location: '/login?next=%2Fdecisions'
	});

	// A form without JavaScript: sent to the login, and the write is not repeated after.
	const form = await postAnswer(request, origin(), { accept: 'text/html' });
	expect(form.status()).toBe(303);
	expect(form.headers()['location']).toBe('/login?next=%2Fdecisions');

	// A page's data, as client-side navigation asks for it.
	const pageData = await request.get('/triage/__data.json');
	expect(await pageData.json()).toMatchObject({
		type: 'redirect',
		location: '/login?next=%2Ftriage'
	});
});

test('a cross-origin post is refused, to the login and to an action', async ({ request }) => {
	const login = await request.post('/login', {
		headers: { origin: 'http://evil.example' },
		form: { passphrase: TEST_PASSPHRASE },
		maxRedirects: 0
	});
	expect(login.status()).toBe(403);
	expect(login.headers()['set-cookie']).toBeUndefined();

	const json = await request.post('/feed/data', {
		headers: { origin: 'http://evil.example', 'content-type': 'application/json' },
		data: {}
	});
	expect(json.status()).toBe(403);

	// server.js sets the protocol adapter-node reads on every request: a client cannot pick its own.
	const spoofed = await request.post('/login', {
		headers: {
			origin: origin().replace('http:', 'https:'),
			'x-quarterdeck-protocol': 'https'
		},
		form: { passphrase: TEST_PASSPHRASE },
		maxRedirects: 0
	});
	expect(spoofed.status()).toBe(403);

	const none = await request.post('/login', {
		form: { passphrase: TEST_PASSPHRASE },
		maxRedirects: 0
	});
	expect(none.status()).toBe(403);
});

test('a wrong passphrase says so, without saying why', async ({ page }) => {
	await page.goto('/login');
	await signIn(page, 'not the passphrase');
	await expect(page.getByRole('alert')).toHaveText(
		'That passphrase did not open the portal. Check it and try again.'
	);
	await expect(page).toHaveURL(/\/login$/);
	await expect(page.getByLabel('Passphrase', { exact: true })).toHaveAttribute(
		'aria-invalid',
		'true'
	);
});

test('the passphrase can be shown and hidden', async ({ page }) => {
	await page.goto('/login');
	const field = page.getByLabel('Passphrase', { exact: true });
	await field.fill('abc');
	await expect(field).toHaveAttribute('type', 'password');
	await page.getByRole('button', { name: 'Show passphrase' }).click();
	await expect(field).toHaveAttribute('type', 'text');
	await page.getByRole('button', { name: 'Hide passphrase' }).click();
	await expect(field).toHaveAttribute('type', 'password');
});

test('the right passphrase reaches the Feed, with a strict, HttpOnly session cookie', async ({
	page
}) => {
	await page.goto('/feed');
	await expect(page).toHaveURL(/\/login$/);
	await signIn(page);
	await expect(page).toHaveURL(/\/feed$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Feed' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

	const [cookie] = (await page.context().cookies()).filter((c) => c.name === 'qd_session');
	expect(cookie.httpOnly).toBe(true);
	expect(cookie.sameSite).toBe('Strict');
	expect(cookie.path).toBe('/');
	expect(cookie.secure).toBe(false);
	expect(Buffer.from(cookie.value, 'base64url')).toHaveLength(32);

	// Signed in, the login page sends the captain on.
	await page.goto('/login');
	await expect(page).toHaveURL(/\/feed$/);
});

test('after signing in, the captain lands where they were going, and never off the site', async ({
	page
}) => {
	await page.goto('/triage?kind=decision');
	await signIn(page);
	await expect(page).toHaveURL(/\/triage\?kind=decision$/);

	await page.context().clearCookies();
	await page.goto('/login?next=//evil.example/feed');
	await signIn(page);
	await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/feed$/);
});

test('pages carry the security headers, and the report frame still runs', async ({ page }) => {
	await page.goto('/login');
	await signIn(page);
	await expect(page).toHaveURL(/\/feed$/);

	const response = await page.goto(REPORT);
	const headers = response?.headers() ?? {};
	expect(headers['cache-control']).toBe('no-store');
	expect(headers['x-frame-options']).toBe('DENY');
	expect(headers['referrer-policy']).toBe('same-origin');
	expect(headers['x-content-type-options']).toBe('nosniff');
	const csp = headers['content-security-policy'] ?? '';
	expect(csp).toContain("frame-ancestors 'none'");
	expect(csp).toContain("object-src 'none'");
	expect(csp).toMatch(/script-src 'self' 'sha256-[^']+' 'nonce-[^']+'/);

	const handle = await page.locator('iframe.frame').elementHandle();
	const frame = await handle?.contentFrame();
	if (!frame) throw new Error('the report frame is not there');
	await expect(
		frame.getByRole('heading', { level: 1, name: 'Archive migration: review' })
	).toBeVisible();
	// The annotator runs under both CSPs: selecting a passage offers a comment.
	await frame.evaluate(() => {
		const p = [...document.querySelectorAll('p')].find((el) =>
			el.textContent?.includes('The cold tier moved')
		);
		if (!p) throw new Error('no paragraph');
		const range = document.createRange();
		range.selectNodeContents(p);
		getSelection()?.removeAllRanges();
		getSelection()?.addRange(range);
	});
	await expect(frame.getByRole('button', { name: 'Comment', exact: true })).toBeVisible();
});

test('no page breaks its own CSP', async ({ page }) => {
	const violations: string[] = [];
	page.on('console', (message) => {
		if (message.text().includes('Content Security Policy')) violations.push(message.text());
	});
	await page.goto('/login');
	await signIn(page);
	await expect(page).toHaveURL(/\/feed$/);
	for (const path of [
		'/feed',
		'/triage',
		'/decisions',
		'/fleet',
		'/spend',
		'/ship/billing',
		'/ship/billing?tab=tools',
		REPORT
	]) {
		await page.goto(path);
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	}
	// Client-side navigation and the theme toggle, too.
	await page
		.getByRole('navigation', { name: 'Sections' })
		.getByRole('link', { name: /^Triage/ })
		.click();
	await expect(page).toHaveURL(/\/triage$/);
	await page.getByRole('button', { name: /Change theme/ }).click();
	expect(violations).toEqual([]);
});

test('signing out ends the session on the server, not only in the browser', async ({
	page,
	playwright
}) => {
	await page.goto('/login');
	await signIn(page);
	await expect(page).toHaveURL(/\/feed$/);
	const [cookie] = (await page.context().cookies()).filter((c) => c.name === 'qd_session');

	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/login\?signed-out=1$/);
	await expect(page.getByRole('status')).toContainText('Signed out');
	await page.goto('/feed');
	await expect(page).toHaveURL(/\/login$/);

	// The old cookie, replayed, opens nothing.
	const replay = await playwright.request.newContext({
		baseURL: origin(),
		extraHTTPHeaders: { cookie: `qd_session=${cookie.value}` }
	});
	expect((await replay.get('/feed/data')).status()).toBe(401);
	await replay.dispose();
});

test('a run of wrong passphrases locks the login, even for the right one', async ({ page }) => {
	await page.goto('/login');
	for (let i = 0; i < 5; i++) {
		await signIn(page, `wrong ${i}`);
		await expect(page.getByRole('alert')).toBeVisible();
	}
	await signIn(page, `wrong again`);
	await expect(page.getByRole('alert')).toContainText('Too many tries. Wait 15 minutes');

	await signIn(page);
	await expect(page.getByRole('alert')).toContainText('Too many tries');
	await expect(page).toHaveURL(/\/login$/);

	// A fresh visit says so before anyone types.
	await page.goto('/login');
	await expect(page.getByRole('alert')).toContainText('Too many tries');
});
