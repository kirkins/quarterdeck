<script lang="ts">
	let { who }: { who: string[] } = $props();
</script>

<div class="blocked">
	<span class="label" aria-hidden="true">Waiting on this</span>
	<ul aria-label="Waiting on this">
		{#each who as name (name)}
			<li class="tag tag-outline">{name}</li>
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
		font-size: var(--text-2xs);
		font-weight: 650;
		letter-spacing: var(--track-caps);
		text-transform: uppercase;
		color: var(--ink-3);
		margin-right: var(--s-1);
	}
	ul {
		display: contents;
	}
</style>
