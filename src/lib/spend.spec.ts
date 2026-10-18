import { describe, expect, it } from 'vitest';
import {
	parseSnapshot,
	type FleetAllowance,
	type RoutesConfig,
	type UsageSummary
} from './shapes.ts';
import {
	allowanceLabel,
	buildRoutes,
	buildUsage,
	costClass,
	formatTokens,
	groupLabel,
	parseGrouping,
	parsePeriod,
	sinceFor
} from './spend.ts';

const NOW = Date.UTC(2026, 9, 17, 12);
const MIN = 60_000;
const HOUR = 60 * MIN;

function route(overrides: Record<string, unknown>) {
	return {
		name: 'plan-main',
		route: null,
		cost: null,
		tier: null,
		state: 'available',
		until_ms: null,
		error: null,
		allowance: null,
		...overrides
	};
}

/** The fleet snapshot as parseSnapshot reads it from Privateer. */
function snapshot(machines: Array<{ name: string; routes: ReturnType<typeof route>[] }>) {
	return parseSnapshot({
		generated_ms: NOW,
		machines: machines.map((m) => ({
			name: m.name,
			reachable: true,
			changed_ms: NOW,
			routes: m.routes
		})),
		ships: [],
		needs: []
	});
}

const config: RoutesConfig = {
	routes: [
		{
			name: 'free-pool',
			cost: 'free',
			note: 'Scouting',
			options: [],
			manifest: null,
			allowance_resets_utc: null
		},
		{
			name: 'plan-main',
			cost: 'plan',
			note: 'Shared',
			options: [],
			manifest: null,
			allowance_resets_utc: null
		},
		{
			name: 'credits-reserve',
			cost: 'credits',
			note: 'Last resort',
			options: [],
			manifest: null,
			allowance_resets_utc: null
		}
	],
	order: { crew: ['free-pool', 'plan-main', 'credits-reserve'], errand: [], first_mate: [] }
};

