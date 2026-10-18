<!--
	A button that copies a step to the clipboard and says so for a moment. With no
	clipboard, or permission refused, the step stays on screen to copy by hand.
-->
<script lang="ts">
	import Icon from './Icon.svelte';

	let { text }: { text: string } = $props();

	let copied = $state(false);
	async function copy() {
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
			setTimeout(() => (copied = false), 1600);
		} catch {
			// No clipboard here (or permission refused): the step stays on screen to copy by hand.
		}
	}
</script>

<button type="button" class="btn btn-quiet btn-sm copy" class:copied onclick={copy}>
	<Icon name={copied ? 'check' : 'copy'} size={15} />
	{copied ? 'Copied' : 'Copy step'}
</button>

<style>
	.copied {
		color: var(--ok);
	}
</style>
