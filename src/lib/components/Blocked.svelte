<script lang="ts">
	let { who }: { who: string[] } = $props();
</script>

<div class="blocked">
	<span class="label" aria-hidden="true">Waiting on this</span>
	<ul aria-label="Waiting on this">
		{#each who as name (name)}
			<li>{name}</li>
		{/each}
	</ul>
</div>

<style>
	.blocked {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2);
	}
	.label {
		font-size: var(--text-xs);
		font-weight: 600;
		color: var(--ink-3);
		margin-right: var(--s-1);
	}
	ul {
		display: contents;
	}
	li {
		font-size: var(--text-xs);
		font-weight: 600;
		padding: 3px 10px;
		border-radius: 999px;
		background: var(--surface-2);
		border: 1px solid var(--line);
		color: var(--ink-2);
	}
</style>
