/**
 * The time a page draws relative times from. The server's clock serves the first
 * render; once the page runs, the browser's clock takes over and is redrawn every
 * 30 s, so "5m ago" keeps moving. Call it during component setup.
 */
import { onMount } from 'svelte';

const REDRAW_MS = 30_000;

export function liveNow(serverNow: () => number): { readonly value: number } {
	let clock = $state(0);
	onMount(() => {
		clock = Date.now();
		const timer = setInterval(() => (clock = Date.now()), REDRAW_MS);
		return () => clearInterval(timer);
	});
	return {
		get value() {
			return Math.max(serverNow(), clock);
		}
	};
}
