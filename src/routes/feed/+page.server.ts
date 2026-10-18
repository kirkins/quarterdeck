import { PAGE_LIMIT } from '#lib/feed.ts';
import { loadFeed } from '#lib/server/feed.ts';
import { errorText } from '#lib/server/submit.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ depends }) => {
	// The page refreshes itself with invalidate('quarterdeck:feed') and after each action.
	depends('quarterdeck:feed');
	const now = Date.now();
	try {
		const result = await loadFeed({ limit: PAGE_LIMIT, include_ship_mail: false });
		if (result.status === 'unsupported') return { now, page: null, unsupported: true, error: null };
		return { now, page: result.page, unsupported: false, error: null };
	} catch (error) {
		console.error('[quarterdeck] could not load the feed:', error);
		return { now, page: null, unsupported: false, error: errorText(error) };
	}
};

/** The same answer and dismiss actions the ship page's conversation posts to. */
export { feedActions as actions } from '#lib/server/feed-actions.ts';
