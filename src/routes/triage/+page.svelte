<script lang="ts">
	import { onMount } from 'svelte';
	import { refreshAll } from '$app/navigation';
	import { page } from '$app/state';
	import Icon from '#lib/components/Icon.svelte';
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

<div class="head">
	<div>
		<h1>Triage</h1>
		{#if !data.error}
			<p class="summary" aria-live="polite">
				{#if data.rows.length === 0}
					Nothing is owed to you.
				{:else}
					<span><strong>{data.rows.length}</strong> owed to you</span>
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
	</div>
	<button
		type="button"
		class="btn btn-quiet refresh"
		onclick={refresh}
		disabled={refreshing}
		aria-label="Refresh triage"
	>
		<span class:spin={refreshing}><Icon name="refresh" /></span>
		<span class="refresh-text">{refreshing ? 'Refreshing…' : 'Refresh'}</span>
	</button>
</div>

{#if data.error}
	<div class="state error" role="alert">
		<Icon name="alert" size={28} />
		<h2>Could not read what is owed to you</h2>
		<p class="detail">{data.error}</p>
		<p>Check that Privateer is reachable from this machine, then try again.</p>
		<button type="button" class="btn btn-primary" onclick={refresh} disabled={refreshing}>
			{refreshing ? 'Trying…' : 'Try again'}
		</button>
	</div>
{:else}
	{#if data.unavailable}
		<p class="notice" role="note">
			<Icon name="alert" size={15} /> Blocked items could not be read: {data.unavailable}
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
		<div class="state empty">
			<svg class="horizon" viewBox="0 0 120 48" aria-hidden="true">
				<circle cx="60" cy="30" r="14" class="sun" />
				<path d="M4 34h112" class="sea" />
				<path d="M16 40c4 2 8 2 12 0s8-2 12 0M72 42c4 2 8 2 12 0s8-2 12 0" class="sea" />
			</svg>
			<h2>All clear</h2>
			<p>Nothing is owed to you by any ship.</p>
		</div>
	{:else if sections.length === 0}
		<div class="state empty">
			<h2>Nothing matches these filters</h2>
			<button type="button" class="btn btn-quiet" onclick={clearFilters}>Clear filters</button>
		</div>
	{:else}
		{#each sections as section (section.id)}
			<section class="section" aria-labelledby="section-{section.id}">
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
	.head {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: var(--s-4);
		margin-bottom: var(--s-5);
	}
	h1 {
		font-family: var(--font-display);
		font-size: var(--text-2xl);
		font-weight: 600;
		letter-spacing: -0.02em;
		line-height: 1.1;
		font-variation-settings: 'opsz' 72;
	}
	.summary {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-1) var(--s-3);
		margin-top: var(--s-2);
		color: var(--ink-2);
		font-size: var(--text-sm);
	}
	.summary span + span::before {
		content: '·';
		margin-right: var(--s-3);
		color: var(--ink-3);
	}
	.summary strong {
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}
	.summary .overdue,
	.summary .overdue strong {
		color: var(--danger);
	}
	.summary .updated {
		color: var(--ink-3);
	}
	.refresh {
		flex: none;
	}
	.spin {
		display: inline-flex;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (max-width: 30rem) {
		.refresh-text {
			display: none;
		}
	}

	.notice {
		display: flex;
		align-items: flex-start;
		gap: var(--s-2);
		margin-bottom: var(--s-4);
		padding: var(--s-3);
		border-radius: var(--radius);
		background: var(--warn-soft);
		color: var(--warn);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}

	.filters {
		display: grid;
		gap: var(--s-2);
		margin-bottom: var(--s-5);
	}
	.chips {
		display: flex;
		gap: var(--s-2);
		overflow-x: auto;
		padding-bottom: var(--s-1);
		scrollbar-width: thin;
	}
	.chip {
		flex: none;
		padding: 4px 12px;
		border-radius: 999px;
		border: 1px solid var(--line-strong);
		background: var(--surface);
		color: var(--ink-2);
		font: inherit;
		font-size: var(--text-sm);
		cursor: pointer;
	}
	.chip[aria-pressed='true'] {
		background: var(--sea-soft);
		border-color: var(--sea);
		color: var(--sea-strong);
		font-weight: 650;
	}
	.chip:focus-visible {
		outline: 2px solid var(--sea);
		outline-offset: 2px;
	}

	.section {
		margin-bottom: var(--s-6);
	}
	.section h2 {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		margin-bottom: var(--s-2);
		font-size: var(--text-xs);
		font-weight: 650;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--sea);
	}
	.count {
		padding: 0 7px;
		border-radius: 999px;
		background: var(--surface-2);
		color: var(--ink-2);
		font-variant-numeric: tabular-nums;
		letter-spacing: 0;
	}
	.rows {
		display: grid;
		gap: var(--s-2);
		padding: 0;
		margin: 0;
		list-style: none;
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
		cursor: pointer;
	}

	.state {
		display: grid;
		justify-items: center;
		gap: var(--s-3);
		padding: var(--s-12) var(--s-6);
		text-align: center;
		border: 1px dashed var(--line-strong);
		border-radius: var(--radius-lg);
		color: var(--ink-2);
	}
	.state h2 {
		font-family: var(--font-display);
		font-size: var(--text-xl);
		font-weight: 600;
		color: var(--ink);
	}
	.state.error {
		border-style: solid;
		border-color: color-mix(in srgb, var(--danger) 35%, transparent);
		background: var(--danger-soft);
	}
	.state.error > :global(.icon) {
		color: var(--danger);
	}
	.detail {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		color: var(--danger);
		overflow-wrap: anywhere;
	}
	.horizon {
		width: 120px;
		height: 48px;
	}
	.horizon .sun {
		fill: var(--brass-soft);
		stroke: var(--brass-line);
	}
	.horizon .sea {
		fill: none;
		stroke: var(--sea);
		stroke-width: 2;
		stroke-linecap: round;
	}
</style>
