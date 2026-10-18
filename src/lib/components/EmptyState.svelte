<!--
	A designed empty, quiet or error state: an illustration, a heading, a
	sentence or two, and what to do next. Errors are announced.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon, { type IconName } from './Icon.svelte';

	let {
		tone = 'calm',
		title,
		level = 2,
		icon,
		children,
		action
	}: {
		/** calm: nothing to do (a horizon); quiet: not offered here; error: something failed. */
		tone?: 'calm' | 'quiet' | 'error';
		title: string;
		level?: 2 | 3;
		icon?: IconName;
		children?: Snippet;
		action?: Snippet;
	} = $props();
</script>

<div class="state tone-{tone}" role={tone === 'error' ? 'alert' : undefined}>
	{#if tone === 'calm'}
		<svg class="horizon" viewBox="0 0 160 72" aria-hidden="true">
			<circle cx="80" cy="44" r="18" class="sun" />
			<path d="M8 46h144" class="line" />
			<path
				d="M30 54c5 2.6 10 2.6 15 0s10-2.6 15 0M96 58c5 2.6 10 2.6 15 0s10-2.6 15 0M62 64c4 2 8 2 12 0"
				class="wave"
			/>
			<path d="M80 14v6M62 20l3 5M98 20l-3 5" class="ray" />
		</svg>
	{:else}
		<span class="badge" aria-hidden="true"
			><Icon name={icon ?? (tone === 'error' ? 'alert' : 'compass')} size={22} /></span
		>
	{/if}
	<svelte:element this={`h${level}`} class="title display">{title}</svelte:element>
	{#if children}<div class="body">{@render children()}</div>{/if}
	{#if action}<div class="action">{@render action()}</div>{/if}
</div>

<style>
	.state {
		display: grid;
		justify-items: center;
		gap: var(--s-3);
		padding: var(--s-10) var(--s-6);
		text-align: center;
		color: var(--ink-2);
		border-radius: var(--radius-xl);
		background:
			radial-gradient(120% 80% at 50% 0%, var(--sea-wash), transparent 70%), var(--surface-2);
		box-shadow: inset 0 0 0 1px var(--line);
		animation: fade var(--dur-3) var(--ease);
	}
	.tone-error {
		background: var(--danger-soft);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--danger) 25%, transparent);
	}
	.title {
		font-size: var(--text-xl);
		line-height: 1.2;
		color: var(--ink);
		text-wrap: balance;
	}
	.body {
		display: grid;
		gap: var(--s-2);
		max-width: 32rem;
		font-size: var(--text-sm);
		text-wrap: pretty;
	}
	.body :global(code) {
		padding: 1px 5px;
		border-radius: var(--radius-xs);
		background: var(--well);
	}
	.body :global(.detail) {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--danger);
		overflow-wrap: anywhere;
	}
	.action {
		margin-top: var(--s-2);
	}
	.badge {
		display: grid;
		place-items: center;
		width: 3rem;
		height: 3rem;
		border-radius: 50%;
		background: var(--surface-raised);
		box-shadow: var(--elev-1);
		color: var(--sea);
	}
	.tone-error .badge {
		color: var(--danger);
	}
	.horizon {
		width: 160px;
		height: 72px;
		margin-bottom: var(--s-1);
	}
	.sun {
		fill: var(--brass-soft);
		stroke: var(--brass-line);
		stroke-width: 1.5;
	}
	.line {
		stroke: var(--line-strong);
		stroke-width: 1.5;
	}
	.wave,
	.ray {
		fill: none;
		stroke: var(--sea);
		stroke-width: 1.75;
		stroke-linecap: round;
	}
	.ray {
		stroke: var(--brass-line);
	}
	/* The sun sits on the horizon: the sea covers its lower half. */
	.horizon .line {
		fill: none;
	}
</style>
