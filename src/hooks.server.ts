import type { Handle } from '@sveltejs/kit/hooks';

const THEMES = new Set(['light', 'dark', 'system']);

/** Render the saved theme into <html> so the first paint is already right. */
export const handle: Handle = async ({ event, resolve }) => {
	const saved = event.cookies.get('qd_theme') ?? 'system';
	event.locals.theme = THEMES.has(saved) ? (saved as App.Locals['theme']) : 'system';
	return resolve(event, {
		transformPageChunk: ({ html }) => html.replace('%qd.theme%', event.locals.theme)
	});
};
