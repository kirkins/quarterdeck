<!-- Refresh a page's data. The icon turns while it works; the label hides on a phone. -->
<script lang="ts">
	import Icon from './Icon.svelte';

	let { label, refreshing, onclick }: { label: string; refreshing: boolean; onclick: () => void } =
		$props();
</script>

<button
	type="button"
	class="btn btn-quiet refresh"
	{onclick}
	disabled={refreshing}
	aria-label={label}
>
	<span class="turn" class:spin={refreshing}><Icon name="refresh" /></span>
	<span class="text">{refreshing ? 'Refreshing…' : 'Refresh'}</span>
</button>

<style>
	.refresh {
		flex: none;
		color: var(--ink-3);
	}
	.refresh:hover {
		color: var(--ink);
	}
	.refresh[disabled] {
		opacity: 1;
		cursor: progress;
	}
	.turn {
		display: inline-flex;
	}
	.spin {
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (max-width: 30rem) {
		.text {
			display: none;
		}
	}
</style>
