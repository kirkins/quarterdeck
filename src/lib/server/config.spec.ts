import { describe, expect, it } from 'vitest';
import { readConfig } from './config.ts';

describe('readConfig', () => {
	it('defaults to fixtures and never sending', () => {
		expect(readConfig({})).toEqual({
			source: 'fixtures',
			privateerBin: '',
			privateerHome: '',
			allowSend: false,
			fixturesDir: 'fixtures'
		});
	});

	it('reads the live settings', () => {
		const config = readConfig({
			QD_SOURCE: 'cli',
			PRIVATEER_BIN: '/opt/privateer',
			PRIVATEER_HOME: '/srv/home',
			QD_ALLOW_SEND: '1'
		});
		expect(config).toMatchObject({ source: 'cli', allowSend: true, privateerHome: '/srv/home' });
	});

	it('only sends on exactly QD_ALLOW_SEND=1 and rejects unknown sources', () => {
		expect(readConfig({ QD_ALLOW_SEND: 'true' }).allowSend).toBe(false);
		expect(() => readConfig({ QD_SOURCE: 'live' })).toThrow(/QD_SOURCE/);
	});
});
