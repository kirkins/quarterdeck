<!--
	The theme: follow the system, or pick light or dark. A desktop shows the
	three as a segmented control; a phone has one button that steps through them.
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

	function choose(next: Theme) {
		theme = next;
		document.documentElement.dataset.theme = theme;
		document.cookie = `qd_theme=${theme}; path=/; max-age=31536000; samesite=lax`;
	}

	function next() {
		choose(ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]);
	}
</script>

<button
	type="button"
	class="cycle btn btn-quiet"
	onclick={next}
	aria-label="Theme: {LABEL[theme]}. Change theme"
	title="Theme: {LABEL[theme]}"
>
	<Icon name={ICON[theme]} size={20} />
</button>

<div class="pick segmented" role="group" aria-label="Theme">
	{#each ORDER as t (t)}
		<button type="button" aria-pressed={theme === t} title={LABEL[t]} onclick={() => choose(t)}>
			<Icon name={ICON[t]} size={16} />
			<span class="visually-hidden">{LABEL[t]}</span>
		</button>
	{/each}
</div>

<style>
	.cycle {
		width: var(--tap);
		padding: 0;
		color: var(--ink-2);
	}
	.pick {
		display: none;
		width: 100%;
	}
	.pick button {
		flex: 1;
		min-height: 2rem;
		color: var(--ink-3);
	}
	.pick button[aria-pressed='true'] {
		color: var(--ink);
	}
	@media (min-width: 60rem) {
		.cycle {
			display: none;
		}
		.pick {
			display: flex;
		}
	}
</style>
