import { fail, redirect } from '@sveltejs/kit';
import { getAuth, HOME, loginEnabled, safeNext, SESSION_COOKIE } from '#lib/server/auth.ts';
import type { Actions, PageServerLoad } from './$types';

/** The longest passphrase read; anything longer is a wrong one, not a reason to hash a megabyte. */
const MAX_PASSPHRASE = 1024;

/** Minutes, rounded up, for the rate-limit message. */
function minutes(ms: number): number {
	return Math.max(1, Math.ceil(ms / 60_000));
}

export const load: PageServerLoad = ({ locals, url, getClientAddress }) => {
	const next = safeNext(url.searchParams.get('next'));
	if (locals.auth !== 'signed-out') redirect(303, locals.auth === 'off' ? HOME : next);
	const { config, limiter } = getAuth();
	const limited = limiter.check(getClientAddress());
	return {
		next: next === HOME ? null : next,
		signedOut: url.searchParams.has('signed-out'),
		retryMinutes: limited.ok ? null : minutes(limited.retryAfterMs),
		sessionHours: config.sessionMs / 3_600_000,
		idleMinutes: config.idleMs / 60_000
	};
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress, url }) => {
		const auth = getAuth();
		if (!loginEnabled(auth.config)) redirect(303, HOME);

		const form = await request.formData();
		const next = safeNext(String(form.get('next') ?? url.searchParams.get('next') ?? ''));
		const passphrase = form.get('passphrase');
		const address = getClientAddress();
		const at = Date.now();

		const limited = auth.limiter.attempt(address, at);
		if (!limited.ok) {
			return fail(429, { error: 'limited' as const, retryMinutes: minutes(limited.retryAfterMs) });
		}
		const good =
			typeof passphrase === 'string' &&
			passphrase.length > 0 &&
			passphrase.length <= MAX_PASSPHRASE &&
			(await auth.verify(passphrase));
		if (!good) {
			// Time and address only: never the passphrase, never what was typed.
			console.warn(`[quarterdeck] login failed at ${new Date(at).toISOString()} from ${address}`);
			return fail(401, { error: 'wrong' as const, retryMinutes: null });
		}

		auth.limiter.succeed(address, at);
		const id = auth.sessions.create();
		cookies.set(SESSION_COOKIE, id, {
			path: '/',
			httpOnly: true,
			sameSite: 'strict',
			secure: auth.config.secure,
			maxAge: Math.floor(auth.config.sessionMs / 1000)
		});
		redirect(303, next);
	}
};
