import { beforeAll, describe, expect, it } from 'vitest';
import {
	hashPassphrase,
	parseLoginHash,
	SCRYPT_DEFAULTS,
	verifyPassphrase
} from '../../../login-hash.js';
import { HOME, LoginLimiter, loginPath, readAuthConfig, safeNext, SessionStore } from './auth.ts';

const PASSPHRASE = 'a passphrase only for this test';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('login hash', () => {
	let secret = '';
	beforeAll(async () => {
		secret = await hashPassphrase(PASSPHRASE);
	});

	it('writes a self-describing scrypt line with the default parameters and a fresh salt', async () => {
		const [scheme, n, r, p, salt, hash] = secret.split('$');
		expect(scheme).toBe('scrypt');
		expect([Number(n), Number(r), Number(p)]).toEqual([
			SCRYPT_DEFAULTS.N,
			SCRYPT_DEFAULTS.r,
			SCRYPT_DEFAULTS.p
		]);
		expect(Buffer.from(salt, 'base64url')).toHaveLength(16);
		expect(Buffer.from(hash, 'base64url')).toHaveLength(32);
		expect(secret).not.toContain(PASSPHRASE);
		const again = await hashPassphrase(PASSPHRASE);
		expect(again.split('$')[4]).not.toBe(salt);
	});

	it('verifies the right passphrase and refuses others', async () => {
		const parsed = parseLoginHash(secret);
		if (!parsed.ok) throw new Error(parsed.error);
		expect(await verifyPassphrase(PASSPHRASE, parsed.value)).toBe(true);
		expect(await verifyPassphrase(`${PASSPHRASE} `, parsed.value)).toBe(false);
		expect(await verifyPassphrase('', parsed.value)).toBe(false);
	});

	it('reads the passphrase in one Unicode form, however it was typed', async () => {
		const composed = 'café au lait on deck';
		const parsed = parseLoginHash(await hashPassphrase(composed));
		if (!parsed.ok) throw new Error(parsed.error);
		expect(await verifyPassphrase('café au lait on deck', parsed.value)).toBe(true);
	});

	it('refuses what is not a usable hash, and never repeats the value', () => {
		const [, , , , salt, hash] = secret.split('$');
		const cases: [string | undefined, RegExp][] = [
			[undefined, /not a scrypt hash/],
			['', /not a scrypt hash/],
			['correct horse battery staple', /not a scrypt hash/],
			[`bcrypt$131072$8$1$${salt}$${hash}`, /not a scrypt hash/],
			[`scrypt$131072$8$${salt}$${hash}`, /not a scrypt hash/],
			[`scrypt$1e5$8$1$${salt}$${hash}`, /malformed/],
			[`scrypt$131071$8$1$${salt}$${hash}`, /power of two/],
			[`scrypt$16384$8$1$${salt}$${hash}`, /weak/],
			[`scrypt$131072$4$1$${salt}$${hash}`, /weak/],
			[`scrypt$131072$8$0$${salt}$${hash}`, /malformed/],
			[`scrypt$2097152$8$1$${salt}$${hash}`, /more scrypt work/],
			[`scrypt$1048576$32$1$${salt}$${hash}`, /more scrypt work/],
			[`scrypt$131072$8$1$${salt}$${hash}=`, /base64url/],
			[`scrypt$131072$8$1$AAAA$${hash}`, /salt shorter/],
			[`scrypt$131072$8$1$${salt}$AAAA`, /hash that is not/]
		];
		for (const [value, error] of cases) {
			const parsed = parseLoginHash(value);
			expect(parsed.ok, String(value)).toBe(false);
			if (!parsed.ok) {
				expect(parsed.error).toMatch(error);
				expect(parsed.error).not.toContain(salt);
				expect(parsed.error).not.toContain(hash);
				expect(parsed.error).not.toContain('horse');
			}
		}
		expect(parseLoginHash(`  ${secret}\n`).ok).toBe(true);
	});
});

