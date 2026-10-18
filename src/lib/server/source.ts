/**
 * Where captain mail comes from. CliSource asks a live privateer home;
 * FixtureSource reads JSON files in the same shapes, so the portal can be
 * built, tested and demonstrated without a fleet.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
	assemble,
	firstCursorOf,
	keepTruncated,
	forwardCursorOf,
	parseFeed,
	parseRoutesShow,
	mergeSnapshot,
	parseShipProfile,
	parseSnapshot,
	parseUsageRecords,
	parseUsageSummary,
	type FeedEntry,
	type FeedPage,
	type FleetSnapshot,
	sinceFixture,
	sinceOf,
	type RoutesConfig,
	type ShipProfile,
	type SinceToken,
	type UsageSummary,
	type Waiting
} from '#lib/shapes.ts';
import { isShipToShip, type FeedBound, type FeedQuery } from '#lib/feed.ts';
import { summarizeRecords, type UsageQuery } from '#lib/usage.ts';
import { REPORT_FORMATS, checkContent, type ReportFormat } from '#lib/report.ts';
import type { ReplyArgs } from './answer.ts';
import type { Config } from './config.ts';
import type { DismissArgs } from './dismiss.ts';
import {
	createRunner,
	PrivateerCommandError,
	PrivateerExecError,
	privateerArgv,
	type ExecFile,
	type Runner
} from './privateer.ts';

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
	/** The fleet across machines (`fleet.snapshot`), read-only. */
	snapshot(): Promise<FleetRead>;
	/** Each route's configuration and try order (`routes.show`), read-only. */
	routesShow(): Promise<Read<RoutesConfig>>;
	/** Token totals across the fleet for a period (`usage.summary`), read-only. */
	usage(query: UsageQuery): Promise<Read<UsageSummary>>;
	/** A report held by id, from whichever home has it (`report.get`). */
	report(id: string): Promise<FetchedReport>;
	/** The captain's feed, merged across homes and machines (`captain.feed`), read-only. */
	feed(query: FeedQuery): Promise<Read<FeedPage>>;
	/** One ship's profile (`ship.profile`), read-only: its tools, routes, permissions and hosting. */
	shipProfile(ship: string): Promise<ShipRead>;
}

export interface FetchedReport {
	format: ReportFormat;
	content: string;
}

/**
 * Read `report.get`: `{id, ship, title, format, bytes, created_ms, content}` at
 * the top level, as Privateer returns it. The format must be markdown or html,
 * and the content a string within the limit.
 */
export function parseFetched(result: unknown, id: string): FetchedReport {
	const body = rec(result);
	const format = body?.format;
	if (!REPORT_FORMATS.includes(format as ReportFormat)) {
		throw new Error(`report ${id} came back without a markdown or html format`);
	}
	const content = checkContent(body?.content);
	if (!content.ok) throw new Error(`report ${id}: ${content.error}`);
	return { format: format as ReportFormat, content: content.value };
}

/**
 * Privateer's answer when no fleet home on this machine holds the report. A
 * report stored on another machine is not reached yet, so it reads the same.
 */
const NOT_HELD_HERE = /^no report \S+ in the fleet$/;

/** True when `report.get` said the report is not held on this machine. */
export function notHeldHere(error: unknown): boolean {
	return (
		error instanceof PrivateerCommandError &&
		typeof error.error === 'string' &&
		NOT_HELD_HERE.test(error.error)
	);
}

