import { describe, expect, it } from 'vitest';
import {
	buildFleet,
	formatUpdated,
	isAwake,
	isRunning,
	isUnsure,
	presenceLabel,
	routeLabel,
	waitLabel
} from './fleet.ts';
import { parseSnapshot } from './shapes.ts';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

/** A snapshot in Privateer's shape, built through parseSnapshot like the real path. */
function snap(
	machines: Record<string, unknown>[],
	ships: Record<string, unknown>[] = [],
	needs: Record<string, unknown>[] = []
) {
	return parseSnapshot({ schema_version: 1, generated_ms: NOW, machines, ships, needs });
}

const machine = (name: string, extra: Record<string, unknown> = {}) => ({
	name,
	link: 'reaches',
	reachable: true,
	changed_ms: NOW - MIN,
	...extra
});

const ship = (name: string, on: string, extra: Record<string, unknown> = {}) => ({
	name,
	machine: on,
	presence: 'hosted',
	presence_since_ms: null,
	open_tasks_total: 0,
	jobs: [],
	...extra
});

const job = (id: string, state = 'running', extra: Record<string, unknown> = {}) => ({
	id,
	task_title: `task ${id}`,
	state,
	started_ms: NOW - MIN,
	...extra
});

describe('presence and job states', () => {
	it('counts only hosted and session as awake', () => {
		expect(isAwake('hosted')).toBe(true);
		expect(isAwake('session')).toBe(true);
		expect(isAwake('asleep')).toBe(false);
		expect(isAwake('absent')).toBe(false);
	});

	it('treats unknown and unavailable as not an all-clear', () => {
		expect(isUnsure('unknown')).toBe(true);
		expect(isUnsure('unavailable')).toBe(true);
		expect(isUnsure('hosted')).toBe(false);
		expect(isUnsure('asleep')).toBe(false);
	});

	it('counts starting, launching and running as running crew, and no other state', () => {
		const jobIn = (state: string) =>
			snap([machine('a')], [ship('s', 'a', { jobs: [job('j', state)] })]).machines[0].ships[0]
				.jobs[0];
		for (const state of ['starting', 'launching', 'running'])
			expect(isRunning(jobIn(state))).toBe(true);
		for (const state of ['queued', 'parked', 'orphaned'])
			expect(isRunning(jobIn(state))).toBe(false);
	});

	it('says how long a presence has held, and leaves out a time it does not know', () => {
		expect(presenceLabel('asleep', NOW - 2 * HOUR, NOW)).toBe('asleep for 2h');
		expect(presenceLabel('hosted', null, NOW)).toBe('hosted');
		expect(presenceLabel('hosted', NOW + MIN, NOW)).toBe('hosted');
	});

	it('words a wait by what it is for, with how long it has held', () => {
		expect(
			waitLabel(
				{ for: 'capacity', since_ms: NOW - 3 * MIN, job_id: null, park: null, behind: [] },
				NOW
			)
		).toBe('waiting for capacity for 3m');
		expect(
			waitLabel({ for: 'disk', since_ms: null, job_id: null, park: null, behind: [] }, NOW)
		).toBe('waiting for disk');
		expect(
			waitLabel({ for: 'job', since_ms: null, job_id: 'job-store-11', park: null, behind: [] }, NOW)
		).toBe('waiting on job-store-11');
	});
});

