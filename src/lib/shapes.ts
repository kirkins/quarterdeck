/**
 * Reads the two captain queries exactly as Privateer returns them, and
 * normalises both into MailItem, so the Decisions and Triage pages share one
 * item model. Shared by server and browser code, so no Node APIs here.
 *
 * Source of truth (privateer: src/captain.rs `waiting`, src/needs.rs `query`):
 *
 *   captain.waiting -> { now_ms, hands_on: [Entry], waiting: [Entry] }
 *     Entry = { ship, asked_ms, age_ms, step: string | null, mail: MailRecord }
 *     MailRecord is a mail row: id, from, to, kind (request | decision),
 *     request_kind, task_id, body, payload, urgency, deadline_ms, created_ms, ...
 *
 *   runtime.needs -> { schema_version, available, origin, observed_ms, items,
 *                      next_after, unknown, reason? }
 *     Need = { id, source: mail | job | schedule | workspace, source_id,
 *              kind: decision | approval | blocker, ship, task_id, question,
 *              choices, correlation, created_ms, actions, artifact,
 *              environment, evidence, status, summary }
 *     `correlation` is the mail id for mail needs. Newer Privateer also sends
 *     urgency, deadline_ms, asked_ms and mail_id on any need, and a mail need's
 *     `kind` may be a mail kind (request | notice | report) rather than a need
 *     kind. Older Privateer omits these, so every one is optional here, and
 *     captain.waiting still supplies them when it lists the same ask.
 */
import type { MailItem } from '#lib/decision.ts';

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Rec)
		: null;
}

function str(value: unknown): string | null {
	return typeof value === 'string' && value !== '' ? value : null;
}

