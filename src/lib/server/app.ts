/**
 * The running portal's state: configuration, the source of captain mail, and
 * the answers given since the server started. Created on first use so that
 * building the app never reads the environment or touches privateer.
 */
import type { Answered } from '#lib/decision.ts';
import type { Waiting } from '#lib/shapes.ts';
import { readConfig, type Config } from './config.ts';
import { createSource, type Source } from './source.ts';

export interface Portal {
	config: Config;
	source: Source;
	/**
	 * Answers given in this process, by asking mail id. In dry runs this is the
	 * only record that a card was answered; with live sending it also hides
	 * the brief window before captain.waiting stops listing the ask.
	 */
	answers: Map<string, Answered>;
}

let portal: Portal | undefined;

export function getPortal(): Portal {
	if (!portal) {
		const config = readConfig();
		portal = { config, source: createSource(config), answers: new Map() };
	}
	return portal;
}

/**
 * How long a read of the captain's items is reused. The layout (nav badge) and
 * the page both read on every navigation; this keeps that to one round trip.
 */
const ITEMS_TTL_MS = 5_000;
let items: { at: number; value: Promise<Waiting> } | undefined;

/** Everything owed to the captain. `fresh` skips the cache, as an action needs. */
export function loadItems(fresh = false): Promise<Waiting> {
	const current = items;
	if (!fresh && current && Date.now() - current.at <= ITEMS_TTL_MS) return current.value;
	const value = getPortal().source.waiting();
	items = { at: Date.now(), value };
	// A failed read must not be reused for the next five seconds.
	value.catch(() => {
		if (items?.value === value) items = undefined;
	});
	return value;
}

/** Forget the cached read, after anything that changes what is owed. */
export function invalidateItems(): void {
	items = undefined;
}
