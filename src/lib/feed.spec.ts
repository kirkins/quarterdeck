import { describe, expect, it } from 'vitest';
import type { Answered } from '#lib/decision.ts';
import {
	CAPTAIN,
	EMPTY_FILTER,
	anchorOf,
	applyLocalAnswers,
	atBottom,
	buildRows,
	dayLabel,
	feedKindOf,
	feedQuery,
	isOpen,
	mergeEntries,
	newerThan,
	newestOf,
	outcomeOf,
	readFeedFilter,
	readLastRead,
	readUpTo,
	segmentsOf,
	shipMark,
	unseenAfter,
	visibleEntries,
	waitingCount
} from './feed.ts';
import { parseFeed, type FeedEntry } from './shapes.ts';

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60_000;
/** Mid-morning, so "earlier today" stays on the same day. */
const NOW = new Date(2026, 9, 17, 10, 0).getTime();

/** One feed entry, with the fields the view reads; `over` replaces any of them. */
function entry(over: Partial<FeedEntry> = {}): FeedEntry {
	return {
		machine: 'north-rig',
		ship: 'billing',
		id: 'b-1',
		created_ms: NOW - 30 * MIN,
		from: 'billing',
		to: CAPTAIN,
		kind: 'request',
		correlation: null,
		task_id: null,
		urgency: 'normal',
		deadline_ms: null,
		state: 'open',
		body: 'Can invoices show the tax ID?',
		payload: {},
		...over
	};
}

describe('parseFeed', () => {
	it('reads entries and the page wrapper, keeping the payload unchanged', () => {
		const page = parseFeed({
			entries: [
				{
					machine: 'north-rig',
					ship: 'ops',
					id: 'o-1',
					created_ms: 5,
					from: 'ops',
					to: 'captain',
					kind: 'decision',
					urgency: 'high',
					deadline_ms: 9,
					state: 'open',
					body: 'Pause it?',
					payload: { decision: { question: 'Pause it?', options: [] } },
					extra: 'ignored'
				}
			],
			more: true,
			next: 'c-7'
		});
		expect(page.more).toBe(true);
		expect(page.next).toBe('c-7');
		expect(page.entries[0]).toMatchObject({ ship: 'ops', urgency: 'high', deadline_ms: 9 });
		expect(page.entries[0].payload).toEqual({ decision: { question: 'Pause it?', options: [] } });
	});

	it('fills what is missing and drops what cannot be keyed', () => {
		const page = parseFeed({
			entries: [
				{ id: 'x', from: 'storefront', to: 'captain' },
				{ from: 'storefront' },
				{ id: 'y' },
				'not a message'
			]
		});
		expect(page.entries).toHaveLength(1);
		expect(page.entries[0]).toMatchObject({
			ship: 'storefront',
			kind: 'request',
			urgency: 'normal',
			created_ms: null,
			state: null,
			payload: {}
		});
		expect(page.more).toBe(false);
		expect(page.next).toBeNull();
	});

	it('names a captain reply by the ship it went to', () => {
		const page = parseFeed({
			entries: [{ id: 'r-1', from: 'captain', to: 'mobile-app', kind: 'reply', correlation: 'm-1' }]
		});
		expect(page.entries[0].ship).toBe('mobile-app');
	});

	it('reads nothing from a result that is not a feed', () => {
		expect(parseFeed(null)).toEqual({ entries: [], more: false, next: null });
		expect(parseFeed({ entries: 'nope' }).entries).toEqual([]);
	});
});

describe('feedQuery', () => {
	it('reads the URL, clamping the limit and ignoring bad values', () => {
		expect(
			feedQuery(new URLSearchParams('after=1700&limit=500&ship=ops&include_ship_mail=1'))
		).toEqual({
			after: 1700,
			limit: 50,
			ship: 'ops',
			include_ship_mail: true
		});
		expect(feedQuery(new URLSearchParams('after=soon&limit=x&before=c-3'))).toEqual({
			before: 'c-3',
			limit: 15,
			include_ship_mail: false
		});
	});
});

