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

<button type="button" class="btn btn-quiet" onclick={copy}>
	<Icon name="link" size={14} />
	{copied ? 'Copied' : 'Copy step'}
</button>
