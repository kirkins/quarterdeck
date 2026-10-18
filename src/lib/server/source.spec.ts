import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ReplyArgs } from './answer.ts';
import { buildDismiss } from './dismiss.ts';
import {
	CliSource,
	FixtureSource,
	isUnknownCommand,
	parseFetched,
	rebaseFixture,
	sendDismiss,
	sendReply,
	type Source
} from './source.ts';
import { PrivateerCommandError, PrivateerExecError } from './privateer.ts';
import { sinceFor } from '#lib/spend.ts';

const NOW = 1_800_000_000_000;
const H = 3_600_000;

const args: ReplyArgs = {
	id: 'mail-1',
	body: 'Yes',
	payload: { answer: { option_id: 'yes' } }
};

describe('CliSource', () => {
	it('reads both queries in their real shapes and merges them', async () => {
		const mail = {
			id: 'a',
			from: 's',
			kind: 'request',
			created_ms: NOW - H,
			urgency: 'high',
			deadline_ms: NOW + H,
			payload: {},
			body: 'Plug it in?'
		};
		const run = vi.fn(async (command: string) =>
			command === 'captain.waiting'
				? {
						now_ms: NOW,
						hands_on: [],
						waiting: [{ ship: 's', asked_ms: NOW - H, step: 'Plug it in', mail }]
					}
				: {
						available: true,
						items: [
							{
								id: 'o:mail:a',
								source: 'mail',
								kind: 'decision',
								ship: 's',
								correlation: 'a',
								created_ms: NOW - H
							},
							{
								id: 'o:job:j',
								source: 'job',
								kind: 'blocker',
								ship: 't',
								evidence: 'capacity_wait',
								status: 'queued',
								created_ms: NOW - 5 * 60_000
							}
						]
					}
		);
		const source = new CliSource(run as never);
		const { items, unavailable } = await source.waiting();
		expect(run.mock.calls.map((c) => c[0]).sort()).toEqual(['captain.waiting', 'runtime.needs']);
		expect(unavailable).toBeNull();
		expect(items.map((i) => i.id).sort()).toEqual(['a', 'o:job:j']);
		const a = items.find((i) => i.id === 'a');
		expect(a?.hands_on).toBe('Plug it in');
		expect(a?.urgency).toBe('high');
	});

	it('writes captain.reply and captain.dismiss through the one write path', async () => {
		const run = vi.fn(async () => ({ id: 'reply-1' }));
		const source = new CliSource(run as never);
		await source.write('captain.reply', args);
		expect(run).toHaveBeenLastCalledWith('captain.reply', args);
		await source.write('captain.dismiss', { id: 'a', note: 'Not needed' });
		expect(run).toHaveBeenLastCalledWith('captain.dismiss', { id: 'a', note: 'Not needed' });
	});
});

describe('FixtureSource', () => {
	it('reads both fixture files in the real shapes and shifts times to now', async () => {
		const dir = await mkdtemp(path.join(tmpdir(), 'qd-fixtures-'));
		const T = 1_700_000_000_000;
		await writeFile(
			path.join(dir, 'captain.waiting.json'),
			JSON.stringify({
				fixture_now_ms: T,
				now_ms: T,
				hands_on: [],
				waiting: [
					{
						ship: 's',
						asked_ms: T - H,
						age_ms: H,
						step: null,
						mail: {
							id: 'a',
							from: 's',
							kind: 'decision',
							created_ms: T - H,
							deadline_ms: T + H,
							urgency: 'normal',
							payload: {}
						}
					}
				]
			})
		);
		await writeFile(
			path.join(dir, 'runtime.needs.json'),
			JSON.stringify({ fixture_now_ms: T, available: true, items: [] })
		);
		const { items, unavailable } = await new FixtureSource(dir, () => NOW).waiting();
		expect(unavailable).toBeNull();
		expect(items).toEqual([
			expect.objectContaining({ id: 'a', asked_ms: NOW - H, deadline_ms: NOW + H, age_ms: H })
		]);
	});

	it('treats missing files as empty and never writes', async () => {
		const dir = await mkdtemp(path.join(tmpdir(), 'qd-empty-'));
		const source = new FixtureSource(dir);
		await expect(source.waiting()).resolves.toEqual({
			items: [],
			unavailable: 'runtime.needs is unavailable'
		});
		await expect(source.write()).rejects.toThrow(/never writes/);
	});
});

