/**
 * Reads the captain's feed for the page and the poll. One place, so both
 * agree on what a page holds: Privateer's entries, with any answer this portal
 * made marked and its reply added where Privateer does not list one yet.
 *
 * The entries are then ordered by time for the chat, which is not Privateer's
 * order, so the page's two cursors are taken before that happens and carried
 * through untouched: a desk copy collected late is older by time and newer by
 * cursor, and only the cursor pages.
 */
import { applyLocalAnswers, withNewest, type FeedQuery } from '#lib/feed.ts';
import type { FeedPage } from '#lib/shapes.ts';
import { getPortal } from './app.ts';

export type FeedLoad = { status: 'ok'; page: FeedPage } | { status: 'unsupported' };

/**
 * A page of the feed. A query that names no bound reads the newest page, bounded
 * by this server's clock, so a browser's clock never decides what is newest.
 */
export async function loadFeed(query: FeedQuery): Promise<FeedLoad> {
	const { source, answers } = getPortal();
	const read = await source.feed(withNewest(query, Date.now()));
	if (read.status === 'unsupported') return read;
	const { entries, more, next, first } = read.value;
	return {
		status: 'ok',
		page: { entries: applyLocalAnswers(entries, answers), more, next, first }
	};
}
