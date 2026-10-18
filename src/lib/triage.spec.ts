import { describe, expect, it } from 'vitest';
import { askKey, type MailItem } from '#lib/decision.ts';
import {
	buildTriage,
	compareRows,
	filterRows,
	groupSections,
	readFilter,
	rowOf,
	sectionOf,
	triageKind,
	type TriageRow
} from './triage.ts';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function item(id: string, over: Partial<MailItem> = {}): MailItem {
	return {
		id,
		from: 'billing',
		to: 'captain',
		kind: 'request',
		payload: {},
		urgency: 'normal',
		deadline_ms: null,
		asked_ms: NOW - 10 * MIN,
		...over
	};
}

function ids(rows: TriageRow[]): string[] {
	return rows.map((r) => r.item.id);
}

describe('triageKind', () => {
	it('tells decisions, requests, approvals and blockers apart', () => {
		expect(triageKind(item('a', { kind: 'decision' }))).toBe('decision');
		expect(triageKind(item('b', { payload: { choices: ['x', 'y'] } }))).toBe('decision');
		expect(triageKind(item('c'))).toBe('request');
		expect(triageKind(item('d', { kind: 'approval' }))).toBe('approval');
		expect(triageKind(item('e', { request_kind: 'production_approval' }))).toBe('approval');
		expect(triageKind(item('f', { kind: 'blocker' }))).toBe('blocker');
	});
});

describe('sectionOf', () => {
	it('puts high urgency, overdue and due-within-a-day in "now"', () => {
		expect(sectionOf({ urgency: 'high', overdue: false, deadline_ms: null }, NOW)).toBe('now');
		expect(sectionOf({ urgency: 'normal', overdue: true, deadline_ms: NOW - 1 }, NOW)).toBe('now');
		expect(sectionOf({ urgency: 'normal', overdue: false, deadline_ms: NOW + DAY - 1 }, NOW)).toBe(
			'now'
		);
	});

	it('puts low urgency in "later", and everything else in "waiting"', () => {
		expect(sectionOf({ urgency: 'low', overdue: false, deadline_ms: null }, NOW)).toBe('later');
		expect(sectionOf({ urgency: 'low', overdue: false, deadline_ms: NOW + 3 * DAY }, NOW)).toBe(
			'later'
		);
		expect(sectionOf({ urgency: 'normal', overdue: false, deadline_ms: null }, NOW)).toBe(
			'waiting'
		);
		expect(sectionOf({ urgency: 'normal', overdue: false, deadline_ms: NOW + 3 * DAY }, NOW)).toBe(
			'waiting'
		);
	});

	it('treats a deadline exactly now as overdue', () => {
		expect(rowOf(item('x', { deadline_ms: NOW }), NOW).overdue).toBe(true);
	});
});

describe('compareRows', () => {
	it('orders urgency high first, then overdue, then nearest deadline, then oldest', () => {
		const rows = buildTriage(
			[
				item('low-old', { urgency: 'low', asked_ms: NOW - 9 * DAY }),
				item('normal-none-old', { asked_ms: NOW - 3 * DAY }),
				item('normal-none-new', { asked_ms: NOW - MIN }),
				item('normal-later', { deadline_ms: NOW + 2 * DAY }),
				item('normal-sooner', { deadline_ms: NOW + 5 * MIN }),
				item('normal-overdue', { deadline_ms: NOW - MIN }),
				item('high-none', { urgency: 'high', asked_ms: NOW - MIN }),
				item('high-overdue', { urgency: 'high', deadline_ms: NOW - 2 * MIN })
			],
			NOW
		).rows;
		expect(ids(rows)).toEqual([
			'high-overdue',
			'high-none',
			'normal-overdue',
			'normal-sooner',
			'normal-later',
			'normal-none-old',
			'normal-none-new',
			'low-old'
		]);
	});

	it('breaks ties on age, then id, so the order is stable', () => {
		const rows = buildTriage(
			[
				item('b', { asked_ms: NOW - MIN }),
				item('a', { asked_ms: NOW - MIN }),
				item('c', { asked_ms: NOW - 5 * MIN })
			],
			NOW
		).rows;
		expect(ids(rows)).toEqual(['c', 'a', 'b']);
		expect(compareRows(rows[1], rows[2])).toBeLessThan(0);
	});

	it('sorts ties on urgency and overdue by deadline, with no deadline last', () => {
		const rows = buildTriage(
			[
				item('none'),
				item('late', { deadline_ms: NOW + 2 * DAY }),
				item('soon', { deadline_ms: NOW + DAY })
			],
			NOW
		).rows;
		expect(ids(rows)).toEqual(['soon', 'late', 'none']);
	});
});

describe('buildTriage', () => {
	it('drops answered asks and duplicates, and lists the ships', () => {
		const answered = new Map([[askKey('billing', 'answered'), { at_ms: NOW, sent: true }]]);
		const { rows, ships } = buildTriage(
			[
				item('answered'),
				item('one', { from: 'storefront' }),
				item('one', { from: 'storefront' }),
				item('two', { from: 'billing' })
			],
			NOW,
			answered
		);
		expect(ids(rows).sort()).toEqual(['one', 'two']);
		expect(ships).toEqual(['billing', 'storefront']);
	});

	it('keeps an id that another ship answered, and drops a dismissed one', () => {
		const dismissed = new Map([[askKey('storefront', 'same'), { at_ms: NOW, sent: true }]]);
		const { rows } = buildTriage(
			[item('same', { from: 'storefront' }), item('same', { from: 'billing' })],
			NOW,
			dismissed
		);
		expect(rows.map((r) => r.item.from)).toEqual(['billing']);
	});

	it('shows notices and reports as notices, not requests', () => {
		expect(triageKind(item('n', { kind: 'notice' }))).toBe('notice');
		expect(triageKind(item('r', { kind: 'report' }))).toBe('notice');
	});
});

describe('sections, filters and stored filters', () => {
	const rows = buildTriage(
		[
			item('hi', { urgency: 'high', kind: 'decision' }),
			item('req', { from: 'storefront' }),
			item('quiet', { urgency: 'low' })
		],
		NOW
	).rows;

	it('groups non-empty sections in display order', () => {
		expect(groupSections(rows).map((s) => [s.id, s.rows.map((r) => r.item.id)])).toEqual([
			['now', ['hi']],
			['waiting', ['req']],
			['later', ['quiet']]
		]);
	});

	it('filters by ship and by kind together', () => {
		expect(ids(filterRows(rows, { ship: 'storefront', kind: null }))).toEqual(['req']);
		expect(ids(filterRows(rows, { ship: null, kind: 'decision' }))).toEqual(['hi']);
		expect(filterRows(rows, { ship: 'storefront', kind: 'decision' })).toEqual([]);
		expect(filterRows(rows, { ship: null, kind: null })).toHaveLength(3);
	});

	it('reads a stored filter, and ignores anything else', () => {
		expect(readFilter('{"ship":"billing","kind":"approval"}')).toEqual({
			ship: 'billing',
			kind: 'approval'
		});
		expect(readFilter('{"ship":"billing","kind":"nope"}')).toEqual({ ship: 'billing', kind: null });
		expect(readFilter('not json')).toEqual({ ship: null, kind: null });
		expect(readFilter(null)).toEqual({ ship: null, kind: null });
		expect(readFilter('[1,2]')).toEqual({ ship: null, kind: null });
	});
});