function num(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function urgencyOf(value: unknown): string {
	return value === 'high' || value === 'low' ? value : 'normal';
}

/** A mail need's mail kind: its own `kind` when that is a mail kind, else decision or approval. */
function mailKindOf(need: Rec): string {
	// Privateer names a mail need's message kind in mail_kind (request or decision);
	// its kind field means approval, decision or blocker. Older Privateer sent only kind.
	const mailKind = str(need.mail_kind);
	if (mailKind === 'request' || mailKind === 'decision') return mailKind;
	const kind = str(need.kind);
	if (kind === 'request' || kind === 'notice' || kind === 'report') return kind;
	return kind === 'approval' ? 'approval' : 'decision';
}

/** A needs_hands mark as its step: {step}, a bare string, or true with no step. */
function handsStep(value: unknown): string | null {
	if (typeof value === 'string') return str(value);
	const step = str(rec(value)?.step);
	if (step) return step;
	return value === true || rec(value) ? 'Needs your hands; see the message.' : null;
}

function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function strings(value: unknown): string[] {
	return list(value).filter((v): v is string => typeof v === 'string' && v !== '');
}

/** What the captain sees for each blocker evidence, when Privateer gives no summary. */
const BLOCKER_SUMMARY: Record<string, string> = {
	orphaned_job: 'A job lost its worker. Recover or cancel it in Privateer.',
	capacity_wait: 'A job is waiting for capacity.',
	stuck_heavy_capacity: 'A heavy job is stuck behind capacity no live process holds.',
	disk_floor_wait: 'A job is waiting for disk space.',
	scheduling_fault: 'A scheduled task is in a fault state.',
	workspace_disk_wait: 'A workspace is waiting for disk space.'
};

/** The result of reading runtime.needs. `unavailable` says why it could not be read. */
export interface Waiting {
	items: MailItem[];
	unavailable: string | null;
}

/** Asks from captain.waiting, one MailItem per mail record. */
export function parseCaptainWaiting(result: unknown, now: number): MailItem[] {
	const items: MailItem[] = [];
	for (const raw of list(rec(result)?.waiting)) {
		const entry = rec(raw);
		const mail = rec(entry?.mail);
		const id = str(mail?.id);
		if (!entry || !mail || !id) continue;
		const asked = num(entry.asked_ms) ?? num(mail.created_ms) ?? now;
		items.push({
			...mail,
			id,
			from: str(mail.from) ?? str(entry.ship) ?? '',
			to: str(mail.to) ?? 'captain',
			kind: str(mail.kind) ?? 'request',
			body: str(mail.body),
			payload: rec(mail.payload) ?? {},
			urgency: str(mail.urgency) ?? 'normal',
			deadline_ms: num(mail.deadline_ms),
			asked_ms: asked,
			age_ms: Math.max(0, now - asked),
			hands_on: str(entry.step)
		});
	}
	return items;
}

/** Items from runtime.needs. Mail needs take the mail id as their id. */
export function parseRuntimeNeeds(result: unknown, now: number): Waiting {
	const root = rec(result);
	if (!root || root.available !== true) {
		return { items: [], unavailable: str(root?.reason) ?? 'runtime.needs is unavailable' };
	}
	const items: MailItem[] = [];
	for (const raw of list(root.items)) {
		const need = rec(raw);
		const needId = str(need?.id);
		if (!need || !needId) continue;
		const ship = str(need.ship) ?? '';

		// Timing is optional on every need (see the header); older Privateer sends none.
		const asked = num(need.asked_ms) ?? num(need.created_ms) ?? now;
		const timing = {
			urgency: urgencyOf(need.urgency),
			deadline_ms: num(need.deadline_ms),
			asked_ms: asked,
			age_ms: Math.max(0, now - asked)
		};

		if (need.source === 'mail') {
			const id = str(need.mail_id) ?? str(need.correlation) ?? str(need.source_id);
			if (!id) continue;
			const kind = mailKindOf(need);
			items.push({
				id,
				from: ship,
				to: 'captain',
				kind,
				body: str(need.question),
				// Decisions carry their choices; approvals carry what is being granted.
				payload:
					kind === 'approval'
						? { artifact: str(need.artifact), environment: str(need.environment) }
						: kind === 'decision'
							? { choices: strings(need.choices) }
							: {},
				task_id: str(need.task_id),
				correlation: id,
				state: 'open',
				...timing,
				hands_on: handsStep(need.needs_hands),
				actions: strings(need.actions)
			});
		} else if (need.source === 'job' || need.source === 'schedule' || need.source === 'workspace') {
			const evidence = str(need.evidence) ?? '';
			items.push({
				id: needId,
				from: ship,
				to: 'captain',
				kind: 'blocker',
				body: str(need.summary) ?? BLOCKER_SUMMARY[evidence] ?? 'Blocked.',
				evidence,
				status: str(need.status),
				task_id: str(need.task_id),
				state: 'open',
				...timing,
				hands_on: null,
				actions: []
			});
		}
	}
	return { items, unavailable: null };
}

/**
 * One list of everything owed to the captain. A mail item both queries report
 * is merged, with captain.waiting's record winning (it has the mail kind,
 * payload, urgency and deadline). Ships choose their own mail ids, so the key
 * is the sender plus the id.
 */
export function assemble(captainWaiting: unknown, runtimeNeeds: unknown, now: number): Waiting {
	const needs = parseRuntimeNeeds(runtimeNeeds, now);
	const byKey = new Map<string, MailItem>();
	const keyOf = (item: MailItem) => `${item.from}\u0000${item.id}`;
	for (const item of needs.items) byKey.set(keyOf(item), item);
	for (const item of parseCaptainWaiting(captainWaiting, now)) {
		const key = keyOf(item);
		byKey.set(key, { ...byKey.get(key), ...item });
	}
	return { items: [...byKey.values()], unavailable: needs.unavailable };
}

/*
 * The fleet map. Privateer's `fleet.snapshot {since?}` (operator-only, read-only)
 * returns every machine, ship, route and need in one JSON. Its shape is the one
 * privateer PR 241 describes. Every field is optional and extra fields are
 * ignored, so a richer snapshot still parses and a poorer one renders with gaps.
 * Parse it here alone.
 */

/** Presence values Privateer reports. Anything else reads as `unknown`, which is not an all-clear. */
export const PRESENCES = [
	'hosted',
	'asleep',
	'session',
	'absent',
	'unavailable',
	'unknown'
] as const;
export type Presence = (typeof PRESENCES)[number];

export interface FleetTask {
	id: string;
	title: string | null;
	status: string | null;
	handoff_to: string | null;
}

/** Why a job is not moving. `for` is capacity, disk, or job (behind a parked crew). */
export interface FleetWait {
	for: string | null;
	since_ms: number | null;
	job_id: string | null;
	park: string | null;
	behind: { job_id: string | null; ship: string | null; unhealthy: boolean }[];
}

/** A live job: starting, queued, launching, running, parked or orphaned, as `state` says. */
export interface FleetJob {
	id: string;
	task_id: string | null;
	task_title: string | null;
	kind: string | null;
	state: string | null;
	heavy: boolean;
	created_ms: number | null;
	spawned_ms: number | null;
	started_ms: number | null;
	model_route: string | null;
	/** The last crew.report line, or null when the crew has not reported. */
	doing: { text: string; at_ms: number | null; report_id: string | null } | null;
	wait: FleetWait | null;
}

export interface FleetShip {
	name: string;
	machine: string | null;
	liaison: string | null;
	harness: string | null;
	hosted: boolean;
	presence: Presence;
	presence_since_ms: number | null;
	unread: number;
	open_requests: number;
	/** At most 20, as Privateer sends them. */
	open_tasks: FleetTask[];
	open_tasks_total: number;
	/** At most 20, newest first. */
	jobs: FleetJob[];
	jobs_total: number;
}

/** Allowance numbers are as Privateer reports them, with no unit it names. */
export interface FleetAllowance {
	shape: string | null;
	window_ends_ms: number | null;
	weekly_ends_ms: number | null;
	window_used: number | null;
	week_used: number | null;
	last_used_ms: number | null;
}

/**
 * A model route on one machine. `state` is available, idle (usable), backing_off or
 * capped; `until_ms` is when a backoff or a cap clears. `error` is the classified
 * error bearings show, never the command's text.
 */
export interface FleetRoute {
	name: string;
	route: string | null;
	cost: string | null;
	tier: string | null;
	state: string | null;
	until_ms: number | null;
	error: string | null;
	allowance: FleetAllowance | null;
}

export interface FleetMachine {
	name: string;
	/** here, reaches, or reached_by: how this machine relates to the one reading. */
	link: string | null;
	reachable: boolean;
	error: string | null;
	via: string | null;
	/** When an unreachable machine was last read; its ships and routes are as of then. */
	as_of_ms: number | null;
	/** When this machine's own section last changed. */
	changed_ms: number | null;
	/** True when this read did not resend the machine's ships and routes. */
	unchanged: boolean;
	truncated: boolean;
	/** Things Privateer could not check, e.g. `answered:<ship>`. */
	unknown: string[];
	routes: FleetRoute[];
	ships: FleetShip[];
}

/** An item needing the captain: runtime.needs with the machine it came from. */
export interface FleetNeed {
	id: string;
	ship: string;
	machine: string | null;
	kind: string | null;
	source: string | null;
	question: string | null;
	/** Set for mail-sourced needs; null for blockers. */
	mail_id: string | null;
	/** Set for a cached need from an unreachable machine; null when live. */
	as_of_ms: number | null;
	actions: string[];
}

export interface FleetSnapshot {
	schema_version: number | null;
	generated_ms: number | null;
	machines: FleetMachine[];
	needs: FleetNeed[];
}

/** The `since` argument: each machine's changed_ms, compared for equality by Privateer. */
export type SinceToken = Record<string, number>;

/** The token for the next read, or null when no machine has a change time to send. */
export function sinceOf(snapshot: FleetSnapshot | null): SinceToken | null {
	if (!snapshot) return null;
	const token: SinceToken = {};
	for (const machine of snapshot.machines) {
		if (machine.changed_ms !== null) token[machine.name] = machine.changed_ms;
	}
	return Object.keys(token).length > 0 ? token : null;
}

/**
 * Joins a read made with `since` onto the snapshot held before it. An unchanged
 * machine comes back with no ships or routes, so its held ones stand; its other
 * fields are the new read's. Needs always come back in full, so they are the new
 * read's. Returns null when an unchanged machine has nothing held to stand on,
 * and the caller reads in full instead.
 */
export function mergeSnapshot(
	held: FleetSnapshot | null,
	next: FleetSnapshot
): FleetSnapshot | null {
	const machines: FleetMachine[] = [];
	for (const machine of next.machines) {
		if (!machine.unchanged) {
			machines.push(machine);
			continue;
		}
		const before = held?.machines.find((m) => m.name === machine.name);
		if (!before) return null;
		machines.push({ ...machine, ships: before.ships, routes: before.routes });
	}
	return { ...next, machines };
}

/** Read `fleet.snapshot` tolerantly: missing fields become null, empty or zero; extras are ignored. */
export function parseSnapshot(result: unknown): FleetSnapshot {
	const root = rec(result);
	const ships = list(root?.ships).flatMap((raw) => {
		const ship = rec(raw);
		const name = str(ship?.name);
		return ship && name ? [parseShip(name, ship)] : [];
	});
	return {
		schema_version: num(root?.schema_version),
		generated_ms: num(root?.generated_ms),
		machines: list(root?.machines).flatMap((raw) => {
			const machine = rec(raw);
			const name = str(machine?.name);
			return machine && name ? [parseMachine(name, machine, ships)] : [];
		}),
		needs: list(root?.needs).flatMap((raw) => {
			const need = rec(raw);
			const id = str(need?.id);
			return need && id ? [parseNeed(id, need)] : [];
		})
	};
}

function presenceOf(value: unknown): Presence {
	return (PRESENCES as readonly unknown[]).includes(value) ? (value as Presence) : 'unknown';
}

function parseMachine(name: string, machine: Rec, ships: FleetShip[]): FleetMachine {
	return {
		name,
		link: str(machine.link),
		reachable: machine.reachable === true,
		error: str(machine.error),
		via: str(machine.via),
		as_of_ms: num(machine.as_of_ms),
		changed_ms: num(machine.changed_ms),
		unchanged: machine.unchanged === true,
		truncated: machine.truncated === true,
		unknown: strings(machine.unknown),
		routes: list(machine.routes).flatMap((raw) => {
			const route = rec(raw);
			const routeName = str(route?.name);
			return route && routeName ? [parseRoute(routeName, route)] : [];
		}),
		ships: ships.filter((ship) => ship.machine === name)
	};
}

function parseShip(name: string, ship: Rec): FleetShip {
	return {
		name,
		machine: str(ship.machine),
		liaison: str(ship.liaison),
		harness: str(ship.harness),
		hosted: ship.hosted === true,
		presence: presenceOf(ship.presence),
		presence_since_ms: num(ship.presence_since_ms),
		unread: num(ship.unread) ?? 0,
		open_requests: num(ship.open_requests) ?? 0,
		open_tasks: list(ship.open_tasks).flatMap((raw) => {
			const task = rec(raw);
			const id = str(task?.id);
			return task && id
				? [
						{
							id,
							title: str(task.title),
							status: str(task.status),
							handoff_to: str(task.handoff_to)
						}
					]
				: [];
		}),
		open_tasks_total: num(ship.open_tasks_total) ?? 0,
		jobs: list(ship.jobs).flatMap((raw) => {
			const job = rec(raw);
			const id = str(job?.id);
			return job && id ? [parseJob(id, job)] : [];
		}),
		jobs_total: num(ship.jobs_total) ?? 0
	};
}

function parseJob(id: string, job: Rec): FleetJob {
	const doing = rec(job.doing);
	const wait = rec(job.wait);
	return {
		id,
		task_id: str(job.task_id),
		task_title: str(job.task_title),
		kind: str(job.kind),
		state: str(job.state),
		heavy: job.heavy === true,
		created_ms: num(job.created_ms),
		spawned_ms: num(job.spawned_ms),
		started_ms: num(job.started_ms),
		model_route: str(job.model_route),
		doing:
			doing && str(doing.text)
				? {
						text: str(doing.text) as string,
						at_ms: num(doing.at_ms),
						report_id: str(doing.report_id)
					}
				: null,
		wait: wait
			? {
					for: str(wait.for),
					since_ms: num(wait.since_ms),
					job_id: str(wait.job_id),
					park: str(wait.park),
					behind: list(wait.behind).flatMap((raw) => {
						const b = rec(raw);
						return b
							? [{ job_id: str(b.job_id), ship: str(b.ship), unhealthy: b.unhealthy === true }]
							: [];
					})
				}
			: null
	};
}

function parseRoute(name: string, route: Rec): FleetRoute {
	const allowance = rec(route.allowance);
	return {
		name,
		route: str(route.route),
		cost: str(route.cost),
		tier: str(route.tier),
		state: str(route.state),
		until_ms: num(route.until_ms),
		error: str(route.error),
		allowance: allowance
			? {
					shape: str(allowance.shape),
					window_ends_ms: num(allowance.window_ends_ms),
					weekly_ends_ms: num(allowance.weekly_ends_ms),
					window_used: num(allowance.window_used),
					week_used: num(allowance.week_used),
					last_used_ms: num(allowance.last_used_ms)
				}
			: null
	};
}

function parseNeed(id: string, need: Rec): FleetNeed {
	return {
		id,
		ship: str(need.ship) ?? '',
		machine: str(need.machine),
		kind: str(need.kind),
		source: str(need.source),
		question: str(need.question),
		mail_id: str(need.mail_id),
		as_of_ms: num(need.as_of_ms),
		actions: strings(need.actions)
	};
}

/*
 * The spend view (PROVISIONAL). Privateer's `routes.show` (config: cost, note,
 * the order each list tries routes in) and `usage.summary` (token totals,
 * fleet-wide) are not final. Like the fleet map, every field is optional and
 * extras are ignored. Adjust these parsers alone; see docs/DECISIONS.md section 14.
 */

/** A route's configuration, as `routes.show` gives it. Its live state is on the fleet snapshot. */
export interface RouteConfig {
	name: string;
	cost: string | null;
	note: string | null;
	options: string[];
	manifest: string | null;
	allowance_resets_utc: string | null;
}

export interface RoutesConfig {
	routes: RouteConfig[];
	/** Route names in the order each list tries them, e.g. crew, errand, first_mate. */
	order: Record<string, string[]>;
}

/** Read `routes.show`: a `routes` object keyed by name, and order lists under `order` or at the top. */
export function parseRoutesShow(result: unknown): RoutesConfig {
	const root = rec(result);
	const routes = rec(root?.routes) ?? {};
	const order = rec(root?.order) ?? root ?? {};
	return {
		routes: Object.entries(routes).flatMap(([name, value]) => {
			const route = rec(value);
			return route && name
				? [
						{
							name,
							cost: str(route.cost),
							note: str(route.note),
							options: strings(route.options),
							manifest: str(route.manifest),
							allowance_resets_utc: str(route.allowance_resets_utc)
						}
					]
				: [];
		}),
		order: {
			crew: strings(order.crew),
			errand: strings(order.errand),
			first_mate: strings(order.first_mate)
		}
	};
}

/** Tokens for one slice of usage. A field is null where the harness reports nothing for it. */
export interface UsageTotals {
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	/** input + output + cacheRead + cacheWrite, as reported; null when nothing is reported. */
	totalTokens: number | null;
}

export interface UsageGroup {
	key: string;
	jobs: number | null;
	/** null when no harness in this group reports usage at all. */
	usage: UsageTotals | null;
	/** Harnesses in this group that report no usage. */
	gaps: string[];
}

export interface UsageSummary {
	since_ms: number | null;
	until_ms: number | null;
	group_by: string;
	groups: UsageGroup[];
}

/** A usage object's totals; totalTokens is derived when Privateer does not send it. */
export function parseUsageTotals(value: unknown): UsageTotals | null {
	const usage = rec(value);
	if (!usage) return null;
	const input = num(usage.input);
	const output = num(usage.output);
	const cacheRead = num(usage.cacheRead);
	const cacheWrite = num(usage.cacheWrite);
	const parts = [input, output, cacheRead, cacheWrite].filter((n): n is number => n !== null);
	const reported = num(usage.totalTokens);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: reported ?? (parts.length > 0 ? parts.reduce((a, b) => a + b, 0) : null)
	};
}

