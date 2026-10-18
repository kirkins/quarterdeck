import { describe, expect, it } from 'vitest';
import { PAGE_LIMIT, firstCursorOf, forwardCursorOf } from '#lib/feed.ts';
import { loadFeed } from './feed.ts';
import { FixtureSource } from './source.ts';

/** A fixture source whose clock the test moves by hand. */
function fixtureAt(start: number) {
	let now = start;
	const source = new FixtureSource('fixtures', () => now);
	return { source, advance: (ms: number) => (now += ms) };
}

function ok<T>(read: { status: string } & Partial<{ value: T }>): T {
	if (read.status !== 'ok' || read.value === undefined) throw new Error(`not ok: ${read.status}`);
	return read.value;
}

/** The page the browser is handed, or a throw. */
async function page(query: Parameters<typeof loadFeed>[0]) {
	const read = await loadFeed(query);
	if (read.status !== 'ok') throw new Error(`not ok: ${read.status}`);
	return read.page;
}

/** A time past every message the fixture holds, as the newest page's bound is: one ms past now. */
const FAR_FUTURE = 9_999_999_999_999;
const newest = { limit: PAGE_LIMIT, include_ship_mail: false, before: FAR_FUTURE };

describe('the fixture feed', () => {
	it('reads the newest page for a bound past everything, oldest first, and pages back by cursor', async () => {
		const { source } = fixtureAt(1_800_000_000_000);
		const first = ok(await source.feed(newest));
		expect(first.entries).toHaveLength(PAGE_LIMIT);
		expect(first.more).toBe(true);
		// A backward page's next is a before cursor: the oldest entry of the page, to page back from.
		expect(first.next).toBe(firstCursorOf(first.entries));
		// The forward cursor is read from the entries, the newest one, which a poll asks with.
		expect(forwardCursorOf(first.entries)).not.toBeNull();

		const second = ok(await source.feed({ ...newest, before: firstCursorOf(first.entries) ?? '' }));
		expect(second.entries).toHaveLength(PAGE_LIMIT);
		// Oldest first, and every entry is older than the oldest of the page before it.
		const oldestOfSecond = second.entries[0].created_ms ?? 0;
		const oldestOfFirst = first.entries[0].created_ms ?? 0;
		expect(oldestOfSecond).toBeLessThanOrEqual(oldestOfFirst);

		let cursor = firstCursorOf(second.entries);
		let pages = 2;
		let last = second;
		while (last.more) {
			last = ok(await source.feed({ ...newest, before: cursor ?? '' }));
			cursor = firstCursorOf(last.entries);
			pages += 1;
		}
		// The fixture's size is not fixed: the pages must cover every visible entry.
		const everything = ok(await source.feed({ ...newest, limit: 1000 }));
		expect(pages).toBe(Math.ceil(everything.entries.length / PAGE_LIMIT));
		expect(last.more).toBe(false);
	});

	it("polls forward from a page's own cursor, and answers nothing new at the end", async () => {
		const { source } = fixtureAt(1_800_000_000_000);
		const first = ok(await source.feed(newest));
		const at = forwardCursorOf(first.entries) ?? '';

		// Nothing has arrived yet, so there is nothing past the newest cursor.
		const quiet = ok(await source.feed({ limit: PAGE_LIMIT, include_ship_mail: false, after: at }));
		expect(quiet.entries).toEqual([]);
		expect(quiet.next).toBeNull();
	});

	it('refuses "now" as a bound, as Privateer does', async () => {
		const { source } = fixtureAt(1_800_000_000_000);
		await expect(source.feed({ ...newest, before: 'now' })).rejects.toThrow(
			'now is not a feed cursor'
		);
	});

	it('gives cursors shaped as Privateer gives them, never digits that read as a time', async () => {
		const { source } = fixtureAt(1_800_000_000_000);
		const everything = ok(await source.feed({ ...newest, limit: 1000 }));
		expect(everything.entries.length).toBeGreaterThan(0);
		for (const e of everything.entries) expect(e.cursor).toMatch(/^f1\.\d+$/);
	});

	it('reads forward from a cursor at most a limit, and says there is more', async () => {
		const { source } = fixtureAt(1_800_000_000_000);
		const all = ok(await source.feed({ ...newest, limit: 1000 }));
		const start = all.entries[0].cursor ?? '';

		const one = ok(await source.feed({ limit: 3, include_ship_mail: false, after: start }));
		expect(one.entries.map((e) => e.id)).toEqual(all.entries.slice(1, 4).map((e) => e.id));
		expect(one.more).toBe(true);
		// A forward page's next is the cursor to read on from: the last entry it holds.
		expect(one.next).toBe(forwardCursorOf(one.entries));

		const next = ok(
			await source.feed({ limit: 3, include_ship_mail: false, after: one.next ?? '' })
		);
		expect(next.entries.map((e) => e.id)).toEqual(all.entries.slice(4, 7).map((e) => e.id));
	});

	it('reads a time as a bound: only the messages written before it', async () => {
		const { source } = fixtureAt(1_800_000_000_000);
		const all = ok(await source.feed({ ...newest, limit: 1000 }));
		// The newest message was written at the newest time, so a bound at that time leaves it out.
		const bound = Math.max(...all.entries.map((e) => e.created_ms ?? 0));
		const page = ok(await source.feed({ ...newest, limit: 1000, before: bound }));
		expect(page.entries.every((e) => (e.created_ms ?? 0) < bound)).toBe(true);
		expect(page.entries.map((e) => e.id)).toEqual(
			all.entries.filter((e) => (e.created_ms ?? 0) < bound).map((e) => e.id)
		);
		expect(page.entries.length).toBeLessThan(all.entries.length);
	});

	it('keeps ship-to-ship mail out unless it is asked for', async () => {
		const { source } = fixtureAt(1_800_000_000_000);
		const without = ok(await source.feed({ ...newest, limit: 50 }));
		const withMail = ok(await source.feed({ ...newest, limit: 50, include_ship_mail: true }));
		const shipToShip = (e: { from: string; to: string }) =>
			e.from !== 'captain' && e.to !== 'captain';
		expect(without.entries.some(shipToShip)).toBe(false);
		expect(withMail.entries.some(shipToShip)).toBe(true);
	});

	it('filters to one ship, by either end of a message', async () => {
		const { source } = fixtureAt(1_800_000_000_000);
		const billing = ok(
			await source.feed({ ...newest, limit: 50, include_ship_mail: true, ship: 'billing' })
		);
		expect(billing.entries.length).toBeGreaterThan(0);
		expect(
			billing.entries.every(
				(e) => e.ship === 'billing' || e.from === 'billing' || e.to === 'billing'
			)
		).toBe(true);
	});

	it('reads only the open items over the whole history, not a page of it', async () => {
		const { source } = fixtureAt(1_800_000_000_000);
		const everything = ok(await source.feed({ ...newest, limit: 1000 }));
		const open = ok(await source.feed({ ...newest, limit: 1000, open_only: true }));

		expect(open.entries.every((e) => e.state === 'open')).toBe(true);
		expect(open.entries.length).toBeGreaterThan(0);
		// The whole history is covered, so more open items than one page holds.
		expect(open.entries.length).toBeGreaterThanOrEqual(
			everything.entries.filter((e) => e.state === 'open').length
		);
		// A privateer's own state filter agrees with it.
		const byState = ok(await source.feed({ ...newest, limit: 1000, states: ['open'] }));
		expect(byState.entries.map((e) => e.id)).toEqual(open.entries.map((e) => e.id));
	});

	it('brings a held message in on a forward poll, with the time it was written', async () => {
		const start = 1_800_000_000_000;
		const { source, advance } = fixtureAt(start);
		const first = ok(await source.feed({ ...newest, limit: 50 }));
		const at = forwardCursorOf(first.entries) ?? '';
		expect(first.entries.some((e) => e.body?.includes('smoke test passed on the new build'))).toBe(
			false
		);

		advance(10_000);
		const poll = ok(await source.feed({ limit: 50, include_ship_mail: false, after: at }));
		expect(poll.entries.map((e) => e.body)).toEqual(
			expect.arrayContaining(['Chandlery smoke test passed on the new build.'])
		);
		// Its cursor is the newest, though its time is written back to when it arrived.
		expect(poll.next).not.toBe(at);
		expect(poll.next).toBe(forwardCursorOf(poll.entries));
	});

	it('finds a desk copy collected late only by an open refresh, and merges it in once', async () => {
		const start = 1_800_000_000_000;
		const { source, advance } = fixtureAt(start);
		const first = ok(await source.feed(newest));
		const at = forwardCursorOf(first.entries) ?? '';
		const late = 'keep that as the nightly job';

		advance(10_000);
		// Forward polling asks after the newest cursor, and still does not see it.
		const poll = ok(await source.feed({ limit: 50, include_ship_mail: false, after: at }));
		expect(poll.entries.map((e) => e.body)).not.toContain(late);

		// The open refresh reads the whole history over open_only, and does.
		const open = ok(await source.feed({ ...newest, limit: 200, open_only: true }));
		const copy = open.entries.find((e) => e.body?.includes(late));
		expect(copy).toBeDefined();
		expect(copy?.ship).toBe('analytics');
		expect(copy?.home).toBe('desk-lab');

		// Merging it into what is loaded keeps one message, under the same key.
		const merged = [...first.entries, ...open.entries].filter(
			(e, i, all) =>
				all.findIndex((o) => `${o.from}\u0000${o.id}` === `${e.from}\u0000${e.id}`) === i
		);
		expect(merged.filter((e) => e.body?.includes(late))).toHaveLength(1);
		// And it now leads the forward cursor, so it is not asked for again.
		expect(forwardCursorOf(open.entries)).toBe(copy?.cursor);
	});
});

