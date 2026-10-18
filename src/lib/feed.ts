/**
 * The Feed: every message to and from the captain, as one chat. Pure functions
 * over FeedEntry so the server and the browser agree on what is shown, in what
 * order, and what counts as waiting. No Node APIs here.
 */
import {
	askKey,
	isDecisionMail,
	toQuestion,
	type Answered,
	type CardOption,
	type MailItem
} from '#lib/decision.ts';
import { commentCount, reportOf } from '#lib/report.ts';
import { formatAge } from '#lib/time.ts';
import type { FeedEntry } from '#lib/shapes.ts';

// A page's two cursors, read in Privateer's own order; see forwardCursorOf.
export { firstCursorOf, forwardCursorOf } from '#lib/shapes.ts';

/** The captain's own name on the wire. */
export const CAPTAIN = 'captain';
/** Entries per page, from the server, both for the first load and for older pages. */
export const PAGE_LIMIT = 15;
/** The most a page may ask for; Privateer caps a page at 200. */
export const MAX_LIMIT = 200;
/** How often a visible feed asks for new entries. */
export const POLL_MS = 10_000;
/**
 * How often the open items are read afresh over the whole history. Forward
 * polling follows cursors, so a desk copy collected late from another machine
 * (older `created_ms` than the cursor that passed it) is not something a poll
 * brings in; an `open_only` read does. See docs/DECISIONS.md section 16.
 */
export const OPEN_REFRESH_MS = 3 * 60_000;
/** Within this many pixels of the end, the captain counts as being at the bottom. */
export const BOTTOM_SLOP = 80;

export type FeedKind =
	'decision' | 'request' | 'approval' | 'needs_hands' | 'report' | 'notice' | 'reply';

export const FEED_KIND_LABELS: Record<FeedKind, string> = {
	decision: 'Decision',
	request: 'Request',
	approval: 'Approval',
	needs_hands: 'Needs hands',
	report: 'Report',
	notice: 'Notice',
	reply: 'Reply'
};

/**
 * A bound on `captain.feed`: a cursor Privateer gave us, or a time in
 * milliseconds. A time is only ever a bound on the newest end (`newestBefore`);
 * the feed is paged by cursor, never by an entry's `created_ms`, which for a
 * desk copy collected late is older than its place in the feed.
 */
export type FeedBound = string | number;

/**
 * A query for `captain.feed`. Pages move by cursor. `before` with no `after`
 * reads the page ending just before it; neither is the newest page.
 */
export interface FeedQuery {
	/** Read forward from this entry's cursor. */
	after?: FeedBound;
	/** Read the page ending just before this bound. */
	before?: FeedBound;
	limit: number;
	ship?: string;
	include_ship_mail: boolean;
	/** Only the items still open, over the whole history rather than the pages loaded. */
	open_only?: boolean;
	/** Privateer's own state filter, as `states`. */
	states?: string[];
}

/** A bound from its text: digits are a time in milliseconds, anything else a cursor. */
function boundOf(value: string): FeedBound {
	return /^\d+$/.test(value) ? Number(value) : value;
}

/**
 * The newest page's `before`: one millisecond past now, so every message
 * written so far is before it. The clock is the server's, since it is the one
 * Privateer's times are checked against.
 */
export function newestBefore(now: number): number {
	return now + 1;
}

/** A query that reads the newest page when it names no bound at all. */
export function withNewest(query: FeedQuery, now: number): FeedQuery {
	if (query.before !== undefined || query.after !== undefined) return query;
	return { ...query, before: newestBefore(now) };
}

/** Read the feed query from a URL's search params. Bad values fall back to the defaults. */
export function feedQuery(params: URLSearchParams): FeedQuery {
	const limit = params.get('limit') === null ? NaN : Math.floor(Number(params.get('limit')));
	const after = params.get('after');
	const before = params.get('before');
	const ship = params.get('ship');
	const states = params
		.getAll('state')
		.flatMap((value) => value.split(','))
		.map((value) => value.trim())
		.filter((value) => value !== '');
	return {
		...(after && { after: boundOf(after) }),
		...(before && { before: boundOf(before) }),
		limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), MAX_LIMIT) : PAGE_LIMIT,
		...(ship && { ship }),
		include_ship_mail: params.get('include_ship_mail') === '1',
		...(params.get('open_only') === '1' && { open_only: true }),
		...(states.length > 0 && { states })
	};
}

/** The key for a message: its sender and id, as askKey keys an ask. */
export function entryKey(entry: Pick<FeedEntry, 'from' | 'id'>): string {
	return askKey(entry.from, entry.id);
}

