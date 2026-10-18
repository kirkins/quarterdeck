import { NEWEST, PAGE_LIMIT } from '#lib/feed.ts';
import { getPortal } from '#lib/server/app.ts';
import { loadFeed } from '#lib/server/feed.ts';
import { loadShipView } from '#lib/server/ship.ts';
import { errorText } from '#lib/server/submit.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, depends }) => {
	// The page refreshes itself after each action, as the Feed does.
	depends('quarterdeck:ship');
	const now = Date.now();
	const ship = await loadShipView(getPortal().source, params.name);
	if (ship.notFound) {
		return { now, ship, page: null, feedUnsupported: false, feedError: null };
	}
	try {
		// The newest page of this ship's conversation, as the Feed reads its own.
		const result = await loadFeed({
			limit: PAGE_LIMIT,
			include_ship_mail: false,
			before: NEWEST,
			ship: ship.name
		});
		if (result.status === 'unsupported') {
			return { now, ship, page: null, feedUnsupported: true, feedError: null };
		}
		return { now, ship, page: result.page, feedUnsupported: false, feedError: null };
	} catch (error) {
		console.error('[quarterdeck] could not load the ship conversation:', error);
		return { now, ship, page: null, feedUnsupported: false, feedError: errorText(error) };
	}
};

/** The conversation answers and dismisses through the Feed's actions, the same write path. */
export { feedActions as actions } from '#lib/server/feed-actions.ts';
