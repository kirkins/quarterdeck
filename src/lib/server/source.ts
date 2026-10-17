/**
 * Where decision mail comes from. CliSource asks a live privateer home;
 * FixtureSource reads JSON files so the portal can be built, tested and
 * demonstrated without a fleet.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { MailItem } from '#lib/decision.ts';
import type { MailSendArgs } from './answer.ts';
import type { Config } from './config.ts';
import { createRunner, privateerArgv, type ExecFile, type Runner } from './privateer.ts';

export interface Source {
	readonly mode: 'fixtures' | 'cli';
	/** Mail owed to the captain: captain.waiting merged with runtime.needs, de-duplicated by id. */
	waiting(): Promise<MailItem[]>;
	/** Really send a captain reply. Callers go through `sendReply`, which decides whether to. */
	send(args: MailSendArgs): Promise<unknown>;
}

/**
 * Pull the list of mail items out of a command result. The commands return an
 * object wrapping a list; accept the common wrapper names rather than guess one.
 */
export function extractItems(result: unknown): MailItem[] {
	const list = Array.isArray(result)
		? result
		: typeof result === 'object' && result !== null
			? ['messages', 'items', 'waiting', 'needs', 'mail']
					.map((key) => (result as Record<string, unknown>)[key])
					.find(Array.isArray)
			: undefined;
	return (list ?? []).filter(
		(item): item is MailItem =>
			typeof item === 'object' && item !== null && typeof (item as MailItem).id === 'string'
	);
}

function mergeById(...lists: MailItem[][]): MailItem[] {
	const byId = new Map<string, MailItem>();
	for (const list of lists) {
		for (const item of list) {
			// Merge so fields only one command reports (e.g. hands_on) survive.
			byId.set(item.id, { ...item, ...byId.get(item.id) });
		}
	}
	return [...byId.values()];
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

	async waiting(): Promise<MailItem[]> {
		const [waiting, needs] = await Promise.all([
			this.#run('captain.waiting', {}),
			this.#run('runtime.needs', {})
		]);
		return mergeById(extractItems(waiting), extractItems(needs));
	}

	send(args: MailSendArgs): Promise<unknown> {
		return this.#run('mail.send', { ...args });
	}
}

/** Fixture files, named after the command whose output they stand in for. */
export const FIXTURE_FILES = ['captain.waiting.json', 'runtime.needs.json'] as const;

/**
 * Fixtures are written at a fixed moment (`fixture_now_ms`). Shift every
 * `*_ms` timestamp so the fixture reads as if it were captured `now`: an ask
 * "due in 45m" stays due in 45m, an overdue one stays overdue.
 */
export function rebaseFixture(items: MailItem[], fixtureNow: number, now: number): MailItem[] {
	const delta = now - fixtureNow;
	return items.map((item) => {
		const out: MailItem = { ...item };
		for (const [key, value] of Object.entries(item)) {
			if (key.endsWith('_ms') && key !== 'age_ms' && typeof value === 'number') {
				out[key] = value + delta;
			}
		}
		const asked = out.asked_ms ?? out.created_ms;
		if (typeof asked === 'number') out.age_ms = now - asked;
		return out;
	});
}

export class FixtureSource implements Source {
	readonly mode = 'fixtures' as const;
	readonly #dir: string;
	readonly #now: () => number;

	constructor(dir: string, now: () => number = Date.now) {
		this.#dir = dir;
		this.#now = now;
	}

	async #read(file: string): Promise<MailItem[]> {
		let text: string;
		try {
			text = await readFile(path.resolve(this.#dir, file), 'utf8');
		} catch (error) {
			if ((error as { code?: string }).code === 'ENOENT') return [];
			throw error;
		}
		const json = JSON.parse(text) as { fixture_now_ms?: unknown };
		const items = extractItems(json);
		const fixtureNow = typeof json.fixture_now_ms === 'number' ? json.fixture_now_ms : null;
		return fixtureNow === null ? items : rebaseFixture(items, fixtureNow, this.#now());
	}

	async waiting(): Promise<MailItem[]> {
		const lists = await Promise.all(FIXTURE_FILES.map((file) => this.#read(file)));
		return mergeById(...lists);
	}

	send(): Promise<unknown> {
		return Promise.reject(new Error('FixtureSource never sends mail'));
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
 * Send a reply, or only log it. Nothing is sent unless the source is live
 * (QD_SOURCE=cli) and QD_ALLOW_SEND=1; otherwise the exact mail.send args (and
 * the argv that would run) are logged and the answer is treated as accepted.
 */
export async function sendReply(
	source: Source,
	config: Pick<Config, 'allowSend' | 'privateerBin' | 'privateerHome'>,
	args: MailSendArgs,
	log: (message: string) => void = console.info
): Promise<SendOutcome> {
	if (source.mode === 'cli' && config.allowSend) {
		return { sent: true, result: await source.send(args) };
	}
	const reason = source.mode === 'fixtures' ? 'fixture mode' : 'QD_ALLOW_SEND is not 1';
	const argv = privateerArgv(
		{ bin: config.privateerBin || 'privateer', home: config.privateerHome || '$PRIVATEER_HOME' },
		'mail.send',
		{ ...args }
	);
	log(`[quarterdeck] not sent (${reason}): mail.send ${JSON.stringify(args)}`);
	log(`[quarterdeck] would run: ${JSON.stringify(argv)}`);
	return { sent: false };
}
