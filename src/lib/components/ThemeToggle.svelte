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
	<Icon name={ICON[theme]} />
	<span class="text">{LABEL[theme]}</span>
</button>

<style>
	.toggle {
		padding: 0 var(--s-3);
		font-weight: 500;
	}
	@media (max-width: 30rem) {
		.text {
			display: none;
		}
	}
</style>
