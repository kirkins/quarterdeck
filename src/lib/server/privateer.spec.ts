import { describe, expect, it, vi } from 'vitest';
import {
	PrivateerCommandError,
	PrivateerExecError,
	PrivateerParseError,
	createRunner,
	privateerArgv,
	type ExecFile
} from './privateer.ts';

type Outcome = { error?: (Error & { code?: unknown; killed?: boolean }) | null; stdout?: string };

function fakeExec(outcome: Outcome) {
	const calls: { file: string; args: readonly string[]; options: unknown }[] = [];
	const execFile: ExecFile = (file, args, options, callback) => {
		calls.push({ file, args, options });
		queueMicrotask(() => callback(outcome.error ?? null, outcome.stdout ?? '', ''));
		return undefined;
	};
	return { execFile, calls };
}

const config = { bin: '/opt/privateer/bin/privateer', home: '/srv/fleet/.privateer' };

describe('privateerArgv', () => {
	it('builds [bin, --home, home, command, --json, args]', () => {
		expect(privateerArgv(config, 'ship.list', { a: 1 })).toEqual([
			'/opt/privateer/bin/privateer',
			'--home',
			'/srv/fleet/.privateer',
			'ship.list',
			'--json',
			'{"a":1}'
		]);
	});
});

describe('createRunner', () => {
	it('runs execFile with an argv array and no shell, and parses JSON', async () => {
		const { execFile, calls } = fakeExec({ stdout: '{"ships":[]}\n' });
		const run = createRunner(config, execFile);
		await expect(run('ship.list', {})).resolves.toEqual({ ships: [] });
		expect(calls).toHaveLength(1);
		expect(calls[0].file).toBe(config.bin);
		expect(calls[0].args).toEqual(['--home', config.home, 'ship.list', '--json', '{}']);
		expect(calls[0].options).toMatchObject({ shell: false });
	});

	it('passes hostile-looking arguments through as one JSON argv element', async () => {
		const { execFile, calls } = fakeExec({ stdout: '{"ok":true}' });
		const run = createRunner(config, execFile);
		const body = '"; rm -rf / #  $(whoami) `id`';
		await run('mail.send', { body });
		expect(calls[0].args.at(-1)).toBe(JSON.stringify({ body }));
		expect(calls[0].args).toHaveLength(5);
	});

	it('surfaces {"ok":false} as a typed error, even with a non-zero exit', async () => {
		const exit = Object.assign(new Error('Command failed'), { code: 1 });
		const { execFile } = fakeExec({ error: exit, stdout: '{"ok":false,"error":"unknown ship"}' });
		const run = createRunner(config, execFile);
		const error = await run('mail.send', {}).catch((e) => e);
		expect(error).toBeInstanceOf(PrivateerCommandError);
		expect(error.error).toBe('unknown ship');
		expect(error.command).toBe('mail.send');
		expect(error.message).toBe('privateer mail.send failed: unknown ship');
	});

	it('reports output that is not a JSON object', async () => {
		const run = createRunner(config, fakeExec({ stdout: 'Usage: privateer …' }).execFile);
		await expect(run('ship.list')).rejects.toBeInstanceOf(PrivateerParseError);
		const runArray = createRunner(config, fakeExec({ stdout: '[1,2]' }).execFile);
		await expect(runArray('ship.list')).rejects.toBeInstanceOf(PrivateerParseError);
		const runEmpty = createRunner(config, fakeExec({ stdout: '' }).execFile);
		await expect(runEmpty('ship.list')).rejects.toBeInstanceOf(PrivateerParseError);
	});

	it('explains a missing binary and a timeout without leaking the command line', async () => {
		const missing = Object.assign(new Error(`spawn ${config.bin} ENOENT`), { code: 'ENOENT' });
		const run = createRunner(config, fakeExec({ error: missing }).execFile);
		const error = await run('ship.list').catch((e) => e);
		expect(error).toBeInstanceOf(PrivateerExecError);
		expect(error.message).toMatch(/not found/);
		expect(error.message).not.toContain(config.home);

		const killed = Object.assign(new Error('killed'), { killed: true });
		const slow = createRunner(config, fakeExec({ error: killed }).execFile);
		await expect(slow('ship.list')).rejects.toThrow(/timed out/);

		const exit = Object.assign(new Error(`Command failed: ${config.bin} --home ${config.home}`), {
			code: 2
		});
		const failing = createRunner(config, fakeExec({ error: exit }).execFile);
		const failed = await failing('ship.list').catch((e) => e);
		expect(failed.message).toBe('privateer ship.list failed with exit code 2');
	});

	it('requires a binary and a home', () => {
		const execFile = vi.fn();
		expect(() => createRunner({ bin: '', home: '/h' }, execFile)).toThrow(/PRIVATEER_BIN/);
		expect(() => createRunner({ bin: '/b', home: '' }, execFile)).toThrow(/PRIVATEER_HOME/);
	});
});