describe('rebaseFixture', () => {
	it('shifts every timestamp at any depth, but not derived ages or the fixture clock', () => {
		const out = rebaseFixture(
			{
				fixture_now_ms: 0,
				now_ms: 100,
				age_ms: 7,
				mail: { created_ms: 10, deadline_ms: null, waited_ms: 3 },
				list: [{ asked_ms: 1 }]
			},
			0,
			NOW
		) as Record<string, unknown>;
		expect(out).toEqual({
			fixture_now_ms: 0,
			now_ms: 100 + NOW,
			age_ms: 7,
			mail: { created_ms: 10 + NOW, deadline_ms: null, waited_ms: 3 },
			list: [{ asked_ms: 1 + NOW }]
		});
	});
});

describe('sendReply', () => {
	function source(mode: Source['mode']) {
		return {
			mode,
			waiting: vi.fn(),
			write: vi.fn(async () => ({ id: 'r' })),
			snapshot: vi.fn(),
			routesShow: vi.fn(),
			usage: vi.fn(),
			report: vi.fn(),
			feed: vi.fn(),
			shipProfile: vi.fn()
		};
	}
	const config = { allowSend: true, privateerBin: '/opt/privateer', privateerHome: '/srv/home' };

	it('never sends in fixture mode, and logs the exact args', async () => {
		const s = source('fixtures');
		const log = vi.fn();
		await expect(sendReply(s, config, args, log)).resolves.toEqual({ sent: false });
		expect(s.write).not.toHaveBeenCalled();
		expect(log.mock.calls[0][0]).toContain(`captain.reply ${JSON.stringify(args)}`);
		expect(JSON.parse(log.mock.calls[1][0].replace('[quarterdeck] would run: ', ''))).toEqual([
			'/opt/privateer',
			'--home',
			'/srv/home',
			'captain.reply',
			'--json',
			JSON.stringify(args)
		]);
	});

	it('does not send from the cli source unless QD_ALLOW_SEND=1', async () => {
		const s = source('cli');
		const log = vi.fn();
		await expect(sendReply(s, { ...config, allowSend: false }, args, log)).resolves.toEqual({
			sent: false
		});
		expect(s.write).not.toHaveBeenCalled();
		expect(log.mock.calls[0][0]).toContain('QD_ALLOW_SEND');
	});

	it('sends from the cli source when allowed', async () => {
		const s = source('cli');
		await expect(sendReply(s, config, args, vi.fn())).resolves.toEqual({
			sent: true,
			result: { id: 'r' }
		});
		expect(s.write).toHaveBeenCalledWith('captain.reply', args);
	});
});

describe('sendDismiss', () => {
	const config = { allowSend: true, privateerBin: '/opt/privateer', privateerHome: '/srv/home' };
	const dismiss = { id: 'mail-9', note: 'Covered elsewhere' };

	it('logs captain.dismiss and never writes in fixture mode', async () => {
		const s = {
			mode: 'fixtures' as const,
			waiting: vi.fn(),
			write: vi.fn(),
			snapshot: vi.fn(),
			routesShow: vi.fn(),
			usage: vi.fn(),
			report: vi.fn(),
			feed: vi.fn(),
			shipProfile: vi.fn()
		};
		const log = vi.fn();
		await expect(sendDismiss(s, config, dismiss, log)).resolves.toEqual({ sent: false });
		expect(s.write).not.toHaveBeenCalled();
		expect(log.mock.calls[0][0]).toContain(`captain.dismiss ${JSON.stringify(dismiss)}`);
		expect(log.mock.calls[1][0]).toContain('"captain.dismiss"');
	});

	it('writes captain.dismiss from the cli source when allowed', async () => {
		const s = {
			mode: 'cli' as const,
			waiting: vi.fn(),
			write: vi.fn(async () => ({ ok: true })),
			snapshot: vi.fn(),
			routesShow: vi.fn(),
			usage: vi.fn(),
			report: vi.fn(),
			feed: vi.fn(),
			shipProfile: vi.fn()
		};
		await expect(sendDismiss(s, config, dismiss, vi.fn())).resolves.toEqual({
			sent: true,
			result: { ok: true }
		});
		expect(s.write).toHaveBeenCalledWith('captain.dismiss', dismiss);
	});
});

