/**
 * The feed as JSON, for the page's older pages, its poll and its filters.
 * Query: after (ms), before (cursor), limit, ship, include_ship_mail=1.
 */
import { json } from '@sveltejs/kit';
import { feedQuery } from '#lib/feed.ts';
import { loadFeed } from '#lib/server/feed.ts';
import { errorText } from '#lib/server/submit.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const result = await loadFeed(feedQuery(url.searchParams));
		if (result.status === 'unsupported') return json({ status: 'unsupported' });
		return json({ status: 'ok', ...result.page });
	} catch (error) {
		console.error('[quarterdeck] could not load the feed:', error);
		return json({ status: 'error', error: errorText(error) }, { status: 502 });
	}
};
