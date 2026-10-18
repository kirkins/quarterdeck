import { describe, expect, it } from 'vitest';
import { buildFleet, formatUpdated, isAwake, routeLabel } from './fleet.ts';
import { parseSnapshot } from './shapes.ts';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

/** A snapshot with the fields the view reads, built through parseSnapshot like the real path. */
function snap(machines: unknown[], needs: unknown[] = []) {
	return parseSnapshot({ generated_ms: NOW, machines, needs });
}

const job = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	task_title: `task ${id}`,
	started_ms: NOW - MIN,
	...extra
});

describe('isAwake', () => {
	it('treats asleep and unknown presence as not awake', () => {
		expect(isAwake('hosted')).toBe(true);
		expect(isAwake('waking')).toBe(true);
		expect(isAwake('asleep')).toBe(false);
		expect(isAwake(null)).toBe(false);
	});
});

describe('buildFleet', () => {
	it('puts machines with needs or crew first, then idle ones, then unreachable last', () => {
		const view = buildFleet(
			snap(
				[
					{ name: 'zeta', reachable: false, ships: [{ name: 'a' }] },
					{ name: 'idle', reachable: true, ships: [{ name: 'b', presence: 'asleep' }] },
					{
						name: 'busy',
						reachable: true,
						ships: [{ name: 'c', presence: 'hosted', jobs: [job('j')] }]
					},
					{
						name: 'needy',
						reachable: true,
						ships: [{ name: 'd', presence: 'asleep' }]
					}
				],
				[{ id: 'n', ship: 'd' }]
			)
		);
		expect(view.machines.map((m) => m.machine.name)).toEqual(['busy', 'needy', 'idle', 'zeta']);
	});

	it('sorts machines with the same rank by name', () => {
		const view = buildFleet(
			snap([
				{ name: 'calypso', reachable: true, ships: [] },
				{ name: 'atlas', reachable: true, ships: [] }
			])
		);
		expect(view.machines.map((m) => m.machine.name)).toEqual(['atlas', 'calypso']);
	});

	it('orders ships: needs, then crew, then awake, then asleep, then by name', () => {
		const view = buildFleet(
			snap(
				[
					{
						name: 'atlas',
						reachable: true,
						ships: [
							{ name: 'asleep-b', presence: 'asleep' },
							{ name: 'awake', presence: 'hosted' },
							{ name: 'crewed', presence: 'asleep', jobs: [job('j')] },
							{ name: 'asleep-a', presence: 'asleep' },
							{ name: 'needs', presence: 'asleep' }
						]
					}
				],
				[{ id: 'n', ship: 'needs' }]
			)
		);
		expect(view.machines[0].ships.map((s) => s.ship.name)).toEqual([
			'needs',
			'crewed',
			'awake',
			'asleep-a',
			'asleep-b'
		]);
	});

	it('counts needs, crew and awake ships for each reachable machine', () => {
		const view = buildFleet(
			snap(
				[
					{
						name: 'atlas',
						reachable: true,
						ships: [
							{ name: 'billing', presence: 'hosted', jobs: [job('1'), job('2')] },
							{ name: 'docs', presence: 'asleep' }
						]
					}
				],
				[
					{ id: 'n1', ship: 'billing' },
					{ id: 'n2', ship: 'billing' }
				]
			)
		);
		expect(view.machines[0]).toMatchObject({ needs: 2, crew: 2, awake: 1 });
		expect(view.machines[0].ships[0]).toMatchObject({ needs: 2, awake: true });
	});

	it('shows nothing for an unreachable machine: no counts, no awake ships', () => {
		const view = buildFleet(
			snap(
				[
					{
						name: 'calypso',
						reachable: false,
						ships: [{ name: 'mobile-app', presence: 'hosted', jobs: [job('j')] }]
					}
				],
				[{ id: 'n', ship: 'mobile-app' }]
			)
		);
		expect(view.machines[0]).toMatchObject({ needs: 0, crew: 0, awake: 0 });
		expect(view.machines[0].ships[0]).toMatchObject({ needs: 0, awake: false });
	});

	it('summarises reachability, awake ships, crew and needs', () => {
		const view = buildFleet(
			snap(
				[
					{
						name: 'atlas',
						reachable: true,
						ships: [
							{ name: 'billing', presence: 'hosted', jobs: [job('1')] },
							{ name: 'docs', presence: 'asleep' }
						]
					},
					{ name: 'boreas', reachable: true, ships: [{ name: 'search', presence: 'hosted' }] },
					{ name: 'calypso', reachable: false, ships: [{ name: 'mobile-app' }] }
				],
				[
					{ id: 'n1', ship: 'billing' },
					{ id: 'n2', ship: 'search' }
				]
			)
		);
		expect(view.summary).toEqual({
			machinesReachable: 2,
			machinesTotal: 3,
			shipsAwake: 2,
			crew: 1,
			needs: 2
		});
	});

	it('handles an empty fleet', () => {
		expect(buildFleet(snap([]))).toEqual({
			machines: [],
			summary: { machinesReachable: 0, machinesTotal: 0, shipsAwake: 0, crew: 0, needs: 0 }
		});
	});
});

describe('formatUpdated', () => {
	it('counts seconds under a minute, then minutes', () => {
		expect(formatUpdated(NOW - 12_000, NOW)).toBe('12s ago');
		expect(formatUpdated(NOW - 59_000, NOW)).toBe('59s ago');
		expect(formatUpdated(NOW - 3 * MIN, NOW)).toBe('3m ago');
	});

	it('never shows a negative age when the clocks disagree', () => {
		expect(formatUpdated(NOW + 2000, NOW)).toBe('0s ago');
	});
});

describe('routeLabel', () => {
	it('shows the state, and how long until a backing-off route clears', () => {
		expect(
			routeLabel(
				{
					name: 'primary',
					harness: null,
					model: null,
					cost: null,
					state: 'available',
					until_ms: null,
					resets_at: null,
					last_error: null
				},
				NOW
			)
		).toBe('available');
		expect(
			routeLabel(
				{
					name: 'overflow',
					harness: null,
					model: null,
					cost: null,
					state: 'backing_off',
					until_ms: NOW + 9 * MIN,
					resets_at: null,
					last_error: null
				},
				NOW
			)
		).toBe('backing off · 9m left');
		expect(
			routeLabel(
				{
					name: 'x',
					harness: null,
					model: null,
					cost: null,
					state: 'capped',
					until_ms: NOW - MIN,
					resets_at: null,
					last_error: null
				},
				NOW
			)
		).toBe('capped');
	});
});