describe('buildDismiss', () => {
	const item = { id: 'mail-9', from: 's', to: 'captain', kind: 'request', payload: {} };

	it('sends only the id when there is no note', () => {
		expect(buildDismiss(item, '  ')).toEqual({ ok: true, args: { id: 'mail-9' }, note: null });
	});

	it('keeps a trimmed note', () => {
		expect(buildDismiss(item, ' Done elsewhere ')).toEqual({
			ok: true,
			args: { id: 'mail-9', note: 'Done elsewhere' },
			note: 'Done elsewhere'
		});
	});

	it('refuses a note over the limit', () => {
		expect(buildDismiss(item, 'x'.repeat(2001))).toEqual({
			ok: false,
			error: 'Keep the note under 2000 characters.'
		});
	});
});

describe('fleet snapshot', () => {
	it('reads fleet.snapshot and parses it', async () => {
		const run = vi.fn(async () => ({
			generated_ms: NOW,
			machines: [{ name: 'atlas', reachable: true }]
		}));
		const read = await new CliSource(run as never).snapshot();
		expect(run).toHaveBeenCalledWith('fleet.snapshot', {});
		expect(read).toEqual({
			status: 'ok',
			snapshot: {
				generated_ms: NOW,
				machines: [{ name: 'atlas', reachable: true, changed_ms: null, routes: [], ships: [] }],
				needs: []
			}
		});
	});

	it('reports an older Privateer that does not know the command as unsupported', async () => {
		const unknownJson = new CliSource(async () => {
			throw new PrivateerCommandError('fleet.snapshot', 'unknown command fleet.snapshot');
		});
		expect(await unknownJson.snapshot()).toEqual({ status: 'unsupported' });

		const unknownClap = new CliSource(async () => {
			throw new PrivateerExecError(
				'fleet.snapshot',
				'privateer fleet.snapshot failed with exit code 2',
				"error: unrecognized subcommand 'fleet.snapshot'"
			);
		});
		expect(await unknownClap.snapshot()).toEqual({ status: 'unsupported' });
	});

	it('rethrows real failures instead of calling them unsupported', async () => {
		const timedOut = new CliSource(async () => {
			throw new PrivateerExecError('fleet.snapshot', 'privateer fleet.snapshot timed out');
		});
		await expect(timedOut.snapshot()).rejects.toThrow('timed out');

		const unknownError = new CliSource(async () => {
			throw new PrivateerCommandError('fleet.snapshot', 'unknown error');
		});
		await expect(unknownError.snapshot()).rejects.toThrow('unknown error');
	});

	it('recognises only the unknown-command messages', () => {
		expect(isUnknownCommand(new Error('unknown command'))).toBe(false);
		expect(isUnknownCommand(new PrivateerCommandError('x', 'no such command: x'))).toBe(true);
	});

	it('reads the fixture snapshot, shifted to now', async () => {
		const read = await new FixtureSource('fixtures', () => NOW).snapshot();
		expect(read.status).toBe('ok');
		if (read.status !== 'ok') return;
		expect(read.snapshot.machines.map((m) => m.name)).toEqual(['atlas', 'boreas', 'calypso']);
		expect(read.snapshot.generated_ms).toBe(NOW);
	});

	it('reports an absent fixture as unsupported', async () => {
		const dir = await mkdtemp(path.join(tmpdir(), 'qd-fleet-'));
		await writeFile(path.join(dir, 'captain.waiting.json'), '{}');
		expect(await new FixtureSource(dir, () => NOW).snapshot()).toEqual({ status: 'unsupported' });
	});
});

