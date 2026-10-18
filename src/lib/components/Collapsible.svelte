<!--
	A list that shows its first few rows and folds the rest behind a count. With
	`all` set (a search is on) every row shows, so a match is never hidden.
-->
<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';
	import { COLLAPSE_AFTER } from '#lib/ship.ts';

	let {
		items,
		noun,
		all = false,
		row
	}: {
		items: T[];
		/** What the rows are, for the count: "skill", "server". */
		noun: string;
		all?: boolean;
		row: Snippet<[T]>;
	} = $props();

	const head = $derived(all ? items : items.slice(0, COLLAPSE_AFTER));
	const rest = $derived(all ? [] : items.slice(COLLAPSE_AFTER));
	const plural = (n: number) => (n === 1 ? noun : `${noun}s`);
</script>

<ul class="rows">
	{#each head as item, i (i)}<li>{@render row(item)}</li>{/each}
</ul>
{#if rest.length > 0}
	<details class="more">
		<summary>Show {rest.length} more {plural(rest.length)}</summary>
		<ul class="rows">
			{#each rest as item, i (i)}<li>{@render row(item)}</li>{/each}
		</ul>
	</details>
{/if}

<style>
	.rows {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.rows li {
		padding: var(--s-2) 0;
		border-top: 1px solid var(--line);
	}
	.rows li:first-child {
		border-top: 0;
	}
	.more summary {
		min-height: var(--tap);
		display: flex;
		align-items: center;
		color: var(--sea-strong);
		font-size: var(--text-sm);
		font-weight: 600;
		cursor: pointer;
	}
	.more summary:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
</style>