describe('one message per key', () => {
	it('keeps a desk copy and its original once, the later version winning', () => {
		const original = entry({ id: 'b-1', body: 'first' });
		const copy = entry({ id: 'b-1', body: 'copy', machine: 'lab-box' });
		const merged = mergeEntries([original], [copy]);
		expect(merged).toHaveLength(1);
		expect(merged[0].body).toBe('copy');
	});

	it('keys by sender and id, so two ships can both say b-1', () => {
		const merged = mergeEntries(
			[entry({ from: 'billing' })],
			[entry({ from: 'ops', ship: 'ops' })]
		);
		expect(merged).toHaveLength(2);
	});

	it('sorts oldest first', () => {
		const merged = mergeEntries(
			[entry({ id: 'new', created_ms: NOW }), entry({ id: 'old', created_ms: NOW - MIN })],
			[]
		);
		expect(merged.map((e) => e.id)).toEqual(['old', 'new']);
	});

	it('finds what is newer than a time, and the newest time', () => {
		const list = [entry({ id: 'a', created_ms: 100 }), entry({ id: 'b', created_ms: 200 })];
		expect(newerThan(list, 150).map((e) => e.id)).toEqual(['b']);
		expect(newerThan(list, null)).toEqual([]);
		expect(newestOf(list)).toBe(200);
		expect(newestOf([])).toBeNull();
	});
});

describe('kinds, open and outcomes', () => {
	it('names what a message is from its payload and sender', () => {
		expect(feedKindOf(entry({ from: CAPTAIN, to: 'billing', kind: 'reply' }))).toBe('reply');
		expect(feedKindOf(entry({ payload: { needs_hands: 'Plug it in.' }, kind: 'request' }))).toBe(
			'needs_hands'
		);
		expect(feedKindOf(entry({ kind: 'report', payload: { report: {} } }))).toBe('report');
		expect(feedKindOf(entry({ kind: 'notice' }))).toBe('notice');
		expect(feedKindOf(entry({ payload: { decision: { question: 'x', options: [] } } }))).toBe(
			'decision'
		);
		expect(feedKindOf(entry({ kind: 'request' }))).toBe('request');
	});

	it('is open only for a ship message to the captain that is still open', () => {
		expect(isOpen(entry())).toBe(true);
		expect(isOpen(entry({ state: 'answered' }))).toBe(false);
		expect(isOpen(entry({ from: CAPTAIN, to: 'billing', kind: 'reply', state: 'open' }))).toBe(
			false
		);
		expect(isOpen(entry({ from: 'ops', to: 'billing' }))).toBe(false);
		expect(waitingCount([entry(), entry({ id: 'b-2', state: 'dismissed' })])).toBe(1);
	});

	it('says what happened to a closed ask, and nothing for an open one', () => {
		expect(outcomeOf(entry({ state: 'dismissed' }))).toBe('Dismissed');
		expect(outcomeOf(entry({ state: 'answered' }))).toBe('Answered');
		expect(outcomeOf(entry())).toBeNull();
	});
});