/** Read `usage.summary`. Each group carries its totals, its job count and its gaps. */
export function parseUsageSummary(result: unknown): UsageSummary {
	const root = rec(result);
	return {
		since_ms: num(root?.since_ms),
		until_ms: num(root?.until_ms),
		group_by: str(root?.group_by) ?? '',
		groups: list(root?.groups).flatMap((raw) => {
			const group = rec(raw);
			const key = str(group?.key);
			return group && key
				? [
						{
							key,
							jobs: num(group.jobs),
							usage: parseUsageTotals(group.usage),
							gaps: strings(group.gaps)
						}
					]
				: [];
		})
	};
}

/**
 * One usage record, as the fixtures hold it: a job's tokens at a moment, with
 * the machine, ship and route it ran on. `usage` is null where the harness
 * reports nothing.
 */
export interface UsageRecord {
	ts_ms: number;
	machine: string;
	ship: string;
	route: string;
	harness: string;
	jobs: number;
	usage: UsageTotals | null;
}

export function parseUsageRecords(result: unknown): UsageRecord[] {
	return list(rec(result)?.records).flatMap((raw) => {
		const record = rec(raw);
		const ts = num(record?.ts_ms);
		const machine = str(record?.machine);
		const ship = str(record?.ship);
		const route = str(record?.route);
		const harness = str(record?.harness);
		return record && ts !== null && machine && ship && route && harness
			? [
					{
						ts_ms: ts,
						machine,
						ship,
						route,
						harness,
						jobs: num(record.jobs) ?? 0,
						usage: parseUsageTotals(record.usage)
					}
				]
			: [];
	});
}

