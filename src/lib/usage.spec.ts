import { describe, expect, it } from 'vitest';
import type { UsageRecord, UsageTotals } from './shapes.ts';
import { summarizeRecords } from './usage.ts';

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 9, 17, 12);

function totals(input: number, output: number): UsageTotals {
	return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output };
}

function record(overrides: Partial<UsageRecord>): UsageRecord {
	return {
		ts_ms: NOW - 2 * 60 * 60_000,
		machine: 'atlas',
		ship: 'billing',
		route: 'plan-main',
		harness: 'tidewater',
		jobs: 1,
		usage: totals(100, 10),
		...overrides
	};
}

describe('summarizeRecords', () => {
	it('only counts records inside the period', () => {
		const records = [
			record({ ts_ms: NOW - 2 * 60 * 60_000, usage: totals(100, 0) }),
			record({ ts_ms: NOW - 3 * DAY, usage: totals(900, 0) })
		];
		const summary = summarizeRecords(records, { since_ms: NOW - DAY, group_by: 'ship' });
		expect(summary.groups).toEqual([{ key: 'billing', jobs: 1, usage: totals(100, 0), gaps: [] }]);
	});

	it('groups by route, ship, machine and day', () => {
		const records = [
			record({ ship: 'billing', route: 'plan-main', machine: 'atlas' }),
			record({
				ship: 'docs',
				route: 'free-pool',
				machine: 'boreas',
				ts_ms: NOW - DAY - 3600_000,
				usage: totals(1, 1)
			})
		];
		const base = { since_ms: NOW - 7 * DAY, group_by: 'route' as const };
		expect(summarizeRecords(records, base).groups.map((g) => g.key)).toEqual([
			'plan-main',
			'free-pool'
		]);
		expect(
			summarizeRecords(records, { ...base, group_by: 'ship' }).groups.map((g) => g.key)
		).toEqual(['billing', 'docs']);
		expect(
			summarizeRecords(records, { ...base, group_by: 'machine' }).groups.map((g) => g.key)
		).toEqual(['atlas', 'boreas']);
		const days = summarizeRecords(records, { ...base, group_by: 'day' });
		expect(days.groups.map((g) => g.key)).toEqual(['2026-10-16', '2026-10-17']);
	});

	it('ranks by total tokens, largest first, but days oldest first', () => {
		const records = [
			record({ ship: 'small', usage: totals(5, 0), ts_ms: NOW - 2 * DAY }),
			record({ ship: 'big', usage: totals(500, 0), ts_ms: NOW - 1 * DAY })
		];
		const byShip = summarizeRecords(records, { since_ms: NOW - 7 * DAY, group_by: 'ship' });
		expect(byShip.groups.map((g) => g.key)).toEqual(['big', 'small']);
		const byDay = summarizeRecords(records, { since_ms: NOW - 7 * DAY, group_by: 'day' });
		expect(byDay.groups.map((g) => g.key)).toEqual(['2026-10-15', '2026-10-16']);
	});

	it('names a harness with no usage as a gap, and adds nothing for it', () => {
		const records = [
			record({
				ship: 'analytics',
				route: 'credits-reserve',
				harness: 'ferry',
				usage: null,
				jobs: 2
			}),
			record({
				ship: 'analytics',
				route: 'plan-main',
				harness: 'tidewater',
				usage: totals(40, 4),
				jobs: 1
			})
		];
		const summary = summarizeRecords(records, { since_ms: NOW - DAY, group_by: 'ship' });
		expect(summary.groups).toEqual([
			{ key: 'analytics', jobs: 3, usage: totals(40, 4), gaps: ['ferry'] }
		]);
	});

	it('keeps usage null for a group where nothing reports, but still counts its jobs and gap', () => {
		const records = [
			record({ ship: 'x', route: 'credits-reserve', harness: 'ferry', usage: null, jobs: 4 })
		];
		const summary = summarizeRecords(records, { since_ms: NOW - DAY, group_by: 'route' });
		expect(summary.groups).toEqual([
			{ key: 'credits-reserve', jobs: 4, usage: null, gaps: ['ferry'] }
		]);
	});

	it('respects an until bound', () => {
		const records = [record({ ts_ms: NOW - 1000, usage: totals(7, 0) })];
		const summary = summarizeRecords(records, {
			since_ms: NOW - DAY,
			until_ms: NOW - 2000,
			group_by: 'ship'
		});
		expect(summary.groups).toEqual([]);
		expect(summary.until_ms).toBe(NOW - 2000);
	});
});
