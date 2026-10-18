<script lang="ts">
	import { onMount } from 'svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import FeedThread from '#lib/components/FeedThread.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import {
		EMPTY_FILTER,
		mergeEntries,
		readFeedFilter,
		shipsIn,
		waitingCount,
		type FeedFilter,
		isWaiting
	} from '#lib/feed.ts';
	import { type FeedEntry } from '#lib/shapes.ts';
	import { formatDeadline } from '#lib/time.ts';
	import { liveNow } from '#lib/clock.svelte.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const FILTER_KEY = 'quarterdeck.feed.filter';

	const clock = liveNow(() => data.now);
	const now = $derived(clock.value);

	// svelte-ignore state_referenced_locally
	let entries = $state<FeedEntry[]>(mergeEntries([], data.page?.entries ?? []));
	let filter = $state<FeedFilter>(EMPTY_FILTER);

	const ships = $derived(shipsIn(entries));
	const waiting = $derived(waitingCount(entries));
	const next = $derived(newestDeadline());

	/** The soonest deadline on an ask still waiting on the captain, or null. */
	function newestDeadline(): number | null {
		const deadlines = entries
			.filter(isWaiting)
			.map((e) => e.deadline_ms)
			.filter((d): d is number => d !== null && d > now)
			.sort((a, b) => a - b);
		return deadlines[0] ?? null;
	}

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

	function changeFilter(next: FeedFilter): void {
		filter = next;
		keep(FILTER_KEY, JSON.stringify(next));
	}

	onMount(() => {
		filter = readFeedFilter(stored(FILTER_KEY));
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

	<FeedThread page={data.page} bind:entries {now} {filter} {form} persistRead />
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
</style>