describe('buildRoutes', () => {
	it('puts throttled routes first, then the try order, then the rest by name', () => {
		const fleet = snapshot([
			{
				name: 'atlas',
				routes: [
					route({ name: 'credits-reserve', cost: 'credits' }),
					route({ name: 'plan-main', cost: 'plan' }),
					route({ name: 'free-pool', cost: 'free', state: 'backing_off', until_ms: NOW + 9 * MIN })
				]
			},
			{
				name: 'boreas',
				routes: [
					route({ name: 'plan-main', cost: 'plan', state: 'capped', until_ms: NOW + 2 * HOUR })
				]
			},
			{ name: 'calypso', routes: [route({ name: 'zeta' }), route({ name: 'alpha' })] }
		]);
		const rows = buildRoutes(fleet, config, NOW);
		expect(rows.map((r) => r.name)).toEqual([
			'free-pool',
			'plan-main',
			'credits-reserve',
			'alpha',
			'zeta'
		]);
		expect(rows.map((r) => r.throttled)).toEqual([true, true, false, false, false]);
	});

	it('gives each machine its own state, with a relative time while throttled', () => {
		const fleet = snapshot([
			{
				name: 'atlas',
				routes: [
					route({ name: 'free-pool', cost: 'free', state: 'backing_off', until_ms: NOW + 9 * MIN })
				]
			},
			{ name: 'boreas', routes: [route({ name: 'free-pool', cost: 'free', state: 'available' })] }
		]);
		const [row] = buildRoutes(fleet, config, NOW);
		expect(row.states).toEqual([
			{
				machine: 'atlas',
				kind: 'backing_off',
				label: 'backing off, back in 9m',
				clearsAt: NOW + 9 * MIN,
				lastError: null,
				identity: null,
				allowance: null
			},
			{
				machine: 'boreas',
				kind: 'available',
				label: 'available',
				clearsAt: null,
				lastError: null,
				identity: null,
				allowance: null
			}
		]);
	});

	it('names the route Privateer reports, and shows an allowance as shares of its window and week', () => {
		const fleet = snapshot([
			{
				name: 'boreas',
				routes: [
					route({
						name: 'plan-main',
						route: 'tidewater large',
						cost: 'plan',
						allowance: {
							shape: 'rolling',
							window_ends_ms: NOW + 2 * HOUR,
							weekly_ends_ms: NOW + 3 * HOUR * 24,
							window_used: 0.4,
							week_used: 0.875,
							last_used_ms: NOW - MIN
						}
					})
				]
			}
		]);
		const row = buildRoutes(fleet, config, NOW).find((r) => r.name === 'plan-main');
		expect(row?.states[0].identity).toBe('tidewater large');
		expect(row?.states[0].allowance).toContain('allowance: window 40% used, resets in ');
		expect(row?.states[0].allowance).toContain(' · week 88% used, resets in ');
		// The allowance is shown on the machine, so the row keeps no plan-not-reported note.
		expect(row?.budget).toBeNull();
	});

	it('says the plan allowance is not reported when no machine reports one', () => {
		const fleet = snapshot([
			{ name: 'boreas', routes: [route({ name: 'plan-main', cost: 'plan' })] }
		]);
		const row = buildRoutes(fleet, config, NOW).find((r) => r.name === 'plan-main');
		expect(row?.budget).toBe('Plan allowance: not reported');
	});

	it('reads an allowance as a share from 0 to 1, and leaves it out when no share is reported', () => {
		const none: FleetAllowance = {
			shape: null,
			window_ends_ms: null,
			weekly_ends_ms: null,
			window_used: null,
			week_used: null,
			last_used_ms: null
		};
		expect(allowanceLabel(none, NOW)).toBeNull();
		expect(allowanceLabel({ ...none, week_used: 1 }, NOW)).toBe('allowance: week 100% used');
		// An end time already past is not a reset to count down to.
		expect(allowanceLabel({ ...none, window_used: 0.1, window_ends_ms: NOW - MIN }, NOW)).toBe(
			'allowance: window 10% used'
		);
	});

	it('shows a capped route as resetting, from until_ms', () => {
		const fleet = snapshot([
			{
				name: 'boreas',
				routes: [
					route({
						name: 'plan-main',
						cost: 'plan',
						state: 'capped',
						until_ms: NOW + 130 * MIN,
						error: 'Weekly allowance used'
					})
				]
			}
		]);
		const [row] = buildRoutes(fleet, config, NOW);
		expect(row.states[0].label).toBe('capped, resets in 2h 10m');
		expect(row.states[0].lastError).toBe('Weekly allowance used');
		expect(row.budget).toBe('Plan allowance: not reported');
	});

	it('treats an idle route as usable: not throttled, with no countdown', () => {
		const fleet = snapshot([
			{ name: 'atlas', routes: [route({ name: 'free-pool', cost: 'free', state: 'idle' })] }
		]);
		const [row] = buildRoutes(fleet, config, NOW);
		expect(row).toMatchObject({ throttled: false });
		expect(row.states[0]).toMatchObject({ kind: 'idle', label: 'idle', clearsAt: null });
	});

	it('does not call a plan allowance unreported once Privateer reports one', () => {
		const fleet = snapshot([
			{
				name: 'atlas',
				routes: [
					route({
						cost: 'plan',
						allowance: {
							shape: 'window',
							window_ends_ms: NOW,
							weekly_ends_ms: NOW,
							window_used: 1,
							week_used: 2,
							last_used_ms: NOW
						}
					})
				]
			}
		]);
		const [row] = buildRoutes(fleet, config, NOW);
		expect(row.budget).toBeNull();
	});

	it('says a backoff is over when its time has passed, rather than counting down', () => {
		const fleet = snapshot([
			{
				name: 'atlas',
				routes: [
					route({ name: 'free-pool', cost: 'free', state: 'backing_off', until_ms: NOW - MIN })
				]
			}
		]);
		const [row] = buildRoutes(fleet, config, NOW);
		expect(row.states[0].label).toBe('backing off');
		expect(row.states[0].clearsAt).toBeNull();
	});

	it('reports credit balances as not reported, and keeps notes and try order from routes.show', () => {
		const fleet = snapshot([
			{ name: 'atlas', routes: [route({ name: 'credits-reserve', cost: 'credits' })] }
		]);
		const row = buildRoutes(fleet, config, NOW).find((r) => r.name === 'credits-reserve');
		expect(row).toMatchObject({
			cost: 'credits',
			costLabel: 'Credits',
			note: 'Last resort',
			tryOrder: 2,
			budget: 'Credit balance: not reported'
		});
	});

	it('still lists routes from routes.show that no machine reports, and works without it', () => {
		const fleet = snapshot([
			{ name: 'atlas', routes: [route({ name: 'plan-main', cost: 'plan' })] }
		]);
		const rows = buildRoutes(fleet, config, NOW);
		expect(rows.map((r) => r.name)).toEqual(['free-pool', 'plan-main', 'credits-reserve']);
		expect(rows[0].states).toEqual([]);

		const bare = buildRoutes(fleet, null, NOW);
		expect(bare).toHaveLength(1);
		expect(bare[0]).toMatchObject({ note: null, tryOrder: null, cost: 'plan' });
	});

	it('uses the fleet cost when routes.show is missing, and marks an unknown cost as such', () => {
		const fleet = snapshot([
			{ name: 'atlas', routes: [route({ name: 'mystery', cost: 'barter' })] }
		]);
		const [row] = buildRoutes(fleet, null, NOW);
		expect(row.cost).toBe('unknown');
		expect(row.costLabel).toBe('Cost not reported');
		expect(row.budget).toBeNull();
	});
});

