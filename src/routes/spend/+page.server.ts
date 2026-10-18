import { getPortal } from '#lib/server/app.ts';
import { errorText } from '#lib/server/submit.ts';
import { buildRoutes, buildUsage, parseGrouping, parsePeriod, sinceFor } from '#lib/spend.ts';
import type { RoutesConfig, UsageSummary, FleetSnapshot } from '#lib/shapes.ts';
import type { PageServerLoad } from './$types';

/** One section of the page: read on its own, so one command failing leaves the rest. */
type Section<T> =
	{ status: 'ok'; value: T } | { status: 'unsupported' } | { status: 'error'; message: string };

async function section<T>(read: () => Promise<Section<T>>, name: string): Promise<Section<T>> {
	try {
		return await read();
	} catch (error) {
		console.error(`[quarterdeck] could not load ${name}:`, error);
		return { status: 'error', message: errorText(error) };
	}
}

export const load: PageServerLoad = async ({ depends, url }) => {
	// The page refreshes itself with invalidate('quarterdeck:spend'); see +page.svelte.
	depends('quarterdeck:spend');
	const now = Date.now();
	const period = parsePeriod(url.searchParams.get('period'));
	const grouping = parseGrouping(url.searchParams.get('group'));
	const source = getPortal().source;

	const [fleet, config, usage] = await Promise.all([
		section<FleetSnapshot>(async () => {
			const read = await source.snapshot();
			return read.status === 'ok' ? { status: 'ok', value: read.snapshot } : read;
		}, 'the fleet'),
		section<RoutesConfig>(async () => {
			const read = await source.routesShow();
			return read.status === 'ok' ? { status: 'ok', value: read.value } : read;
		}, 'route configuration'),
		section<UsageSummary>(async () => {
			const read = await source.usage({ since_ms: sinceFor(period, now), group_by: grouping });
			return read.status === 'ok' ? { status: 'ok', value: read.value } : read;
		}, 'usage')
	]);

	return {
		now,
		period,
		grouping,
		routes:
			fleet.status === 'ok'
				? {
						status: 'ok' as const,
						rows: buildRoutes(fleet.value, config.status === 'ok' ? config.value : null, now),
						// Without routes.show the rows still show state and cost, but no notes or try order.
						notesUnavailable: config.status !== 'ok'
					}
				: fleet,
		usage:
			usage.status === 'ok'
				? { status: 'ok' as const, view: buildUsage(usage.value, grouping) }
				: usage
	};
};
