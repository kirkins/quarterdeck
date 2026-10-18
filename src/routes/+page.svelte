<script lang="ts">
	import { onMount } from 'svelte';
	import { refreshAll } from '$app/navigation';
	import DecisionCard from '#lib/components/DecisionCard.svelte';
	import Icon from '#lib/components/Icon.svelte';
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

<div class="head">
	<div>
		<h1>Decisions</h1>
		{#if !data.error}
			<p class="summary" aria-live="polite">
				{#if open.length === 0}
					Nothing waiting on you.
				{:else}
					<span><strong>{open.length}</strong> waiting</span>
					{#if overdue > 0}<span class="overdue"><strong>{overdue}</strong> overdue</span>{/if}
					{#if next !== null}<span>next {formatDeadline(next, now).toLowerCase()}</span>{/if}
				{/if}
			</p>
		{/if}
	</div>
	<button
		type="button"
		class="btn btn-quiet refresh"
		onclick={refresh}
		disabled={refreshing}
		aria-label="Refresh decisions"
	>
		<span class:spin={refreshing}><Icon name="refresh" /></span>
		<span class="refresh-text">{refreshing ? 'Refreshing…' : 'Refresh'}</span>
	</button>
</div>

{#if data.error}
	<div class="state error" role="alert">
		<Icon name="alert" size={28} />
		<h2>Could not read the fleet’s asks</h2>
		<p class="detail">{data.error}</p>
		<p>Check that Privateer is reachable from this machine, then try again.</p>
		<button type="button" class="btn btn-primary" onclick={refresh} disabled={refreshing}>
			{refreshing ? 'Trying…' : 'Try again'}
		</button>
	</div>
{:else if data.cards.length === 0}
	<div class="state empty">
		<svg class="horizon" viewBox="0 0 120 48" aria-hidden="true">
			<circle cx="60" cy="30" r="14" class="sun" />
			<path d="M4 34h112" class="sea" />
			<path d="M16 40c4 2 8 2 12 0s8-2 12 0M72 42c4 2 8 2 12 0s8-2 12 0" class="sea" />
		</svg>
		<h2>Calm seas</h2>
		<p>No ship is waiting on a decision from you.</p>
	</div>
{:else}
	<ol class="cards">
		{#each data.cards as card (card.key)}
			<li><DecisionCard {card} {now} {failure} {dismissFailure} /></li>
		{/each}
	</ol>
{/if}

<style>
	.head {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: var(--s-4);
		margin-bottom: var(--s-6);
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

	.cards {
		display: grid;
		gap: var(--s-5);
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
