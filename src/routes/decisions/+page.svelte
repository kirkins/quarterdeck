<script lang="ts">
	import { onMount } from 'svelte';
	import { refreshAll } from '$app/navigation';
	import DecisionCard from '#lib/components/DecisionCard.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import RefreshButton from '#lib/components/RefreshButton.svelte';
	import { failureFrom } from '#lib/form.ts';
	import { formatDeadline, urgencyOf } from '#lib/time.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// Relative times tick on the client; the first render uses the server's clock.
	let clock = $state(0);
	const now = $derived(Math.max(data.now, clock));
	let refreshing = $state(false);

	onMount(() => {
		clock = Date.now();
		const timer = setInterval(() => (clock = Date.now()), 30_000);
		return () => clearInterval(timer);
	});

	const open = $derived(data.cards.flatMap((c) => c.questions).filter((q) => !q.answered));
	const overdue = $derived(open.filter((q) => urgencyOf(q.deadline_ms, now) === 'overdue').length);
	const next = $derived(
		open
			.map((q) => q.deadline_ms)
			.filter((d): d is number => d !== null && d > now)
			.sort((a, b) => a - b)[0] ?? null
	);
	const failure = $derived(failureFrom(form, ['answer']));
	const dismissFailure = $derived(failureFrom(form, ['dismiss']));

	async function refresh() {
		refreshing = true;
		try {
			await refreshAll();
		} finally {
			refreshing = false;
		}
	}
</script>

<svelte:head>
	<title>{open.length > 0 ? `(${open.length}) ` : ''}Decisions · Quarterdeck</title>
</svelte:head>

<PageHeader title="Decisions">
	{#snippet summary()}
		{#if !data.error}
			<p class="summary" aria-live="polite">
				{#if open.length === 0}
					<span>Nothing waiting on you</span>
				{:else}
					<span class="need"><strong>{open.length}</strong> waiting</span>
					{#if overdue > 0}<span class="overdue"><strong>{overdue}</strong> overdue</span>{/if}
					{#if next !== null}<span>next {formatDeadline(next, now).toLowerCase()}</span>{/if}
				{/if}
			</p>
		{/if}
	{/snippet}
	{#snippet actions()}
		<RefreshButton label="Refresh decisions" {refreshing} onclick={refresh} />
	{/snippet}
</PageHeader>

{#if data.error}
	<EmptyState tone="error" title="Could not read the fleet’s asks">
		<p class="detail">{data.error}</p>
		<p>Check that Privateer is reachable from this machine, then try again.</p>
		{#snippet action()}
			<button type="button" class="btn btn-primary" onclick={refresh} disabled={refreshing}>
				{refreshing ? 'Trying…' : 'Try again'}
			</button>
		{/snippet}
	</EmptyState>
{:else if data.cards.length === 0}
	<EmptyState title="Calm seas">
		<p>No ship is waiting on a decision from you.</p>
	</EmptyState>
{:else}
	<ol class="cards">
		{#each data.cards as card (card.key)}
			<li><DecisionCard {card} {now} {failure} {dismissFailure} /></li>
		{/each}
	</ol>
{/if}

<style>
	.cards {
		display: grid;
		gap: var(--s-5);
	}
</style>
