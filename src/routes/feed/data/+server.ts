/**
 * The feed as JSON, for the page's older pages, its poll, its open refresh and
 * its filters. Query: before (a cursor, or a time in ms), after (a cursor or a
 * time in ms), limit, ship, include_ship_mail=1, open_only=1, state (repeatable).
 * With neither before nor after, it is the newest page.
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
