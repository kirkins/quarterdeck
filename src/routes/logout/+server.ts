import { redirect } from '@sveltejs/kit';
import { getAuth, HOME, SESSION_COOKIE } from '#lib/server/auth.ts';
import type { RequestHandler } from './$types';

/**
 * Sign out: a plain form post from the sidebar, so the page reloads and keeps
 * nothing. The session is gone from the server, not just from the browser.
 */
export const POST: RequestHandler = ({ cookies }) => {
	const auth = getAuth();
	auth.sessions.destroy(cookies.get(SESSION_COOKIE));
	cookies.delete(SESSION_COOKIE, { path: '/', secure: auth.config.secure });
	redirect(303, '/login?signed-out=1');
};

/** A plain visit signs nobody out: it goes home. */
export const GET: RequestHandler = () => {
	redirect(303, HOME);
};