describe('costClass', () => {
	it('accepts the three costs and nothing else', () => {
		expect(['free', 'plan', 'credits'].map(costClass)).toEqual(['free', 'plan', 'credits']);
		expect(costClass(null)).toBe('unknown');
		expect(costClass('FREE')).toBe('unknown');
	});
});

describe('period and grouping switches', () => {
	it('falls back to the default for anything it does not know', () => {
		expect(parsePeriod('24h')).toBe('24h');
		expect(parsePeriod('30d')).toBe('30d');
		expect(parsePeriod('1y')).toBe('7d');
		expect(parsePeriod(null)).toBe('7d');
		expect(parseGrouping('ship')).toBe('ship');
		expect(parseGrouping('province')).toBe('route');
		expect(parseGrouping(undefined)).toBe('route');
	});

	it('counts a 24 h period back from now', () => {
		expect(sinceFor('24h', NOW)).toBe(NOW - 24 * HOUR);
	});

	it('starts a period of days at the midnight that opens its first day, whatever the hour', () => {
		const midnight = Date.UTC(2026, 9, 17);
		expect(sinceFor('7d', NOW)).toBe(midnight - 6 * 24 * HOUR);
		expect(sinceFor('30d', NOW)).toBe(midnight - 29 * 24 * HOUR);
		// Late in the day and early in it give the same thirty days.
		expect(sinceFor('30d', midnight + 23 * HOUR)).toBe(sinceFor('30d', midnight + HOUR));
	});
});

describe('formatTokens', () => {
	it('abbreviates large counts and says so when there is none', () => {
		expect(formatTokens(null)).toBe('not reported');
		expect(formatTokens(0)).toBe('0');
		expect(formatTokens(912)).toBe('912');
		expect(formatTokens(8_400)).toBe('8.4k');
		expect(formatTokens(845_000)).toBe('845k');
		expect(formatTokens(1_200_000)).toBe('1.2M');
		expect(formatTokens(3_100_000_000)).toBe('3.1B');
	});
});

describe('groupLabel', () => {
	it('shows a day as day and month, and leaves other keys as they are', () => {
		expect(groupLabel('2026-10-16', 'day')).toBe('16 Oct');
		expect(groupLabel('billing', 'ship')).toBe('billing');
	});
});

describe('buildUsage', () => {
	const summary: UsageSummary = {
		since_ms: NOW - 7 * 24 * HOUR,
		until_ms: null,
		group_by: 'ship',
		groups: [
			{
				key: 'billing',
				jobs: 3,
				usage: {
					input: 800_000,
					output: 200_000,
					cacheRead: 4_000_000,
					cacheWrite: 300_000,
					totalTokens: 5_300_000
				},
				gaps: []
			},
			{ key: 'analytics', jobs: 2, usage: null, gaps: ['ferry'] },
			{
				key: 'docs-site',
				jobs: 1,
				usage: {
					input: 50_000,
					output: 10_000,
					cacheRead: null,
					cacheWrite: null,
					totalTokens: 60_000
				},
				gaps: []
			}
		]
	};

	it('scales each bar to the largest group, with a visible minimum', () => {
		const view = buildUsage(summary, 'ship');
		expect(view.rows.map((r) => r.key)).toEqual(['billing', 'analytics', 'docs-site']);
		expect(view.rows[0].share).toBe(100);
		expect(view.rows[1].share).toBe(0);
		expect(view.rows[2].share).toBeGreaterThan(0);
		expect(view.rows[2].share).toBeLessThan(5);
	});

	it('labels totals with input, output and cache apart, and names the gap', () => {
		const view = buildUsage(summary, 'ship');
		expect(view.rows[0]).toMatchObject({
			totalLabel: '5.3M',
			input: '800k',
			output: '200k',
			cacheRead: '4.0M',
			cacheWrite: '300k'
		});
		expect(view.rows[1]).toMatchObject({ totalLabel: 'not reported', gaps: ['ferry'] });
		expect(view.totals).toEqual({
			input: 850_000,
			output: 210_000,
			cacheRead: 4_000_000,
			cacheWrite: 300_000,
			totalTokens: 5_360_000
		});
		expect(view.jobs).toBe(6);
		expect(view.gaps).toEqual(['ferry']);
	});

	it('has no totals when nothing in the period reports usage', () => {
		const none = buildUsage(
			{ ...summary, groups: [{ key: 'x', jobs: 1, usage: null, gaps: ['ferry'] }] },
			'route'
		);
		expect(none.totals).toBeNull();
		expect(none.rows[0].share).toBe(0);
	});

	it('turns a day key into a label for the chart', () => {
		expect(
			buildUsage(
				{
					...summary,
					group_by: 'day',
					groups: [{ key: '2026-10-01', jobs: 1, usage: null, gaps: [] }]
				},
				'day'
			).rows[0].label
		).toBe('1 Oct');
	});
});
