// Startup checks, run by server.js before the server listens. Plain JS so that
// `npm start` needs no extra build step; the types are in startup-guard.d.ts.
// Nothing here prints or returns a secret.

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
	// Login is not built yet, so a QD_LOGIN_SECRET protects nothing and must not
	// unlock sending on a network bind. The login change will turn this on.
	const loginEnforced = false;
	const login = loginEnforced && Boolean(env.QD_LOGIN_SECRET?.trim());
	const exposed = !isLoopback(host);

	/** @type {string[]} */
	const errors = [];
	/** @type {string[]} */
	const warnings = [];

	if (exposed && send && !login) {
		errors.push(
			`HOST=${host} is not loopback and QD_ALLOW_SEND=1, but no login is configured. ` +
				'Set QD_ALLOW_SEND=0, or bind HOST to 127.0.0.1 until login exists.'
		);
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
		warnings.push(
			'HOST is not loopback and ORIGIN is unset: form posts may be rejected. ' +
				'Set ORIGIN=http://<vpn-address>:<port> (see docs/DEPLOY.md).'
		);
	}
	if (env.QD_LOGIN_SECRET?.trim()) {
		warnings.push('QD_LOGIN_SECRET is set, but login is not implemented yet: nothing enforces it.');
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
