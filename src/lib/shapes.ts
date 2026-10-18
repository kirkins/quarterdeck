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
