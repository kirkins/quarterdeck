<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
</script>

<svelte:head>
	<title>{page.status} · Quarterdeck</title>
</svelte:head>

<div class="error">
	<p class="code">{page.status}</p>
	<h1>{page.status === 404 ? 'Off the chart' : 'Something went wrong'}</h1>
	<p>{page.error?.message ?? 'An unexpected error occurred.'}</p>
	<a class="btn" href={resolve('/feed')}>Back to the Feed</a>
</div>

<style>
	.error {
		display: grid;
		justify-items: start;
		gap: var(--s-3);
		padding: var(--s-8) 0;
	}
	.code {
		font-family: var(--font-mono);
		color: var(--ink-3);
	}
	h1 {
		font-family: var(--font-display);
		font-size: var(--text-2xl);
		font-weight: 600;
	}
	p {
		color: var(--ink-2);
	}
	.btn {
		text-decoration: none;
	}
</style>
