import { describe, expect, it } from 'vitest';
import type { Answered } from '#lib/decision.ts';
import {
	CAPTAIN,
	EMPTY_FILTER,
	MAX_LIMIT,
	PAGE_LIMIT,
	anchorOf,
	applyLocalAnswers,
	atBottom,
	buildRows,
	captainNoteOf,
	commentsOf,
	closedAtOf,
	dayLabel,
	entryKey,
	endReasonOf,
	feedKindOf,
	feedQuery,
	isOpen,
	mergeEntries,
	newestBefore,
	newestOf,
	outcomeOf,
	outcomesOf,
	readFeedFilter,
	readLastRead,
	readUpTo,
	segmentsOf,
	shipMark,
	unseenAfter,
	isWaiting,
	visibleEntries,
	waitingCount,
	withNewest
} from './feed.ts';
import { firstCursorOf, forwardCursorOf, parseFeed, type FeedEntry } from './shapes.ts';

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60_000;
/** Mid-morning, so "earlier today" stays on the same day. */
const NOW = new Date(2026, 9, 17, 10, 0).getTime();

/** One feed entry, with the fields the view reads; `over` replaces any of them. */
function entry(over: Partial<FeedEntry> = {}): FeedEntry {
	return {
		machine: 'north-rig',
		home: 'desk-north',
		ship: 'billing',
		id: 'b-1',
		cursor: 'c-1',
		created_ms: NOW - 30 * MIN,
		from: 'billing',
		to: CAPTAIN,
		kind: 'request',
		request_kind: null,
		correlation: null,
		task_id: null,
		urgency: 'normal',
		deadline_ms: null,
		state: 'open',
		end_reason: null,
		answered_by: null,
		answered_ms: null,
		ended_by: null,
		ended_ms: null,
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

	it('reads the desk home, the request kind, the cursor and how an ask ended', () => {
		const page = parseFeed({
			entries: [
				{
					ship: 'analytics',
					home: 'desk-lab',
					id: 'a-9',
					cursor: 'c-42',
					created_ms: 5,
					from: 'analytics',
					to: 'captain',
					kind: 'request',
					request_kind: 'notice',
					state: 'dismissed',
					end_reason: 'dismissed',
					answered_by: null,
					answered_ms: null,
					ended_by: 'captain',
					ended_ms: 7,
					body: 'Marked read?'
				}
			]
		});
		expect(page.entries[0]).toMatchObject({
			home: 'desk-lab',
			cursor: 'c-42',
			request_kind: 'notice',
			end_reason: 'dismissed',
			ended_by: 'captain',
			ended_ms: 7,
			answered_ms: null
		});
	});

	it('takes the cursor from `next` when an entry carries no cursor of its own', () => {
		const page = parseFeed({ entries: [{ id: 'x', from: 'ops', to: 'captain', next: 'c-5' }] });
		expect(page.entries[0].cursor).toBe('c-5');
	});

	it('fills what is missing and drops what cannot be keyed', () => {
		const page = parseFeed({
			entries: [
				{ id: 'x', from: 'chandlery', to: 'captain' },
				{ from: 'chandlery' },
				{ id: 'y' },
				'not a message'
			]
		});
		expect(page.entries).toHaveLength(1);
		expect(page.entries[0]).toMatchObject({
			ship: 'chandlery',
			kind: 'request',
			urgency: 'normal',
			created_ms: null,
			state: null,
			cursor: null,
			home: null,
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
		expect(parseFeed(null)).toEqual({ entries: [], more: false, next: null, first: null });
		expect(parseFeed({ entries: 'nope' }).entries).toEqual([]);
	});

	it("reads both ends of a page in Privateer's order, not by time", () => {
		const page = parseFeed({
			entries: [
				// A desk copy collected late: newest in the feed, oldest by time.
				{ id: 'late', cursor: 'c-9', created_ms: 100, from: 'ops', to: 'captain' },
				{ id: 'newer', cursor: 'c-8', created_ms: 900, from: 'ops', to: 'captain' }
			],
			more: true,
			next: null
		});
		expect(page.first).toBe('c-9');
		// next is Privateer's own, unchanged. The forward cursor is the newest entry's, read from the entries.
		expect(page.next).toBeNull();
		expect(forwardCursorOf(page.entries)).toBe('c-8');
	});

	it("keeps Privateer's next as sent, whichever way the page reads", () => {
		const page = parseFeed({
			entries: [{ id: 'a', cursor: 'c-1', from: 'ops', to: 'captain' }],
			next: 'c-1'
		});
		expect(page.next).toBe('c-1');
	});
});

describe('feedQuery', () => {
	it('reads a time as a number and a cursor as text, and the newest page is one ms past now', () => {
		expect(feedQuery(new URLSearchParams('before=1800000000000'))).toEqual({
			before: 1_800_000_000_000,
			limit: PAGE_LIMIT,
			include_ship_mail: false
		});
		expect(feedQuery(new URLSearchParams('after=f1.12&before=f1.3')).after).toBe('f1.12');
		expect(feedQuery(new URLSearchParams('after=f1.12&before=f1.3')).before).toBe('f1.3');
		expect(newestBefore(1_800_000_000_000)).toBe(1_800_000_000_001);
	});

	it('reads the newest page when it names no bound, and keeps any bound it is given', () => {
		const query = { limit: PAGE_LIMIT, include_ship_mail: false };
		expect(withNewest(query, 1_800_000_000_000)).toEqual({
			...query,
			before: 1_800_000_000_001
		});
		expect(withNewest({ ...query, after: 'f1.4' }, 1_800_000_000_000)).toEqual({
			...query,
			after: 'f1.4'
		});
	});

	it('reads cursors, open_only and states, clamping the limit', () => {
		expect(
			feedQuery(
				new URLSearchParams('after=c-12&limit=500&ship=ops&include_ship_mail=1&open_only=1')
			)
		).toEqual({
			after: 'c-12',
			limit: MAX_LIMIT,
			ship: 'ops',
			include_ship_mail: true,
			open_only: true
		});
		expect(
			feedQuery(new URLSearchParams('before=f1.9&limit=x&state=open&state=dismissed'))
		).toEqual({
			before: 'f1.9',
			limit: PAGE_LIMIT,
			include_ship_mail: false,
			states: ['open', 'dismissed']
		});
		expect(feedQuery(new URLSearchParams('after=&open_only=0&state=,'))).toEqual({
			limit: PAGE_LIMIT,
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

	it('keeps one message per key within a first page that repeats one', () => {
		const first = entry({ id: 'b-1', body: 'first' });
		const copy = entry({ id: 'b-1', body: 'copy', machine: 'lab-box' });
		const page = mergeEntries([], [first, copy, entry({ id: 'b-2' })]);
		expect(page.map((e) => e.id)).toEqual(['b-1', 'b-2']);
		expect(page[0].body).toBe('copy');
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

	it('finds the newest time', () => {
		const list = [entry({ id: 'a', created_ms: 100 }), entry({ id: 'b', created_ms: 200 })];
		expect(newestOf(list)).toBe(200);
		expect(newestOf([])).toBeNull();
	});
});

describe('paging by cursor', () => {
	const oldest = entry({ id: 'old', cursor: 'c-1', created_ms: 100 });
	const middle = entry({ id: 'mid', cursor: 'c-2', created_ms: 200 });
	const newest = entry({ id: 'new', cursor: 'c-3', created_ms: 300 });

	it('takes both ends of a page from the page just read', () => {
		const page = [oldest, middle, newest];
		expect(firstCursorOf(page)).toBe('c-1');
		// A page arrives oldest first, so its last entry is where a forward read goes next.
		expect(forwardCursorOf(page)).toBe('c-3');
		expect(firstCursorOf([])).toBeNull();
		expect(forwardCursorOf([])).toBeNull();
	});

	it('skips entries with no cursor of their own', () => {
		const page = [entry({ id: 'no-cursor', cursor: null }), oldest];
		expect(firstCursorOf(page)).toBe('c-1');
		expect(firstCursorOf([entry({ cursor: null })])).toBeNull();
	});

	it('does not let a late desk copy move the page boundaries by its time', () => {
		// Collected from another machine: newest in the feed, older than the rest by time.
		const late = entry({ id: 'late', cursor: 'c-4', created_ms: 50, body: 'ran elsewhere' });
		// A page that ends with it reads forward after c-4, not after the message below it in time.
		expect(forwardCursorOf([oldest, middle, newest, late])).toBe('c-4');
		// Paging back is read from the page, so the boundary only moves when a page is read.
		expect(firstCursorOf([oldest, middle, newest, late])).toBe('c-1');
		// Ordered by time the copy is the oldest, which is exactly why it cannot be the boundary.
		const byTime = [oldest, middle, newest, late].sort(
			(a, b) => (a.created_ms ?? 0) - (b.created_ms ?? 0)
		);
		expect(byTime[0].id).toBe('late');
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

	it('takes the words from the end reason, which is what Privateer now sends', () => {
		expect(outcomeOf(entry({ state: 'closed', end_reason: 'dismissed' }))).toBe('Dismissed');
		expect(outcomeOf(entry({ kind: 'notice', state: 'closed', end_reason: 'dismissed' }))).toBe(
			'Marked read'
		);
		expect(outcomeOf(entry({ state: 'closed', end_reason: 'answered' }))).toBe('Answered');
		// The end reason is what the state used to say, so both are read.
		expect(endReasonOf(entry({ state: 'dismissed' }))).toBe('dismissed');
		expect(endReasonOf(entry({ state: 'closed', end_reason: 'expired' }))).toBe('expired');
	});

	it('says when it was answered, when the reply is not in the loaded pages', () => {
		const answered = entry({
			state: 'answered',
			end_reason: 'answered',
			answered_ms: NOW - 2 * MIN
		});
		expect(outcomeOf(answered, null, NOW)).toBe('Answered 2m ago');
		expect(closedAtOf(answered)).toBe(NOW - 2 * MIN);
		// ended_ms alone is enough when there was no answer.
		expect(closedAtOf(entry({ ended_ms: NOW - 5 * MIN }))).toBe(NOW - 5 * MIN);
		// With no time reported, the words stand on their own.
		expect(outcomeOf(entry({ state: 'answered' }), null, NOW)).toBe('Answered');
	});
});

describe('outcomes in words', () => {
	const decision = entry({
		id: 'd-1',
		state: 'answered',
		payload: {
			decision: {
				question: 'Which platform first?',
				options: [
					{ id: 'android', label: 'Android first' },
					{ id: 'ios', label: 'iOS first' }
				]
			}
		}
	});
	const reply = (over: Partial<FeedEntry>) =>
		entry({
			id: 'r-1',
			from: CAPTAIN,
			to: 'billing',
			kind: 'reply',
			correlation: 'd-1',
			state: null,
			body: '',
			payload: {},
			...over
		});

	it('says which option the captain chose, from the reply', () => {
		const chose = reply({ body: 'Android first', payload: { answer: { option_id: 'android' } } });
		expect(outcomeOf(decision, chose)).toBe('You chose Android first');
		expect(outcomesOf([decision, chose]).get('billing\u0000d-1')).toBe('You chose Android first');
	});

	it('quotes the first words of a written answer', () => {
		const wrote = reply({
			body: 'Yes, go ahead with the rollout on the staging ring first please'
		});
		expect(outcomeOf(entry({ id: 'd-1', state: 'answered' }), wrote)).toBe(
			'You answered: Yes, go ahead with the rollout on the…'
		);
	});

	it('says Dismissed, or Marked read for a notice, and Answered when nothing is known', () => {
		expect(outcomeOf(entry({ state: 'dismissed' }))).toBe('Dismissed');
		expect(outcomeOf(entry({ kind: 'notice', state: 'dismissed' }))).toBe('Marked read');
		expect(outcomeOf(decision)).toBe('Answered');
		expect(outcomesOf([decision]).has('billing\u0000d-1')).toBe(true);
		expect(outcomesOf([entry()]).size).toBe(0);
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

describe('waiting versus unread', () => {
	it('counts decisions, requests and approvals as waiting, but not open notices or reports', () => {
		const decision = entry({ id: 'd', kind: 'decision', payload: { choices: ['a', 'b'] } });
		const request = entry({ id: 'r', kind: 'request' });
		const approval = entry({ id: 'a', kind: 'approval', payload: { artifact: 'x' } });
		const notice = entry({ id: 'n', kind: 'notice' });
		const report = entry({ id: 'p', kind: 'report', payload: { report: 'rep-1' } });
		expect(isWaiting(decision)).toBe(true);
		expect(isWaiting(request)).toBe(true);
		expect(isWaiting(approval)).toBe(true);
		expect(isWaiting(notice)).toBe(false);
		expect(isWaiting(report)).toBe(false);
		expect(waitingCount([decision, request, approval, notice, report])).toBe(3);
	});

	it('keeps an open notice in the feed but out of "only waiting on me"', () => {
		const notice = entry({ id: 'n', kind: 'notice' });
		const request = entry({ id: 'r', kind: 'request' });
		const only = visibleEntries([notice, request], { ...EMPTY_FILTER, onlyWaiting: true });
		expect(only.map((e) => e.id)).toEqual(['r']);
		expect(visibleEntries([notice, request], EMPTY_FILTER)).toHaveLength(2);
	});
});

describe('commentsOf', () => {
	const report = { title: 'Audit', format: 'markdown', content: '# Audit' };
	const ask = entry({ from: 'analytics', id: 'a-1', kind: 'notice', payload: { report } });
	const note = { anchor: { quote: 'Audit' }, comment: 'Keep this' };

	it('says how many comments a captain reply carries, and on which report', () => {
		const reply = entry({
			from: CAPTAIN,
			to: 'analytics',
			id: 'r-1',
			kind: 'reply',
			correlation: 'a-1',
			payload: { annotations: [note, note] }
		});
		expect(commentsOf([ask, reply]).get(entryKey(reply))).toBe('2 comments on Audit');
	});

	it('reads the singular, and leaves out the title when the report is not in the list', () => {
		const reply = entry({
			from: CAPTAIN,
			to: 'analytics',
			id: 'r-2',
			kind: 'reply',
			correlation: 'gone',
			payload: { annotations: [note] }
		});
		expect(commentsOf([reply]).get(entryKey(reply))).toBe('1 comment');
	});

	it('leaves out messages with no comments, and comments from anyone but the captain', () => {
		const plain = entry({ from: CAPTAIN, id: 'r-3', kind: 'reply', payload: {} });
		const ship = entry({ from: 'analytics', id: 'a-9', payload: { annotations: [note] } });
		expect(commentsOf([ask, plain, ship]).size).toBe(0);
	});
});

describe('captainNoteOf', () => {
	const note = { anchor: { quote: 'Audit' }, comment: 'Keep this' };
	const reply = (body: string | null, annotations: unknown[] = [note]) =>
		entry({
			from: CAPTAIN,
			to: 'analytics',
			id: 'r-1',
			kind: 'reply',
			correlation: 'a-1',
			body,
			payload: { annotations }
		});

	it("is the captain's note past the generated comments line", () => {
		expect(captainNoteOf(reply('1 comment on Audit\n\nCheck the totals again.'))).toBe(
			'Check the totals again.'
		);
	});

	it('is null when the body is only the generated line', () => {
		expect(captainNoteOf(reply('2 comments on Audit', [note, note]))).toBeNull();
	});

	it('is null for an empty body', () => {
		expect(captainNoteOf(reply(''))).toBeNull();
		expect(captainNoteOf(reply(null))).toBeNull();
	});

	it('keeps a note that is several paragraphs long, as written', () => {
		expect(captainNoteOf(reply('1 comment on Audit\n\nFirst.\n\nSecond.'))).toBe(
			'First.\n\nSecond.'
		);
	});

	it('keeps a body that does not open with the generated line, all of it', () => {
		expect(captainNoteOf(reply('Thanks, both points stand.'))).toBe('Thanks, both points stand.');
	});
});
