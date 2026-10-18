/**
 * The fleet map's view model: summary counts, needs per ship, job states and
 * waits, and the sort order for machines and ships. Pure functions over
 * FleetSnapshot, so the server and the browser agree on what is shown first.
 * No Node APIs here.
 */
import { formatAge, formatSpan } from '#lib/time.ts';
import type {
	FleetJob,
	FleetMachine,
	FleetRoute,
	FleetShip,
	FleetSnapshot,
	FleetWait,
	Presence
} from '#lib/shapes.ts';

/** Job states that count as running crew. */
const RUNNING = new Set(['starting', 'launching', 'running']);

/** A job that is running, starting or launching. Queued, parked and orphaned are not running. */
export function isRunning(job: FleetJob): boolean {
	return job.state !== null && RUNNING.has(job.state);
}

/** Presence that says the ship is there and can work. */
export function isAwake(presence: Presence): boolean {
	return presence === 'hosted' || presence === 'session';
}

/**
 * Presence that is not an all-clear: Privateer does not know, or could not read
 * the ship's home. Such a ship is not counted as awake or healthy.
 */
export function isUnsure(presence: Presence): boolean {
	return presence === 'unknown' || presence === 'unavailable';
}

/** "hosted", or "asleep for 2h" with how long the presence has held. */
export function presenceLabel(presence: Presence, since: number | null, now: number): string {
	if (since === null || since > now) return presence;
	return `${presence} for ${formatSpan(now - since)}`;
}

/** Why a job is not moving, in words; the wait's own time is shown when it is known. */
export function waitLabel(wait: FleetWait, now: number): string {
	const since =
		wait.since_ms !== null && wait.since_ms <= now ? ` for ${formatSpan(now - wait.since_ms)}` : '';
	if (wait.for === 'job') return `waiting on ${wait.job_id ?? 'another job'}${since}`;
	if (wait.for === 'capacity') return `waiting for capacity${since}`;
	if (wait.for === 'disk') return `waiting for disk${since}`;
	return `waiting${since}`;
}

/**
 * What a parked crew waits behind, in a few words: the park text, then the jobs it
 * is behind, with a note on each one that is unhealthy. Null when Privateer gives neither.
 */
export function waitDetail(wait: FleetWait): string | null {
	const behind = wait.behind.map(
		(b) =>
			`${b.job_id ?? 'another job'}${b.ship ? ` on ${b.ship}` : ''}${b.unhealthy ? ' (unhealthy)' : ''}`
	);
	const shown = behind.slice(0, 2);
	if (behind.length > shown.length) shown.push(`${behind.length - shown.length} more`);
	const parts = [wait.park, shown.length > 0 ? `behind ${shown.join(', ')}` : null];
	const text = parts.filter((p): p is string => p !== null).join(' · ');
	return text === '' ? null : text;
}

export interface ShipView {
	ship: FleetShip;
	/** Items needing the captain that name this ship. Counted even when the machine is unreachable. */
	needs: number;
	/** Live counts; zero when the machine is unreachable, as those jobs are last known. */
	running: number;
	waiting: number;
	orphaned: number;
	awake: boolean;
	unsure: boolean;
	/** Ships with needs or orphaned crew first, then crew running, then awake, then unsure, then the rest. */
	rank: number;
}

export interface MachineView {
	machine: FleetMachine;
	/** Needs across this machine's ships. */
	needs: number;
	running: number;
	waiting: number;
	orphaned: number;
	/** Ships awake on this machine; zero when unreachable. */
	awake: number;
	unsure: number;
	ships: ShipView[];
	/** Reachable machines with needs or crew come first; idle reachable next; unreachable last. */
	rank: number;
}

export interface FleetSummary {
	machinesReachable: number;
	machinesTotal: number;
	shipsAwake: number;
	/** Ships whose presence is unknown or unavailable on a reachable machine. */
	shipsUnsure: number;
	crew: number;
	waiting: number;
	orphaned: number;
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

export function buildFleet(snapshot: FleetSnapshot): FleetView {
	const machines = snapshot.machines.map((machine): MachineView => {
		const live = machine.reachable;
		const ships = machine.ships.map((ship): ShipView => {
			// A need belongs to the machine it came from; a need with no machine counts for its ship anywhere.
			const needs = snapshot.needs.filter(
				(n) => n.ship === ship.name && (n.machine === null || n.machine === machine.name)
			).length;
			const count = (test: (job: FleetJob) => boolean) =>
				live ? ship.jobs.filter(test).length : 0;
			const running = count(isRunning);
			const waiting = count((j) => j.state === 'queued' || j.state === 'parked');
			const orphaned = count((j) => j.state === 'orphaned');
			const awake = live && isAwake(ship.presence);
			const unsure = live && isUnsure(ship.presence);
			const rank =
				needs > 0 || orphaned > 0 ? 0 : running + waiting > 0 ? 1 : awake ? 2 : unsure ? 3 : 4;
			return { ship, needs, running, waiting, orphaned, awake, unsure, rank };
		});
		ships.sort((a, b) => a.rank - b.rank || a.ship.name.localeCompare(b.ship.name));

		const sum = (pick: (s: ShipView) => number) => ships.reduce((total, s) => total + pick(s), 0);
		const needs = sum((s) => s.needs);
		const running = sum((s) => s.running);
		const orphaned = sum((s) => s.orphaned);
		const busy = needs > 0 || running > 0 || orphaned > 0;
		return {
			machine,
			needs,
			running,
			waiting: sum((s) => s.waiting),
			orphaned,
			awake: sum((s) => (s.awake ? 1 : 0)),
			unsure: sum((s) => (s.unsure ? 1 : 0)),
			ships,
			rank: !machine.reachable ? 2 : busy ? 0 : 1
		};
	});
	machines.sort((a, b) => a.rank - b.rank || a.machine.name.localeCompare(b.machine.name));

	const reachable = snapshot.machines.filter((m) => m.reachable);
	const total = (pick: (m: MachineView) => number) => machines.reduce((sum, m) => sum + pick(m), 0);
	return {
		machines,
		summary: {
			machinesReachable: reachable.length,
			machinesTotal: snapshot.machines.length,
			shipsAwake: total((m) => m.awake),
			shipsUnsure: total((m) => m.unsure),
			crew: total((m) => m.running),
			waiting: total((m) => m.waiting),
			orphaned: total((m) => m.orphaned),
			needs: snapshot.needs.length
		}
	};
}
