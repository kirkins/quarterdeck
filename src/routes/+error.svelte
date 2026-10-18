<script lang="ts">
	import EmptyState from '#lib/components/EmptyState.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
</script>

<svelte:head>
	<title>{page.status} · Quarterdeck</title>
</svelte:head>

<div class="error">
	<p class="code">Error {page.status}</p>
	<h1 class="display">{page.status === 404 ? 'Off the chart' : 'Something went wrong'}</h1>
	<EmptyState
		tone={page.status === 404 ? 'quiet' : 'error'}
		title={page.status === 404
			? 'This page is not on any chart we have'
			: 'The page could not be drawn'}
		icon="compass"
	>
		<p>{page.error?.message ?? 'An unexpected error occurred.'}</p>
		{#snippet action()}
			<a class="btn btn-primary" href={resolve('/feed')}
				><Icon name="arrow-left" size={16} /> Back to the Feed</a
			>
		{/snippet}
	</EmptyState>
</div>

<style>
	.error {
		display: grid;
		gap: var(--s-4);
		padding: var(--s-4) 0;
	}
	.code {
		font-size: var(--text-2xs);
		font-weight: 650;
		letter-spacing: var(--track-caps);
		text-transform: uppercase;
		color: var(--sea);
	}
	h1 {
		margin-top: calc(-1 * var(--s-3));
		font-size: var(--text-3xl);
		line-height: 1.05;
		letter-spacing: -0.025em;
	}
</style>