/*
 * The captain's feed. Privateer's `captain.feed` is built (its PR 232): one
 * stream of every message to and from the captain, across ships, collected by
 * each ship's desk home. The command takes
 *
 *   captain.feed {after?, before?, limit?, ship?, include_ship_mail?, states?, open_only?}
 *
 * and answers `{ entries, more, next }`. Pages are oldest first. `before` is a
 * cursor, or a time in milliseconds, that the page ends just before; the newest
 * page is `before` one millisecond past now. Every entry carries its own
 * `cursor`, and that is what paging is built on, never `created_ms`: a desk copy
 * collected late from another machine can carry an older `created_ms` than the
 * cursor, so ordering by time would lose it. `next` is direction-dependent: after
 * a forward read it is the cursor to continue from, and after a backward read it
 * is a `before` cursor, so the browser never takes a forward cursor from it (see
 * forwardCursorOf). Every field is optional and extras are ignored. Adjust these
 * parsers alone; see docs/DECISIONS.md section 16.
 */

/** One message in the feed. `payload` is the mail payload, unchanged. */
export interface FeedEntry {
	/** No longer sent by Privateer: another machine's mail arrives through the desk home. Kept for older data. */
	machine: string | null;
	/** The desk home that collected this message, as Privateer reports it. */
	home: string | null;
	/** The ship the conversation belongs to; for ship-to-ship mail, the sender. */
	ship: string;
	id: string;
	/**
	 * This entry's own place in the feed. Pass back as `after` to read forward
	 * from here, or as `before` to read the page ending just before it.
	 */
	cursor: string | null;
	created_ms: number | null;
	from: string;
	to: string;
	kind: string;
	/** A request's own kind, where the mail row names one separately. */
	request_kind: string | null;
	correlation: string | null;
	task_id: string | null;
	urgency: string;
	deadline_ms: number | null;
	/** "open", "answered", "dismissed", or another state Privateer reports. */
	state: string | null;
	/** Why an ask ended: "answered", "dismissed", or another reason. */
	end_reason: string | null;
	/** Who answered it, and when; the same pair for whatever closed it. */
	answered_by: string | null;
	answered_ms: number | null;
	ended_by: string | null;
	ended_ms: number | null;
	body: string | null;
	payload: Rec;
	/** Set on an answer made in this portal that Privateer does not list yet. */
	local?: { sent: boolean };
}

