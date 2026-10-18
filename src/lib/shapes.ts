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
	const kind = str(need.kind);
	if (kind === 'request' || kind === 'notice' || kind === 'report') return kind;
	return kind === 'approval' ? 'approval' : 'decision';
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
				hands_on: null,
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
 * The fleet map (PROVISIONAL). Privateer's `fleet.snapshot` is not out yet; this
 * is the shape we build against, from its description. Every field is optional
 * and extra fields are ignored, so a real snapshot that is richer still parses,
 * and a poorer one renders with gaps rather than failing. Adjust it here, in
 * parseSnapshot alone, when the Privateer PR lands. See docs/DECISIONS.md.
 */

/** A running crew job: a task's worker, with what it is doing now. */
export interface FleetJob {
	id: string;
	task_id: string | null;
	task_title: string | null;
	/** The last crew.report line. */
	doing_now: string | null;
	started_ms: number | null;
	heavy: boolean;
	/** Why the job is not moving, e.g. "waiting for capacity". */
	waits: string | null;
}

export interface FleetShip {
	name: string;
	scope: string | null;
	/** "hosted", "asleep", or another presence Privateer reports. */
	presence: string | null;
	open_tasks: number;
	jobs: FleetJob[];
}

/**
 * A model route on one machine. `cost` is "free", "plan" or "credits" as
 * Privateer reports it; `state` is "available", "backing_off" or "capped".
 * `until_ms` is when a backoff clears; `resets_at` is when a cap resets.
 */
export interface FleetRoute {
	name: string;
	harness: string | null;
	model: string | null;
	cost: string | null;
	state: string | null;
	until_ms: number | null;
	resets_at: number | null;
	last_error: string | null;
}

export interface FleetMachine {
	name: string;
	reachable: boolean;
	/** When this machine's state last changed, as Privateer observed it. */
	changed_ms: number | null;
	ships: FleetShip[];
	routes: FleetRoute[];
}

/** An item needing the captain, from runtime.needs, with the ship it belongs to. */
export interface FleetNeed {
	id: string;
	ship: string;
	kind: string | null;
}

export interface FleetSnapshot {
	generated_ms: number | null;
	machines: FleetMachine[];
	needs: FleetNeed[];
}

/** Read `fleet.snapshot` tolerantly: missing fields become null, empty or zero; extras are ignored. */
export function parseSnapshot(result: unknown): FleetSnapshot {
	const root = rec(result);
	return {
		generated_ms: num(root?.generated_ms),
		machines: list(root?.machines).flatMap((raw) => {
			const machine = rec(raw);
			const name = str(machine?.name);
			return machine && name ? [parseMachine(name, machine)] : [];
		}),
		needs: list(root?.needs).flatMap((raw) => {
			const need = rec(raw);
			const id = str(need?.id);
			const ship = str(need?.ship);
			return need && id && ship ? [{ id, ship, kind: str(need.kind) }] : [];
		})
	};
}

function parseMachine(name: string, machine: Rec): FleetMachine {
	return {
		name,
		reachable: machine.reachable === true,
		changed_ms: num(machine.changed_ms),
		ships: list(machine.ships).flatMap((raw) => {
			const ship = rec(raw);
			const shipName = str(ship?.name);
			return ship && shipName ? [parseShip(shipName, ship)] : [];
		}),
		routes: list(machine.routes).flatMap((raw) => {
			const route = rec(raw);
			const routeName = str(route?.name);
			return route && routeName ? [parseRoute(routeName, route)] : [];
		})
	};
}

function parseRoute(name: string, route: Rec): FleetRoute {
	return {
		name,
		harness: str(route.harness),
		model: str(route.model),
		cost: str(route.cost),
		state: str(route.state),
		until_ms: num(route.until_ms),
		resets_at: num(route.resets_at),
		last_error: str(route.last_error)
	};
}

