/**
 * The spend view's model: which routes are usable now and when the throttled
 * ones come back, and the token totals by period and grouping. Pure functions
 * over the parsed shapes, so the server and the browser agree. No Node APIs here.
 */
import { formatSpan } from '#lib/time.ts';
import { addUsage, GROUPINGS, type Grouping } from '#lib/usage.ts';
import type {
	FleetSnapshot,
	RouteConfig,
	RoutesConfig,
	UsageGroup,
	UsageSummary,
	UsageTotals
} from '#lib/shapes.ts';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/**
 * The periods the usage switch offers, most recent first. A period of whole days
 * is that many days ending today, so the day chart draws exactly that many bars;
 * the 24 h period is the last 24 hours as they run.
 */
export const PERIODS = {
	'24h': { label: '24 h', span: DAY, long: 'the last 24 hours', wholeDays: null },
	'7d': { label: '7 days', span: 7 * DAY, long: 'the last 7 days', wholeDays: 7 },
	'30d': { label: '30 days', span: 30 * DAY, long: 'the last 30 days', wholeDays: 30 }
} as const;
export type Period = keyof typeof PERIODS;
export const DEFAULT_PERIOD: Period = '7d';
export const DEFAULT_GROUPING: Grouping = 'route';

export const GROUPING_LABELS: Record<Grouping, string> = {
	route: 'Route',
	ship: 'Ship',
	day: 'Day',
	machine: 'Machine'
};

/** An unknown or missing period falls back to the default, rather than failing. */
export function parsePeriod(value: string | null | undefined): Period {
	return value === '24h' || value === '7d' || value === '30d' ? value : DEFAULT_PERIOD;
}

export function parseGrouping(value: string | null | undefined): Grouping {
	return (GROUPINGS as readonly string[]).includes(value ?? '')
		? (value as Grouping)
		: DEFAULT_GROUPING;
}

/**
 * The start of a period, counted back from now. A period of whole days starts at
 * the midnight (UTC, as the day chart's buckets are keyed) that opens its first
 * day, so it does not reach into the day before, whatever the hour.
 */
export function sinceFor(period: Period, now: number): number {
	const { span, wholeDays } = PERIODS[period];
	if (wholeDays === null) return now - span;
	const midnight = Math.floor(now / DAY) * DAY;
	return midnight - (wholeDays - 1) * DAY;
}

export type CostClass = 'free' | 'plan' | 'credits' | 'unknown';

const COST_LABELS: Record<CostClass, string> = {
	free: 'Free',
	plan: 'Plan',
	credits: 'Credits',
	unknown: 'Cost not reported'
};

export function costClass(cost: string | null): CostClass {
	return cost === 'free' || cost === 'plan' || cost === 'credits' ? cost : 'unknown';
}

/** A route's state on one machine. `kind` is what the sort and the marker use. */
export interface RouteStateView {
	machine: string;
	kind: 'available' | 'backing_off' | 'capped' | 'unknown';
	/** "backing off, back in 7m"; "capped, resets in 2h 10m"; or the bare state. */
	label: string;
	/** Absolute time the route clears, for a title attribute; null when it is not known. */
	clearsAt: number | null;
	lastError: string | null;
}

export interface RouteRow {
	name: string;
	cost: CostClass;
	costLabel: string;
	/** From routes.show; null when that command is not offered. */
	note: string | null;
	/** Plan allowance or credit balance: always "not reported" until Privateer has them. */
	budget: string | null;
	/** Position in the crew try order; null when no order lists it. */
	tryOrder: number | null;
	throttled: boolean;
	harnesses: string[];
	models: string[];
	states: RouteStateView[];
}

/** "available", "backing off, back in 7m", "capped, resets in 2h". */
function describe(
	state: string | null,
	until: number | null,
	now: number,
	kind: RouteStateView['kind']
): string {
	const pretty = (state ?? 'unknown').replaceAll('_', ' ');
	if (kind === 'available' || until === null || until <= now) return pretty;
	const verb = kind === 'capped' ? 'resets' : 'back';
	return `${pretty}, ${verb} in ${formatSpan(until - now)}`;
}

function stateKind(state: string | null): RouteStateView['kind'] {
	return state === 'available' || state === 'backing_off' || state === 'capped' ? state : 'unknown';
}

/** The try order of a route: the crew list first, then errand, then first mate. */
function tryOrderOf(name: string, config: RoutesConfig | null): number | null {
	if (!config) return null;
	for (const list of Object.values(config.order)) {
		const at = list.indexOf(name);
		if (at !== -1) return at;
	}
	return null;
}

/**
 * One row per route name, with its state on each machine that has it. Throttled
 * routes (backing off or capped on any machine) come first; then the routes in
 * the order crew try them; then the rest by name.
 */
