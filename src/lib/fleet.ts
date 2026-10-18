/**
 * The fleet map's view model: summary counts, needs per ship, and the sort
 * order for machines and ships. Pure functions over FleetSnapshot, so the
 * server and the browser agree on what is shown first. No Node APIs here.
 */
import { formatAge, formatSpan } from '#lib/time.ts';
import type { FleetJob, FleetMachine, FleetRoute, FleetShip, FleetSnapshot } from '#lib/shapes.ts';

/** Presence values that mean the ship is not asleep. */
export function isAwake(presence: string | null): boolean {
	return presence !== null && presence !== 'asleep';
}

export interface ShipView {
	ship: FleetShip;
	/** Items needing the captain that name this ship. */
	needs: number;
	awake: boolean;
	/** Ships with needs first, then crew running, then awake, then asleep. */
	rank: number;
}

export interface MachineView {
	machine: FleetMachine;
	/** Needs across this machine's ships; zero when the machine is unreachable. */
	needs: number;
	/** Crew jobs running on this machine; zero when unreachable. */
	crew: number;
	/** Ships awake on this machine; zero when unreachable. */
	awake: number;
	ships: ShipView[];
	/** Reachable machines with needs or crew come first; unreachable last. */
	rank: number;
}

export interface FleetSummary {
	machinesReachable: number;
	machinesTotal: number;
	shipsAwake: number;
	crew: number;
	needs: number;
}

export interface FleetView {
	machines: MachineView[];
	summary: FleetSummary;
}

/** "updated 12s ago", or "updated 3m ago" once a minute has passed. */
export function formatUpdated(at: number, now: number): string {
	const ms = now - at;
	if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s ago`;
	return formatAge(at, now);
}

/** A route's state and, while it is backing off or capped, how long until it clears. */
export function routeLabel(route: FleetRoute, now: number): string {
	const state = (route.state ?? 'unknown').replaceAll('_', ' ');
	if (route.until_ms === null || route.until_ms <= now) return state;
	return `${state} · ${formatSpan(route.until_ms - now)} left`;
}

/** The running crew on a ship, in the order Privateer lists it. */
export function crewOf(ship: FleetShip): FleetJob[] {
	return ship.jobs;
}

export function buildFleet(snapshot: FleetSnapshot): FleetView {
	const needsByShip = new Map<string, number>();
	for (const need of snapshot.needs) {
		needsByShip.set(need.ship, (needsByShip.get(need.ship) ?? 0) + 1);
	}

	const machines = snapshot.machines.map((machine): MachineView => {
		const ships = machine.ships.map((ship): ShipView => {
			const needs = machine.reachable ? (needsByShip.get(ship.name) ?? 0) : 0;
			const crew = machine.reachable ? crewOf(ship).length : 0;
			const awake = machine.reachable && isAwake(ship.presence);
			const rank = needs > 0 ? 0 : crew > 0 ? 1 : awake ? 2 : 3;
			return { ship, needs, awake, rank };
		});
		ships.sort((a, b) => a.rank - b.rank || a.ship.name.localeCompare(b.ship.name));

		const needs = ships.reduce((sum, s) => sum + s.needs, 0);
		const crew = machine.reachable ? ships.reduce((sum, s) => sum + crewOf(s.ship).length, 0) : 0;
		const awake = ships.filter((s) => s.awake).length;
		const busy = needs > 0 || crew > 0;
		return {
			machine,
			needs,
			crew,
			awake,
			ships,
			rank: !machine.reachable ? 2 : busy ? 0 : 1
		};
	});
	machines.sort((a, b) => a.rank - b.rank || a.machine.name.localeCompare(b.machine.name));

	const reachable = snapshot.machines.filter((m) => m.reachable);
	return {
		machines,
		summary: {
			machinesReachable: reachable.length,
			machinesTotal: snapshot.machines.length,
			shipsAwake: machines.reduce((sum, m) => sum + m.ships.filter((s) => s.awake).length, 0),
			crew: machines.reduce((sum, m) => sum + m.crew, 0),
			needs: snapshot.needs.length
		}
	};
}
