/**
 * The built-in login: one user, the captain. QD_LOGIN_SECRET holds a scrypt
 * hash of the passphrase (login-hash.js). A good passphrase starts a session,
 * held in this process's memory and named by a random id in an HttpOnly,
 * SameSite=Strict cookie. A restart signs everyone out. See docs/DECISIONS.md,
 * section 18.
 *
 * Nothing here logs a passphrase, the hash, or a session id.
 */
import { createHash, randomBytes } from 'node:crypto';
import { parseLoginHash, verifyPassphrase, type LoginHash } from '../../../login-hash.js';

export const SESSION_COOKIE = 'qd_session';

/** Where a signed-in captain lands when there is nowhere better to go. */
export const HOME = '/feed';

export interface AuthConfig {
	/** The parsed QD_LOGIN_SECRET; null when login is off (loopback development). */
	secret: LoginHash | null;
	/** Set when QD_LOGIN_SECRET is present but not a usable hash: every request is refused. */
	error: string | null;
	/** Absolute session lifetime (QD_SESSION_HOURS, default 12). */
	sessionMs: number;
	/** Idle timeout (QD_SESSION_IDLE_MINUTES, default 120). */
	idleMs: number;
	/** Secure cookie: when ORIGIN is https. */
	secure: boolean;
}

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/** A positive number from the environment, or the fallback; null when it is set but not one. */
export function positive(value: string | undefined, fallback: number, max: number): number | null {
	if (value === undefined || value.trim() === '') return fallback;
	const n = Number(value);
	return Number.isFinite(n) && n > 0 && n <= max ? n : null;
}

export function readAuthConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
	const hours = positive(env.QD_SESSION_HOURS, 12, 24 * 30);
	const idle = positive(env.QD_SESSION_IDLE_MINUTES, 120, 24 * 60 * 30);
	const secure = (env.ORIGIN ?? '').trim().toLowerCase().startsWith('https:');
	const base = {
		sessionMs: (hours ?? 12) * HOUR,
		idleMs: (idle ?? 120) * MINUTE,
		secure
	};
	const raw = env.QD_LOGIN_SECRET?.trim();
	if (!raw) return { ...base, secret: null, error: null };
	const parsed = parseLoginHash(raw);
	if (!parsed.ok) return { ...base, secret: null, error: parsed.error };
	if (hours === null || idle === null) {
		return {
			...base,
			secret: null,
			error: 'QD_SESSION_HOURS and QD_SESSION_IDLE_MINUTES must be positive numbers.'
		};
	}
	return { ...base, secret: parsed.value, error: null };
}

interface Session {
	created: number;
	seen: number;
}

/**
 * Sessions in memory, keyed by a SHA-256 of the cookie's id, so the map never
 * holds a usable id. Each has an absolute lifetime and an idle timeout.
 */
export class SessionStore {
	readonly #sessions = new Map<string, Session>();

	constructor(
		readonly lifetimeMs: number,
		readonly idleMs: number,
		readonly max = 32
	) {}

	static #key(id: string): string {
		return createHash('sha256').update(id).digest('hex');
	}

	/** A new session; its id goes in the cookie and nowhere else. */
	create(now = Date.now()): string {
		this.#prune(now);
		// A single user has few devices: past the cap, the oldest session goes.
		while (this.#sessions.size >= this.max) {
			const oldest = this.#sessions.keys().next().value;
			if (oldest === undefined) break;
			this.#sessions.delete(oldest);
		}
		const id = randomBytes(32).toString('base64url');
		this.#sessions.set(SessionStore.#key(id), { created: now, seen: now });
		return id;
	}

	/** Whether the id names a live session; a live one counts as seen now. */
	check(id: string | undefined, now = Date.now()): boolean {
		if (!id || id.length > 128) return false;
		const key = SessionStore.#key(id);
		const session = this.#sessions.get(key);
		if (!session) return false;
		if (now - session.created >= this.lifetimeMs || now - session.seen >= this.idleMs) {
			this.#sessions.delete(key);
			return false;
		}
		session.seen = now;
		return true;
	}

	/** When a session ends at the latest, for the cookie's lifetime. */
	expires(id: string): number | null {
		const session = this.#sessions.get(SessionStore.#key(id));
		return session ? session.created + this.lifetimeMs : null;
	}

	destroy(id: string | undefined): void {
		if (id) this.#sessions.delete(SessionStore.#key(id));
	}

	get size(): number {
		return this.#sessions.size;
	}

	#prune(now: number): void {
		for (const [key, s] of this.#sessions) {
			if (now - s.created >= this.lifetimeMs || now - s.seen >= this.idleMs) {
				this.#sessions.delete(key);
			}
		}
	}
}

export type LimitCheck = { ok: true } | { ok: false; retryAfterMs: number };

interface Strikes {
	/** Failure times inside the window. */
	failures: number[];
	/** How many lockouts so far; each doubles the next. */
	lockouts: number;
	lockedUntil: number;
	last: number;
}