export function buildRoutes(
	snapshot: FleetSnapshot,
	config: RoutesConfig | null,
	now: number
): RouteRow[] {
	const byName = new Map<string, RouteRow>();
	const configByName = new Map<string, RouteConfig>(config?.routes.map((r) => [r.name, r]) ?? []);

	const rowFor = (name: string): RouteRow => {
		const existing = byName.get(name);
		if (existing) return existing;
		const route = configByName.get(name);
		const cost = costClass(route?.cost ?? null);
		const row: RouteRow = {
			name,
			cost,
			costLabel: COST_LABELS[cost],
			note: route?.note ?? null,
			budget: null,
			tryOrder: tryOrderOf(name, config),
			throttled: false,
			harnesses: [],
			models: [],
			states: []
		};
		byName.set(name, row);
		return row;
	};

	for (const machine of snapshot.machines) {
		for (const route of machine.routes) {
			const row = rowFor(route.name);
			const kind = stateKind(route.state);
			const until = kind === 'capped' ? (route.resets_at ?? route.until_ms) : route.until_ms;
			if (kind === 'backing_off' || kind === 'capped') row.throttled = true;
			// A route's cost comes from the fleet when routes.show is not offered.
			if (row.cost === 'unknown') {
				row.cost = costClass(route.cost);
				row.costLabel = COST_LABELS[row.cost];
			}
			if (route.harness && !row.harnesses.includes(route.harness))
				row.harnesses.push(route.harness);
			if (route.model && !row.models.includes(route.model)) row.models.push(route.model);
			row.states.push({
				machine: machine.name,
				kind,
				label: describe(route.state, until, now, kind),
				clearsAt: until !== null && until > now ? until : null,
				lastError: route.last_error
			});
		}
	}

	// Routes the config names but no machine reports still show, so the try order is complete.
	for (const route of config?.routes ?? []) rowFor(route.name);

	for (const row of byName.values()) {
		if (row.cost === 'plan') row.budget = 'Plan allowance: not reported';
		if (row.cost === 'credits') row.budget = 'Credit balance: not reported';
	}

	return [...byName.values()].sort(
		(a, b) =>
			Number(b.throttled) - Number(a.throttled) ||
			(a.tryOrder ?? Infinity) - (b.tryOrder ?? Infinity) ||
			a.name.localeCompare(b.name)
	);
}

/** "912", "8.4k", "1.2M", "3.1B"; "not reported" when there is no number. */
export function formatTokens(n: number | null): string {
	if (n === null) return 'not reported';
	const abs = Math.abs(n);
	if (abs < 1000) return String(Math.round(n));
	for (const [unit, size] of [
		['B', 1e9],
		['M', 1e6],
		['k', 1e3]
	] as const) {
		if (abs >= size) {
			const scaled = n / size;
			return `${Math.abs(scaled) < 10 ? scaled.toFixed(1) : Math.round(scaled)}${unit}`;
		}
	}
	return String(Math.round(n));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A group's label: a day key is shown as "16 Oct", anything else as it is. */
export function groupLabel(key: string, grouping: Grouping): string {
	if (grouping !== 'day') return key;
	const [, month, day] = key.split('-');
	const m = Number(month) - 1;
	return m >= 0 && m < 12 ? `${Number(day)} ${MONTHS[m]}` : key;
}

export interface UsageRowView {
	key: string;
	label: string;
	jobs: number | null;
	/** Total tokens, as reported; null when no harness reports them for this group. */
	total: number | null;
	totalLabel: string;
	input: string;
	output: string;
	cacheRead: string;
	cacheWrite: string;
	/** Bar length as a percentage of the largest group, for the inline bars. */
	share: number;
	/** Harnesses in this group that report no usage. */
	gaps: string[];
}

/** The period's totals, formatted for the page. Each is "not reported" when nothing reports it. */
export interface UsageTotalsLabels {
	total: string;
	input: string;
	output: string;
	cacheRead: string;
	cacheWrite: string;
}

export interface UsageView {
	grouping: Grouping;
	rows: UsageRowView[];
	totals: UsageTotals | null;
	labels: UsageTotalsLabels;
	jobs: number;
	/** Every harness that reports no usage anywhere in the period. */
	gaps: string[];
}

function rowFor(group: UsageGroup, grouping: Grouping, max: number): UsageRowView {
	const total = group.usage?.totalTokens ?? null;
	return {
		key: group.key,
		label: groupLabel(group.key, grouping),
		jobs: group.jobs,
		total,
		totalLabel: formatTokens(total),
		input: formatTokens(group.usage?.input ?? null),
		output: formatTokens(group.usage?.output ?? null),
		cacheRead: formatTokens(group.usage?.cacheRead ?? null),
		cacheWrite: formatTokens(group.usage?.cacheWrite ?? null),
		share: total !== null && max > 0 ? Math.max(2, (total / max) * 100) : 0,
		gaps: group.gaps
	};
}

/** Rows for the usage list or the day chart, with the period's totals and gaps. */
export function buildUsage(summary: UsageSummary, grouping: Grouping): UsageView {
	const max = Math.max(0, ...summary.groups.map((g) => g.usage?.totalTokens ?? 0));
	const rows = summary.groups.map((g) => rowFor(g, grouping, max));
	const totals = summary.groups.reduce<UsageTotals | null>(
		(sum, g) => addUsage(sum, g.usage),
		null
	);
	const gaps = [...new Set(summary.groups.flatMap((g) => g.gaps))].sort();
	return {
		grouping,
		rows,
		totals,
		labels: {
			total: formatTokens(totals?.totalTokens ?? null),
			input: formatTokens(totals?.input ?? null),
			output: formatTokens(totals?.output ?? null),
			cacheRead: formatTokens(totals?.cacheRead ?? null),
			cacheWrite: formatTokens(totals?.cacheWrite ?? null)
		},
		jobs: summary.groups.reduce((n, g) => n + (g.jobs ?? 0), 0),
		gaps
	};
}
