/**
 * Where captain mail comes from. CliSource asks a live privateer home;
 * FixtureSource reads JSON files in the same shapes, so the portal can be
 * built, tested and demonstrated without a fleet.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { assemble, type Waiting } from '#lib/shapes.ts';
import type { ReplyArgs } from './answer.ts';
import type { Config } from './config.ts';
import type { DismissArgs } from './dismiss.ts';
import { createRunner, privateerArgv, type ExecFile, type Runner } from './privateer.ts';

/** The privateer commands Quarterdeck writes. Everything else is a read. */
export type WriteCommand = 'captain.reply' | 'captain.dismiss';

export interface Source {
	readonly mode: 'fixtures' | 'cli';
	/** Everything owed to the captain: captain.waiting and runtime.needs, merged. */
	waiting(): Promise<Waiting>;
	/**
	 * Really run a write. Callers go through `sendWrite`, which decides whether to.
	 * This is the only place privateer is written to.
	 */
	write(command: WriteCommand, args: ReplyArgs | DismissArgs): Promise<unknown>;
}

export class CliSource implements Source {
	readonly mode = 'cli' as const;
	readonly #run: Runner;

	constructor(run: Runner) {
		this.#run = run;
	}

	static fromConfig(config: Config, execFile?: ExecFile): CliSource {
		return new CliSource(
			createRunner({ bin: config.privateerBin, home: config.privateerHome }, execFile)
		);
	}

	async waiting(): Promise<Waiting> {
		const [waiting, needs] = await Promise.all([
			this.#run('captain.waiting', {}),
			this.#run('runtime.needs', {})
		]);
		return assemble(waiting, needs, Date.now());
	}

	/**
	 * The one function that writes to privateer. Both commands take the ask's
	 * item id and nothing else for routing: Privateer finds the ask across this
	 * machine's homes and linked machines. See docs/DECISIONS.md section 12.
	 */
	write(command: WriteCommand, args: ReplyArgs | DismissArgs): Promise<unknown> {
		return this.#run(command, { ...args });
	}
}

/** Fixture files, named after the command whose output they stand in for. */
export const FIXTURE_FILES = ['captain.waiting.json', 'runtime.needs.json'] as const;

/** Keys that are derived when read, never shifted with the fixture clock. */
const DERIVED_KEYS = new Set(['age_ms', 'waited_ms']);

/**
 * Fixtures are written at a fixed moment (`fixture_now_ms`). Shift every
 * `*_ms` timestamp, at any depth, by the same amount, so the fixture reads as
 * if it were captured `now`: an ask "due in 45m" stays due in 45m, and an
 * overdue one stays overdue. Derived ages are recomputed when parsed.
 */
export function rebaseFixture(value: unknown, fixtureNow: number, now: number): unknown {
	const delta = now - fixtureNow;
	const shift = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(shift);
		if (typeof node !== 'object' || node === null) return node;
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(node)) {
			const isTime = key.endsWith('_ms') && !DERIVED_KEYS.has(key) && key !== 'fixture_now_ms';
			out[key] = isTime && typeof child === 'number' ? child + delta : shift(child);
		}
		return out;
	};
	return shift(value);
}

export class FixtureSource implements Source {
	readonly mode = 'fixtures' as const;
	readonly #dir: string;
	readonly #now: () => number;

	constructor(dir: string, now: () => number = Date.now) {
		this.#dir = dir;
		this.#now = now;
	}

	/** One fixture file as parsed JSON, or null when it is absent. */
	async #read(file: string): Promise<unknown> {
		let text: string;
		try {
			text = await readFile(path.resolve(this.#dir, file), 'utf8');
		} catch (error) {
			if ((error as { code?: string }).code === 'ENOENT') return null;
			throw error;
		}
		const json = JSON.parse(text) as { fixture_now_ms?: unknown };
		return typeof json.fixture_now_ms === 'number'
			? rebaseFixture(json, json.fixture_now_ms, this.#now())
			: json;
	}

	async waiting(): Promise<Waiting> {
		const [captain, needs] = await Promise.all(FIXTURE_FILES.map((file) => this.#read(file)));
		return assemble(captain, needs, this.#now());
	}

	write(): Promise<unknown> {
		return Promise.reject(new Error('FixtureSource never writes to privateer'));
	}
}

export function createSource(config: Config): Source {
	return config.source === 'cli'
		? CliSource.fromConfig(config)
		: new FixtureSource(config.fixturesDir);
}

export interface SendOutcome {
	sent: boolean;
	result?: unknown;
}

/**
 * Run a write, or only log it. Nothing is sent unless the source is live
 * (QD_SOURCE=cli) and QD_ALLOW_SEND=1; otherwise the exact args (and the argv
 * that would run) are logged and the action is treated as accepted.
 */
export async function sendWrite(
	source: Source,
	config: Pick<Config, 'allowSend' | 'privateerBin' | 'privateerHome'>,
	command: WriteCommand,
	args: ReplyArgs | DismissArgs,
	log: (message: string) => void = console.info
): Promise<SendOutcome> {
	if (source.mode === 'cli' && config.allowSend) {
		return { sent: true, result: await source.write(command, args) };
	}
	const reason = source.mode === 'fixtures' ? 'fixture mode' : 'QD_ALLOW_SEND is not 1';
	const argv = privateerArgv(
		{ bin: config.privateerBin || 'privateer', home: config.privateerHome || '$PRIVATEER_HOME' },
		command,
		{ ...args }
	);
	log(`[quarterdeck] not sent (${reason}): ${command} ${JSON.stringify(args)}`);
	log(`[quarterdeck] would run: ${JSON.stringify(argv)}`);
	return { sent: false };
}

/** Send a captain reply (`captain.reply`). */
export function sendReply(
	source: Source,
	config: Pick<Config, 'allowSend' | 'privateerBin' | 'privateerHome'>,
	args: ReplyArgs,
	log?: (message: string) => void
): Promise<SendOutcome> {
	return sendWrite(source, config, 'captain.reply', args, log);
}

/** Close an ask without a reply (`captain.dismiss`). */
export function sendDismiss(
	source: Source,
	config: Pick<Config, 'allowSend' | 'privateerBin' | 'privateerHome'>,
	args: DismissArgs,
	log?: (message: string) => void
): Promise<SendOutcome> {
	return sendWrite(source, config, 'captain.dismiss', args, log);
}
