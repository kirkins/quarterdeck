<script lang="ts">
	import { onMount } from 'svelte';
	import { refreshAll } from '$app/navigation';
	import { page } from '$app/state';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import RefreshButton from '#lib/components/RefreshButton.svelte';
	import TriageRow from '#lib/components/TriageRow.svelte';
	import { askKey } from '#lib/decision.ts';
	import { failureFrom } from '#lib/form.ts';
	import { formatAge } from '#lib/time.ts';
	import {
		filterRows,
		groupSections,
		KIND_LABELS,
		readFilter,
		type Filter,
		type TriageKind
	} from '#lib/triage.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const STORAGE_KEY = 'quarterdeck.triage.filter';
	const KINDS: (TriageKind | null)[] = [
		null,
		'decision',
		'request',
		'approval',
		'notice',
		'blocker'
	];
	const REFRESH_MS = 60_000;

	// Relative times tick on the client; the first render uses the server's clock.
	let clock = $state(0);
	const now = $derived(Math.max(data.now, clock));
	let loadedAt = $state(0);
	let refreshing = $state(false);
	let filter = $state<Filter>({ ship: null, kind: null });
	let ready = $state(false);
	/** The open row, by its ask key (sender and mail id). */
	let openKey = $state<string | null>(null);

	const rows = $derived(filterRows(data.rows, filter));
	const sections = $derived(groupSections(rows));
	const filtering = $derived(filter.ship !== null || filter.kind !== null);
	const failure = $derived(failureFrom(form, ['answer', 'reply']));
	const dismissFailure = $derived(failureFrom(form, ['dismiss']));

	// Each fresh load restarts the "updated" clock.
	$effect(() => {
		void data;
		loadedAt = Date.now();
	});

	// Remember the last filter for this browser. A blocked or private storage is fine without it.
	$effect(() => {
		if (!ready) return;
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(filter));
		} catch {
			// Not remembered this time.
		}
	});

	async function refresh() {
		if (refreshing) return;
		refreshing = true;
		try {
			await refreshAll();
		} finally {
			refreshing = false;
		}
	}

	onMount(() => {
		let stored: string | null;
		try {
			stored = localStorage.getItem(STORAGE_KEY);
		} catch {
			stored = null;
		}
		// A link from the fleet map names a ship; that choice wins over the remembered one.
		const shipParam = page.url.searchParams.get('ship');
		filter = shipParam ? { ship: shipParam, kind: null } : readFilter(stored);
		ready = true;
		clock = Date.now();

		const tick = setInterval(() => (clock = Date.now()), 10_000);
		const poll = setInterval(refresh, REFRESH_MS);
		const onFocus = () => refresh();
		window.addEventListener('focus', onFocus);
		return () => {
			clearInterval(tick);
			clearInterval(poll);
			window.removeEventListener('focus', onFocus);
		};
	});

	function toggle(key: string) {
		openKey = openKey === key ? null : key;
	}

	function clearFilters() {
		filter = { ship: null, kind: null };
	}
</script>

<svelte:head>
	<title>{data.rows.length > 0 ? `(${data.rows.length}) ` : ''}Triage · Quarterdeck</title>
</svelte:head>