describe('readAuthConfig', () => {
	let secret = '';
	beforeAll(async () => {
		secret = await hashPassphrase(PASSPHRASE);
	});

	it('is off without a secret, with the default lifetimes', () => {
		const config = readAuthConfig({});
		expect(config.secret).toBeNull();
		expect(config.error).toBeNull();
		expect(config.sessionMs).toBe(12 * HOUR);
		expect(config.idleMs).toBe(2 * HOUR);
		expect(config.secure).toBe(false);
	});

	it('reads the hash, the lifetimes, and a Secure cookie from an https ORIGIN', () => {
		const config = readAuthConfig({
			QD_LOGIN_SECRET: secret,
			QD_SESSION_HOURS: '8',
			QD_SESSION_IDLE_MINUTES: '30',
			ORIGIN: 'https://quarterdeck.example'
		});
		expect(config.secret?.N).toBe(SCRYPT_DEFAULTS.N);
		expect(config.error).toBeNull();
		expect(config.sessionMs).toBe(8 * HOUR);
		expect(config.idleMs).toBe(30 * MINUTE);
		expect(config.secure).toBe(true);
		expect(readAuthConfig({ ORIGIN: 'http://192.0.2.10:3000' }).secure).toBe(false);
	});

	it('fails closed on a secret that is not a hash, or on bad lifetimes', () => {
		const bad = readAuthConfig({ QD_LOGIN_SECRET: 'plain words' });
		expect(bad.secret).toBeNull();
		expect(bad.error).toMatch(/not a scrypt hash/);
		const hours = readAuthConfig({ QD_LOGIN_SECRET: secret, QD_SESSION_HOURS: '-1' });
		expect(hours.secret).toBeNull();
		expect(hours.error).toMatch(/QD_SESSION_HOURS/);
	});
});

describe('SessionStore', () => {
	it('names each session with a fresh 32-byte id and knows only its hash', () => {
		const store = new SessionStore(12 * HOUR, 2 * HOUR);
		const a = store.create(0);
		const b = store.create(0);
		expect(Buffer.from(a, 'base64url')).toHaveLength(32);
		expect(a).not.toBe(b);
		expect(store.check(a, 1)).toBe(true);
		expect(store.check(`${a}x`, 1)).toBe(false);
		expect(store.check(undefined, 1)).toBe(false);
		expect(store.check('', 1)).toBe(false);
	});

	it('ends a session after its idle timeout, and each visit restarts it', () => {
		const store = new SessionStore(12 * HOUR, 2 * HOUR);
		const id = store.create(0);
		expect(store.check(id, 2 * HOUR - 1)).toBe(true);
		expect(store.check(id, 4 * HOUR - 2)).toBe(true);
		expect(store.check(id, 6 * HOUR - 2)).toBe(false);
		// Once ended it stays ended.
		expect(store.check(id, 6 * HOUR - 3)).toBe(false);
	});

	it('ends a session at its absolute lifetime, however busy', () => {
		const store = new SessionStore(12 * HOUR, 2 * HOUR);
		const id = store.create(0);
		for (let t = HOUR; t < 12 * HOUR; t += HOUR) expect(store.check(id, t)).toBe(true);
		expect(store.check(id, 12 * HOUR)).toBe(false);
		expect(store.expires(id)).toBeNull();
	});

	it('forgets a session on sign out', () => {
		const store = new SessionStore(12 * HOUR, 2 * HOUR);
		const id = store.create(0);
		const other = store.create(0);
		store.destroy(id);
		expect(store.check(id, 1)).toBe(false);
		expect(store.check(other, 1)).toBe(true);
	});

	it('keeps at most a handful, dropping the oldest', () => {
		const store = new SessionStore(12 * HOUR, 2 * HOUR, 3);
		const ids = [store.create(0), store.create(1), store.create(2), store.create(3)];
		expect(store.size).toBe(3);
		expect(store.check(ids[0], 4)).toBe(false);
		expect(store.check(ids[3], 4)).toBe(true);
	});
});