function rec(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** The feed's own order: by cursor, which is arrival order, not creation time. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC midnight a time falls after: the day the usage chart's buckets are keyed by. */
function dayStart(time: number): number {
	return Math.floor(time / DAY_MS) * DAY_MS;
}

/** A fixture cursor's place in arrival order, read from its `f1.<n>` form. */
function ordinalOf(cursor: string | null): number {
	return Number(cursor?.replace(/^f1\./, '') ?? 0);
}

function byCursor(a: FeedEntry, b: FeedEntry): number {
	return ordinalOf(a.cursor) - ordinalOf(b.cursor);
}

/**
 * `unsupported` means this Privateer does not offer `fleet.snapshot` yet, which
 * is a state to show calmly, not an error.
 */
export type FleetRead = { status: 'ok'; snapshot: FleetSnapshot } | { status: 'unsupported' };

/** A read that an older Privateer may not offer, the same way as FleetRead. */
export type Read<T> = { status: 'ok'; value: T } | { status: 'unsupported' };

/**
 * A ship's profile: as Read, not_found when no ship has that name, and elsewhere
 * when the ship runs on another machine, whose Privateer is the one to ask.
 */
export type ShipRead =
	Read<ShipProfile> | { status: 'not_found' } | { status: 'elsewhere'; machine: string };

/** Privateer's words for a ship it does not know, on stderr or in its JSON error. */
const UNKNOWN_SHIP = /not found|unknown ship|no such ship|no ship named/i;

/** Privateer's refusal for a ship on another machine: "ship X is on machine M; ask there". */
const OTHER_MACHINE = /ship \S+ is on machine ([^;"\s]+); ask there/;

/** The machine a refusal names, or null when the message is not that refusal. */
export function machineOf(message: string): string | null {
	return OTHER_MACHINE.exec(message)?.[1] ?? null;
}

/**
 * An older Privateer refuses a command it does not know. Its CLI says so on
 * stderr (clap: "unrecognized subcommand") or as a JSON error. Anything else is
 * a real failure and is rethrown.
 */
const UNKNOWN_COMMAND = /unknown (sub)?command|unrecognized subcommand|no such command/i;

export function isUnknownCommand(error: unknown): boolean {
	if (error instanceof PrivateerCommandError) return UNKNOWN_COMMAND.test(error.message);
	if (error instanceof PrivateerExecError) {
		return UNKNOWN_COMMAND.test(`${error.message}\n${error.stderr}`);
	}
	return false;
}

export class CliSource implements Source {
	readonly mode = 'cli' as const;
	readonly #run: Runner;
	/** The last fleet read, which a `since` read joins onto. */
	#fleet: FleetSnapshot | null = null;

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

	async report(id: string): Promise<FetchedReport> {
		return parseFetched(await this.#run('report.get', { id }), id);
	}

	async snapshot(): Promise<FleetRead> {
		try {
			const held = this.#fleet;
			const since = sinceOf(held);
			let snapshot = since ? await this.#fleetSince(since, held) : null;
			// Any doubt about a partial read reads in full.
			snapshot ??= parseSnapshot(await this.#run('fleet.snapshot', {}));
			this.#fleet = keepTruncated(held, snapshot);
			return { status: 'ok', snapshot: this.#fleet };
		} catch (error) {
			if (isUnknownCommand(error)) return { status: 'unsupported' };
			throw error;
		}
	}

	/** A read with `since`, joined onto the held snapshot; null when the answer cannot be joined. */
	async #fleetSince(since: SinceToken, held: FleetSnapshot | null): Promise<FleetSnapshot | null> {
		const raw = await this.#run('fleet.snapshot', { since });
		if (!Array.isArray(rec(raw)?.machines)) return null;
		return mergeSnapshot(held, parseSnapshot(raw));
	}

	async routesShow(): Promise<Read<RoutesConfig>> {
		try {
			return { status: 'ok', value: parseRoutesShow(await this.#run('routes.show', {})) };
		} catch (error) {
			if (isUnknownCommand(error)) return { status: 'unsupported' };
			throw error;
		}
	}

	async usage(query: UsageQuery): Promise<Read<UsageSummary>> {
		try {
			return {
				status: 'ok',
				value: parseUsageSummary(await this.#run('usage.summary', { ...query }))
			};
		} catch (error) {
			if (isUnknownCommand(error)) return { status: 'unsupported' };
			throw error;
		}
	}

	async feed(query: FeedQuery): Promise<Read<FeedPage>> {
		try {
			return { status: 'ok', value: parseFeed(await this.#run('captain.feed', { ...query })) };
		} catch (error) {
			if (isUnknownCommand(error)) return { status: 'unsupported' };
			throw error;
		}
	}

	async shipProfile(ship: string): Promise<ShipRead> {
		try {
			const result = await this.#run('ship.profile', { ship });
			return { status: 'ok', value: parseShipProfile(result, ship) };
		} catch (error) {
			if (isUnknownCommand(error)) return { status: 'unsupported' };
			if (error instanceof PrivateerCommandError) {
				const machine = machineOf(error.message);
				if (machine !== null) return { status: 'elsewhere', machine };
				if (UNKNOWN_SHIP.test(error.message)) return { status: 'not_found' };
			}
			throw error;
		}
	}
}

/** Fixture files, named after the command whose output they stand in for. */
export const FIXTURE_FILES = ['captain.waiting.json', 'runtime.needs.json'] as const;
/** Reports held by id, keyed by report_id: `{ "reports": { "<id>": { format, content } } }`. */
export const REPORT_FIXTURE = 'report.get.json';
export const FLEET_FIXTURE = 'fleet-snapshot.json';
export const ROUTES_FIXTURE = 'routes-show.json';
export const USAGE_FIXTURE = 'usage-records.json';
export const FEED_FIXTURE = 'captain.feed.json';
/** Ship profiles by name: `{ "ships": { "<name>": { ...profile } } }`. */
export const SHIP_PROFILE_FIXTURE = 'ship-profile.json';

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
			const isTime =
				(key.endsWith('_ms') || key === 'resets_at') &&
				!DERIVED_KEYS.has(key) &&
				key !== 'fixture_now_ms';
			out[key] = isTime && typeof child === 'number' ? child + delta : shift(child);
		}
		return out;
	};
	return shift(value);
}

/**
 * The entries before a bound: the ones written before a time, or the ones ahead
 * of a cursor. An unknown cursor reads as the start of the feed, as a stale one would.
 */
function beforeBound(visible: readonly FeedEntry[], bound: FeedBound): FeedEntry[] {
	if (typeof bound === 'number') return visible.filter((e) => (e.created_ms ?? 0) < bound);
	const at = visible.findIndex((e) => e.cursor === bound);
	return at < 0 ? [] : visible.slice(0, at);
}

/**
 * The entries after a bound: the ones written after a time, or the ones behind a
 * cursor. An unknown cursor reads as the start of the feed, as a stale one would.
 */
function afterBound(visible: readonly FeedEntry[], bound: FeedBound): FeedEntry[] {
	if (typeof bound === 'number') return visible.filter((e) => (e.created_ms ?? 0) > bound);
	const at = visible.findIndex((e) => e.cursor === bound);
	return at < 0 ? [...visible] : visible.slice(at + 1);
}

export class FixtureSource implements Source {
	readonly mode = 'fixtures' as const;
	readonly #dir: string;
	readonly #now: () => number;
	/** When this process first read the feed; see feed(). */
	#feedBase: number | undefined;
	/** When this process first read the fleet, which pins its times as feed() pins its own. */
	#fleetBase: number | undefined;
	/** The last fleet read, which a `since` read joins onto, as CliSource's does. */
	#fleet: FleetSnapshot | null = null;
	/** When each held feed message first arrived; see feed(). */
	readonly #arrivals = new Map<string, number>();
	/**
	 * The cursor Privateer would have given each message, in the order they arrived.
	 * Shaped as Privateer's are (`f1.` and a number), never all digits, so a cursor
	 * is never mistaken for a time.
	 */
	readonly #cursors = new Map<string, string>();

	constructor(dir: string, now: () => number = Date.now) {
		this.#dir = dir;
		this.#now = now;
	}

	/**
	 * One message's place in the feed, given when it arrives, so a cursor never
	 * moves once it has been handed out. A message collected late from another
	 * machine keeps the cursor its fixture gives it, older than the newest, and its
	 * own older `created_ms`: paging is done on cursors and not times, and a forward
	 * poll from the newest cursor never sees it.
	 */
	#cursorFor(key: string): string {
		const held = this.#cursors.get(key);
		if (held !== undefined) return held;
		const cursor = `f1.${this.#cursors.size + 1}`;
		this.#cursors.set(key, cursor);
		return cursor;
	}

	/**
	 * One fixture file as parsed JSON, or null when it is absent. `byDay` shifts it
	 * by whole days, so its midnight lands on the midnight `now` falls in: each
	 * record keeps its time of day, and the days it falls on do not move with the hour.
	 */
	async #read(file: string, now: number = this.#now(), byDay = false): Promise<unknown> {
		let text: string;
		try {
			text = await readFile(path.resolve(this.#dir, file), 'utf8');
		} catch (error) {
			if ((error as { code?: string }).code === 'ENOENT') return null;
			throw error;
		}
		const json = JSON.parse(text) as { fixture_now_ms?: unknown };
		if (typeof json.fixture_now_ms !== 'number') return json;
		const fixtureNow = json.fixture_now_ms;
		const target = byDay ? fixtureNow + dayStart(now) - dayStart(fixtureNow) : now;
		return rebaseFixture(json, fixtureNow, target);
	}

	async waiting(): Promise<Waiting> {
		const [captain, needs] = await Promise.all(FIXTURE_FILES.map((file) => this.#read(file)));
		return assemble(captain, needs, this.#now());
	}

	write(): Promise<unknown> {
		return Promise.reject(new Error('FixtureSource never writes to privateer'));
	}

	async report(id: string): Promise<FetchedReport> {
		const raw = rec(await this.#read(REPORT_FIXTURE));
		const held = rec(raw?.reports)?.[id];
		// What report.get says for a report no home on this machine holds.
		if (!held) throw new PrivateerCommandError('report.get', `no report ${id} in the fleet`);
		return parseFetched(held, id);
	}

	/**
	 * The fleet fixture, answered as a `since` read when one is held: an unchanged
	 * machine keeps what was held, as it does from Privateer. The times are pinned to
	 * the first read, so a machine's changed_ms holds from one read to the next.
	 */
	async snapshot(): Promise<FleetRead> {
		this.#fleetBase ??= this.#now();
		const raw = await this.#read(FLEET_FIXTURE, this.#fleetBase);
		if (raw === null) return { status: 'unsupported' };
		const held = this.#fleet;
		const since = sinceOf(held);
		const joined =
			since && held ? mergeSnapshot(held, parseSnapshot(sinceFixture(raw, since))) : null;
		this.#fleet = keepTruncated(held, joined ?? parseSnapshot(raw));
		return { status: 'ok', snapshot: this.#fleet };
	}

	async routesShow(): Promise<Read<RoutesConfig>> {
		const raw = await this.#read(ROUTES_FIXTURE);
		return raw === null ? { status: 'unsupported' } : { status: 'ok', value: parseRoutesShow(raw) };
	}

	/**
	 * The feed as captain.feed answers it: oldest first, one page at a time. `before`
	 * ends the page just before a cursor, or just before a time in milliseconds
	 * (the newest page is `before` one millisecond past now). `after` reads forward
	 * from a cursor, up to `limit`. The text "now" is not a bound, as Privateer
	 * refuses it. `next` is direction-dependent, as Privateer's is: a backward page
	 * gives a `before` cursor (its oldest entry) while there are older entries, and
	 * a forward page gives the cursor to read on from, null once nothing is newer.
	 *
	 * The fixture's times are pinned to the moment this process first reads the
	 * feed, so a poll sees only what is really new. An entry with `arrives_in_s`
	 * is held back until that many seconds after then, so the live feed can be
	 * seen to bring a message in. An entry marked `desk_copy` is a copy collected
	 * late from another machine: it keeps its own older `created_ms` and the cursor
	 * its fixture gives it, older than the newest, so a forward poll from the newest
	 * cursor does not see it, and only an open refresh over the whole history does.
	 */
	async feed(query: FeedQuery): Promise<Read<FeedPage>> {
		if (query.before === 'now') throw new Error('now is not a feed cursor');
		this.#feedBase ??= this.#now();
		const elapsed = this.#now() - this.#feedBase;
		const raw = await this.#read(FEED_FIXTURE, this.#feedBase);
		if (raw === null) return { status: 'unsupported' };
		const held = rec(raw)?.entries;
		const arrived: FeedEntry[] = [];
		for (const e of Array.isArray(held) ? held : []) {
			const entry = rec(e);
			if (!entry) continue;
			const delay = entry.arrives_in_s;
			if (typeof delay === 'number' && delay * 1000 > elapsed) continue;
			const id = String(entry.id);
			const key = `${entry.from}\u0000${id}`;
			const deskCopy = entry.desk_copy === true;
			let created = entry.created_ms;
			if (typeof delay === 'number' && !deskCopy) {
				// A held message is stamped when it first arrives, so it is newer than anything before it.
				if (!this.#arrivals.has(id)) this.#arrivals.set(id, this.#now());
				created = this.#arrivals.get(id);
			}
			// A desk copy keeps the cursor its fixture gives it; every other message takes its arrival place.
			const cursor =
				deskCopy && typeof entry.cursor === 'string' ? entry.cursor : this.#cursorFor(key);
			arrived.push(...parseFeed({ entries: [{ ...entry, created_ms: created, cursor }] }).entries);
		}
		const visible = arrived
			.filter((e) => query.include_ship_mail || !isShipToShip(e))
			.filter(
				(e) =>
					query.ship === undefined ||
					e.ship === query.ship ||
					e.from === query.ship ||
					e.to === query.ship
			)
			.filter((e) => !query.open_only || e.state === 'open')
			.filter((e) => !query.states || (e.state !== null && query.states.includes(e.state)))
			.sort(byCursor);
		const { limit } = query;

		if (query.after !== undefined) {
			// The oldest `limit` entries after the bound, so a forward read pages up from it.
			const rest = afterBound(visible, query.after);
			const page = rest.slice(0, limit);
			return {
				status: 'ok',
				value: {
					entries: page,
					more: rest.length > page.length,
					next: forwardCursorOf(page),
					first: firstCursorOf(page)
				}
			};
		}

		// The newest `limit` entries before the bound: the newest page when there is none.
		const older = query.before === undefined ? visible : beforeBound(visible, query.before);
		const page = older.slice(Math.max(0, older.length - limit));
		const more = older.length > page.length;
		return {
			status: 'ok',
			value: {
				entries: page,
				more,
				next: more ? firstCursorOf(page) : null,
				first: firstCursorOf(page)
			}
		};
	}

	async shipProfile(ship: string): Promise<ShipRead> {
		const raw = await this.#read(SHIP_PROFILE_FIXTURE);
		if (raw === null) return { status: 'unsupported' };
		const ships = rec(rec(raw)?.ships) ?? {};
		if (!Object.hasOwn(ships, ship)) return { status: 'not_found' };
		// A ship on another machine is refused, as Privateer refuses it: its message stands for the answer.
		const refusal = rec(ships[ship])?.refused;
		if (typeof refusal === 'string') {
			const machine = machineOf(refusal);
			if (machine !== null) return { status: 'elsewhere', machine };
		}
		return { status: 'ok', value: parseShipProfile(ships[ship], ship) };
	}

	/** Records are grouped here, the way usage.summary would group them live. */
	async usage(query: UsageQuery): Promise<Read<UsageSummary>> {
		const raw = await this.#read(USAGE_FIXTURE, this.#now(), true);
		if (raw === null) return { status: 'unsupported' };
		return { status: 'ok', value: summarizeRecords(parseUsageRecords(raw), query) };
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