export interface FeedPage {
	entries: FeedEntry[];
	/** True when there are older entries than these. */
	more: boolean;
	/**
	 * Privateer's `next` as it sent it. Its direction follows the read: a forward
	 * read's next is a cursor to read on from, a backward read's is a `before`
	 * cursor. Read forward from forwardCursorOf(entries), never from this.
	 */
	next: string | null;
	/** Where to read backward from: the first entry's own cursor, in Privateer's order. */
	first: string | null;
}

/**
 * The cursor to read the page before one just read: the first entry of that
 * page, since Privateer lists each page oldest first. It is read here, while the
 * page is still in Privateer's order, and never from entries sorted for the chat:
 * a desk copy collected late from another machine carries a `created_ms` older
 * than the cursor that passed it, so the oldest time on screen is not the oldest
 * place in the feed, and paging back from it would re-read a page.
 */
export function firstCursorOf(entries: readonly FeedEntry[]): string | null {
	for (const e of entries) if (e.cursor !== null) return e.cursor;
	return null;
}

/**
 * Where a forward read continues from: the last entry of the page just read, the
 * newest message Privateer listed. Polling with this is what keeps a late desk
 * copy from being asked for again on every poll.
 */
export function forwardCursorOf(entries: readonly FeedEntry[]): string | null {
	let cursor: string | null = null;
	for (const e of entries) if (e.cursor !== null) cursor = e.cursor;
	return cursor;
}