function hasNeedsHands(payload: Record<string, unknown>): boolean {
	const hands = payload.needs_hands;
	return typeof hands === 'string'
		? hands.trim() !== ''
		: hands === true || (typeof hands === 'object' && hands !== null);
}

/** What a message is, for its marker. Captain replies are replies; the rest follow their payload. */
export function feedKindOf(entry: FeedEntry): FeedKind {
	if (entry.from === CAPTAIN || entry.kind === 'reply') return 'reply';
	if (hasNeedsHands(entry.payload)) return 'needs_hands';
	if (entry.kind === 'report' || 'report' in entry.payload) return 'report';
	if (entry.kind === 'notice') return 'notice';
	if (entry.kind === 'approval') return 'approval';
	if (isDecisionMail(toMailItem(entry))) return 'decision';
	return 'request';
}

/** The fields the decision and triage code read, from one entry. */
export function toMailItem(entry: FeedEntry): MailItem {
	return {
		id: entry.id,
		from: entry.from,
		to: entry.to,
		kind: entry.kind,
		body: entry.body,
		payload: entry.payload,
		task_id: entry.task_id,
		correlation: entry.correlation,
		request_kind: entry.request_kind,
		urgency: entry.urgency,
		deadline_ms: entry.deadline_ms,
		created_ms: entry.created_ms ?? undefined,
		asked_ms: entry.created_ms ?? undefined,
		hands_on: entry.payload.needs_hands ?? null
	};
}

/** A message the ship sent and the captain has not closed. Captain replies are never open. */
export function isOpen(entry: FeedEntry): boolean {
	return entry.from !== CAPTAIN && entry.to === CAPTAIN && (entry.state ?? 'open') === 'open';
}

/**
 * An open message that waits on the captain's decision or step: a decision, request,
 * approval or needs_hands. A plain notice or report is open too, but it is unread,
 * not waiting, so it is labelled and counted apart.
 */
export function isWaiting(entry: FeedEntry): boolean {
	return isOpen(entry) && !['notice', 'report'].includes(feedKindOf(entry));
}

export function isShipToShip(entry: FeedEntry): boolean {
	return entry.from !== CAPTAIN && entry.to !== CAPTAIN;
}

/** The option a captain's reply chose, from its payload.answer, or null for a written answer. */
function chosenOption(reply: FeedEntry): string | null {
	const answer = reply.payload.answer;
	const option =
		typeof answer === 'object' && answer !== null
			? (answer as { option_id?: unknown }).option_id
			: null;
	return typeof option === 'string' && option !== '' ? option : null;
}

/** The first few words of a text, with an ellipsis when some were left out. */
function firstWords(text: string, count: number): string {
	const words = text.trim().split(/\s+/);
	return words.length > count ? `${words.slice(0, count).join(' ')}…` : words.join(' ');
}

/**
 * Why an ask ended. Privateer sends `end_reason` beside the state; an older
 * Privateer sent the reason as the state itself, so both are read here.
 */
export function endReasonOf(entry: FeedEntry): string | null {
	return entry.end_reason ?? entry.state;
}

/** When an ask was answered or otherwise closed, whichever Privateer reported first. */
export function closedAtOf(entry: FeedEntry): number | null {
	return entry.answered_ms ?? entry.ended_ms;
}

/**
 * What happened to a closed ask, in words, or null while it is open or for a
 * plain message. The captain's own reply, when the feed has it, says more than
 * any reason can: its payload.answer names the option chosen, and its body is
 * what was written. Without one, the end reason and the time it closed at do.
 */
export function outcomeOf(
	entry: FeedEntry,
	reply: FeedEntry | null = null,
	now?: number
): string | null {
	const end = endReasonOf(entry);
	const kind = feedKindOf(entry);
	if (end === 'dismissed') {
		return kind === 'notice' || kind === 'report' ? 'Marked read' : 'Dismissed';
	}
	if (end !== 'answered') return null;
	if (reply) {
		const option_id = chosenOption(reply);
		const body = (reply.body ?? '').trim();
		if (option_id !== null) {
			const option = optionsOf(entry).find((o) => o.id === option_id);
			const label = option?.label ?? body;
			return label ? `You chose ${label}` : 'Answered';
		}
		return body ? `You answered: ${firstWords(body, 8)}` : 'Answered';
	}
	// The reply is not in the loaded pages, so the end reason and its time stand in.
	const at = closedAtOf(entry);
	const ago = at !== null && now !== undefined ? formatAge(at, now) : null;
	return ago ? `Answered ${ago}` : 'Answered';
}