describe('LoginLimiter', () => {
	it('allows four misses, then locks the address for fifteen minutes', () => {
		const limiter = new LoginLimiter();
		for (let i = 0; i < 4; i++) expect(limiter.attempt('a', i).ok).toBe(true);
		// The fifth attempt runs, and its failure locks the address.
		expect(limiter.attempt('a', 4).ok).toBe(true);
		const locked = limiter.attempt('a', 5);
		expect(locked).toEqual({ ok: false, retryAfterMs: 15 * MINUTE - 1 });
		expect(limiter.check('b', 5).ok).toBe(true);
		expect(limiter.attempt('a', 4 + 15 * MINUTE).ok).toBe(true);
	});

	it('doubles each lockout, up to a day', () => {
		const limiter = new LoginLimiter();
		let now = 0;
		const lockouts: number[] = [];
		for (let round = 0; round < 9; round++) {
			for (let i = 0; i < 5; i++) expect(limiter.attempt('a', now).ok).toBe(true);
			const check = limiter.check('a', now);
			if (check.ok) throw new Error('expected a lockout');
			lockouts.push(check.retryAfterMs / MINUTE);
			now += check.retryAfterMs;
		}
		expect(lockouts).toEqual([15, 30, 60, 120, 240, 480, 960, 1440, 1440]);
		// A quiet day after the last lockout ends, the address starts afresh.
		now += 24 * HOUR;
		for (let i = 0; i < 5; i++) limiter.attempt('a', now);
		const fresh = limiter.check('a', now);
		expect(fresh.ok ? 0 : fresh.retryAfterMs / MINUTE).toBe(15);
	});

	it('takes back a good attempt and clears the address', () => {
		const limiter = new LoginLimiter();
		for (let i = 0; i < 4; i++) limiter.attempt('a', i);
		limiter.attempt('a', 10);
		limiter.succeed('a', 10);
		expect(limiter.check('a', 11).ok).toBe(true);
		for (let i = 0; i < 4; i++) expect(limiter.attempt('a', 20 + i).ok).toBe(true);
	});

	it('counts an attempt before its check finishes, so a burst cannot slip past', () => {
		const limiter = new LoginLimiter();
		const started = Array.from({ length: 10 }, () => limiter.attempt('a', 0).ok);
		expect(started.filter(Boolean)).toHaveLength(5);
	});

	it('locks everyone out after twenty misses from anywhere in fifteen minutes', () => {
		const limiter = new LoginLimiter();
		for (let i = 0; i < 20; i++) expect(limiter.attempt(`10.0.0.${i}`, i * 1000).ok).toBe(true);
		const check = limiter.check('192.0.2.1', 20_000);
		expect(check.ok).toBe(false);
		if (!check.ok) expect(check.retryAfterMs).toBe(15 * MINUTE - 20_000);
		expect(limiter.check('192.0.2.1', 15 * MINUTE).ok).toBe(true);
	});

	it('forgets old addresses past its cap', () => {
		const limiter = new LoginLimiter(5, 1_000_000, 15 * MINUTE, 24 * HOUR, 2);
		for (let i = 0; i < 5; i++) limiter.attempt('a', i);
		expect(limiter.check('a', 5).ok).toBe(false);
		limiter.attempt('b', 6);
		limiter.attempt('c', 7);
		expect(limiter.check('a', 8).ok).toBe(true);
	});
});

describe('safeNext', () => {
	it('keeps a path on this site, with its query and fragment', () => {
		expect(safeNext('/triage')).toBe('/triage');
		expect(safeNext('/ship/billing?tab=tools')).toBe('/ship/billing?tab=tools');
		expect(safeNext('/report/a%2Fb#c')).toBe('/report/a%2Fb#c');
		expect(safeNext('/feed/../fleet')).toBe('/fleet');
	});

	it('refuses anything that could leave the site', () => {
		for (const value of [
			null,
			undefined,
			'',
			'feed',
			'//evil.example',
			'//evil.example/feed',
			'/\\evil.example',
			'\\\\evil.example',
			'/\t/evil.example',
			'/\n/evil.example',
			'https://evil.example',
			'javascript:alert(1)',
			'http:/evil.example',
			' /feed',
			`/${'a'.repeat(2048)}`
		]) {
			expect(safeNext(value), String(value)).toBe(HOME);
		}
	});

	it('does not go back to the login or the sign-out', () => {
		expect(safeNext('/login')).toBe(HOME);
		expect(safeNext('/login?next=/feed')).toBe(HOME);
		expect(safeNext('/logout')).toBe(HOME);
	});

	it('builds the login address with the next path encoded', () => {
		expect(loginPath('/feed')).toBe('/login');
		expect(loginPath('/ship/billing?tab=tools')).toBe(
			'/login?next=%2Fship%2Fbilling%3Ftab%3Dtools'
		);
		expect(loginPath('//evil.example')).toBe('/login');
	});
});
