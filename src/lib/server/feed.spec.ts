import { describe, expect, it } from 'vitest';
import { PAGE_LIMIT } from '#lib/feed.ts';
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

describe('the fixture feed', () => {
	it('pages the newest entries first, then the page before, oldest last', async () => {
		const { source } = fixtureAt(1_800_000_000_000);
		const first = ok(await source.feed({ limit: PAGE_LIMIT, include_ship_mail: false }));
		expect(first.entries).toHaveLength(PAGE_LIMIT);
		expect(first.more).toBe(true);
		expect(first.next).not.toBeNull();

		const second = ok(
			await source.feed({ limit: PAGE_LIMIT, include_ship_mail: false, before: first.next ?? '' })
		);
		expect(second.entries).toHaveLength(PAGE_LIMIT);
		const newestOfSecond = second.entries[second.entries.length - 1].created_ms ?? 0;
		const oldestOfFirst = first.entries[0].created_ms ?? 0;
		expect(newestOfSecond).toBeLessThanOrEqual(oldestOfFirst);

		let cursor = second.next;
		let pages = 2;
		let last = second;
		while (cursor !== null) {
			last = ok(await source.feed({ limit: PAGE_LIMIT, include_ship_mail: false, before: cursor }));
			cursor = last.next;
			pages += 1;
		}
		expect(pages).toBe(3);
		expect(last.more).toBe(false);
	});

	it('keeps ship-to-ship mail out unless it is asked for', async () => {
		const { source } = fixtureAt(1_800_000_000_000);
		const without = ok(await source.feed({ limit: 50, include_ship_mail: false }));
		const withMail = ok(await source.feed({ limit: 50, include_ship_mail: true }));
		const shipToShip = (e: { from: string; to: string }) =>
			e.from !== 'captain' && e.to !== 'captain';
		expect(without.entries.some(shipToShip)).toBe(false);
		expect(withMail.entries.some(shipToShip)).toBe(true);
	});

	it('filters to one ship, by either end of a message', async () => {
		const { source } = fixtureAt(1_800_000_000_000);
		const billing = ok(await source.feed({ limit: 50, include_ship_mail: true, ship: 'billing' }));
		expect(billing.entries.length).toBeGreaterThan(0);
		expect(
			billing.entries.every(
				(e) => e.ship === 'billing' || e.from === 'billing' || e.to === 'billing'
			)
		).toBe(true);
	});

	it('holds back messages that have not arrived, and brings them on a later poll', async () => {
		const start = 1_800_000_000_000;
		const { source, advance } = fixtureAt(start);
		const before = ok(await source.feed({ limit: 50, include_ship_mail: false }));
		const newest = Math.max(...before.entries.map((e) => e.created_ms ?? 0));
		expect(before.entries.some((e) => e.body?.includes('smoke test passed on the new build'))).toBe(
			false
		);

		advance(10_000);
		const poll = ok(await source.feed({ limit: 50, include_ship_mail: false, after: newest }));
		expect(poll.entries.map((e) => e.body)).toEqual(
			expect.arrayContaining(['Storefront smoke test passed on the new build.'])
		);
		expect(poll.entries.every((e) => (e.created_ms ?? 0) > newest)).toBe(true);
	});
});