/** The options an ask offers, read the same way the decision card reads them. */
export function optionsOf(entry: FeedEntry): CardOption[] {
	return toQuestion(toMailItem(entry), entry.created_ms ?? 0).options;
}

/** The outcome of every closed ask in a list, keyed by entryKey. */
export function outcomesOf(entries: readonly FeedEntry[], now?: number): Map<string, string> {
	const replies = new Map<string, FeedEntry>();
	for (const e of entries) {
		if (e.from === CAPTAIN && e.correlation) replies.set(askKey(e.to, e.correlation), e);
	}
	const out = new Map<string, string>();
	for (const e of entries) {
		const outcome = outcomeOf(e, replies.get(entryKey(e)) ?? null, now);
		if (outcome) out.set(entryKey(e), outcome);
	}
	return out;
}

/** Entries oldest first, one per message: a desk copy and its original share a key and keep the later one. */
export function mergeEntries(
	current: readonly FeedEntry[],
	incoming: readonly FeedEntry[]
): FeedEntry[] {
	const byKey = new Map<string, FeedEntry>();
	for (const entry of current) byKey.set(entryKey(entry), entry);
	for (const entry of incoming) byKey.set(entryKey(entry), entry);
	return [...byKey.values()].sort(byTime);
}

function byTime(a: FeedEntry, b: FeedEntry): number {
	return (a.created_ms ?? 0) - (b.created_ms ?? 0) || a.id.localeCompare(b.id);
}

/** The newest creation time in a list, or null for an empty list. */
export function newestOf(entries: readonly FeedEntry[]): number | null {
	let newest: number | null = null;
	for (const e of entries) {
		if (e.created_ms !== null && (newest === null || e.created_ms > newest)) newest = e.created_ms;
	}
	return newest;
}

export interface FeedFilter {
	ship: string | null;
	onlyWaiting: boolean;
	shipMail: boolean;
}

export const EMPTY_FILTER: FeedFilter = { ship: null, onlyWaiting: false, shipMail: false };

/** Parse a stored filter, ignoring anything that is not one. */
export function readFeedFilter(raw: string | null): FeedFilter {
	if (!raw) return EMPTY_FILTER;
	try {
		const value = JSON.parse(raw) as Partial<Record<keyof FeedFilter, unknown>>;
		return {
			ship: typeof value.ship === 'string' && value.ship !== '' ? value.ship : null,
			onlyWaiting: value.onlyWaiting === true,
			shipMail: value.shipMail === true
		};
	} catch {
		return EMPTY_FILTER;
	}
}

/** The entries the filter shows, in their order. */
export function visibleEntries(entries: readonly FeedEntry[], filter: FeedFilter): FeedEntry[] {
	return entries.filter(
		(e) =>
			(filter.shipMail || !isShipToShip(e)) &&
			(filter.ship === null ||
				e.ship === filter.ship ||
				e.from === filter.ship ||
				e.to === filter.ship) &&
			(!filter.onlyWaiting || isWaiting(e))
	);
}

/** The ships named in the feed, sorted, for the ship picker. */
export function shipsIn(entries: readonly FeedEntry[]): string[] {
	const names = new Set<string>();
	for (const e of entries) {
		if (e.ship) names.add(e.ship);
	}
	return [...names].sort();
}

/** How many items are waiting on the captain. Unread notices are not counted. */
export function waitingCount(entries: readonly FeedEntry[]): number {
	return entries.filter(isWaiting).length;
}

/* ------------------------------------------------------------------------ */
/* Rows: what the page draws, in order                                       */
/* ------------------------------------------------------------------------ */

export type Row =
	| { type: 'day'; key: string; label: string }
	| { type: 'unread'; key: 'unread' }
	| {
			type: 'message';
			key: string;
			entry: FeedEntry;
			/** Starts a run of messages from one side, so it gets the name and mark. */
			first: boolean;
			/** Ends a run. */
			last: boolean;
			/** The captain's own reply: drawn on the right. */
			mine: boolean;
			shipToShip: boolean;
	  };

/** Which side a message is drawn on, and which messages share a run. */
function runOf(entry: FeedEntry): string {
	if (entry.from === CAPTAIN) return 'out';
	if (isShipToShip(entry)) return `s2s:${entry.from}>${entry.to}`;
	return `in:${entry.from}`;
}

function sameDay(a: number, b: number): boolean {
	const x = new Date(a);
	const y = new Date(b);
	return (
		x.getFullYear() === y.getFullYear() &&
		x.getMonth() === y.getMonth() &&
		x.getDate() === y.getDate()
	);
}