function parseShip(name: string, ship: Rec): FleetShip {
	return {
		name,
		scope: str(ship.scope),
		presence: str(ship.presence),
		open_tasks: num(ship.open_tasks) ?? 0,
		jobs: list(ship.jobs).flatMap((raw) => {
			const job = rec(raw);
			const id = str(job?.id);
			return job && id
				? [
						{
							id,
							task_id: str(job.task_id),
							task_title: str(job.task_title),
							doing_now: str(job.doing_now),
							started_ms: num(job.started_ms),
							heavy: job.heavy === true,
							waits: str(job.waits)
						}
					]
				: [];
		})
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
 * The captain's feed (PROVISIONAL). Privateer's `captain.feed` is agreed but not
 * built yet: one stream of every message to and from the captain, across ships
 * and machines. The entry fields are as agreed; the page wrapper
 * `{ entries, more, next }` is our guess. Every field is optional and extras are
 * ignored. Adjust these parsers alone; see docs/DECISIONS.md section 16.
 */

/** One message in the feed. `payload` is the mail payload, unchanged. */
export interface FeedEntry {
	machine: string | null;
	/** The ship the conversation belongs to; for ship-to-ship mail, the sender. */
	ship: string;
	id: string;
	created_ms: number | null;
	from: string;
	to: string;
	kind: string;
	correlation: string | null;
	task_id: string | null;
	urgency: string;
	deadline_ms: number | null;
	/** "open", "answered", "dismissed", or another state Privateer reports. */
	state: string | null;
	body: string | null;
	payload: Rec;
	/** Set on an answer made in this portal that Privateer does not list yet. */
	local?: { sent: boolean };
}

export interface FeedPage {
	entries: FeedEntry[];
	/** True when there are older entries than these. */
	more: boolean;
	/** Opaque cursor for the page of older entries; pass it back as `before`. */
	next: string | null;
}

/** Read `captain.feed`. Entries without an id or a sender are dropped. */
export function parseFeed(result: unknown): FeedPage {
	const root = rec(result);
	return {
		entries: list(root?.entries).flatMap((raw) => {
			const entry = rec(raw);
			const id = str(entry?.id);
			const from = str(entry?.from);
			if (!entry || !id || !from) return [];
			const to = str(entry.to) ?? '';
			return [
				{
					machine: str(entry.machine),
					ship: str(entry.ship) ?? (from === 'captain' ? to : from),
					id,
					created_ms: num(entry.created_ms),
					from,
					to,
					kind: str(entry.kind) ?? 'request',
					correlation: str(entry.correlation),
					task_id: str(entry.task_id),
					urgency: urgencyOf(entry.urgency),
					deadline_ms: num(entry.deadline_ms),
					state: str(entry.state),
					body: str(entry.body),
					payload: rec(entry.payload) ?? {}
				}
			];
		}),
		more: root?.more === true,
		next: str(root?.next)
	};
}

/*
 * The ship profile (PROVISIONAL). Privateer's `ship.profile {ship}` is not built
 * yet, and this page is the only reader. The field names are our guess at what
 * a captain needs to see about one ship: its machine and hosting, its first
 * mate, the model routes it may use, its charter and permissions, and the tools
 * it carries. Every field is optional and extras are ignored. Nothing secret is
 * kept: an option whose name looks like a credential keeps only whether it is
 * set, MCP servers keep credential names and never values, and a URL keeps no
 * user name, password or secret query value. Adjust these parsers alone; see
 * docs/DECISIONS.md section 17.
 */

/** Names that mark a value as a secret. Matched case-insensitively against a field's name. */
const SECRET_NAME = /token|secret|key|password|passwd|credential|auth/i;

/** One first-mate option. A secret-looking option has no value, only whether one is set. */
export interface ProfileOption {
	name: string;
	value: string | null;
	secret: boolean;
	set: boolean;
}

/** Which list a route kind uses on this ship: the ship's own, or the fleet's default. */
export interface ProfileRoutes {
	kind: string;
	list: 'ship' | 'fleet' | null;
	names: string[];
}

export interface ProfileTool {
	name: string;
	description: string | null;
}

export interface ProfileMcpServer {
	name: string;
	url: string | null;
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
	charter: { actions: string[] };
	permissions: { fleetMode: string | null; fleetRules: string[]; shipRules: string[] };
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

function option(name: string, raw: unknown): ProfileOption {
	const value = typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : str(raw);
	const secret = SECRET_NAME.test(name);
	return { name, value: secret ? null : value, secret, set: value !== null };
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
				list: scope === 'ship' || scope === 'fleet' ? scope : null,
				names: strings(route?.names)
			};
		}),
		charter: { actions: strings(charter?.actions) },
		permissions: {
			fleetMode: str(permissions?.fleet_mode),
			fleetRules: strings(permissions?.fleet_rules),
			shipRules: strings(permissions?.ship_rules)
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
							credentials: credentialNames(server.credentials)
						}
					]
				: [];
		}),
		plugins: tools(root.plugins)
	};
}
