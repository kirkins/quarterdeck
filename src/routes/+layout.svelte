<script lang="ts">
	import '../app.css';
	import favicon from '#lib/assets/favicon.svg';
	import Mark from '#lib/components/Mark.svelte';
	import ThemeToggle from '#lib/components/ThemeToggle.svelte';
	import { resolve } from '$app/paths';
	import { navigating, page } from '$app/state';
	import type { LayoutProps } from './$types';

	let { children, data }: LayoutProps = $props();

	const open = $derived(typeof page.data.open === 'number' ? page.data.open : null);
	const triage = $derived(typeof data.triage === 'number' ? data.triage : null);
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<a class="skip" href="#main">Skip to content</a>

<header class="masthead">
	<div class="inner">
		<a class="brand" href={resolve('/')} aria-label="Quarterdeck, home">
			<Mark size={30} />
			<span class="wordmark">Quarterdeck</span>
		</a>
		<nav aria-label="Sections">
			<ul>
				<li>
					<a href={resolve('/')} aria-current={page.url.pathname === '/' ? 'page' : undefined}>
						Decisions
						{#if open}<span class="count" aria-label="{open} waiting">{open}</span>{/if}
					</a>
				</li>
				<li>
					<a
						href={resolve('/triage')}
						aria-current={page.url.pathname.startsWith('/triage') ? 'page' : undefined}
					>
						Triage
						{#if triage}<span class="count" aria-label="{triage} owed to you">{triage}</span>{/if}
					</a>
				</li>
				<li>
					<a
						href={resolve('/fleet')}
						aria-current={page.url.pathname.startsWith('/fleet') ? 'page' : undefined}
					>
						Fleet
					</a>
				</li>
				<li>
					<a
						href={resolve('/spend')}
						aria-current={page.url.pathname.startsWith('/spend') ? 'page' : undefined}
					>
						Spend
					</a>
				</li>
			</ul>
		</nav>
		<div class="tools">
			<ThemeToggle initial={data.theme} />
		</div>
	</div>
	{#if navigating.to}
		<div class="progress" role="progressbar" aria-label="Loading"></div>
	{/if}
</header>

{#if !data.live}
	<p class="mode" role="note">
		{#if data.mode === 'fixtures'}
			<strong>Fixture data</strong> · answers are logged, not sent
		{:else}
			<strong>Dry run</strong> · live asks; answers are logged, not sent
		{/if}
	</p>
{/if}

<main id="main" tabindex="-1">
	{@render children()}
</main>

<style>
	.skip {
		position: absolute;
		left: var(--s-2);
		top: -100px;
		z-index: 10;
		padding: var(--s-2) var(--s-3);
		background: var(--surface);
		border-radius: var(--radius-sm);
		box-shadow: var(--shadow);
	}
	.skip:focus {
		top: var(--s-2);
	}

	.masthead {
		position: sticky;
		top: 0;
		z-index: 5;
		background: var(--bg);
		border-bottom: 1px solid var(--line);
		padding-top: env(safe-area-inset-top);
	}
	.inner {
		max-width: calc(var(--content) + 2 * var(--s-4));
		margin: 0 auto;
		padding: 0 var(--s-4);
		display: grid;
		grid-template-columns: 1fr auto;
		grid-template-areas:
			'brand tools'
			'nav nav';
		align-items: center;
		column-gap: var(--s-4);
	}
	.brand {
		grid-area: brand;
		display: inline-flex;
		align-items: center;
		gap: var(--s-3);
		min-height: 56px;
		color: var(--ink);
		text-decoration: none;
		justify-self: start;
	}
	.wordmark {
		font-family: var(--font-display);
		font-size: 1.3125rem;
		font-weight: 620;
		letter-spacing: -0.01em;
		font-variation-settings: 'opsz' 48;
	}
	.tools {
		grid-area: tools;
	}
	nav {
		grid-area: nav;
		margin: 0 calc(-1 * var(--s-4));
		overflow-x: auto;
		scrollbar-width: none;
	}
	nav ul {
		display: flex;
		gap: var(--s-1);
		padding: 0 var(--s-2);
	}
	nav a {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: var(--s-2);
		min-height: var(--tap);
		padding: 0 var(--s-3);
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--ink-2);
		text-decoration: none;
		white-space: nowrap;
	}
	nav a[aria-current='page'] {
		color: var(--ink);
	}
	nav a[aria-current='page']::after {
		content: '';
		position: absolute;
		left: var(--s-3);
		right: var(--s-3);
		bottom: -1px;
		height: 2px;
		border-radius: 2px;
		background: var(--sea);
	}
	.count {
		min-width: 1.5rem;
		padding: 1px 7px;
		border-radius: 999px;
		background: var(--sea);
		color: var(--sea-ink);
		font-size: var(--text-xs);
		font-variant-numeric: tabular-nums;
		text-align: center;
	}

	@media (min-width: 48rem) {
		.inner {
			grid-template-columns: auto 1fr auto;
			grid-template-areas: 'brand nav tools';
			column-gap: var(--s-6);
		}
		nav {
			margin: 0;
			align-self: stretch;
			display: flex;
		}
		nav ul {
			padding: 0;
		}
		nav a {
			min-height: 64px;
		}
	}

	.progress {
		position: absolute;
		left: 0;
		bottom: -1px;
		height: 2px;
		width: 40%;
		background: var(--sea);
		animation: slide 1s var(--ease) infinite;
	}
	@keyframes slide {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(260%);
		}
	}

	.mode {
		max-width: var(--content);
		margin: var(--s-4) auto 0;
		padding: var(--s-1) var(--s-3);
		font-size: var(--text-xs);
		color: var(--ink-2);
		width: fit-content;
		max-width: calc(100% - 2 * var(--s-4));
		border: 1px dashed var(--line-strong);
		border-radius: 999px;
		text-align: center;
	}

	main {
		max-width: calc(var(--content) + 2 * var(--s-4));
		margin: 0 auto;
		padding: var(--s-6) var(--s-4) calc(var(--s-12) + env(safe-area-inset-bottom));
	}
	main:focus {
		outline: none;
	}
</style>