/** "Today", "Yesterday", or a short date. */
export function dayLabel(ms: number, now: number): string {
	if (sameDay(ms, now)) return 'Today';
	if (sameDay(ms, now - 24 * 60 * 60 * 1000)) return 'Yesterday';
	return new Intl.DateTimeFormat('en-GB', {
		weekday: 'short',
		day: 'numeric',
		month: 'short'
	}).format(ms);
}

/**
 * The flat list the page draws. Date separators come before the first message
 * of each day; the Unread divider comes before the first message newer than
 * `lastRead`. Keys are stable, so a poll or an older page does not remount
 * what is already on screen.
 */
export function buildRows(
	entries: readonly FeedEntry[],
	{ now, lastRead }: { now: number; lastRead: number | null }
): Row[] {
	const sorted = [...entries].sort(byTime);
	const rows: Row[] = [];
	let unreadDone = lastRead === null;
	let day: string | null = null;
	for (const entry of sorted) {
		const created = entry.created_ms ?? now;
		const dayKey = new Date(created).toDateString();
		if (dayKey !== day) {
			day = dayKey;
			rows.push({ type: 'day', key: `day:${dayKey}`, label: dayLabel(created, now) });
		}
		if (!unreadDone && created > (lastRead ?? 0)) {
			unreadDone = true;
			rows.push({ type: 'unread', key: 'unread' });
		}
		rows.push({
			type: 'message',
			key: entryKey(entry),
			entry,
			first: false,
			last: false,
			mine: entry.from === CAPTAIN,
			shipToShip: isShipToShip(entry)
		});
	}
	// Second pass: a run is a consecutive set of messages from one side, within one day.
	const runs = rows.map((row) => (row.type === 'message' ? runOf(row.entry) : null));
	return rows.map((row, i) => {
		if (row.type !== 'message') return row;
		const before = i > 0 ? rows[i - 1] : null;
		const after = i < rows.length - 1 ? rows[i + 1] : null;
		const run = runs[i];
		return {
			...row,
			first: before?.type !== 'message' || runs[i - 1] !== run,
			last: after?.type !== 'message' || runs[i + 1] !== run
		};
	});
}

/* ------------------------------------------------------------------------ */
/* Unread, the pill, and the scroll                                          */
/* ------------------------------------------------------------------------ */

/** Whether the captain is at the end of the feed. */
export function atBottom(scrollY: number, innerHeight: number, scrollHeight: number): boolean {
	return scrollHeight - (scrollY + innerHeight) <= BOTTOM_SLOP;
}

/**
 * The count behind the "N new messages" pill. At the bottom, new messages are
 * read as they arrive, so the count stays at zero; scrolled up, they are counted.
 */
export function unseenAfter(previous: number, added: number, bottom: boolean): number {
	return bottom ? 0 : previous + added;
}

/** Where the captain last read: the newest message seen while at the bottom. */
export function readUpTo(
	lastRead: number | null,
	newest: number | null,
	bottom: boolean
): number | null {
	if (!bottom || newest === null) return lastRead;
	return lastRead === null || newest > lastRead ? newest : lastRead;
}

/** Parse a stored "last read" time, ignoring anything that is not a time. */
export function readLastRead(raw: string | null): number | null {
	const value = raw === null ? NaN : Number(raw);
	return Number.isFinite(value) && value > 0 ? value : null;
}

/* ------------------------------------------------------------------------ */
/* Local answers: what this portal sent, before Privateer lists it            */
/* ------------------------------------------------------------------------ */

/**
 * Mark each ask this portal answered or dismissed, and add the captain's reply
 * as a message when Privateer does not list one yet. A reply Privateer already
 * lists wins, so nothing shows twice.
 */
export function applyLocalAnswers(
	entries: readonly FeedEntry[],
	answers: ReadonlyMap<string, Answered>
): FeedEntry[] {
	const replied = new Set(
		entries
			.filter((e) => e.from === CAPTAIN && e.correlation)
			.map((e) => askKey(e.to, e.correlation as string))
	);
	const marked = entries.map((entry) => {
		const answer = answers.get(entryKey(entry));
		if (!answer || !isOpen(entry)) return entry;
		return { ...entry, state: answer.dismissed ? 'dismissed' : 'answered' };
	});
	const added: FeedEntry[] = [];
	for (const entry of entries) {
		const key = entryKey(entry);
		const answer = answers.get(key);
		if (!answer || answer.dismissed || replied.has(key) || !isOpen(entry)) continue;
		const body = replyBody(answer);
		added.push({
			machine: null,
			home: null,
			ship: entry.ship,
			id: `local-${entry.id}`,
			cursor: null,
			created_ms: answer.at_ms,
			from: CAPTAIN,
			to: entry.from,
			kind: 'reply',
			request_kind: null,
			correlation: entry.id,
			task_id: entry.task_id,
			urgency: 'normal',
			deadline_ms: null,
			state: null,
			end_reason: null,
			answered_by: null,
			answered_ms: null,
			ended_by: null,
			ended_ms: null,
			body,
			payload: answer.option_id ? { answer: { option_id: answer.option_id } } : {},
			local: { sent: answer.sent }
		});
	}
	return [...marked, ...added].sort(byTime);
}

