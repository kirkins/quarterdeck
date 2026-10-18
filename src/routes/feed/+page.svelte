<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import FeedMessage from '#lib/components/FeedMessage.svelte';
	import { failureFrom } from '#lib/form.ts';
	import {
		EMPTY_FILTER,
		PAGE_LIMIT,
		POLL_MS,
		atBottom,
		buildRows,
		entryKey,
		applyLocalAnswers,
		mergeEntries,
		newestOf,
		readFeedFilter,
		readLastRead,
		readUpTo,
		shipsIn,
		unseenAfter,
		visibleEntries,
		waitingCount,
		type FeedFilter,
		isOpen,
		toMailItem,
		CAPTAIN
	} from '#lib/feed.ts';
	import { askKey, toQuestion, type Answered } from '#lib/decision.ts';
	import { parseFeed, type FeedEntry } from '#lib/shapes.ts';
	import { formatDeadline } from '#lib/time.ts';
	import { SvelteMap } from 'svelte/reactivity';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const FILTER_KEY = 'quarterdeck.feed.filter';
	const READ_KEY = 'quarterdeck.feed.read';

	// Relative times tick on the client; the first render uses the server's clock.
	let clock = $state(0);
	const now = $derived(Math.max(data.now, clock));

	// svelte-ignore state_referenced_locally
	let entries = $state<FeedEntry[]>(data.page?.entries ?? []);
	// svelte-ignore state_referenced_locally
	let olderCursor = $state<string | null>(data.page?.next ?? null);
	// svelte-ignore state_referenced_locally
	let hasOlder = $state(data.page?.more ?? false);
	let filter = $state<FeedFilter>(EMPTY_FILTER);
	/** Where the captain had read to when this page opened: the Unread divider sits above it. */
	let openedRead = $state<number | null>(null);
	/** Where the captain has read to, kept for next time. */
	let readMark: number | null = null;
	let unseen = $state(0);
	let freshKeys = $state<string[]>([]);
	let loadingOlder = $state(false);
	let reloading = $state(false);
	let fetchError = $state<string | null>(null);
	let polling = false;
	let loadedOlder = false;
	let initialised = false;

	// A server page (after an action, or a fresh load) joins what is already on screen.
	$effect(() => {
		const page = data.page;
		if (!initialised) {
			initialised = true;
			return;
		}
		if (!page) return;
		untrack(() => {
			entries = mergeEntries(entries, page.entries);
			if (!loadedOlder) {
				olderCursor = page.next;
				hasOlder = page.more;
			}
		});
	});

	// An action this page sent closes its ask in place, wherever it sits in the list.
	$effect(() => {
		const done = form as { from?: string; id?: string; record?: Answered | null } | null;
		if (!done?.record || !done.from || !done.id) return;
		const { from, id, record } = { from: done.from, id: done.id, record: done.record };
		untrack(() => {
			const ask = entries.filter((e) => entryKey(e) === askKey(from, id));
			entries = mergeEntries(
				entries,
				applyLocalAnswers(ask, new Map([[askKey(from, id), record]]))
			);
		});
	});

	const shown = $derived(visibleEntries(entries, filter));
	const rows = $derived(buildRows(shown, { now, lastRead: openedRead }));
	const ships = $derived(shipsIn(entries));
	const waiting = $derived(waitingCount(entries));
	const multiMachine = $derived(new Set(entries.map((e) => e.machine).filter(Boolean)).size > 1);
	const failure = $derived(failureFrom(form, ['answer']));
	const dismissFailure = $derived(failureFrom(form, ['dismiss']));
	const next = $derived(
		entries
			.filter(isOpen)
			.map((e) => toQuestion(toMailItem(e), now).deadline_ms)
			.filter((d): d is number => d !== null && d > now)
			.sort((a, b) => a - b)[0] ?? null
	);

	/** Each captain reply names the ask it answers, so it can quote it and jump to it. */
	const quotes = $derived.by(() => {
		const asks = new SvelteMap(entries.map((e) => [entryKey(e), e]));
		const out = new SvelteMap<string, { key: string; text: string }>();
		for (const e of entries) {
			if (e.from !== CAPTAIN || !e.correlation) continue;
			const ask = asks.get(askKey(e.to, e.correlation));
			if (!ask) continue;
			const text = toQuestion(toMailItem(ask), now).question;
			out.set(entryKey(e), {
				key: entryKey(ask),
				text: text.length > 90 ? `${text.slice(0, 89)}…` : text
			});
		}
		return out;
	});

	function stored(key: string): string | null {
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	}

	function keep(key: string, value: string): void {
		try {
			localStorage.setItem(key, value);
		} catch {
			// Private browsing or a full store: the feed still works, it just forgets.
		}
	}

	function atBottomNow(): boolean {
		return atBottom(window.scrollY, window.innerHeight, document.documentElement.scrollHeight);
	}

	function scrollToEnd(): void {
		window.scrollTo({ top: document.documentElement.scrollHeight });
	}

	/** Marks the feed read up to its newest message, once the captain is at the bottom. */
	function markRead(): void {
		const next = readUpTo(readMark, newestOf(entries), atBottomNow());
		if (next !== readMark && next !== null) {
			readMark = next;
			keep(READ_KEY, String(next));
		}
	}

	/** The query string the filter asks Privateer for. */
	function filterParams(): Record<string, string> {
		return {
			...(filter.ship && { ship: filter.ship }),
			include_ship_mail: filter.shipMail ? '1' : '0'
		};
	}

	async function fetchFeed(params: Record<string, string>) {
		const search = new URLSearchParams({ limit: String(PAGE_LIMIT), ...params });
		const response = await fetch(`/feed/data?${search}`, {
			headers: { accept: 'application/json' }
		});
		const body = (await response.json()) as { status: string; error?: string } & Record<
			string,
			unknown
		>;
		if (body.status === 'unsupported') throw new Error('unsupported');
		if (body.status !== 'ok') throw new Error(body.error ?? 'The feed could not be read.');
		return parseFeed(body);
	}

	/** Newer messages, asked for by the newest time on screen. Pauses while the tab is hidden. */
	async function poll(): Promise<void> {
		if (polling || reloading || document.visibilityState !== 'visible') return;
		const newest = newestOf(entries);
		if (newest === null) return;
		polling = true;
		try {
			const page = await fetchFeed({ after: String(newest), ...filterParams() });
			const known = new Set(entries.map(entryKey));
			const arrived = page.entries.filter((e) => !known.has(entryKey(e)));
			fetchError = null;
			if (arrived.length === 0) return;
			const bottom = atBottomNow();
			entries = mergeEntries(entries, arrived);
			unseen = unseenAfter(unseen, arrived.length, bottom);
			freshKeys = arrived.map(entryKey);
			setTimeout(() => (freshKeys = []), 2_000);
			if (bottom) {
				await tick();
				scrollToEnd();
			}
			markRead();
		} catch (error) {
			fetchError = error instanceof Error ? error.message : 'The feed could not be read.';
		} finally {
			polling = false;
		}
	}

	/** Older messages above the top, keeping the captain where they were. */
	async function loadOlder(): Promise<void> {
		if (loadingOlder || !hasOlder || olderCursor === null) return;
		loadingOlder = true;
		const height = document.documentElement.scrollHeight;
		const y = window.scrollY;
		try {
			const page = await fetchFeed({ before: olderCursor, ...filterParams() });
			loadedOlder = true;
			entries = mergeEntries(entries, page.entries);
			olderCursor = page.next;
			hasOlder = page.more;
			await tick();
			window.scrollTo(0, y + (document.documentElement.scrollHeight - height));
		} catch (error) {
			fetchError = error instanceof Error ? error.message : 'Older messages could not be read.';
		} finally {
			loadingOlder = false;
		}
	}

	/** A fresh first page for a changed filter. Ship filtering is Privateer's, so it is asked again. */
	async function reload(): Promise<void> {
		reloading = true;
		try {
			const page = await fetchFeed(filterParams());
			loadedOlder = false;
			entries = page.entries;
			olderCursor = page.next;
			hasOlder = page.more;
			unseen = 0;
			fetchError = null;
			await tick();
			scrollToEnd();
			markRead();
		} catch (error) {
			fetchError = error instanceof Error ? error.message : 'The feed could not be read.';
		} finally {
			reloading = false;
		}
	}

	function changeFilter(next: FeedFilter): void {
		const refetch = next.ship !== filter.ship || next.shipMail !== filter.shipMail;
		filter = next;
		keep(FILTER_KEY, JSON.stringify(next));
		if (refetch) void reload();
	}

	function jumpToEnd(): void {
		unseen = 0;
		scrollToEnd();
		markRead();
	}

	onMount(() => {
		clock = Date.now();
		filter = readFeedFilter(stored(FILTER_KEY));
		readMark = readLastRead(stored(READ_KEY));
		openedRead = readMark;
		if (filter.ship || filter.shipMail) void reload();

		void tick().then(() => {
			scrollToEnd();
			markRead();
		});

		const onScroll = () => {
			unseen = unseenAfter(unseen, 0, atBottomNow());
			markRead();
			if (window.scrollY < 240) void loadOlder();
		};
		const onVisible = () => {
			if (document.visibilityState === 'visible') void poll();
		};
		const clockTimer = setInterval(() => (clock = Date.now()), 30_000);
		const pollTimer = setInterval(() => void poll(), POLL_MS);
		window.addEventListener('scroll', onScroll, { passive: true });
		window.addEventListener('focus', onVisible);
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			clearInterval(clockTimer);
			clearInterval(pollTimer);
			window.removeEventListener('scroll', onScroll);
			window.removeEventListener('focus', onVisible);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});
