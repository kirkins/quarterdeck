/**
 * Reads what the ship page shows about one ship: its place on the fleet map and
 * its profile. The two reads are independent, so one that fails or that an older
 * Privateer does not offer leaves the other standing, and each tab says its own state.
 */
import { isShipName, shipFacts, type ShipFacts } from '#lib/ship.ts';
import type { ShipProfile } from '#lib/shapes.ts';
import { errorText } from './submit.ts';
import type { Source } from './source.ts';

/**
 * `error` is a read that failed; `unsupported` is an older Privateer; `not_found` is a ship it
 * does not know; `elsewhere` is a ship that runs on another machine, whose Privateer answers for it.
 */
export type ProfileState = 'ok' | 'unsupported' | 'error' | 'not_found' | 'elsewhere';
export type FactsState = 'ok' | 'unsupported' | 'error';

export interface ShipView {
	name: string;
	/** True when the name is not a ship, or the fleet and Privateer both do not know it. */
	notFound: boolean;
	facts: ShipFacts | null;
	factsState: FactsState;
	factsError: string | null;
	profile: ShipProfile | null;
	profileState: ProfileState;
	profileError: string | null;
	/** The machine that runs the ship, when its tools are read there. */
	profileMachine: string | null;
}

export async function loadShipView(source: Source, name: string): Promise<ShipView> {
	if (!isShipName(name)) {
		return {
			name,
			notFound: true,
			facts: null,
			factsState: 'ok',
			factsError: null,
			profile: null,
			profileState: 'not_found',
			profileError: null,
			profileMachine: null
		};
	}
	const [snapshot, profile] = await Promise.allSettled([
		source.snapshot(),
		source.shipProfile(name)
	]);

	let facts: ShipFacts | null = null;
	let factsState: FactsState = 'ok';
	let factsError: string | null = null;
	if (snapshot.status === 'rejected') {
		factsState = 'error';
		factsError = errorText(snapshot.reason);
	} else if (snapshot.value.status === 'unsupported') {
		factsState = 'unsupported';
	} else {
		facts = shipFacts(snapshot.value.snapshot, name);
	}

	let shipProfile: ShipProfile | null = null;
	let profileState: ProfileState;
	let profileError: string | null = null;
	let profileMachine: string | null = null;
	if (profile.status === 'rejected') {
		profileState = 'error';
		profileError = errorText(profile.reason);
	} else {
		profileState = profile.value.status;
		if (profile.value.status === 'ok') shipProfile = profile.value.value;
		if (profile.value.status === 'elsewhere') profileMachine = profile.value.machine;
	}

	return {
		name,
		notFound: profileState === 'not_found' && facts === null,
		facts,
		factsState,
		factsError,
		profile: shipProfile,
		profileState,
		profileError,
		profileMachine
	};
}