/**
 * Login attempts, per client address and across all of them. An attempt counts
 * as a failure from the moment it starts, so a burst of parallel guesses is
 * limited before any scrypt finishes; a good passphrase takes its attempt
 * back and clears its address.
 *
 * Five failures in fifteen minutes lock an address out for fifteen minutes,
 * then thirty, sixty, and so on up to a day. Twenty failures in fifteen
 * minutes from anywhere lock everyone out until the oldest ages out, so many
 * addresses cannot share the guessing.
 */
export class LoginLimiter {
	readonly #addresses = new Map<string, Strikes>();
	#global: number[] = [];

	constructor(
		readonly perAddress = 5,
		readonly globalMax = 20,
		readonly windowMs = 15 * MINUTE,
		readonly maxLockMs = 24 * HOUR,
		readonly maxAddresses = 1000
	) {}

	/** Whether an address may try now. */
	check(address: string, now = Date.now()): LimitCheck {
		this.#global = this.#global.filter((t) => now - t < this.windowMs);
		const strikes = this.#addresses.get(address);
		const waits: number[] = [];
		if (strikes && strikes.lockedUntil > now) waits.push(strikes.lockedUntil - now);
		if (this.#global.length >= this.globalMax) {
			waits.push(this.#global[0] + this.windowMs - now);
		}
		return waits.length ? { ok: false, retryAfterMs: Math.max(...waits) } : { ok: true };
	}

	/** Start an attempt: refused while locked out, otherwise counted as a failure until `succeed`. */
	attempt(address: string, now = Date.now()): LimitCheck {
		const checked = this.check(address, now);
		if (checked.ok) this.#fail(address, now);
		return checked;
	}

	/** The attempt started at `at` was good: forget the address, and take the attempt back. */
	succeed(address: string, at: number): void {
		this.#addresses.delete(address);
		const index = this.#global.indexOf(at);
		if (index >= 0) this.#global.splice(index, 1);
	}

	#fail(address: string, now: number): void {
		this.#global.push(now);
		let strikes = this.#addresses.get(address);
		// Strikes are forgotten a quiet day after the last failure or lockout ends.
		if (strikes && now - Math.max(strikes.last, strikes.lockedUntil) >= this.maxLockMs) {
			strikes = undefined;
		}
		if (!strikes) {
			strikes = { failures: [], lockouts: 0, lockedUntil: 0, last: now };
			if (this.#addresses.size >= this.maxAddresses) {
				const oldest = this.#addresses.keys().next().value;
				if (oldest !== undefined) this.#addresses.delete(oldest);
			}
		}
		// Re-insert so the map stays in order of last failure.
		this.#addresses.delete(address);
		this.#addresses.set(address, strikes);
		strikes.last = now;
		strikes.failures = strikes.failures.filter((t) => now - t < this.windowMs);
		strikes.failures.push(now);
		if (strikes.failures.length >= this.perAddress) {
			const lock = Math.min(this.windowMs * 2 ** strikes.lockouts, this.maxLockMs);
			strikes.lockedUntil = now + lock;
			strikes.lockouts += 1;
			strikes.failures = [];
		}
	}
}

/**
 * Where to go after signing in: a path on this site, or HOME. Anything that
 * could leave the site (`//host`, `/\host`, a scheme, a control character) or
 * loop back to the login is refused.
 */
export function safeNext(value: string | null | undefined): string {
	if (!value || value.length > 2048) return HOME;
	if (!value.startsWith('/') || value.startsWith('//')) return HOME;
	// Browsers read a backslash as a slash, and drop tabs and newlines.
	// eslint-disable-next-line no-control-regex
	if (/[\\\u0000-\u001f\u007f]/.test(value)) return HOME;
	const base = 'http://quarterdeck.invalid';
	let url: URL;
	try {
		url = new URL(value, base);
	} catch {
		return HOME;
	}
	if (url.origin !== base) return HOME;
	if (url.pathname === '/login' || url.pathname.startsWith('/login/')) return HOME;
	if (url.pathname === '/logout') return HOME;
	return `${url.pathname}${url.search}${url.hash}`;
}

/** The login page's address for a request that needs a session first. */
export function loginPath(next: string): string {
	const safe = safeNext(next);
	return safe === HOME ? '/login' : `/login?next=${encodeURIComponent(safe)}`;
}

export interface Auth {
	config: AuthConfig;
	sessions: SessionStore;
	limiter: LoginLimiter;
	/** Verify one passphrase at a time: each scrypt holds about 128 MiB. */
	verify(passphrase: string): Promise<boolean>;
}

let auth: Auth | undefined;

export function getAuth(): Auth {
	if (!auth) {
		const config = readAuthConfig();
		let queue: Promise<unknown> = Promise.resolve();
		auth = {
			config,
			sessions: new SessionStore(config.sessionMs, config.idleMs),
			limiter: new LoginLimiter(),
			verify(passphrase) {
				const secret = config.secret;
				if (!secret) return Promise.resolve(false);
				const run = queue.then(() => verifyPassphrase(passphrase, secret));
				queue = run.catch(() => undefined);
				return run;
			}
		};
	}
	return auth;
}

/** Whether login is on: QD_LOGIN_SECRET is set (valid or not; invalid fails closed). */
export function loginEnabled(config: AuthConfig): boolean {
	return config.secret !== null || config.error !== null;
}
