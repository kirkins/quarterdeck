<script lang="ts">
	import EmptyState from '#lib/components/EmptyState.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { params }: PageProps = $props();
</script>

<svelte:head>
	<title>{params.name} · Quarterdeck</title>
</svelte:head>

<PageHeader title={params.name} eyebrow="Ship" />

<EmptyState tone="quiet" title="The ship page is coming" icon="ship">
	<p>Its thread is the Feed, filtered to this ship.</p>
	{#snippet action()}
		<a class="btn" href={resolve('/feed')}>Back to the Feed</a>
	{/snippet}
</EmptyState>
