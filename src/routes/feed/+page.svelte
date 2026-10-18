<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import FeedMessage from '#lib/components/FeedMessage.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
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
		outcomesOf,
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
	let entries = $state<FeedEntry[]>(mergeEntries([], data.page?.entries ?? []));
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
	/** The one open ask whose form is showing, by entryKey. */
	let expandedKey = $state<string | null>(null);

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
	const outcomes = $derived(outcomesOf(entries));
	/** An ask whose answer or dismiss failed opens, so the error is seen where it was made. */
	const failedKeys = $derived(
		[failure, dismissFailure].flatMap((f) => (f ? [askKey(f.from, f.id)] : []))
	);
	function toggleAsk(key: string) {
		expandedKey = expandedKey === key ? null : key;
	}
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

<PageHeader title="Feed">
	{#snippet summary()}
		{#if data.page}
			<p class="summary" aria-live="polite">
				{#if waiting === 0}
					<span>Nothing waiting on you</span>
				{:else}
					<span class="need"><strong>{waiting}</strong> waiting on you</span>
				{/if}
				{#if next !== null}<span>next {formatDeadline(next, now).toLowerCase()}</span>{/if}
			</p>
		{/if}
	{/snippet}
</PageHeader>

{#if data.unsupported}
	<EmptyState tone="quiet" title="The feed is not on this Privateer yet" icon="feed">
		<p>
			This Privateer does not offer <code>captain.feed</code>. Decisions, Triage and the Fleet still
			work; the feed appears once Privateer has it.
		</p>
	</EmptyState>
{:else if data.error}
	<EmptyState tone="error" title="Could not read the feed">
		<p class="detail">{data.error}</p>
		<p>Check that Privateer is reachable from this machine, then reload.</p>
	</EmptyState>
{:else}
	<div class="toolbar" role="group" aria-label="Filter the feed">
		<label class="ship-pick">
			<span class="visually-hidden">Ship</span>
			<Icon name="ship" size={16} />
			<select
				value={filter.ship ?? ''}
				onchange={(event) => changeFilter({ ...filter, ship: event.currentTarget.value || null })}
			>
				<option value="">All ships</option>
				{#each ships as ship (ship)}<option value={ship}>{ship}</option>{/each}
			</select>
			<Icon name="chevron" size={16} />
		</label>
		<label class="chip toggle">
			<input
				type="checkbox"
				checked={filter.onlyWaiting}
				onchange={(event) => changeFilter({ ...filter, onlyWaiting: event.currentTarget.checked })}
			/>
			<span class="tick" aria-hidden="true"><Icon name="check" size={12} stroke={2.5} /></span>
			Only waiting on me
		</label>
		<label class="chip toggle">
			<input
				type="checkbox"
				checked={filter.shipMail}
				onchange={(event) => changeFilter({ ...filter, shipMail: event.currentTarget.checked })}
			/>
			<span class="tick" aria-hidden="true"><Icon name="check" size={12} stroke={2.5} /></span>
			Include ship-to-ship mail
		</label>
	</div>

	{#if fetchError}
		<p class="callout callout-danger fetch-error" role="alert">
			<Icon name="alert" size={16} />{fetchError}
		</p>
	{/if}

	<div class="stream-wrap" aria-busy={reloading} class:reloading>
		{#if hasOlder}
			<p class="older">
				{#if loadingOlder}
					<span role="status" class="loading-older"
						><span class="skeleton bar" aria-hidden="true"></span>Loading older messages…</span
					>
				{:else}
					<button type="button" class="btn btn-quiet btn-sm" onclick={() => loadOlder()}
						>Load older messages</button
					>
				{/if}
			</p>
		{/if}

		{#if rows.length === 0}
			<EmptyState
				tone={entries.length === 0 ? 'calm' : 'quiet'}
				title={entries.length === 0 ? 'No messages yet' : 'Nothing matches these filters'}
				icon="feed"
			>
				<p>
					{entries.length === 0
						? 'When a ship writes to you, it appears here.'
						: 'Try all ships, or include everything, not only what waits on you.'}
				</p>
			</EmptyState>
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
						outcome={outcomes.get(row.key) ?? null}
						expanded={expandedKey === row.key || failedKeys.includes(row.key)}
						ontoggle={() => toggleAsk(row.key)}
					/>
				{/if}
			{/each}
		</ol>
	</div>

	{#if unseen > 0}
		<button type="button" class="pill" onclick={jumpToEnd}>
			<Icon name="arrow-down" size={16} />
			{unseen} new {unseen === 1 ? 'message' : 'messages'}
		</button>
	{/if}
{/if}

<style>
	.toolbar {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		margin: calc(-1 * var(--s-2)) calc(-1 * var(--s-4)) var(--s-2);
		padding: var(--s-1) var(--s-4) var(--s-2);
		overflow-x: auto;
		scrollbar-width: none;
	}
	.toolbar::-webkit-scrollbar {
		display: none;
	}

	.ship-pick {
		position: relative;
		flex: none;
		display: inline-flex;
		align-items: center;
		color: var(--ink-2);
	}
	.ship-pick > :global(.icon:first-of-type) {
		position: absolute;
		left: 11px;
		pointer-events: none;
		color: var(--sea);
	}
	.ship-pick > :global(.icon:last-of-type) {
		position: absolute;
		right: 10px;
		pointer-events: none;
		color: var(--ink-3);
	}
	.ship-pick select {
		appearance: none;
		min-height: 2.25rem;
		padding: 0 2rem 0 2.125rem;
		border: 0;
		border-radius: var(--radius-pill);
		background: var(--surface-raised);
		box-shadow: var(--elev-1);
		color: var(--ink);
		font-size: var(--text-sm);
		font-weight: 600;
		cursor: pointer;
	}
	.ship-pick select:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}

	.toggle {
		position: relative;
	}
	.toggle input {
		position: absolute;
		inset: 0;
		margin: 0;
		opacity: 0;
		cursor: pointer;
	}
	.toggle:has(input:focus-visible) {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.tick {
		display: grid;
		place-items: center;
		width: 1rem;
		height: 1rem;
		margin-left: -2px;
		border-radius: 5px;
		box-shadow: inset 0 0 0 1.5px var(--line-input);
		color: transparent;
		transition:
			background-color var(--dur-1) var(--ease),
			color var(--dur-1) var(--ease);
	}
	.toggle:has(input:checked) {
		background: var(--sea-soft);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sea) 45%, transparent);
		color: var(--sea-strong);
	}
	.toggle:has(input:checked) .tick {
		background: var(--sea);
		box-shadow: none;
		color: var(--sea-ink);
	}

	.fetch-error {
		margin-bottom: var(--s-3);
	}

	.stream-wrap {
		display: grid;
		gap: var(--s-2);
		transition: opacity var(--dur-2) var(--ease);
	}
	.stream-wrap.reloading {
		opacity: 0.55;
	}
	.stream {
		display: grid;
		margin: 0;
		padding: 0 0 var(--s-4);
		list-style: none;
	}
	.older {
		display: flex;
		justify-content: center;
		margin: 0;
		font-size: var(--text-sm);
		color: var(--ink-3);
	}
	.loading-older {
		display: inline-flex;
		align-items: center;
		gap: var(--s-2);
		min-height: 2.25rem;
	}
	.loading-older .bar {
		width: 2.5rem;
		height: 0.5rem;
		border-radius: var(--radius-pill);
	}

	.day,
	.unread {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		margin: var(--s-8) 0 var(--s-1);
		font-size: var(--text-2xs);
		font-weight: 650;
		letter-spacing: var(--track-caps);
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
	.day span {
		padding: 3px 10px;
		border-radius: var(--radius-pill);
		background: var(--bg);
		box-shadow: inset 0 0 0 1px var(--line);
	}
	.unread {
		margin-top: var(--s-6);
		color: var(--brass);
	}
	.unread::before,
	.unread::after {
		background: var(--brass-line);
	}

	.pill {
		position: fixed;
		left: 50%;
		bottom: calc(var(--dock) + var(--s-4));
		transform: translateX(-50%);
		z-index: 25;
		display: inline-flex;
		align-items: center;
		gap: var(--s-2);
		min-height: var(--tap);
		padding: 0 var(--s-5) 0 var(--s-4);
		border: 0;
		border-radius: var(--radius-pill);
		background: var(--navy);
		color: var(--navy-ink);
		font-size: var(--text-sm);
		font-weight: 650;
		box-shadow: var(--elev-3);
		cursor: pointer;
		animation: rise var(--dur-3) var(--ease);
	}
	@media (min-width: 60rem) {
		.pill {
			left: calc(50% + var(--sidebar-w) / 2);
		}
	}
</style>
