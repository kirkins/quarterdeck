/**
 * Reads the captain's feed for the page and the poll. One place, so both
 * agree on what a page holds: Privateer's entries, with any answer this portal
 * made marked and its reply added where Privateer does not list one yet.
 */
import { applyLocalAnswers, type FeedQuery } from '#lib/feed.ts';
import type { FeedPage } from '#lib/shapes.ts';
import { getPortal } from './app.ts';

export type FeedLoad = { status: 'ok'; page: FeedPage } | { status: 'unsupported' };

export async function loadFeed(query: FeedQuery): Promise<FeedLoad> {
	const { source, answers } = getPortal();
	const read = await source.feed(query);
	if (read.status === 'unsupported') return read;
	const { entries, more, next } = read.value;
	return { status: 'ok', page: { entries: applyLocalAnswers(entries, answers), more, next } };
}
