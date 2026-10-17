import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { MailSendArgs } from './answer.ts';
import {
	CliSource,
	FixtureSource,
	extractItems,
	rebaseFixture,
	sendReply,
	type Source
} from './source.ts';

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

describe('extractItems', () => {
	it('finds the list under the usual wrapper names, or a bare list', () => {
		const item = { id: 'a', from: 'x', to: 'captain', kind: 'decision' };
		expect(extractItems({ messages: [item] })).toEqual([item]);
		expect(extractItems({ items: [item] })).toEqual([item]);
		expect(extractItems({ waiting: [item] })).toEqual([item]);
		expect(extractItems([item, null, { no: 'id' }])).toEqual([item]);
		expect(extractItems({ other: 1 })).toEqual([]);
		expect(extractItems(null)).toEqual([]);
	});
});

describe('CliSource', () => {
	it('merges captain.waiting and runtime.needs by id', async () => {
		const run = vi.fn(async (command: string) =>
			command === 'captain.waiting'
				? {
						messages: [
							{ id: 'a', from: 's', kind: 'decision' },
							{ id: 'b', from: 's' }
						]
					}
				: {
						messages: [
							{ id: 'b', from: 's', hands_on: 'Plug it in' },
							{ id: 'c', from: 't' }
						]
					}
		);
		const source = new CliSource(run as never);
		const items = await source.waiting();
		expect(run.mock.calls.map((c) => c[0]).sort()).toEqual(['captain.waiting', 'runtime.needs']);
		expect(items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
		expect(items[1].hands_on).toBe('Plug it in');
	});

	it('sends with mail.send', async () => {
		const run = vi.fn(async () => ({ id: 'reply-1' }));
		await new CliSource(run as never).send(args);
		expect(run).toHaveBeenCalledWith('mail.send', args);
	});
});

describe('FixtureSource', () => {
	it('reads both fixture files and shifts times to now', async () => {
		const dir = await mkdtemp(path.join(tmpdir(), 'qd-fixtures-'));
		const T = 1_700_000_000_000;
		await writeFile(
			path.join(dir, 'captain.waiting.json'),
			JSON.stringify({
				fixture_now_ms: T,
				messages: [{ id: 'a', from: 's', created_ms: T - H, deadline_ms: T + H, age_ms: 1 }]
			})
		);
		await writeFile(
			path.join(dir, 'runtime.needs.json'),
			JSON.stringify({ messages: [{ id: 'b', from: 's', created_ms: 5 }] })
		);
		const items = await new FixtureSource(dir, () => NOW).waiting();
		expect(items).toEqual([
			{ id: 'a', from: 's', created_ms: NOW - H, deadline_ms: NOW + H, age_ms: H },
			{ id: 'b', from: 's', created_ms: 5 }
		]);
	});

	it('treats missing files as empty and never sends', async () => {
		const dir = await mkdtemp(path.join(tmpdir(), 'qd-empty-'));
		const source = new FixtureSource(dir);
		await expect(source.waiting()).resolves.toEqual([]);
		await expect(source.send()).rejects.toThrow(/never sends/);
	});

	it('keeps null deadlines null when rebasing', () => {
		const [item] = rebaseFixture(
			[{ id: 'x', from: 's', to: 'c', kind: 'decision', deadline_ms: null }],
			0,
			NOW
		);
		expect(item.deadline_ms).toBeNull();
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