/** Read `captain.feed`. Entries without an id or a sender are dropped. */
export function parseFeed(result: unknown): FeedPage {
	const root = rec(result);
	const entries = list(root?.entries).flatMap((raw) => {
		const entry = rec(raw);
		const id = str(entry?.id);
		const from = str(entry?.from);
		if (!entry || !id || !from) return [];
		const to = str(entry.to) ?? '';
		const request_kind = str(entry.request_kind);
		return [
			{
				machine: str(entry.machine),
				home: str(entry.home),
				ship: str(entry.ship) ?? (from === 'captain' ? to : from),
				id,
				cursor: str(entry.cursor) ?? str(entry.next),
				created_ms: num(entry.created_ms),
				from,
				to,
				kind: str(entry.kind) ?? request_kind ?? 'request',
				request_kind,
				correlation: str(entry.correlation),
				task_id: str(entry.task_id),
				urgency: urgencyOf(entry.urgency),
				deadline_ms: num(entry.deadline_ms),
				state: str(entry.state),
				end_reason: str(entry.end_reason),
				answered_by: str(entry.answered_by),
				answered_ms: num(entry.answered_ms),
				ended_by: str(entry.ended_by),
				ended_ms: num(entry.ended_ms),
				body: str(entry.body),
				payload: rec(entry.payload) ?? {}
			}
		];
	});
	return {
		entries,
		more: root?.more === true,
		// Both ends are taken here, while the page is still in Privateer's own order.
		next: str(root?.next),
		first: firstCursorOf(entries)
	};
}

