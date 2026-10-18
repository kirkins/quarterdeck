import { beforeAll, describe, expect, it } from 'vitest';
import { hashPassphrase } from '../../../login-hash.js';
import { checkStartup, hostAllowed, isLoopback, requestOrigin } from '../../../startup-guard.js';

const VPN = '192.0.2.10';

describe('isLoopback', () => {
	it('accepts loopback names only', () => {
		expect(isLoopback('127.0.0.1')).toBe(true);
		expect(isLoopback('127.5.4.3')).toBe(true);
		expect(isLoopback('localhost')).toBe(true);
		expect(isLoopback('::1')).toBe(true);
		expect(isLoopback('[::1]')).toBe(true);
		expect(isLoopback('0.0.0.0')).toBe(false);
		expect(isLoopback('::')).toBe(false);
		expect(isLoopback(VPN)).toBe(false);
	});
});

describe('checkStartup', () => {
	it('starts on the defaults: fixtures, loopback, no send', () => {
		const report = checkStartup({});
		expect(report).toEqual({
			ok: true,
			errors: [],
			warnings: [],
			summary: 'source=fixtures send=off login=off listen=127.0.0.1:3000'
		});
	});

	it('refuses a non-loopback bind with send on and no login', () => {
		const report = checkStartup({
			HOST: VPN,
			QD_SOURCE: 'cli',
			QD_ALLOW_SEND: '1',
			ORIGIN: `http://${VPN}:3000`
		});
		expect(report.ok).toBe(false);
		expect(report.errors).toHaveLength(1);
		expect(report.errors[0]).toMatch(/no login is configured/);
	});

	it('refuses a wildcard bind with send on and no login', () => {
		expect(checkStartup({ HOST: '0.0.0.0', QD_SOURCE: 'cli', QD_ALLOW_SEND: '1' }).ok).toBe(false);
	});

	it('allows send on loopback without a login', () => {
		expect(checkStartup({ QD_SOURCE: 'cli', QD_ALLOW_SEND: '1' }).ok).toBe(true);
	});

	it('allows a non-loopback bind with send off', () => {
		const report = checkStartup({ HOST: VPN, QD_SOURCE: 'cli', ORIGIN: `http://${VPN}:3000` });
		expect(report.ok).toBe(true);
		expect(report.warnings).toHaveLength(1);
		expect(report.warnings[0]).toMatch(/no login is configured/);
		expect(report.summary).toBe(`source=cli send=off login=off listen=${VPN}:3000`);
	});

	it('refuses a QD_LOGIN_SECRET that is not a hash, and never echoes it', () => {
		const report = checkStartup({ QD_LOGIN_SECRET: 'my plain passphrase' });
		expect(report.ok).toBe(false);
		expect(report.errors[0]).toMatch(/not a scrypt hash/);
		expect(JSON.stringify(report)).not.toContain('plain passphrase');
		expect(report.summary).toContain('login=off');
		expect(
			checkStartup({ HOST: VPN, QD_LOGIN_SECRET: '   ', ORIGIN: `http://${VPN}:3000` }).ok
		).toBe(true);
	});

	it('refuses session settings that are not positive numbers', () => {
		expect(checkStartup({ QD_SESSION_HOURS: '0' }).errors[0]).toMatch(/QD_SESSION_HOURS/);
		expect(checkStartup({ QD_SESSION_IDLE_MINUTES: 'two' }).errors[0]).toMatch(
			/QD_SESSION_IDLE_MINUTES/
		);
		expect(checkStartup({ QD_SESSION_HOURS: '8', QD_SESSION_IDLE_MINUTES: '30' }).ok).toBe(true);
	});

	describe('with a valid login hash', () => {
		let secret = '';
		beforeAll(async () => {
			secret = await hashPassphrase('a passphrase only for this test');
		});

		it('turns login on, and lets send on a network bind', () => {
			const report = checkStartup({
				HOST: VPN,
				QD_SOURCE: 'cli',
				QD_ALLOW_SEND: '1',
				QD_LOGIN_SECRET: secret,
				ORIGIN: `http://${VPN}:3000`
			});
			expect(report).toEqual({
				ok: true,
				errors: [],
				warnings: [],
				summary: `source=cli send=on login=on listen=${VPN}:3000`
			});
			expect(JSON.stringify(report)).not.toContain(secret.split('$')[5]);
		});

		it('still refuses send on a network bind without ORIGIN', () => {
			const report = checkStartup({
				HOST: VPN,
				QD_SOURCE: 'cli',
				QD_ALLOW_SEND: '1',
				QD_LOGIN_SECRET: secret
			});
			expect(report.ok).toBe(false);
			expect(report.errors).toHaveLength(1);
			expect(report.errors[0]).toMatch(/ORIGIN is unset/);
		});

		it('refuses a hash whose parameters are weak', () => {
			const weak = secret.replace(/^scrypt\$131072\$/, 'scrypt$16384$');
			const report = checkStartup({ QD_LOGIN_SECRET: weak });
			expect(report.ok).toBe(false);
			expect(report.errors[0]).toMatch(/weak scrypt parameters/);
		});

		it('turns login on over loopback too', () => {
			expect(checkStartup({ QD_LOGIN_SECRET: secret }).summary).toContain('login=on');
		});
	});

	it('refuses send with fixtures, whatever the bind', () => {
		const report = checkStartup({ QD_ALLOW_SEND: '1' });
		expect(report.ok).toBe(false);
		expect(report.errors[0]).toMatch(/QD_SOURCE=fixtures/);
	});

	it('refuses a non-loopback bind without ORIGIN', () => {
		const report = checkStartup({ HOST: VPN, QD_SOURCE: 'cli' });
		expect(report.ok).toBe(false);
		expect(report.errors[0]).toMatch(/ORIGIN is unset/);
	});

	it('refuses an ORIGIN that is not a URL', () => {
		const report = checkStartup({ ORIGIN: 'vpn-address:3000' });
		expect(report.ok).toBe(false);
		expect(report.errors[0]).toMatch(/ORIGIN must be an http/);
	});
});