/** The reply's words, built as the server builds the write: the option, a note, or the captain's own answer. */
function replyBody(answer: Answered): string {
	const label = answer.label ?? null;
	const text = answer.text ?? null;
	if (label && text) return `${label} — ${text}`;
	return label ?? text ?? '';
}

/**
 * The step a needs-hands message asks the captain to take, as the ship wrote it:
 * a plain string, or an object with a `step` (or a summary, text or body).
 */
export function handsTextOf(payload: Record<string, unknown>): string | null {
	const hands = payload.needs_hands;
	if (typeof hands === 'string') return hands.trim() || null;
	if (typeof hands !== 'object' || hands === null) return null;
	const record = hands as Record<string, unknown>;
	for (const key of ['step', 'summary', 'text', 'body']) {
		const text = record[key];
		if (typeof text === 'string' && text.trim() !== '') return text.trim();
	}
	return null;
}

/** The reports an entry carries, if it is a valid one. */
export function reportTitleOf(entry: FeedEntry): string | null {
	const reported = reportOf(entry.payload);
	return reported?.ok ? reported.value.title : null;
}

/**
 * The comments a captain reply or notice carries, as a line for the feed:
 * "N comments on <title>". The title is the report the reply answers, found
 * among the entries by its correlation. Keyed by entryKey; entries with no
 * comments are absent.
 */
export function commentsOf(entries: readonly FeedEntry[]): Map<string, string> {
	const titles = new Map<string, string>();
	for (const entry of entries) {
		const title = reportTitleOf(entry);
		if (title) titles.set(entryKey(entry), title);
	}
	const out = new Map<string, string>();
	for (const entry of entries) {
		const annotations = entry.payload?.annotations;
		if (entry.from !== CAPTAIN || !Array.isArray(annotations) || annotations.length === 0) continue;
		const title =
			titles.get(entryKey(entry)) ??
			(entry.correlation ? titles.get(askKey(entry.to, entry.correlation)) : undefined);
		const count = commentCount(annotations.length);
		out.set(entryKey(entry), title ? `${count} on ${title}` : count);
	}
	return out;
}

/**
 * The captain's own note on a reply or notice that carries comments: its body
 * past the "N comments on <title>" line the send path puts first. Null when
 * there is no note. A body without that line is all note.
 */
export function captainNoteOf(entry: FeedEntry): string | null {
	const body = entry.body?.trim() ?? '';
	const annotations = entry.payload?.annotations;
	const count = Array.isArray(annotations) ? annotations.length : 0;
	const summary = `${commentCount(count)} on `;
	if (!body.startsWith(summary)) return body || null;
	const gap = body.indexOf('\n\n');
	const note = gap === -1 ? '' : body.slice(gap + 2).trim();
	return note || null;
}

/** A ship's mark: its initial and a colour that is the same for that name everywhere. */
export function shipMark(name: string): { initial: string; hue: number } {
	let hash = 0;
	for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
	const initial = [...name.trim()][0]?.toUpperCase() ?? '?';
	return { initial, hue: hash % 360 };
}

/** A piece of a message body: plain text, or a link to an http(s) address. */
export interface Segment {
	text: string;
	href?: string;
}

const LINK = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

/**
 * A plain-text body split into text and links. Never HTML: the body is only
 * ever rendered as text nodes and anchors.
 */
export function segmentsOf(body: string): Segment[] {
	const out: Segment[] = [];
	let last = 0;
	for (const match of body.matchAll(LINK)) {
		const at = match.index ?? 0;
		if (at > last) out.push({ text: body.slice(last, at) });
		out.push({ text: match[0], href: match[0] });
		last = at + match[0].length;
	}
	if (last < body.length) out.push({ text: body.slice(last) });
	return out;
}

/** A DOM id for a message, so a reply can jump to the ask it answers. */
export function anchorOf(key: string): string {
	let hash = 0;
	for (const ch of key) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
	return `m${hash.toString(36)}`;
}

/** "14:05", in the viewer's locale and time zone. Browser only: the server's clock is not the captain's. */
export function clockOf(ms: number): string {
	return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(ms);
}