<PageHeader title="Triage">
	{#snippet summary()}
		{#if !data.error}
			<p class="summary" aria-live="polite">
				{#if data.rows.length === 0}
					<span>Nothing is owed to you</span>
				{:else}
					<span class="need"><strong>{data.rows.length}</strong> owed to you</span>
					{#if data.rows.some((r) => r.overdue)}
						<span class="overdue"
							><strong>{data.rows.filter((r) => r.overdue).length}</strong> overdue</span
						>
					{/if}
				{/if}
				{#if loadedAt > 0}<span class="updated">Updated {formatAge(loadedAt, clock || now)}</span
					>{/if}
			</p>
		{/if}
	{/snippet}
	{#snippet actions()}
		<RefreshButton label="Refresh triage" {refreshing} onclick={refresh} />
	{/snippet}
</PageHeader>

{#if data.error}
	<EmptyState tone="error" title="Could not read what is owed to you">
		<p class="detail">{data.error}</p>
		<p>Check that Privateer is reachable from this machine, then try again.</p>
		{#snippet action()}
			<button type="button" class="btn btn-primary" onclick={refresh} disabled={refreshing}>
				{refreshing ? 'Trying…' : 'Try again'}
			</button>
		{/snippet}
	</EmptyState>
{:else}
	{#if data.unavailable}
		<p class="callout callout-warn notice" role="note">
			<Icon name="alert" size={16} /> Blocked items could not be read: {data.unavailable}
		</p>
	{/if}

	{#if data.rows.length > 0}
		<div class="filters">
			<div class="chips" role="group" aria-label="Filter by ship">
				<button
					type="button"
					class="chip"
					aria-pressed={filter.ship === null}
					onclick={() => (filter = { ...filter, ship: null })}>All ships</button
				>
				{#each data.ships as ship (ship)}
					<button
						type="button"
						class="chip"
						aria-pressed={filter.ship === ship}
						onclick={() => (filter = { ...filter, ship })}>{ship}</button
					>
				{/each}
			</div>
			<div class="chips" role="group" aria-label="Filter by kind">
				{#each KINDS as kind (kind ?? 'all')}
					<button
						type="button"
						class="chip"
						aria-pressed={filter.kind === kind}
						onclick={() => (filter = { ...filter, kind })}
						>{kind === null ? 'Any kind' : KIND_LABELS[kind]}</button
					>
				{/each}
			</div>
		</div>
	{/if}

	{#if data.rows.length === 0}
		<EmptyState title="All clear">
			<p>Nothing is owed to you by any ship.</p>
		</EmptyState>
	{:else if sections.length === 0}
		<EmptyState tone="quiet" title="Nothing matches these filters" icon="inbox">
			{#snippet action()}
				<button type="button" class="btn" onclick={clearFilters}>Clear filters</button>
			{/snippet}
		</EmptyState>
	{:else}
		{#each sections as section (section.id)}
			<section class="section section-{section.id}" aria-labelledby="section-{section.id}">
				<h2 id="section-{section.id}">
					{section.title}
					<span class="count">{section.rows.length}</span>
				</h2>
				<ul class="rows">
					{#each section.rows as row (askKey(row.item.from, row.item.id))}
						{@const key = askKey(row.item.from, row.item.id)}
						<TriageRow
							{row}
							{now}
							{failure}
							{dismissFailure}
							open={openKey === key}
							ontoggle={() => toggle(key)}
						/>
					{/each}
				</ul>
			</section>
		{/each}
		{#if filtering}
			<p class="footnote">
				Filtered. <button type="button" class="link" onclick={clearFilters}>Show everything</button>
			</p>
		{/if}
	{/if}
{/if}

<style>
	.notice {
		margin-bottom: var(--s-4);
	}

	.filters {
		display: grid;
		gap: var(--s-2);
		margin: calc(-1 * var(--s-2)) calc(-1 * var(--s-4)) var(--s-4);
	}
	.chips {
		display: flex;
		gap: var(--s-2);
		padding: 2px var(--s-4);
		overflow-x: auto;
		scrollbar-width: none;
		-webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 2rem), transparent);
		mask-image: linear-gradient(90deg, #000 calc(100% - 2rem), transparent);
	}
	.chips::-webkit-scrollbar {
		display: none;
	}

	.section {
		margin-bottom: var(--s-8);
	}
	.section h2 {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		margin-bottom: var(--s-3);
		font-size: var(--text-2xs);
		font-weight: 700;
		letter-spacing: var(--track-caps);
		text-transform: uppercase;
		color: var(--ink-2);
	}
	.section h2::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--line);
	}
	.section-now h2 {
		color: var(--danger);
	}
	.section-now .count {
		background: var(--danger-soft);
		color: var(--danger);
	}
	.rows {
		display: grid;
		gap: var(--s-2);
	}
	.footnote {
		font-size: var(--text-sm);
		color: var(--ink-3);
	}
	.link {
		background: none;
		border: 0;
		padding: 0;
		font: inherit;
		color: var(--sea);
		text-decoration: underline;
		text-underline-offset: 0.18em;
		cursor: pointer;
	}
	@media (min-width: 60rem) {
		.filters {
			margin-left: 0;
			margin-right: 0;
		}
		.chips {
			padding: 2px 0;
		}
	}
</style>
