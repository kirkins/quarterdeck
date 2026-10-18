/**
 * Groups usage records into the shape `usage.summary` returns. Used by the
 * fixture source, which stands in for Privateer, so that every period and
 * grouping shows the same way it would live. Shared by server and browser code.
 */
import type { UsageGroup, UsageRecord, UsageSummary, UsageTotals } from '#lib/shapes.ts';

export const GROUPINGS = ['route', 'ship', 'day', 'machine'] as const;
export type Grouping = (typeof GROUPINGS)[number];

export interface UsageQuery {
	since_ms: number;
	until_ms?: number;
	group_by: Grouping;
}

function keyOf(record: UsageRecord, by: Grouping): string {
	if (by === 'route') return record.route;
	if (by === 'ship') return record.ship;
	if (by === 'machine') return record.machine;
	return new Date(record.ts_ms).toISOString().slice(0, 10);
}

/** Add two slices of usage, keeping null where neither reports a count. */
export function addUsage(a: UsageTotals | null, b: UsageTotals | null): UsageTotals | null {
	if (!b) return a;
	if (!a) return b;
	const add = (x: number | null, y: number | null) =>
		x === null && y === null ? null : (x ?? 0) + (y ?? 0);
	return {
		input: add(a.input, b.input),
		output: add(a.output, b.output),
		cacheRead: add(a.cacheRead, b.cacheRead),
		cacheWrite: add(a.cacheWrite, b.cacheWrite),
		totalTokens: add(a.totalTokens, b.totalTokens)
	};
}

/**
 * Totals per group for records in [since_ms, until_ms). A harness that reports
 * no usage (usage null) is named in `gaps` and adds nothing to the totals.
 * Groups are ranked by total tokens, except by day, which runs oldest first.
 */
export function summarizeRecords(records: UsageRecord[], query: UsageQuery): UsageSummary {
	const groups = new Map<string, { jobs: number; usage: UsageTotals | null; gaps: Set<string> }>();
	for (const record of records) {
		if (record.ts_ms < query.since_ms) continue;
		if (query.until_ms !== undefined && record.ts_ms >= query.until_ms) continue;
		const key = keyOf(record, query.group_by);
		const group = groups.get(key) ?? { jobs: 0, usage: null, gaps: new Set<string>() };
		group.jobs += record.jobs;
		if (record.usage === null) group.gaps.add(record.harness);
		group.usage = addUsage(group.usage, record.usage);
		groups.set(key, group);
	}

	const out: UsageGroup[] = [...groups.entries()].map(([key, group]) => ({
		key,
		jobs: group.jobs,
		usage: group.usage,
		gaps: [...group.gaps].sort()
	}));
	out.sort((a, b) => {
		if (query.group_by === 'day') return a.key.localeCompare(b.key);
		return (
			(b.usage?.totalTokens ?? -1) - (a.usage?.totalTokens ?? -1) || a.key.localeCompare(b.key)
		);
	});
	return {
		since_ms: query.since_ms,
		until_ms: query.until_ms ?? null,
		group_by: query.group_by,
		groups: out
	};
}