describe('spend reads (routes.show, usage.summary)', () => {
	it('runs routes.show and parses the config and order lists', async () => {
		const run = vi.fn(async () => ({
			routes: { 'free-pool': { cost: 'free', note: 'Scouting' } },
			crew: ['free-pool']
		}));
		const read = await new CliSource(run as never).routesShow();
		expect(run).toHaveBeenCalledWith('routes.show', {});
		expect(read).toMatchObject({
			status: 'ok',
			value: {
				routes: [{ name: 'free-pool', cost: 'free', note: 'Scouting' }],
				order: { crew: ['free-pool'] }
			}
		});
	});

	it('passes the period and grouping to usage.summary, leaving out an open end', async () => {
		const run = vi.fn(async () => ({
			since_ms: NOW - 24 * H,
			group_by: 'ship',
			groups: [{ key: 'billing', jobs: 2, usage: { input: 10, output: 5 }, gaps: [] }]
		}));
		const read = await new CliSource(run as never).usage({
			since_ms: NOW - 24 * H,
			group_by: 'ship'
		});
		expect(run).toHaveBeenCalledWith('usage.summary', { since_ms: NOW - 24 * H, group_by: 'ship' });
		expect(read.status).toBe('ok');
		if (read.status !== 'ok') return;
		expect(read.value.groups[0]).toMatchObject({
			key: 'billing',
			jobs: 2,
			usage: { totalTokens: 15 }
		});
	});

	it('reports an older Privateer as unsupported for each, and rethrows real failures', async () => {
		const unknown = new CliSource(async () => {
			throw new PrivateerCommandError('usage.summary', 'unknown command usage.summary');
		});
		expect(await unknown.usage({ since_ms: NOW, group_by: 'day' })).toEqual({
			status: 'unsupported'
		});
		expect(await unknown.routesShow()).toEqual({ status: 'unsupported' });

		const broken = new CliSource(async () => {
			throw new PrivateerExecError('usage.summary', 'privateer usage.summary timed out');
		});
		await expect(broken.usage({ since_ms: NOW, group_by: 'day' })).rejects.toThrow('timed out');
	});

	it('reads the routes and usage fixtures, and groups the usage records as usage.summary would', async () => {
		const source = new FixtureSource('fixtures', () => NOW);
		const routes = await source.routesShow();
		expect(routes.status).toBe('ok');
		if (routes.status === 'ok') {
			expect(routes.value.order.crew).toEqual(['free-pool', 'plan-main', 'credits-reserve']);
		}

		const week = await source.usage({ since_ms: NOW - 7 * 24 * H, group_by: 'ship' });
		expect(week.status).toBe('ok');
		if (week.status !== 'ok') return;
		const gapped = week.value.groups.find((g) => g.gaps.includes('ferry'));
		expect(gapped?.key).toBe('analytics');
		expect(gapped?.usage).toBeNull();
		expect(week.value.groups.every((g) => g.jobs !== null && g.jobs > 0)).toBe(true);

		const day = await source.usage({ since_ms: NOW - 24 * H, group_by: 'day' });
		expect(day.status === 'ok' && day.value.groups.length).toBeGreaterThan(0);
	});

	it('draws the same days for the usage fixture at any hour of the day', async () => {
		const days = async (now: number) => {
			const source = new FixtureSource('fixtures', () => now);
			const read = await source.usage({ since_ms: sinceFor('30d', now), group_by: 'day' });
			if (read.status !== 'ok') throw new Error('expected usage');
			return read.value.groups.map((g) => g.key);
		};
		const midnight = Date.UTC(2026, 9, 17);
		const early = await days(midnight + H);
		const late = await days(midnight + 23 * H);
		expect(early).toEqual(late);
		// Thirty days, each with its own bar, and none of them before the first.
		expect(early).toHaveLength(30);
	});

	it('shows a shorter period as no more tokens than a longer one', async () => {
		const source = new FixtureSource('fixtures', () => NOW);
		const total = async (since: number) => {
			const read = await source.usage({ since_ms: since, group_by: 'route' });
			if (read.status !== 'ok') throw new Error('expected usage');
			return read.value.groups.reduce((n, g) => n + (g.usage?.totalTokens ?? 0), 0);
		};
		const day = await total(NOW - 24 * H);
		const month = await total(NOW - 30 * 24 * H);
		expect(day).toBeGreaterThan(0);
		expect(month).toBeGreaterThan(day);
	});

	it('reports absent spend fixtures as unsupported', async () => {
		const dir = await mkdtemp(path.join(tmpdir(), 'qd-spend-'));
		await writeFile(path.join(dir, 'captain.waiting.json'), '{}');
		const source = new FixtureSource(dir, () => NOW);
		expect(await source.routesShow()).toEqual({ status: 'unsupported' });
		expect(await source.usage({ since_ms: NOW, group_by: 'route' })).toEqual({
			status: 'unsupported'
		});
	});
});

