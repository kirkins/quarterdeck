<script lang="ts">
	import EmptyState from '#lib/components/EmptyState.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import ShipConversation from '#lib/components/ShipConversation.svelte';
	import ShipTools from '#lib/components/ShipTools.svelte';
	import { liveNow } from '#lib/clock.svelte.ts';
	import { presenceLabel, waitLabel } from '#lib/fleet.ts';
	import { SHIP_TABS, tabOf, type ShipTab } from '#lib/ship.ts';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const clock = liveNow(() => data.now);
	const now = $derived(clock.value);
	const view = $derived(data.ship);
	const facts = $derived(view.facts);

	// The conversation is the default; ?tab=tools opens the tools. The URL follows the tab.
	let tab = $state<ShipTab>(tabOf(page.url.searchParams.get('tab')));

	function setTab(next: ShipTab) {
		tab = next;
		const search = new SvelteURLSearchParams(page.url.search);
		if (next === 'conversation') search.delete('tab');
		else search.set('tab', next);
		const query = search.toString();
		const path = resolve('/ship/[name]', { name: view.name });
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- the same page; only its ?tab= changes
		replaceState(query ? `${path}?${query}` : path, page.state);
	}

	/** Arrow keys move between the tabs, as a tab list should. */
	function onTabKey(event: KeyboardEvent) {
		if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
		const index = SHIP_TABS.findIndex((t) => t.id === tab);
		const step = event.key === 'ArrowRight' ? 1 : -1;
		const next = SHIP_TABS[(index + step + SHIP_TABS.length) % SHIP_TABS.length];
		event.preventDefault();
		setTab(next.id);
		document.getElementById(`tab-${next.id}`)?.focus();
	}
</script>

<svelte:head>
	<title>{view.name} · Quarterdeck</title>
</svelte:head>

{#if view.notFound}
	<PageHeader title="Not found" eyebrow="Ship" />
	<EmptyState tone="quiet" title="No ship called “{view.name}”" icon="ship">
		<p>Check the name, or find the ship on the Fleet.</p>
		{#snippet action()}
			<a class="btn" href={resolve('/fleet')}>Open the Fleet</a>
		{/snippet}
	</EmptyState>
{:else}
	<PageHeader title={view.name} eyebrow="Ship">
		{#snippet summary()}
			<p class="summary">
				{#if facts}
					<span>On {facts.machine}{facts.reachable ? '' : ' (not reachable)'}</span>
					<span>{presenceLabel(facts.presence, facts.presenceSince, now)}</span>
					{#if facts.needs > 0}
						<a class="needs" href="{resolve('/triage')}?ship={encodeURIComponent(view.name)}">
							<strong>{facts.needs}</strong>
							{facts.needs === 1 ? 'item needs' : 'items need'} you
						</a>
					{:else}
						<span>Nothing waiting on you</span>
					{/if}
				{:else if view.factsState === 'error'}
					<span>The fleet could not be read</span>
				{:else}
					<span>Not on any machine in the fleet map</span>
				{/if}
			</p>
		{/snippet}
	</PageHeader>

	{#if facts && facts.jobs.length > 0}
		<section class="crew" aria-labelledby="crew-now">
			<h2 id="crew-now">Crew now</h2>
			<ul>
				{#each facts.jobs as job (job.id)}
					<li data-state={job.state}>
						<span class="task">{job.task_title ?? job.task_id ?? 'A task'}</span>
						{#if job.doing}<span class="doing">{job.doing.text}</span>{/if}
						{#if job.state && job.state !== 'running'}<span class="tag">{job.state}</span>{/if}
						{#if job.wait}<span class="tag tag-warn">{waitLabel(job.wait, now)}</span>{/if}
					</li>
				{/each}
			</ul>
		</section>
	{:else if view.factsState === 'unsupported'}
		<p class="hint">
			The fleet map is not on this Privateer yet, so the header facts are not shown.
		</p>
	{/if}

	<div class="segmented tabs" role="tablist" aria-label="Ship">
		{#each SHIP_TABS as t (t.id)}
			<button
				type="button"
				role="tab"
				id="tab-{t.id}"
				aria-selected={tab === t.id}
				aria-controls="panel-{t.id}"
				tabindex={tab === t.id ? 0 : -1}
				onclick={() => setTab(t.id)}
				onkeydown={onTabKey}>{t.label}</button
			>
		{/each}
	</div>

	{#if tab === 'conversation'}
		<div id="panel-conversation" role="tabpanel" aria-labelledby="tab-conversation" class="panel">
			{#if data.feedUnsupported}
				<EmptyState tone="quiet" title="The feed is not on this Privateer yet" icon="feed">
					<p>
						This Privateer does not offer <code>captain.feed</code>, so this conversation cannot be
						read yet.
					</p>
				</EmptyState>
			{:else if data.feedError}
				<EmptyState tone="error" title="Could not read the conversation">
					<p class="detail">{data.feedError}</p>
					<p>Check that Privateer is reachable from this machine, then reload.</p>
				</EmptyState>
			{:else}
				{#key view.name}
					<ShipConversation name={view.name} page={data.page} {now} {form} />
				{/key}
			{/if}
		</div>
	{:else}
		<div id="panel-tools" role="tabpanel" aria-labelledby="tab-tools" class="panel">
			<ShipTools {view} />
		</div>
	{/if}
{/if}

<style>
	.summary {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-1) var(--s-3);
		margin: 0;
		font-size: var(--text-sm);
		color: var(--ink-2);
	}
	.summary > span:not(:last-child)::after,
	.summary > a:not(:last-child)::after {
		content: '·';
		margin-left: var(--s-3);
		color: var(--ink-3);
	}
	.needs {
		color: var(--brass);
		font-weight: 600;
		text-decoration: none;
	}
	.needs:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}

	.crew {
		margin-bottom: var(--s-5);
	}
	.crew h2 {
		margin: 0 0 var(--s-2);
		font-size: var(--text-2xs);
		font-weight: 650;
		letter-spacing: var(--track-caps);
		text-transform: uppercase;
		color: var(--ink-3);
	}
	.crew ul {
		display: grid;
		gap: var(--s-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.crew li {
		display: grid;
		gap: 2px;
		padding: var(--s-3);
		border-radius: var(--radius);
		background: var(--surface);
		box-shadow: var(--elev-1);
	}
	.task {
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--ink);
	}
	.doing {
		font-size: var(--text-sm);
		color: var(--ink-2);
	}
	.crew .tag {
		justify-self: start;
	}
	.hint {
		margin: 0 0 var(--s-4);
		font-size: var(--text-sm);
		color: var(--ink-3);
	}

	.tabs {
		display: flex;
		margin-bottom: var(--s-5);
	}
	.tabs button {
		flex: 1;
	}
	.tabs [aria-selected='true'] {
		background: var(--surface-raised);
		box-shadow: var(--elev-1);
		color: var(--ink);
	}
	.tabs button:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
</style>
