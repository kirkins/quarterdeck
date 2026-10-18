import { describe, expect, it } from 'vitest';
import { checkStartup, hostAllowed, isLoopback } from '../../../startup-guard.js';

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
		expect(report.warnings).toEqual([]);
		expect(report.summary).toBe(`source=cli send=off login=off listen=${VPN}:3000`);
	});

	it('treats any non-empty QD_LOGIN_SECRET as a login, but warns that it is not enforced yet', () => {
		const report = checkStartup({
			HOST: VPN,
			QD_SOURCE: 'cli',
			QD_ALLOW_SEND: '1',
			QD_LOGIN_SECRET: 'x',
			ORIGIN: `http://${VPN}:3000`
		});
		expect(report.ok).toBe(true);
		expect(report.warnings).toEqual([
			'QD_LOGIN_SECRET is set, but login is not implemented yet: nothing enforces it.'
		]);
		expect(report.summary).not.toContain('x');
		expect(report.summary).toContain('login=on');
		expect(checkStartup({ HOST: VPN, QD_LOGIN_SECRET: '   ' }).errors).toEqual([]);
	});

	it('refuses send with fixtures, whatever the bind', () => {
		const report = checkStartup({ QD_ALLOW_SEND: '1' });
		expect(report.ok).toBe(false);
		expect(report.errors[0]).toMatch(/QD_SOURCE=fixtures/);
	});

	it('warns on a non-loopback bind without ORIGIN', () => {
		const report = checkStartup({ HOST: VPN, QD_SOURCE: 'cli' });
		expect(report.ok).toBe(true);
		expect(report.warnings[0]).toMatch(/ORIGIN is unset/);
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