describe('reports by id', () => {
	it('reads report.get at the top level or under report, and checks its format and size', () => {
		expect(parseFetched({ format: 'html', content: '<p>x</p>' }, 'r')).toEqual({
			format: 'html',
			content: '<p>x</p>'
		});
		expect(parseFetched({ ok: true, report: { format: 'markdown', content: '# x' } }, 'r')).toEqual(
			{
				format: 'markdown',
				content: '# x'
			}
		);
		expect(() => parseFetched({ format: 'pdf', content: 'x' }, 'r')).toThrow(/format/);
		expect(() => parseFetched({ format: 'html' }, 'r')).toThrow(/content/);
		expect(() =>
			parseFetched({ format: 'html', content: 'a'.repeat(256 * 1024 + 1) }, 'r')
		).toThrow(/larger/);
	});

	it('CliSource asks report.get for the id', async () => {
		const run = vi.fn(async () => ({ format: 'markdown', content: 'x' }));
		const source = new CliSource(run as never);
		await expect(source.report('r-7')).resolves.toEqual({ format: 'markdown', content: 'x' });
		expect(run).toHaveBeenCalledWith('report.get', { id: 'r-7' });
	});

	it('FixtureSource reads the report from the fixtures, and says when it is missing', async () => {
		const dir = await mkdtemp(path.join(tmpdir(), 'qd-report-'));
		await writeFile(
			path.join(dir, 'report.get.json'),
			JSON.stringify({ reports: { 'r-7': { format: 'html', content: '<h1>Audit</h1>' } } })
		);
		const source = new FixtureSource(dir, () => NOW);
		await expect(source.report('r-7')).resolves.toEqual({
			format: 'html',
			content: '<h1>Audit</h1>'
		});
		await expect(source.report('nope')).rejects.toThrow(/not in the fixtures/);
	});
});

describe('ship.profile', () => {
	it('reads a profile with the ship name it was asked for, masking secrets', async () => {
		const run = vi.fn(async () => ({
			machine: 'atlas',
			first_mate: { options: { api_key: 'do-not-show-this' } }
		}));
		const read = await new CliSource(run as never).shipProfile('billing');
		expect(run).toHaveBeenCalledWith('ship.profile', { ship: 'billing' });
		expect(read.status).toBe('ok');
		if (read.status !== 'ok') return;
		expect(read.value.ship).toBe('billing');
		expect(JSON.stringify(read.value)).not.toContain('do-not-show-this');
	});

	it('maps an unknown ship to not_found, and an older Privateer to unsupported', async () => {
		const unknownShip = new CliSource(async () => {
			throw new PrivateerCommandError('ship.profile', 'ship not found: ghost');
		});
		expect(await unknownShip.shipProfile('ghost')).toEqual({ status: 'not_found' });

		const older = new CliSource(async () => {
			throw new PrivateerCommandError('ship.profile', 'unknown command ship.profile');
		});
		expect(await older.shipProfile('billing')).toEqual({ status: 'unsupported' });
	});

	it('rethrows any other failure', async () => {
		const broken = new CliSource(async () => {
			throw new PrivateerCommandError('ship.profile', 'database locked');
		});
		await expect(broken.shipProfile('billing')).rejects.toThrow('database locked');
	});

	it('reads the fixture profiles by name, and says not_found for a ship it lacks', async () => {
		const source = new FixtureSource('fixtures', () => NOW);
		const billing = await source.shipProfile('billing');
		expect(billing.status).toBe('ok');
		if (billing.status === 'ok') expect(billing.value.mcpServers.length).toBeGreaterThan(2);
		expect(await source.shipProfile('ghost')).toEqual({ status: 'not_found' });
		expect(await source.shipProfile('constructor')).toEqual({ status: 'not_found' });
	});

	it('reports an absent profile fixture as unsupported', async () => {
		const dir = await mkdtemp(path.join(tmpdir(), 'qd-ship-'));
		expect(await new FixtureSource(dir, () => NOW).shipProfile('billing')).toEqual({
			status: 'unsupported'
		});
	});
});