/*
 * The ship profile, as Privateer's `ship.profile {ship}` sends it (src/profile.rs
 * in Privateer, PR 234). Every part is optional and extras are ignored. Nothing
 * secret is kept: Privateer masks secret-looking options to "<set>", and we keep
 * only whether one is set; MCP servers keep credential names and never values,
 * and a URL keeps no user name, password or secret query value. Adjust these
 * parsers alone; see docs/DECISIONS.md section 17.
 */

/** What Privateer writes in place of a secret-looking option's value. */
const SET = '<set>';

/**
 * Names that mark a value as a secret, matched case-insensitively. This is
 * Privateer's own list, so a name it hides is hidden here too.
 */
const SECRET_NAME = /key|token|secret|pass|auth|cred|cookie|session/i;

/** One first-mate option. A secret-looking option has no value, only whether one is set. */
export interface ProfileOption {
	name: string;
	value: string | null;
	secret: boolean;
	set: boolean;
}

/** Which list a route kind uses on this ship: the ship's own, the fleet's default, or none at all. */
export interface ProfileRoutes {
	kind: string;
	list: 'ship' | 'fleet' | 'none' | null;
	names: string[];
}

export interface ProfileTool {
	name: string;
	description: string | null;
}

export interface ProfileMcpServer {
	name: string;
	url: string | null;
	description: string | null;
	/** Credential names the server reads. Values are never kept. */
	credentials: string[];
}

export interface ShipProfile {
	ship: string;
	machine: string | null;
	hosted: boolean | null;
	sleep: { policy: string | null; idle_minutes: number | null };
	firstMate: { harness: string | null; options: ProfileOption[] };
	routes: ProfileRoutes[];
	charter: { actions: string[]; active: boolean | null };
	permissions: { fleetMode: string | null; fleetRules: string[] };
	/** Whether the first mate's skills and servers are a bounded plan, and why the plan failed if it did. */
	toolBundles: { bounded: boolean | null; error: string | null };
	skills: ProfileTool[];
	mcpServers: ProfileMcpServer[];
	plugins: ProfileTool[];
}

