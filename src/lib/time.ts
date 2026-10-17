/** Relative times and deadline urgency for cards. Shared by server and browser. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A compact span such as "45m", "3h", "2h 10m" or "4d". */
export function formatSpan(ms: number): string {
	const abs = Math.abs(ms);
	if (abs < MINUTE) return 'under a minute';
	if (abs < HOUR) return `${Math.round(abs / MINUTE)}m`;
	if (abs < 6 * HOUR) {
		const h = Math.floor(abs / HOUR);
		const m = Math.round((abs - h * HOUR) / MINUTE);
		return m === 0 || m === 60 ? `${m === 60 ? h + 1 : h}h` : `${h}h ${m}m`;
	}
	if (abs < 36 * HOUR) return `${Math.round(abs / HOUR)}h`;
	return `${Math.round(abs / DAY)}d`;
}

/** "3h ago", "just now". */
export function formatAge(asked_ms: number, now: number): string {
	const ms = now - asked_ms;
	if (ms < MINUTE) return 'just now';
	return `${formatSpan(ms)} ago`;
}

export type Urgency = 'overdue' | 'soon' | 'today' | 'later' | 'none';

/** Overdue; due within an hour; within a day; later; or no deadline. */
export function urgencyOf(deadline_ms: number | null, now: number): Urgency {
	if (deadline_ms === null) return 'none';
	const left = deadline_ms - now;
	if (left <= 0) return 'overdue';
	if (left <= HOUR) return 'soon';
	if (left <= DAY) return 'today';
	return 'later';
}

/** "Overdue by 2h", "Due in 45m", "No deadline". */
export function formatDeadline(deadline_ms: number | null, now: number): string {
	if (deadline_ms === null) return 'No deadline';
	const left = deadline_ms - now;
	if (left <= 0) return `Overdue by ${formatSpan(left)}`;
	return `Due in ${formatSpan(left)}`;
}

/** An absolute timestamp for a `title`/`datetime` attribute. */
export function isoTime(ms: number): string {
	return new Date(ms).toISOString();
}