describe('the page handed to the browser', () => {
	it('carries both cursors, though its entries are ordered by time for the chat', async () => {
		const { source } = fixtureAt(1_800_000_000_000);
		const query = { limit: PAGE_LIMIT, include_ship_mail: false };
		const raw = ok(await source.feed(query));
		const first = await page(query);

		// The newest page holds copies collected late: older by time than the rest of the feed,
		// newer by cursor. Ordering the page by time for the chat therefore moves them, and the
		// page's cursors are read before that happens.
		expect(first.entries.map((e) => e.id)).not.toEqual(raw.entries.map((e) => e.id));
		expect(new Set(first.entries.map((e) => e.id))).toEqual(new Set(raw.entries.map((e) => e.id)));
		expect(first.first).toBe(raw.first);
		expect(first.next).toBe(raw.next);

		// Paging on the page's own cursors walks every message exactly once.
		const key = (e: { from: string; id: string }) => `${e.from}\u0000${e.id}`;
		const seen = new Set(first.entries.map(key));
		let cursor = first.first;
		let pages = 1;
		while (cursor !== null) {
			const older = await page({ limit: PAGE_LIMIT, include_ship_mail: false, before: cursor });
			for (const e of older.entries) {
				expect(seen.has(key(e))).toBe(false);
				seen.add(key(e));
			}
			if (!older.more) break;
			cursor = older.first;
			pages += 1;
		}
		expect(pages).toBeGreaterThan(1);

		const everything = await page({ limit: 1000, include_ship_mail: false });
		expect(seen.size).toBe(everything.entries.length);
	});
});
