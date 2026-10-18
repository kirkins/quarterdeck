import type { Handle } from '@sveltejs/kit/hooks';
import { hostAllowed } from '../startup-guard.js';

const THEMES = new Set(['light', 'dark', 'system']);

/**
 * Refuse a Host header that is not ours when the server is not on loopback
 * (DNS rebinding), then render the saved theme into <html> so the first paint is already right.
 */
export const handle: Handle = async ({ event, resolve }) => {
	if (!hostAllowed(process.env, event.request.headers.get('host'))) {
		return new Response('Forbidden: unexpected Host header', { status: 403 });
	}
	const saved = event.cookies.get('qd_theme') ?? 'system';
	event.locals.theme = THEMES.has(saved) ? (saved as App.Locals['theme']) : 'system';
	return resolve(event, {
		transformPageChunk: ({ html }) => html.replace('%qd.theme%', event.locals.theme)
	});
};
