<!-- A page-shaped placeholder while the next page loads. The progress bar is what is announced. -->
<script lang="ts">
	let { rows = 4 }: { rows?: number } = $props();
</script>

<div class="skeleton-page" aria-hidden="true">
	<span class="skeleton title"></span>
	<span class="skeleton line short"></span>
	<div class="cards">
		{#each Array.from({ length: rows }, (_, n) => n) as i (i)}
			<div class="card">
				<span class="skeleton line tiny"></span>
				<span class="skeleton line"></span>
				<span class="skeleton line mid"></span>
			</div>
		{/each}
	</div>
</div>

<style>
	.skeleton-page {
		display: grid;
		gap: var(--s-3);
		animation: fade var(--dur-3) var(--ease);
	}
	.title {
		width: 9rem;
		height: 2.25rem;
		border-radius: var(--radius);
	}
	.line {
		height: 0.875rem;
		width: 100%;
	}
	.short {
		width: 14rem;
		margin-bottom: var(--s-4);
	}
	.mid {
		width: 62%;
	}
	.tiny {
		width: 5rem;
		height: 0.625rem;
	}
	.cards {
		display: grid;
		gap: var(--s-3);
	}
	.card {
		display: grid;
		gap: var(--s-3);
		padding: var(--s-4);
		border-radius: var(--radius-lg);
		background: var(--surface);
		box-shadow: var(--elev-1);
	}
</style>
