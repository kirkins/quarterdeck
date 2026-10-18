import { json, redirect } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit/hooks';
import { hostAllowed } from '../startup-guard.js';
import { getAuth, loginEnabled, loginPath, SESSION_COOKIE } from '#lib/server/auth.ts';

const THEMES = new Set(['light', 'dark', 'system']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** The only routes a visitor without a session may reach. Static files never get here. */
const PUBLIC_ROUTES = new Set(['/login']);

/**
 * Every request that changes something must come from this site. SvelteKit
 * already checks form posts; this covers every other content type too, so no
 * endpoint relies on the browser's preflight alone.
 */
function crossSite(event: RequestEvent): boolean {
	if (SAFE_METHODS.has(event.request.method)) return false;
	return event.request.headers.get('origin') !== event.url.origin;
}

/** Whether a request without a session should be sent to the login page rather than refused. */
function wantsPage(event: RequestEvent): boolean {
	if (event.isDataRequest) return true;
	if (event.request.headers.get('x-sveltekit-action') === 'true') return true;
	return (event.request.headers.get('accept') ?? '').includes('text/html');
}

const HEADERS: Record<string, string> = {
	'x-frame-options': 'DENY',
	'referrer-policy': 'same-origin',
	'x-content-type-options': 'nosniff',
	'cross-origin-opener-policy': 'same-origin'
};

/**
 * In order: refuse a Host header that is not ours when the server is not on
 * loopback (DNS rebinding); refuse a cross-site write; when login is on,
 * require a session everywhere but the login page; then render the saved
 * theme into <html> so the first paint is already right. The CSP is set by
 * SvelteKit (vite.config.ts); the rest of the headers are set here.
 */
export const handle: Handle = async ({ event, resolve }) => {
	if (!hostAllowed(process.env, event.request.headers.get('host'))) {
		return new Response('Forbidden: unexpected Host header', { status: 403 });
	}
	if (crossSite(event)) {
		return new Response('Forbidden: cross-site request', { status: 403 });
	}

	const auth = getAuth();
	if (auth.config.error) {
		// A QD_LOGIN_SECRET that cannot be read protects nothing: refuse everything.
		// The startup guard stops `npm start`; this covers `vite dev` and `vite preview`.
		console.error(`[quarterdeck] login is misconfigured: ${auth.config.error}`);
		return new Response('Quarterdeck is misconfigured: see the server log.', { status: 503 });
	}
	const enabled = loginEnabled(auth.config);
	const signedIn = enabled && auth.sessions.check(event.cookies.get(SESSION_COOKIE));
	event.locals.auth = enabled ? (signedIn ? 'signed-in' : 'signed-out') : 'off';

	if (event.locals.auth === 'signed-out' && !PUBLIC_ROUTES.has(event.route.id ?? '')) {
		if (event.cookies.get(SESSION_COOKIE)) {
			event.cookies.delete(SESSION_COOKIE, { path: '/', secure: auth.config.secure });
		}
		if (!wantsPage(event)) {
			return json({ status: 'signed-out', error: 'Signed out. Sign in again.' }, { status: 401 });
		}
		// A page goes back where it was after signing in; a write does not repeat.
		const next = SAFE_METHODS.has(event.request.method)
			? `${event.url.pathname}${event.url.search}`
			: event.url.pathname;
		redirect(303, loginPath(next));
	}

	const saved = event.cookies.get('qd_theme') ?? 'system';
	event.locals.theme = THEMES.has(saved) ? (saved as App.Locals['theme']) : 'system';
	const response = await resolve(event, {
		transformPageChunk: ({ html }) => html.replace('%qd.theme%', event.locals.theme)
	});

	for (const [name, value] of Object.entries(HEADERS)) {
		if (!response.headers.has(name)) response.headers.set(name, value);
	}
	// Nothing the portal renders is for a cache: it is the captain's own mail.
	response.headers.set('cache-control', 'no-store');
	return response;
};
