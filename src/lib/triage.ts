/**
 * Triage: everything owed to the captain, in one order. Pure functions over
 * MailItem so the server and the browser agree on sorting, sections and
 * filters. No Node APIs here.
 */
import { askKey, isDecisionMail, type MailItem } from '#lib/decision.ts';

export type TriageKind = 'decision' | 'request' | 'approval' | 'notice' | 'blocker';
export type Section = 'now' | 'waiting' | 'later';
export type Urgency = 'high' | 'normal' | 'low';

export const KIND_LABELS: Record<TriageKind, string> = {
	decision: 'Decision',
	request: 'Request',
	approval: 'Approval',
	notice: 'Notice',
	blocker: 'Blocked'
};

export const SECTIONS: { id: Section; title: string }[] = [
	{ id: 'now', title: 'Needs you now' },
	{ id: 'waiting', title: 'Waiting on you' },
	{ id: 'later', title: 'When you have a moment' }
];

const DAY = 24 * 60 * 60 * 1000;
const URGENCY_RANK: Record<Urgency, number> = { high: 0, normal: 1, low: 2 };

export interface TriageRow {
	item: MailItem;
	kind: TriageKind;
	section: Section;
	urgency: Urgency;
	overdue: boolean;
	deadline_ms: number | null;
	asked_ms: number;
	/** The ship marked this ask as one only the captain's hands can do. */
	needsHands: boolean;
}

export interface Triage {
	/** Every open item, most urgent first. */
	rows: TriageRow[];
	/** Ship names present in `rows`, sorted, for the ship filter. */
	ships: string[];
}

export interface Filter {
	ship: string | null;
	kind: TriageKind | null;
}

/** What kind of ask this is, from the mail kind, its request kind and its payload. */
export function triageKind(item: MailItem): TriageKind {
	if (item.kind === 'blocker') return 'blocker';
	if (item.kind === 'notice' || item.kind === 'report') return 'notice';
	if (item.kind === 'approval' || item.request_kind === 'production_approval') return 'approval';
	return isDecisionMail(item) ? 'decision' : 'request';
}

function urgencyOf(item: MailItem): Urgency {
	return item.urgency === 'high' || item.urgency === 'low' ? item.urgency : 'normal';
}

/** Section for a row: high urgency, overdue or due within a day is "now"; low is "later". */
export function sectionOf(
	row: Pick<TriageRow, 'urgency' | 'overdue' | 'deadline_ms'>,
	now: number
): Section {
	if (row.urgency === 'high' || row.overdue) return 'now';
	if (row.deadline_ms !== null && row.deadline_ms - now <= DAY) return 'now';
	return row.urgency === 'low' ? 'later' : 'waiting';
}

export function rowOf(item: MailItem, now: number): TriageRow {
	const deadline_ms = typeof item.deadline_ms === 'number' ? item.deadline_ms : null;
	const urgency = urgencyOf(item);
	const overdue = deadline_ms !== null && deadline_ms <= now;
	const asked_ms = item.asked_ms ?? item.created_ms ?? now;
	return {
		item,
		kind: triageKind(item),
		section: sectionOf({ urgency, overdue, deadline_ms }, now),
		urgency,
		overdue,
		deadline_ms,
		asked_ms,
		needsHands: typeof item.hands_on === 'string' && item.hands_on.trim() !== ''
	};
}

function deadlineOrder(a: number | null, b: number | null): number {
	if (a === b) return 0;
	if (a === null) return 1;
	if (b === null) return -1;
	return a - b;
}

/**
 * Urgency high first; then overdue; then the nearest deadline (none last);
 * then the oldest ask. Ties on all of those fall back to the id, so the order
 * never depends on the order Privateer happened to list things in.
 */
export function compareRows(a: TriageRow, b: TriageRow): number {
	return (
		URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] ||
		Number(b.overdue) - Number(a.overdue) ||
		deadlineOrder(a.deadline_ms, b.deadline_ms) ||
		a.asked_ms - b.asked_ms ||
		a.item.id.localeCompare(b.item.id)
	);
}

/**
 * Every item not yet answered or dismissed in this process, de-duplicated by
 * sender and id, most urgent first. `answered` is keyed by `askKey`.
 */
export function buildTriage(
	items: readonly MailItem[],
	now: number,
	answered: ReadonlyMap<string, unknown> = new Map()
): Triage {
	const seen = new Set<string>();
	const rows: TriageRow[] = [];
	for (const item of items) {
		if (!item || typeof item.id !== 'string') continue;
		const key = askKey(item.from, item.id);
		if (seen.has(key) || answered.has(key)) continue;
		seen.add(key);
		rows.push(rowOf(item, now));
	}
	rows.sort(compareRows);
	const ships = [...new Set(rows.map((row) => row.item.from))].sort();
	return { rows, ships };
}

export function filterRows(rows: readonly TriageRow[], filter: Filter): TriageRow[] {
	return rows.filter(
		(row) =>
			(filter.ship === null || row.item.from === filter.ship) &&
			(filter.kind === null || row.kind === filter.kind)
	);
}

/** The non-empty sections, in display order. Rows keep their sorted order. */
export function groupSections(
	rows: readonly TriageRow[]
): { id: Section; title: string; rows: TriageRow[] }[] {
	return SECTIONS.map((section) => ({
		...section,
		rows: rows.filter((row) => row.section === section.id)
	})).filter((section) => section.rows.length > 0);
}

/** Parse a stored filter, ignoring anything that is not one. */
export function readFilter(raw: string | null): Filter {
	const empty: Filter = { ship: null, kind: null };
	if (!raw) return empty;
	try {
		const value = JSON.parse(raw) as Partial<Record<keyof Filter, unknown>>;
		const kind = typeof value.kind === 'string' && value.kind in KIND_LABELS ? value.kind : null;
		const ship = typeof value.ship === 'string' && value.ship !== '' ? value.ship : null;
		return { ship, kind: kind as TriageKind | null };
	} catch {
		return empty;
	}
}
