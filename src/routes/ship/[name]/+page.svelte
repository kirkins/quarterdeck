<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { params }: PageProps = $props();
</script>

<svelte:head>
	<title>{params.name} · Quarterdeck</title>
</svelte:head>

<h1>{params.name}</h1>
<p class="coming">
	The ship page is coming. Its thread is the Feed, filtered to this ship.
	<a href={resolve('/feed')}>Back to the Feed</a>
</p>

<style>
	h1 {
		margin: 0 0 var(--s-3);
		font-size: var(--text-2xl);
	}
	.coming {
		color: var(--ink-2);
	}
</style>
