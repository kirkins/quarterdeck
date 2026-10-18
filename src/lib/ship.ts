/**
 * The ship page: what a ship's name must look like, its header facts from the
 * fleet map, and the search over its tools. Pure, so the server and the page
 * agree, and it is unit tested without Privateer.
 */
import type { FleetJob, FleetSnapshot, Presence, ShipProfile } from '#lib/shapes.ts';

/** A ship name is a word with letters, digits, dots, dashes or underscores. Anything else is not a ship. */
const SHIP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isShipName(name: string): boolean {
	return SHIP_NAME.test(name);
}

/** The two tabs on a ship. The conversation is the default. */
export const SHIP_TABS = [
	{ id: 'conversation', label: 'Conversation' },
	{ id: 'tools', label: 'Tools' }
] as const;

export type ShipTab = (typeof SHIP_TABS)[number]['id'];

/** Reads the tab a URL asks for; anything unknown is the conversation. */
export function tabOf(raw: string | null): ShipTab {
	return raw === 'tools' ? 'tools' : 'conversation';
}

/** What the fleet map says about one ship, for the page header. */
export interface ShipFacts {
	machine: string;
	reachable: boolean;
	presence: Presence;
	presenceSince: number | null;
	openTasks: number;
	/** The live crew on the ship: running, queued, parked or orphaned, each with what it is doing. */
	jobs: FleetJob[];
	/** Items from runtime.needs that name this ship. */
	needs: number;
}

/** The ship's facts, or null when the fleet map does not place it on any machine. */
export function shipFacts(snapshot: FleetSnapshot, name: string): ShipFacts | null {
	for (const machine of snapshot.machines) {
		const ship = machine.ships.find((s) => s.name === name);
		if (!ship) continue;
		return {
			machine: machine.name,
			reachable: machine.reachable,
			presence: ship.presence,
			presenceSince: ship.presence_since_ms,
			openTasks: ship.open_tasks_total,
			jobs: ship.jobs,
			needs: snapshot.needs.filter(
				(n) => n.ship === name && (n.machine === null || n.machine === machine.name)
			).length
		};
	}
	return null;
}

/** Lists longer than this collapse behind a count, so a phone shows the first few. */
export const COLLAPSE_AFTER = 5;

/** The tools whose name, description or URL contain the query, case-insensitively. An empty query keeps all. */
export function matchTools(profile: ShipProfile, query: string) {
	const q = query.trim().toLowerCase();
	const has = (...parts: (string | null)[]) =>
		q === '' || parts.some((p) => (p ?? '').toLowerCase().includes(q));
	return {
		skills: profile.skills.filter((s) => has(s.name, s.description)),
		mcpServers: profile.mcpServers.filter((m) => has(m.name, m.url, ...m.credentials)),
		plugins: profile.plugins.filter((p) => has(p.name, p.description))
	};
}
