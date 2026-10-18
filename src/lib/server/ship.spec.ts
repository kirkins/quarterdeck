import { describe, expect, it, vi } from 'vitest';
import { parseSnapshot } from '#lib/shapes.ts';
import { loadShipView } from './ship.ts';
import type { ShipRead, Source, FleetRead } from './source.ts';

const snapshot = parseSnapshot({
	machines: [
		{
			name: 'atlas',
			reachable: true,
			ships: [{ name: 'billing', presence: 'hosted', open_tasks: 1, jobs: [] }]
		}
	],
	needs: []
});

/** A source whose two reads answer as given; the other methods are never called here. */
function sourceWith(snap: FleetRead | Error, profile: ShipRead | Error) {
	const source = {
		snapshot: vi.fn(async () => {
			if (snap instanceof Error) throw snap;
			return snap;
		}),
		shipProfile: vi.fn(async () => {
			if (profile instanceof Error) throw profile;
			return profile;
		})
	};
	return { source: source as unknown as Source, mock: source };
}

const okProfile: ShipRead = {
	status: 'ok',
	value: {
		ship: 'billing',
		machine: 'atlas',
		hosted: true,
		sleep: { policy: null, idle_minutes: null },
		firstMate: { harness: null, options: [] },
		routes: [],
		charter: { actions: [], active: null },
		permissions: { fleetMode: null, fleetRules: [] },
		toolBundles: { bounded: null, error: null },
		skills: [],
		mcpServers: [],
		plugins: []
	}
};

describe('loadShipView', () => {
	it('answers a name that is not a ship without asking Privateer', async () => {
		const { source, mock } = sourceWith({ status: 'ok', snapshot }, okProfile);
		const view = await loadShipView(source, '../etc');
		expect(view.notFound).toBe(true);
		expect(mock.snapshot).not.toHaveBeenCalled();
		expect(mock.shipProfile).not.toHaveBeenCalled();
	});

	it('shows a ship with its facts and its profile', async () => {
		const { source } = sourceWith({ status: 'ok', snapshot }, okProfile);
		const view = await loadShipView(source, 'billing');
		expect(view).toMatchObject({
			notFound: false,
			facts: { machine: 'atlas', presence: 'hosted', openTasks: 1 },
			factsState: 'ok',
			profileState: 'ok',
			profile: { ship: 'billing', machine: 'atlas' }
		});
	});

	it('is not found when neither the fleet nor Privateer knows the ship', async () => {
		const { source } = sourceWith({ status: 'ok', snapshot }, { status: 'not_found' });
		const view = await loadShipView(source, 'ghost');
		expect(view.notFound).toBe(true);
		expect(view.profileState).toBe('not_found');
	});

	it('is not a not-found page when the fleet places the ship but it has no profile', async () => {
		const { source } = sourceWith({ status: 'ok', snapshot }, { status: 'not_found' });
		const view = await loadShipView(source, 'billing');
		expect(view.notFound).toBe(false);
		expect(view.facts?.machine).toBe('atlas');
		expect(view.profileState).toBe('not_found');
	});

	it('keeps the header when the profile is unsupported, and the profile when the fleet is', async () => {
		const older = sourceWith({ status: 'unsupported' }, { status: 'unsupported' });
		const both = await loadShipView(older.source, 'billing');
		expect(both).toMatchObject({
			notFound: false,
			factsState: 'unsupported',
			profileState: 'unsupported'
		});

		const fleetDown = sourceWith(new Error('fleet exploded'), okProfile);
		const view = await loadShipView(fleetDown.source, 'billing');
		expect(view).toMatchObject({
			factsState: 'error',
			factsError: 'fleet exploded',
			profileState: 'ok'
		});
	});

	it('says a ship on another machine is read there, and is not a not-found page', async () => {
		const { source } = sourceWith(
			{ status: 'ok', snapshot },
			{ status: 'elsewhere', machine: 'boreas' }
		);
		const view = await loadShipView(source, 'search-index');
		expect(view).toMatchObject({
			notFound: false,
			profileState: 'elsewhere',
			profileMachine: 'boreas',
			profile: null,
			profileError: null
		});
	});

	it('reports a failed profile read as an error, not as a missing ship', async () => {
		const { source } = sourceWith({ status: 'ok', snapshot }, new Error('timed out'));
		const view = await loadShipView(source, 'billing');
		expect(view).toMatchObject({
			notFound: false,
			profileState: 'error',
			profileError: 'timed out'
		});
	});
});