</script>

<svelte:head>
	<title>{waiting > 0 ? `(${waiting}) ` : ''}Feed · Quarterdeck</title>
</svelte:head>

<div class="head">
	<h1>Feed</h1>
	{#if data.page}
		<p class="summary" aria-live="polite">
			{#if waiting === 0}
				Nothing waiting on you.
			{:else}
				<span><strong>{waiting}</strong> waiting on you</span>
			{/if}
			{#if next !== null}<span>next {formatDeadline(next, now).toLowerCase()}</span>{/if}
		</p>
	{/if}
</div>

{#if data.unsupported}
	<section class="calm" aria-labelledby="unsupported-title">
		<h2 id="unsupported-title">The feed is not on this Privateer yet</h2>
		<p>
			This Privateer does not offer <code>captain.feed</code>. Decisions, Triage and the Fleet still
			work; the feed appears once Privateer has it.
		</p>
	</section>
{:else if data.error}
	<p class="error" role="alert">Could not read the feed: {data.error}</p>
{:else}
	<div class="toolbar" role="group" aria-label="Filter the feed">
		<label class="ship-pick">
			<span class="visually-hidden">Ship</span>
			<select
				value={filter.ship ?? ''}
				onchange={(event) => changeFilter({ ...filter, ship: event.currentTarget.value || null })}
			>
				<option value="">All ships</option>
				{#each ships as ship (ship)}<option value={ship}>{ship}</option>{/each}
			</select>
		</label>
		<label class="toggle">
			<input
				type="checkbox"
				checked={filter.onlyWaiting}
				onchange={(event) => changeFilter({ ...filter, onlyWaiting: event.currentTarget.checked })}
			/>
			Only waiting on me
		</label>
		<label class="toggle">
			<input
				type="checkbox"
				checked={filter.shipMail}
				onchange={(event) => changeFilter({ ...filter, shipMail: event.currentTarget.checked })}
			/>
			Include ship-to-ship mail
		</label>
	</div>

	{#if fetchError}
		<p class="error" role="alert">{fetchError}</p>
	{/if}

	<div class="stream-wrap" aria-busy={reloading}>
		{#if hasOlder}
			<p class="older">
				{#if loadingOlder}
					<span role="status">Loading older messages…</span>
				{:else}
					<button type="button" class="btn btn-quiet" onclick={() => loadOlder()}
						>Load older messages</button
					>
				{/if}
			</p>
		{/if}

		{#if rows.length === 0}
			<p class="empty">
				{entries.length === 0 ? 'No messages yet.' : 'Nothing matches these filters.'}
			</p>
		{/if}

		<ol class="stream" aria-label="Messages with the captain">
			{#each rows as row (row.key)}
				{#if row.type === 'day'}
					<li class="day" role="separator" aria-label={row.label}><span>{row.label}</span></li>
				{:else if row.type === 'unread'}
					<li class="unread" role="separator"><span>Unread</span></li>
				{:else}
					<FeedMessage
						entry={row.entry}
						first={row.first}
						last={row.last}
						mine={row.mine}
						shipToShip={row.shipToShip}
						{multiMachine}
						quote={quotes.get(row.key) ?? null}
						{now}
						{failure}
						{dismissFailure}
						fresh={freshKeys.includes(row.key)}
					/>
				{/if}
			{/each}
		</ol>
	</div>

	{#if unseen > 0}
		<button type="button" class="pill" onclick={jumpToEnd}>
			{unseen} new {unseen === 1 ? 'message' : 'messages'}
		</button>
	{/if}
{/if}

<style>
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--s-2) var(--s-4);
		margin-bottom: var(--s-4);
	}
	h1 {
		margin: 0;
		font-size: var(--text-2xl);
	}
	.summary {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-1) var(--s-4);
		margin: 0;
		font-size: var(--text-sm);
		color: var(--ink-2);
	}
	.summary strong {
		color: var(--ink);
	}

	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2) var(--s-4);
		margin-bottom: var(--s-4);
		font-size: var(--text-sm);
	}
	.ship-pick select {
		min-height: var(--tap);
		padding: 0 var(--s-3);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: var(--ink);
		font: inherit;
	}
	.toggle {
		display: inline-flex;
		align-items: center;
		gap: var(--s-2);
		min-height: var(--tap);
		color: var(--ink-2);
		cursor: pointer;
	}
	.toggle input {
		width: 18px;
		height: 18px;
		accent-color: var(--sea);
	}

	.stream-wrap {
		display: grid;
		gap: var(--s-2);
	}
	.stream {
		display: grid;
		gap: 0;
		margin: 0;
		padding: 0 0 var(--s-4);
		list-style: none;
	}
	.older {
		margin: 0;
		text-align: center;
		font-size: var(--text-sm);
		color: var(--ink-3);
	}
	.day,
	.unread {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		margin: var(--s-5) 0 var(--s-2);
		font-size: var(--text-xs);
		font-weight: 650;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--ink-3);
	}
	.day::before,
	.day::after,
	.unread::before,
	.unread::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--line);
	}
	.unread {
		color: var(--sea-strong);
	}
	.unread::before,
	.unread::after {
		background: var(--sea);
	}

	.empty {
		padding: var(--s-8) 0;
		text-align: center;
		color: var(--ink-3);
	}
	.calm {
		padding: var(--s-6);
		border: 1px dashed var(--line-strong);
		border-radius: var(--radius);
		color: var(--ink-2);
	}
	.calm h2 {
		margin: 0 0 var(--s-2);
		font-size: var(--text-lg);
		color: var(--ink);
	}
	.calm p {
		margin: 0;
	}
	.error {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		color: var(--danger);
	}

	.pill {
		position: fixed;
		left: 50%;
		bottom: calc(var(--s-4) + env(safe-area-inset-bottom));
		transform: translateX(-50%);
		z-index: 4;
		min-height: var(--tap);
		padding: 0 var(--s-4);
		border: 0;
		border-radius: 999px;
		background: var(--sea);
		color: var(--sea-ink);
		font: inherit;
		font-size: var(--text-sm);
		font-weight: 650;
		box-shadow: var(--shadow);
		cursor: pointer;
	}
</style>