describe('filters', () => {
	const list = [
		entry({ id: 'a', ship: 'billing' }),
		entry({ id: 'b', ship: 'ops', from: 'ops', state: 'answered' }),
		entry({ id: 'c', ship: 'analytics', from: 'analytics', to: 'billing', state: null })
	];

	it('shows the captain’s mail by default, ship-to-ship only when asked', () => {
		expect(visibleEntries(list, EMPTY_FILTER).map((e) => e.id)).toEqual(['a', 'b']);
		expect(visibleEntries(list, { ...EMPTY_FILTER, shipMail: true }).map((e) => e.id)).toEqual([
			'a',
			'b',
			'c'
		]);
	});

	it('filters to one ship, and to what waits on the captain', () => {
		expect(
			visibleEntries(list, { ...EMPTY_FILTER, ship: 'billing', shipMail: true }).map((e) => e.id)
		).toEqual(['a', 'c']);
		expect(visibleEntries(list, { ...EMPTY_FILTER, onlyWaiting: true })).toEqual([list[0]]);
	});

	it('remembers a stored filter, and ignores anything that is not one', () => {
		expect(
			readFeedFilter(JSON.stringify({ ship: 'ops', onlyWaiting: true, shipMail: true }))
		).toEqual({
			ship: 'ops',
			onlyWaiting: true,
			shipMail: true
		});
		expect(readFeedFilter('{not json')).toEqual(EMPTY_FILTER);
		expect(readFeedFilter(null)).toEqual(EMPTY_FILTER);
		expect(readFeedFilter('{"ship":42,"shipMail":"yes"}')).toEqual(EMPTY_FILTER);
	});
});

describe('rows: runs, date separators, the unread divider', () => {
	it('puts a day separator before each day and a run per side', () => {
		const rows = buildRows(
			[
				entry({ id: 'a', created_ms: NOW - 3 * 60 * MIN }),
				entry({ id: 'b', created_ms: NOW - 2 * 60 * MIN }),
				entry({
					id: 'r',
					from: CAPTAIN,
					to: 'billing',
					kind: 'reply',
					correlation: 'b',
					created_ms: NOW - 90 * MIN
				}),
				entry({ id: 'c', created_ms: NOW - 30 * MIN })
			],
			{ now: NOW, lastRead: null }
		);
		expect(rows.map((r) => r.type)).toEqual(['day', 'message', 'message', 'message', 'message']);
		const messages = rows.filter((r) => r.type === 'message');
		expect(messages.map((r) => [r.first, r.last])).toEqual([
			[true, false],
			[false, true],
			[true, true],
			[true, true]
		]);
		expect(messages[2].type === 'message' && messages[2].mine).toBe(true);
	});

	it('starts a new run after a day separator, even from the same side', () => {
		const rows = buildRows(
			[entry({ id: 'a', created_ms: NOW - 2 * DAY }), entry({ id: 'b', created_ms: NOW - DAY })],
			{ now: NOW, lastRead: null }
		);
		const first = rows.find((r) => r.type === 'message' && r.entry.id === 'b');
		expect(first?.type === 'message' && first.first).toBe(true);
	});

	it('labels days as today, yesterday, or a short date', () => {
		expect(dayLabel(NOW - MIN, NOW)).toBe('Today');
		expect(dayLabel(NOW - DAY - MIN * 5, NOW)).toBe('Yesterday');
		expect(dayLabel(NOW - 5 * DAY, NOW)).toMatch(/\d/);
	});

	it('puts the Unread divider before the first message newer than the last read', () => {
		const rows = buildRows(
			[
				entry({ id: 'old', created_ms: NOW - 3 * 60 * MIN }),
				entry({ id: 'new1', created_ms: NOW - 2 * 60 * MIN }),
				entry({ id: 'new2', created_ms: NOW - 60 * MIN })
			],
			{ now: NOW, lastRead: NOW - 150 * MIN }
		);
		const types = rows.map((r) => (r.type === 'message' ? r.entry.id : r.type));
		expect(types.indexOf('unread')).toBe(types.indexOf('old') + 1);
		expect(types.filter((t) => t === 'unread')).toHaveLength(1);
	});

	it('has no divider when nothing has been read, or nothing is new', () => {
		const list = [entry({ id: 'a', created_ms: NOW - MIN })];
		expect(buildRows(list, { now: NOW, lastRead: null }).some((r) => r.type === 'unread')).toBe(
			false
		);
		expect(buildRows(list, { now: NOW, lastRead: NOW }).some((r) => r.type === 'unread')).toBe(
			false
		);
	});

	it('keys messages by sender and id, with a stable key for the divider and each day', () => {
		const rows = buildRows([entry({ id: 'a' })], { now: NOW, lastRead: null });
		const message = rows.find((r) => r.type === 'message');
		expect(message?.key).toBe('billing\u0000a');
		expect(rows[0].key).toMatch(/^day:/);
	});
});