/** A URL with no user name or password, and with any secret-looking query value hidden. */
export function displayUrl(raw: unknown): string | null {
	const text = str(raw);
	if (text === null) return null;
	try {
		const url = new URL(text);
		url.username = '';
		url.password = '';
		for (const [key, value] of url.searchParams) {
			if (SECRET_NAME.test(key) && value !== '') url.searchParams.set(key, 'hidden');
		}
		return url.toString();
	} catch {
		return null;
	}
}

/**
 * An option's value as text. Nested maps and lists are written out as JSON with
 * every secret-looking key masked and every URL scrubbed, at any depth, so a
 * credential nested inside a non-secret option never reaches the page.
 */
function scalarText(raw: unknown): string | null {
	if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
	if (Array.isArray(raw) || rec(raw)) {
		return JSON.stringify(raw, (key, value) => {
			if (key !== '' && SECRET_NAME.test(key)) return SET;
			return typeof value === 'string' ? (displayUrl(value) ?? value) : value;
		});
	}
	return str(raw);
}

function option(name: string, raw: unknown): ProfileOption {
	const value = scalarText(raw);
	// A value Privateer masked is a secret even under a name this list does not know.
	const secret = SECRET_NAME.test(name) || value === SET;
	if (secret) return { name, value: null, secret, set: value !== null };
	// A non-secret option can still hold a URL with credentials in it: scrub it.
	return {
		name,
		value: value === null ? null : (displayUrl(value) ?? value),
		secret,
		set: value !== null
	};
}

/** A keyed object (`{ name: value }`) read in its key order. */
function keyed(value: unknown): [string, unknown][] {
	const object = rec(value);
	return object ? Object.entries(object) : [];
}

/** Credential names from either a list of names or a keyed object; never the values. */
function credentialNames(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.flatMap((c) => {
			const name = typeof c === 'string' ? c : str(rec(c)?.name);
			return name ? [name] : [];
		});
	}
	return keyed(value).map(([name]) => name);
}

/** Named tools (skills, plugins) from a list of `{ name, description }`. */
function tools(value: unknown): ProfileTool[] {
	return list(value).flatMap((raw) => {
		const tool = rec(raw);
		const name = str(tool?.name);
		return tool && name ? [{ name, description: str(tool.description) }] : [];
	});
}

/** Read `ship.profile`. Missing parts become null, empty or false. */
export function parseShipProfile(result: unknown, ship: string): ShipProfile {
	const root = rec(result) ?? {};
	const sleep = rec(root.sleep);
	const firstMate = rec(root.first_mate);
	const permissions = rec(root.permissions);
	const charter = rec(root.charter);
	const bundles = rec(root.tool_bundles);
	return {
		ship,
		machine: str(root.machine),
		hosted: typeof root.hosted === 'boolean' ? root.hosted : null,
		sleep: {
			policy: str(sleep?.policy),
			idle_minutes: num(sleep?.idle_minutes)
		},
		firstMate: {
			harness: str(firstMate?.harness),
			options: keyed(firstMate?.options).map(([name, value]) => option(name, value))
		},
		routes: keyed(root.routes).map(([kind, value]) => {
			const route = rec(value);
			const scope = str(route?.list);
			return {
				kind,
				list: scope === 'ship' || scope === 'fleet' || scope === 'none' ? scope : null,
				names: strings(route?.names)
			};
		}),
		charter: {
			actions: strings(charter?.actions),
			active: typeof charter?.active === 'boolean' ? charter.active : null
		},
		permissions: {
			fleetMode: str(permissions?.fleet_mode),
			fleetRules: strings(permissions?.fleet_rules)
		},
		toolBundles: {
			bounded: typeof bundles?.bounded === 'boolean' ? bundles.bounded : null,
			error: str(bundles?.error)
		},
		skills: tools(root.skills),
		mcpServers: list(root.mcp_servers).flatMap((raw) => {
			const server = rec(raw);
			const name = str(server?.name);
			return server && name
				? [
						{
							name,
							url: displayUrl(server.url),
							description: str(server.description),
							credentials: credentialNames(server.credentials)
						}
					]
				: [];
		}),
		plugins: tools(root.plugins)
	};
}
