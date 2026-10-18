import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { MailSendArgs } from './answer.ts';
import { CliSource, FixtureSource, rebaseFixture, sendReply, type Source } from './source.ts';

const NOW = 1_800_000_000_000;
const H = 3_600_000;

const args: MailSendArgs = {
	from: 'captain',
	to: 'billing',
	kind: 'reply',
	correlation: 'mail-1',
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

	it('sends with mail.send', async () => {
		const run = vi.fn(async () => ({ id: 'reply-1' }));
		await new CliSource(run as never).send(args);
		expect(run).toHaveBeenCalledWith('mail.send', args);
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

	it('treats missing files as empty and never sends', async () => {
		const dir = await mkdtemp(path.join(tmpdir(), 'qd-empty-'));
		const source = new FixtureSource(dir);
		await expect(source.waiting()).resolves.toEqual({
			items: [],
			unavailable: 'runtime.needs is unavailable'
		});
		await expect(source.send()).rejects.toThrow(/never sends/);
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
		return { mode, waiting: vi.fn(), send: vi.fn(async () => ({ id: 'r' })) };
	}
	const config = { allowSend: true, privateerBin: '/opt/privateer', privateerHome: '/srv/home' };

	it('never sends in fixture mode, and logs the exact args', async () => {
		const s = source('fixtures');
		const log = vi.fn();
		await expect(sendReply(s, config, args, log)).resolves.toEqual({ sent: false });
		expect(s.send).not.toHaveBeenCalled();
		expect(log.mock.calls[0][0]).toContain(`mail.send ${JSON.stringify(args)}`);
		expect(JSON.parse(log.mock.calls[1][0].replace('[quarterdeck] would run: ', ''))).toEqual([
			'/opt/privateer',
			'--home',
			'/srv/home',
			'mail.send',
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
		expect(s.send).not.toHaveBeenCalled();
		expect(log.mock.calls[0][0]).toContain('QD_ALLOW_SEND');
	});

	it('sends from the cli source when allowed', async () => {
		const s = source('cli');
		await expect(sendReply(s, config, args, vi.fn())).resolves.toEqual({
			sent: true,
			result: { id: 'r' }
		});
		expect(s.send).toHaveBeenCalledWith(args);
	});
});