describe('the new-messages pill and the read mark', () => {
	it('counts new messages only while scrolled up, and clears at the bottom', () => {
		expect(unseenAfter(0, 2, false)).toBe(2);
		expect(unseenAfter(2, 1, false)).toBe(3);
		expect(unseenAfter(3, 1, true)).toBe(0);
	});

	it('knows the bottom with a little slack', () => {
		expect(atBottom(900, 800, 1700)).toBe(true);
		expect(atBottom(500, 800, 1700)).toBe(false);
	});

	it('moves the read mark forward only, and only while at the bottom', () => {
		expect(readUpTo(null, 100, false)).toBeNull();
		expect(readUpTo(null, 100, true)).toBe(100);
		expect(readUpTo(100, 90, true)).toBe(100);
		expect(readUpTo(100, 200, true)).toBe(200);
		expect(readLastRead('123')).toBe(123);
		expect(readLastRead('nope')).toBeNull();
		expect(readLastRead(null)).toBeNull();
	});
});

describe('local answers', () => {
	const ask = entry({
		id: 'd-1',
		body: 'Pause it?',
		payload: { decision: { question: 'Pause it?', options: [] } }
	});

	it('marks an answered ask and adds the captain’s reply when Privateer has none', () => {
		const answers = new Map<string, Answered>([
			['billing\u0000d-1', { option_id: 'pause', label: 'Pause it', at_ms: NOW, sent: false }]
		]);
		const out = applyLocalAnswers([ask], answers);
		expect(out.find((e) => e.id === 'd-1')?.state).toBe('answered');
		const reply = out.find((e) => e.from === CAPTAIN);
		expect(reply).toMatchObject({
			body: 'Pause it',
			correlation: 'd-1',
			to: 'billing',
			local: { sent: false }
		});
	});

	it('does not add a reply twice when Privateer already lists it', () => {
		const answers = new Map<string, Answered>([
			['billing\u0000d-1', { text: 'Yes', at_ms: NOW, sent: true }]
		]);
		const listed = entry({
			id: 'r-9',
			from: CAPTAIN,
			to: 'billing',
			kind: 'reply',
			correlation: 'd-1',
			state: null,
			body: 'Yes'
		});
		const out = applyLocalAnswers([ask, listed], answers);
		expect(out.filter((e) => e.from === CAPTAIN)).toHaveLength(1);
	});

	it('marks a dismissed ask without a reply', () => {
		const answers = new Map<string, Answered>([
			['billing\u0000d-1', { dismissed: true, at_ms: NOW, sent: true }]
		]);
		const out = applyLocalAnswers([ask], answers);
		expect(out).toHaveLength(1);
		expect(out[0].state).toBe('dismissed');
	});
});

describe('segments, anchors and ship marks', () => {
	it('splits a body into text and http links, and never reads HTML', () => {
		expect(segmentsOf('See https://example.test/a, then <b>stop</b>.')).toEqual([
			{ text: 'See ' },
			{ text: 'https://example.test/a', href: 'https://example.test/a' },
			{ text: ', then <b>stop</b>.' }
		]);
	});

	it('gives each message a stable anchor and each ship a stable mark', () => {
		expect(anchorOf('billing\u0000a')).toBe(anchorOf('billing\u0000a'));
		expect(anchorOf('billing\u0000a')).not.toBe(anchorOf('ops\u0000a'));
		expect(shipMark('billing')).toEqual(shipMark('billing'));
		expect(shipMark('billing').initial).toBe('B');
		expect(shipMark('ops').hue).toBeGreaterThanOrEqual(0);
	});
});
