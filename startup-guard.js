// Startup checks, run by server.js before the server listens. Plain JS so that
// `npm start` needs no extra build step; the types are in startup-guard.d.ts.
// Nothing here prints or returns a secret.
import { parseLoginHash } from './login-hash.js';

/** @param {string} host */
export function isLoopback(host) {
	const h = host
		.trim()
		.toLowerCase()
		.replace(/^\[(.*)\]$/, '$1');
	return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * 0.0.0.0 and :: mean "every interface", so no single address can be matched.
 * @param {string} host
 */
function isUnspecified(host) {
	const h = host
		.trim()
		.toLowerCase()
		.replace(/^\[(.*)\]$/, '$1');
	return h === '0.0.0.0' || h === '::';
}

/** @param {string} host */
function bracketed(host) {
	return host.includes(':') ? `[${host}]` : host;
}

/**
 * The ORIGIN as a URL, or null when it is not an http or https URL.
 * @param {string} value
 */
function originUrl(value) {
	try {
		const url = new URL(value);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
	} catch {
		return null;
	}
}

/**
 * Decide whether the server may start.
 * @param {Record<string, string | undefined>} env
 * @returns {{ ok: boolean, errors: string[], warnings: string[], summary: string }}
 */
export function checkStartup(env = process.env) {
	const host = (env.HOST || '127.0.0.1').trim();
	const port = (env.PORT || '3000').trim();
	const source = (env.QD_SOURCE || 'fixtures').trim().toLowerCase();
	const send = env.QD_ALLOW_SEND === '1';
	const secret = env.QD_LOGIN_SECRET?.trim();
	const parsed = secret ? parseLoginHash(secret) : null;
	// The login is built (src/lib/server/auth.ts): a valid hash turns it on for
	// every route, so it counts as a login. An invalid one refuses to start.
	const loginEnforced = true;
	const login = loginEnforced && parsed?.ok === true;
	const exposed = !isLoopback(host);

	/** @type {string[]} */
	const errors = [];
	/** @type {string[]} */
	const warnings = [];

	if (parsed && !parsed.ok) errors.push(parsed.error);
	if (exposed && send && !login) {
		errors.push(
			`HOST=${host} is not loopback and QD_ALLOW_SEND=1, but no login is configured. ` +
				'Set QD_LOGIN_SECRET (`npm run hash-password`, see docs/DEPLOY.md), ' +
				'or QD_ALLOW_SEND=0, or bind HOST to 127.0.0.1.'
		);
	}
	for (const [name, max] of /** @type {const} */ ([
		['QD_SESSION_HOURS', 24 * 30],
		['QD_SESSION_IDLE_MINUTES', 24 * 60 * 30]
	])) {
		const value = env[name]?.trim();
		if (value && !(Number(value) > 0 && Number(value) <= max)) {
			errors.push(`${name} must be a positive number, at most ${max}.`);
		}
	}
	if (send && source === 'fixtures') {
		errors.push(
			'QD_ALLOW_SEND=1 with QD_SOURCE=fixtures: fixtures never send. ' +
				'Set QD_SOURCE=cli, or QD_ALLOW_SEND=0.'
		);
	}
	if (env.ORIGIN) {
		if (!originUrl(env.ORIGIN)) {
			errors.push(
				'ORIGIN must be an http:// or https:// URL, for example http://<vpn-address>:3000.'
			);
		}
	} else if (exposed) {
		// The origin check on every form post, and the login cookie's Secure
		// flag, are only right when the server knows the address the browser uses.
		errors.push(
			`HOST=${host} is not loopback and ORIGIN is unset. ` +
				'Set ORIGIN=http://<vpn-address>:<port>, the address the browser uses (see docs/DEPLOY.md).'
		);
	}
	if (exposed && !login) {
		warnings.push(
			'HOST is not loopback and no login is configured: anyone who can reach the port can read the portal. ' +
				'Set QD_LOGIN_SECRET (see docs/DEPLOY.md).'
		);
	}

	const summary =
		`source=${source} send=${send ? 'on' : 'off'} login=${login ? 'on' : 'off'} ` +
		`listen=${isUnspecified(host) ? '*' : bracketed(host)}:${port}`;
	return { ok: errors.length === 0, errors, warnings, summary };
}

/**
 * Whether a request's Host header is acceptable. Loopback binds accept any
 * Host (as before). Otherwise only HOST:PORT and the ORIGIN host are accepted,
 * which stops DNS rebinding from reaching a non-loopback server.
 * @param {Record<string, string | undefined>} env
 * @param {string | null} hostHeader
 */
export function hostAllowed(env, hostHeader) {
	const host = (env.HOST || '127.0.0.1').trim();
	if (isLoopback(host)) return true;

	const allowed = new Set();
	if (!isUnspecified(host)) {
		allowed.add(`${bracketed(host)}:${(env.PORT || '3000').trim()}`.toLowerCase());
	}
	const origin = env.ORIGIN ? originUrl(env.ORIGIN) : null;
	if (origin) allowed.add(origin.host.toLowerCase());
	return allowed.has((hostHeader ?? '').trim().toLowerCase());
}

/**
 * What the server's request URLs should say about themselves. adapter-node 6
 * no longer reads ORIGIN: it builds each request's URL from headers, and
 * assumes https when no protocol header names it. SvelteKit's origin check
 * compares a form post's Origin with that URL, so over plain http every post
 * would be refused. server.js passes these values in headers it sets itself
 * on every request, overwriting anything a client sent.
 * @param {Record<string, string | undefined>} env
 * @returns {{ protocol: string, host: string | null }}
 */
export function requestOrigin(env) {
	const origin = env.ORIGIN ? originUrl(env.ORIGIN) : null;
	if (origin) return { protocol: origin.protocol.slice(0, -1), host: origin.host };
	// No ORIGIN means a loopback bind (the guard requires one otherwise): plain http, any Host.
	return { protocol: 'http', host: null };
}
