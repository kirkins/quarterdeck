<!--
	The head of every page: the title in the display face, a summary line that
	says what needs the captain, and the page's own actions on the right.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		eyebrow,
		summary,
		actions
	}: { title: string; eyebrow?: string; summary?: Snippet; actions?: Snippet } = $props();
</script>

<header class="page-head">
	<div class="titles">
		{#if eyebrow}<p class="eyebrow">{eyebrow}</p>{/if}
		<h1 class="display">{title}</h1>
		{@render summary?.()}
	</div>
	{#if actions}<div class="actions">{@render actions()}</div>{/if}
</header>

<style>
	.page-head {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: var(--s-4);
		margin-bottom: var(--s-6);
		padding-bottom: var(--s-4);
		border-bottom: 1px solid var(--line);
	}
	.titles {
		display: grid;
		gap: var(--s-1);
		min-width: 0;
	}
	h1 {
		font-size: var(--text-3xl);
		line-height: 1.05;
		letter-spacing: -0.025em;
		font-weight: 540;
		color: var(--ink);
	}
	.eyebrow {
		color: var(--sea);
	}
	.actions {
		flex: none;
		display: flex;
		gap: var(--s-2);
	}

	/* The summary line: plain facts, the ones that need the captain in brass. */
	.page-head :global(.summary) {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		row-gap: var(--s-1);
		/* Every fact starts with its separator; the ones that start a line are clipped away. */
		margin: var(--s-2) 0 0 -1rem;
		padding: 4px 0;
		clip-path: inset(0 0 0 1rem);
		color: var(--ink-2);
		font-size: var(--text-sm);
	}
	.page-head :global(.summary > span::before) {
		content: '';
		display: inline-block;
		width: 4px;
		height: 4px;
		margin: 0 6px;
		border-radius: 50%;
		background: var(--ink-3);
		opacity: 0.6;
		vertical-align: middle;
	}
	.page-head :global(.summary strong) {
		color: var(--ink);
		font-weight: 650;
		font-variant-numeric: tabular-nums;
	}
	/* What needs the captain comes first, marked in brass where its separator would be. */
	.page-head :global(.summary .need) {
		color: var(--ink);
		font-weight: 550;
	}
	.page-head :global(.summary .need::before) {
		width: 8px;
		height: 8px;
		margin: 0 7px 0 calc(1rem + 1px);
		background: var(--brass-fill);
		opacity: 1;
		vertical-align: 1px;
	}
	.page-head :global(.summary .overdue),
	.page-head :global(.summary .overdue strong) {
		color: var(--danger);
	}
	.page-head :global(.summary .updated) {
		color: var(--ink-3);
	}
	.page-head :global(.summary a) {
		color: inherit;
	}
</style>