describe('buildFleet', () => {
	it('puts machines with needs or crew first, then idle ones, then unreachable last', () => {
		const view = buildFleet(
			snap(
				[machine('zeta', { reachable: false }), machine('idle'), machine('busy'), machine('needy')],
				[
					ship('a', 'zeta'),
					ship('b', 'idle', { presence: 'asleep' }),
					ship('c', 'busy', { jobs: [job('j')] }),
					ship('d', 'needy', { presence: 'asleep' })
				],
				[{ id: 'n', ship: 'd', machine: 'needy' }]
			)
		);
		expect(view.machines.map((m) => m.machine.name)).toEqual(['busy', 'needy', 'idle', 'zeta']);
	});

	it('sorts machines with the same rank by name', () => {
		const view = buildFleet(snap([machine('calypso'), machine('atlas')]));
		expect(view.machines.map((m) => m.machine.name)).toEqual(['atlas', 'calypso']);
	});

	it('orders ships: needs or orphaned crew, then running crew, then awake, then unknown, then the rest', () => {
		const view = buildFleet(
			snap(
				[machine('atlas')],
				[
					ship('asleep-b', 'atlas', { presence: 'asleep' }),
					ship('awake', 'atlas'),
					ship('crewed', 'atlas', { presence: 'asleep', jobs: [job('j')] }),
					ship('asleep-a', 'atlas', { presence: 'asleep' }),
					ship('unknown', 'atlas', { presence: 'unknown' }),
					ship('needs', 'atlas', { presence: 'asleep' }),
					ship('orphan', 'atlas', { presence: 'asleep', jobs: [job('o', 'orphaned')] })
				],
				[{ id: 'n', ship: 'needs', machine: 'atlas' }]
			)
		);
		expect(view.machines[0].ships.map((s) => s.ship.name)).toEqual([
			'needs',
			'orphan',
			'crewed',
			'awake',
			'unknown',
			'asleep-a',
			'asleep-b'
		]);
	});

	it('counts running, waiting and orphaned crew apart, and needs by machine and ship', () => {
		const view = buildFleet(
			snap(
				[machine('atlas')],
				[
					ship('billing', 'atlas', {
						jobs: [job('1'), job('2', 'queued'), job('3', 'parked'), job('4', 'orphaned')]
					})
				],
				[
					{ id: 'n1', ship: 'billing', machine: 'atlas' },
					{ id: 'n2', ship: 'billing', machine: 'boreas' },
					{ id: 'n3', ship: 'billing', machine: null }
				]
			)
		);
		expect(view.machines[0]).toMatchObject({
			needs: 2,
			running: 1,
			waiting: 2,
			orphaned: 1,
			awake: 1
		});
		expect(view.machines[0].ships[0]).toMatchObject({
			needs: 2,
			running: 1,
			waiting: 2,
			orphaned: 1,
			awake: true
		});
	});

	it('shows an unreachable machine as last known, with its counts at zero', () => {
		const view = buildFleet(
			snap(
				[machine('calypso', { reachable: false, as_of_ms: NOW - HOUR })],
				[ship('mobile-app', 'calypso', { jobs: [job('j')] })],
				[{ id: 'n', ship: 'mobile-app', machine: 'calypso' }]
			)
		);
		expect(view.machines[0]).toMatchObject({
			needs: 1,
			running: 0,
			waiting: 0,
			orphaned: 0,
			awake: 0,
			unsure: 0
		});
		expect(view.machines[0].ships[0]).toMatchObject({
			needs: 1,
			running: 0,
			awake: false,
			unsure: false
		});
		expect(view.machines[0].ships[0].ship.jobs).toHaveLength(1);
	});

	it('does not count unknown or unavailable presence as awake, and reports it as unsure', () => {
		const view = buildFleet(
			snap(
				[machine('atlas')],
				[
					ship('a', 'atlas', { presence: 'unknown' }),
					ship('b', 'atlas', { presence: 'unavailable' }),
					ship('c', 'atlas', { presence: 'hosted' })
				]
			)
		);
		expect(view.machines[0]).toMatchObject({ awake: 1, unsure: 2 });
		expect(view.summary).toMatchObject({ shipsAwake: 1, shipsUnsure: 2 });
	});

	it('summarises reachability, awake and unsure ships, crew, waiting, orphaned and needs', () => {
		const view = buildFleet(
			snap(
				[machine('atlas'), machine('boreas'), machine('calypso', { reachable: false })],
				[
					ship('billing', 'atlas', { jobs: [job('1'), job('2', 'queued')] }),
					ship('docs', 'atlas', { presence: 'asleep' }),
					ship('search', 'boreas', { jobs: [job('3', 'orphaned')] }),
					ship('ledger', 'boreas', { presence: 'unknown' }),
					ship('mobile-app', 'calypso', { jobs: [job('4')] })
				],
				[
					{ id: 'n1', ship: 'billing', machine: 'atlas' },
					{ id: 'n2', ship: 'search', machine: 'boreas' }
				]
			)
		);
		expect(view.summary).toEqual({
			machinesReachable: 2,
			machinesTotal: 3,
			shipsAwake: 2,
			shipsUnsure: 1,
			crew: 1,
			waiting: 1,
			orphaned: 1,
			needs: 2
		});
	});

	it('handles an empty fleet', () => {
		expect(buildFleet(snap([]))).toEqual({
			machines: [],
			summary: {
				machinesReachable: 0,
				machinesTotal: 0,
				shipsAwake: 0,
				shipsUnsure: 0,
				crew: 0,
				waiting: 0,
				orphaned: 0,
				needs: 0
			}
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
	const route = (state: string, until: number | null) =>
		parseSnapshot({
			machines: [{ name: 'a', routes: [{ name: 'r', state, until_ms: until }] }]
		}).machines[0].routes[0];

	it('shows the state, and how long until a backing-off route clears', () => {
		expect(routeLabel(route('available', null), NOW)).toBe('available');
		expect(routeLabel(route('idle', null), NOW)).toBe('idle');
		expect(routeLabel(route('backing_off', NOW + 9 * MIN), NOW)).toBe('backing off · 9m left');
		expect(routeLabel(route('capped', NOW - MIN), NOW)).toBe('capped');
	});
});
