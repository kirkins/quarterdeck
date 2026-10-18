<!--
	The captain's stream of messages: the Feed, and one ship's conversation. It
	owns the polling, the paging up, the answer-in-place and the "new messages"
	pill. The page around it owns the filter and the summary, so both pages
	share one implementation. Read marks are kept only for the whole Feed
	(persistRead): a ship's thread must not mark the other ships read.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import FeedMessage from '#lib/components/FeedMessage.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { failureFrom } from '#lib/form.ts';
	import {
		MAX_LIMIT,
		OPEN_REFRESH_MS,
		PAGE_LIMIT,
		POLL_MS,
		atBottom,
		buildRows,
		entryKey,
		applyLocalAnswers,
		forwardCursorOf,
		mergeEntries,
		newestOf,
		commentsOf,
		outcomesOf,
		readUpTo,
		readLastRead,
		visibleEntries,
		unseenAfter,
		toMailItem,
		CAPTAIN,
		type FeedFilter
	} from '#lib/feed.ts';
	import { askKey, toQuestion, type Answered } from '#lib/decision.ts';
	import { parseFeed, type FeedEntry, type FeedPage } from '#lib/shapes.ts';
	import { SvelteMap } from 'svelte/reactivity';
	import { onMount, untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';

	interface Props {
		/** The first page, as the server read it for this filter. */
		page: FeedPage | null;
		/** The messages on screen. The parent reads them for its summary. */
		entries?: FeedEntry[];
		now: number;
		filter: FeedFilter;
		/** The action result from this page's answer or dismiss, if any. */
		form: unknown;
		/** Remember where the captain has read to. Only the whole Feed does. */
		persistRead?: boolean;
		/** What to say when there is nothing yet. */
		emptyText?: string;
	}

	let {
		page,
		entries = $bindable([]),
		now,
		filter,
		form,
		persistRead = false,
		emptyText = 'When a ship writes to you, it appears here.'
	}: Props = $props();

	const READ_KEY = 'quarterdeck.feed.read';

	// svelte-ignore state_referenced_locally
	let hasOlder = $state(page?.more ?? false);
	/**
	 * Where a forward poll starts: the newest entry of the page last read. Taken
	 * from the entries, never from `next`, which for a backward page is a cursor
	 * to page back with.
	 */
	// svelte-ignore state_referenced_locally
	let forwardCursor = $state<string | null>(forwardCursorOf(page?.entries ?? []));
	/**
	 * Where to page back to: the oldest place in the feed among what is loaded.
	 * Privateer reads it off the page in its own order, because it is not the
	 * oldest time on screen: a desk copy collected late from another machine
	 * carries an older `created_ms` than the cursor that passed it.
	 */
	// svelte-ignore state_referenced_locally
	let olderCursor = $state<string | null>(page?.first ?? null);
	/** Where the captain had read to when this page opened: the Unread divider sits above it. */
	let openedRead = $state<number | null>(null);
	/** Where the captain has read to, kept for next time. */
	let readMark: number | null = null;
	let unseen = $state(0);
	let freshKeys = $state<string[]>([]);
	let loadingOlder = $state(false);
	let reloading = $state(false);
	let refreshingOpen = false;
	let fetchError = $state<string | null>(null);
	let polling = false;
	let initialised = false;
	/** The one open ask whose form is showing, by entryKey. */
	let expandedKey = $state<string | null>(null);
	/** The filter the thread last read Privateer for. The first page already matches the first filter. */
	// svelte-ignore state_referenced_locally
	let fetchedFor = filterKey(filter);

	function filterKey(f: FeedFilter): string {
		return `${f.ship ?? ''}|${f.shipMail}|${f.onlyWaiting}`;
	}

	// A server page (after an action, or a fresh load) joins what is already on screen.
	$effect(() => {
		const next = page;
		if (!initialised) {
			initialised = true;
			return;
		}
		if (!next) return;
		untrack(() => {
			entries = mergeEntries(entries, next.entries);
			forwardCursor = forwardCursorOf(next.entries) ?? forwardCursor;
			hasOlder = hasOlder || next.more;
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

	// A changed ship or mail filter asks Privateer again; the rest of the filter is client side.
	$effect(() => {
		const key = filterKey(filter);
		if (key === fetchedFor) return;
		fetchedFor = key;
		untrack(() => void reload());
	});

	const shown = $derived(visibleEntries(entries, filter));
	const rows = $derived(buildRows(shown, { now, lastRead: openedRead }));
	const failure = $derived(failureFrom(form, ['answer']));
	const dismissFailure = $derived(failureFrom(form, ['dismiss']));
	const outcomes = $derived(outcomesOf(entries, now));
	const comments = $derived(commentsOf(entries));
	/** An ask whose answer or dismiss failed opens, so the error is seen where it was made. */
	const failedKeys = $derived(
		[failure, dismissFailure].flatMap((f) => (f ? [askKey(f.from, f.id)] : []))
	);
	const multiMachine = $derived(new Set(entries.map((e) => e.machine).filter(Boolean)).size > 1);

	function toggleAsk(key: string) {
		expandedKey = expandedKey === key ? null : key;
	}

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
		if (!persistRead) return;
		const next = readUpTo(readMark, newestOf(entries), atBottomNow());
		if (next !== readMark && next !== null) {
			readMark = next;
			keep(READ_KEY, String(next));
		}
	}

	/**
	 * The query string the filter asks Privateer for. Ship filtering, ship mail and
	 * "only waiting on me" are Privateer's to apply, so each asks for itself:
	 * open_only reads the whole history, not only the pages already loaded.
	 */
	function filterParams(): Record<string, string> {
		return {
			...(filter.ship && { ship: filter.ship }),
			include_ship_mail: filter.shipMail ? '1' : '0',
			...(filter.onlyWaiting && { open_only: '1' })
		};
	}

	async function fetchFeed(params: Record<string, string>) {
		const search = new URLSearchParams({ limit: String(PAGE_LIMIT), ...params });
		const response = await fetch(`/feed/data?${search}`, {
			headers: { accept: 'application/json' }
		});
		if (response.status === 401) {
			// The session ended: reloading the page's data sends the captain to sign in, then back here.
			await invalidateAll();
			throw new Error('Signed out. Sign in again.');
		}
		const body = (await response.json()) as { status: string; error?: string } & Record<
			string,
			unknown
		>;
		if (body.status === 'unsupported') throw new Error('unsupported');
		if (body.status !== 'ok') throw new Error(body.error ?? 'The feed could not be read.');
		return parseFeed(body);
	}

	/**
	 * Newer messages, asked for from the newest cursor on screen. Pauses while the
	 * tab is hidden.
	 */
	async function poll(): Promise<void> {
		if (polling || reloading || document.visibilityState !== 'visible') return;
		if (forwardCursor === null) return;
		polling = true;
		try {
			const result = await fetchFeed({ after: forwardCursor, ...filterParams() });
			const known = new Set(entries.map(entryKey));
			const arrived = result.entries.filter((e) => !known.has(entryKey(e)));
			forwardCursor = forwardCursorOf(result.entries) ?? forwardCursor;
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

	/**
	 * The open items, read again over the whole history. A desk copy collected
	 * late from another machine carries an older `created_ms` than the cursor that
	 * passed it, so no amount of forward polling brings it in; an open_only read
	 * does. It reads the newest open page, so it does not move the forward cursor:
	 * that is the poll's, read from the newest page of the whole feed. Anything
	 * already on screen is merged by key, so nothing appears twice and the captain
	 * is not moved.
	 */
	async function refreshOpen(): Promise<void> {
		if (refreshingOpen || reloading) return;
		if (filter.onlyWaiting) return;
		refreshingOpen = true;
		try {
			const result = await fetchFeed({
				...filterParams(),
				open_only: '1',
				limit: String(MAX_LIMIT)
			});
			const known = new Set(entries.map(entryKey));
			const added = result.entries.filter((e) => !known.has(entryKey(e)));
			fetchError = null;
			if (added.length === 0) return;
			entries = mergeEntries(entries, added);
			const bottom = atBottomNow();
			if (bottom) await tick();
		} catch (error) {
			fetchError = error instanceof Error ? error.message : 'The open items could not be read.';
		} finally {
			refreshingOpen = false;
		}
	}

	/** Older messages above the top, keeping the captain where they were. */
	async function loadOlder(): Promise<void> {
		// A reload brings its own cursors: an older page asked for before it lands would be stale.
		if (loadingOlder || reloading || !hasOlder || olderCursor === null) return;
		loadingOlder = true;
		const height = document.documentElement.scrollHeight;
		const y = window.scrollY;
		const asked = fetchedFor;
		try {
			const result = await fetchFeed({ before: olderCursor, ...filterParams() });
			// The filter changed while this page was read: it belongs to the old filter, so it is dropped.
			if (asked !== fetchedFor) return;
			entries = mergeEntries(entries, result.entries);
			olderCursor = result.first ?? olderCursor;
			hasOlder = result.more;
			await tick();
			window.scrollTo(0, y + (document.documentElement.scrollHeight - height));
		} catch (error) {
			fetchError = error instanceof Error ? error.message : 'Older messages could not be read.';
		} finally {
			loadingOlder = false;
		}
	}

	/** A fresh newest page for a changed filter. Ship filtering is Privateer's, so it is asked again. */
	async function reload(): Promise<void> {
		reloading = true;
		try {
			const result = await fetchFeed({ ...filterParams() });
			entries = result.entries;
			forwardCursor = forwardCursorOf(result.entries);
			olderCursor = result.first;
			hasOlder = result.more;
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

	/** Jumps to the newest message, as the pill asks. */
	function jumpToEnd(): void {
		unseen = 0;
		scrollToEnd();
		markRead();
	}

	onMount(() => {
		if (persistRead) {
			readMark = readLastRead(stored(READ_KEY));
			openedRead = readMark;
		}

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
			if (document.visibilityState !== 'visible') return;
			void poll();
			// Coming back to the tab is also when a late desk copy is worth re-reading.
			void refreshOpen();
		};
		const pollTimer = setInterval(() => void poll(), POLL_MS);
		const openTimer = setInterval(() => void refreshOpen(), OPEN_REFRESH_MS);
		window.addEventListener('scroll', onScroll, { passive: true });
		window.addEventListener('focus', onVisible);
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			clearInterval(pollTimer);
			clearInterval(openTimer);
			window.removeEventListener('scroll', onScroll);
			window.removeEventListener('focus', onVisible);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});
</script>

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
					? emptyText
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
					comments={comments.get(row.key) ?? null}
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

<style>
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