describe('hostAllowed', () => {
	it('accepts any Host on a loopback bind', () => {
		expect(hostAllowed({}, 'anything.example')).toBe(true);
		expect(hostAllowed({ HOST: '::1' }, null)).toBe(true);
	});

	it('accepts only HOST:PORT and the ORIGIN host on a non-loopback bind', () => {
		const env = { HOST: VPN, PORT: '3000', ORIGIN: `http://${VPN}:3000` };
		expect(hostAllowed(env, `${VPN}:3000`)).toBe(true);
		expect(hostAllowed(env, `${VPN.toUpperCase()}:3000`)).toBe(true);
		expect(hostAllowed(env, `${VPN}:3001`)).toBe(false);
		expect(hostAllowed(env, 'attacker.example:3000')).toBe(false);
		expect(hostAllowed(env, null)).toBe(false);
	});

	it('accepts the ORIGIN host when HOST is a wildcard', () => {
		const env = { HOST: '0.0.0.0', ORIGIN: `https://quarterdeck.example` };
		expect(hostAllowed(env, 'quarterdeck.example')).toBe(true);
		expect(hostAllowed(env, `${VPN}:3000`)).toBe(false);
	});

	it('brackets an IPv6 HOST', () => {
		const env = { HOST: 'fd00::2', PORT: '3000' };
		expect(hostAllowed(env, '[fd00::2]:3000')).toBe(true);
	});
});

describe('requestOrigin', () => {
	it('takes the protocol and host from ORIGIN', () => {
		expect(requestOrigin({ ORIGIN: `http://${VPN}:3000` })).toEqual({
			protocol: 'http',
			host: `${VPN}:3000`
		});
		expect(requestOrigin({ ORIGIN: 'https://quarterdeck.example' })).toEqual({
			protocol: 'https',
			host: 'quarterdeck.example'
		});
	});

	it('is plain http with the request’s own Host without ORIGIN (loopback)', () => {
		expect(requestOrigin({})).toEqual({ protocol: 'http', host: null });
		expect(requestOrigin({ ORIGIN: 'not a url' })).toEqual({ protocol: 'http', host: null });
	});
});
