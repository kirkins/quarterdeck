<!--
	One ship's thread with the captain: the Feed filtered to that ship. It is keyed
	by the ship in the page, so a move to another ship starts with that ship's messages.
-->
<script lang="ts">
	import FeedThread from '#lib/components/FeedThread.svelte';
	import { mergeEntries, type FeedFilter } from '#lib/feed.ts';
	import type { FeedEntry, FeedPage } from '#lib/shapes.ts';

	let {
		name,
		page,
		now,
		form
	}: { name: string; page: FeedPage | null; now: number; form: unknown } = $props();

	// svelte-ignore state_referenced_locally
	let entries = $state<FeedEntry[]>(mergeEntries([], page?.entries ?? []));
	const filter: FeedFilter = $derived({ ship: name, onlyWaiting: false, shipMail: false });
</script>

<FeedThread
	{page}
	bind:entries
	{now}
	{filter}
	{form}
	emptyText="{name} has not written to you yet."
/>
