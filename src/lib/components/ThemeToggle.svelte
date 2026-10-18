<!--
	The theme: follow the system, or pick light or dark. One button steps
	through the three; a desktop shows its name beside the icon.
-->
<script lang="ts">
	import Icon from './Icon.svelte';

	type Theme = 'system' | 'light' | 'dark';
	const ORDER: Theme[] = ['system', 'light', 'dark'];
	const LABEL: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };
	const ICON = { system: 'system', light: 'sun', dark: 'moon' } as const;

	let { initial }: { initial: Theme } = $props();
	// svelte-ignore state_referenced_locally
	let theme = $state<Theme>(initial);

	function next() {
		theme = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
		document.documentElement.dataset.theme = theme;
		document.cookie = `qd_theme=${theme}; path=/; max-age=31536000; samesite=lax`;
	}
</script>

<button
	type="button"
	class="toggle btn btn-quiet"
	onclick={next}
	aria-label="Theme: {LABEL[theme]}. Change theme"
	title="Theme: {LABEL[theme]}"
>
	<Icon name={ICON[theme]} size={20} />
	<span class="text"><span class="eyebrow">Theme</span> {LABEL[theme]}</span>
</button>

<style>
	.toggle {
		width: var(--tap);
		padding: 0;
		color: var(--ink-2);
	}
	.text {
		display: none;
	}
	@media (min-width: 60rem) {
		.toggle {
			width: 100%;
			justify-content: flex-start;
			gap: var(--s-3);
			padding: 0 var(--s-2);
			font-weight: 550;
		}
		.text {
			display: inline-flex;
			align-items: baseline;
			gap: var(--s-2);
		}
	}
</style>
