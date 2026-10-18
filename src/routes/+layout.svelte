<!--
	The shell. One navigation, drawn two ways: a tab bar at the bottom of a
	phone, in reach of the thumb, and a quiet sidebar on a desktop. Badges say
	what waits on the captain. Toasts confirm what was sent.
-->
<script lang="ts">
	import '../app.css';
	import { untrack } from 'svelte';
	import favicon from '#lib/assets/favicon.svg';
	import Icon, { type IconName } from '#lib/components/Icon.svelte';
	import Mark from '#lib/components/Mark.svelte';
	import Skeleton from '#lib/components/Skeleton.svelte';
	import ThemeToggle from '#lib/components/ThemeToggle.svelte';
	import Toaster from '#lib/components/Toaster.svelte';
	import { toast, toastFor } from '#lib/toast.svelte.ts';
	import { resolve } from '$app/paths';
	import { navigating, page } from '$app/state';
	import type { LayoutProps } from './$types';

	let { children, data }: LayoutProps = $props();

	type Section = '/feed' | '/triage' | '/decisions' | '/fleet' | '/spend';
	const SECTIONS: { path: Section; label: string; icon: IconName }[] = [
		{ path: '/feed', label: 'Feed', icon: 'feed' },
		{ path: '/triage', label: 'Triage', icon: 'inbox' },
		{ path: '/decisions', label: 'Decisions', icon: 'compass' },
		{ path: '/fleet', label: 'Fleet', icon: 'anchor' },
		{ path: '/spend', label: 'Spend', icon: 'chart' }
	];
	/** Pages that use the full width: a report beside its comments, the machines, the numbers. */
	const WIDE = ['/report', '/fleet', '/spend'];

	const open = $derived(typeof page.data.open === 'number' ? page.data.open : null);
	const triage = $derived(typeof data.triage === 'number' ? data.triage : null);
	const wide = $derived(WIDE.some((p) => page.url.pathname.startsWith(p)));

	// Every form action echoes what it did; say so for a moment.
	$effect(() => {
		const said = toastFor(page.form);
		if (said) untrack(() => toast(said.text, said.tone));
	});

	// A page that takes a moment to load shows its shape rather than the old page.
	let slow = $state(false);
	$effect(() => {
		const to = navigating.to;
		if (!to || to.url.pathname === page.url.pathname) {
			slow = false;
			return;
		}
		const timer = setTimeout(() => (slow = true), 180);
		return () => clearTimeout(timer);
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<a class="skip" href="#main">Skip to content</a>

{#if navigating.to}
	<div class="progress" role="progressbar" aria-label="Loading"></div>
{/if}

<div class="shell">
	<header class="rail">
		<a class="brand" href={resolve('/feed')} aria-label="Quarterdeck, home">
			<Mark size={30} />
			<span class="wordmark">Quarterdeck</span>
		</a>

		<nav aria-label="Sections">
			<ul>
				{#each SECTIONS as s (s.path)}
					{@const current = page.url.pathname.startsWith(s.path)}
					<li>
						<a class="tab" href={resolve(s.path)} aria-current={current ? 'page' : undefined}>
							<span class="tab-icon"
								><Icon name={s.icon} size={22} stroke={current ? 2 : 1.75} /></span
							>
							<span class="tab-label">{s.label}</span>
							{#if s.path === '/feed' && triage}
								<span class="dot" aria-label="{triage} waiting on you"></span>
							{:else if s.path === '/triage' && triage}
								<span class="count count-brass" aria-label="{triage} owed to you">{triage}</span>
							{:else if s.path === '/decisions' && open}
								<span class="count" aria-label="{open} waiting">{open}</span>
							{/if}
						</a>
					</li>
				{/each}
			</ul>
		</nav>

		{#if !data.live}
			<p class="mode" role="note">
				<span class="mode-dot" aria-hidden="true"></span>
				{#if data.mode === 'fixtures'}
					<span><strong>Fixture data</strong> · answers are logged, not sent</span>
				{:else}
					<span><strong>Dry run</strong> · live asks; answers are logged, not sent</span>
				{/if}
			</p>
		{/if}

		<div class="tools">
			<ThemeToggle initial={data.theme} />
		</div>
	</header>

	<main id="main" tabindex="-1" class:wide>
		{#if slow}
			<Skeleton />
		{:else}
			{@render children()}
		{/if}
	</main>
</div>

<Toaster />

<style>
	:global(:root) {
		/* What the tab bar takes from the bottom of a phone; floating things sit above it. */
		--dock: calc(var(--tabbar-h) + env(safe-area-inset-bottom));
	}
	@media (min-width: 60rem) {
		:global(:root) {
			--dock: 0px;
		}
	}

	/* A faint chart grid under everything: seasoning, not costume. */
	:global(body) {
		background-image:
			linear-gradient(var(--chart-line) 1px, transparent 1px),
			linear-gradient(90deg, var(--chart-line) 1px, transparent 1px);
		background-size: 72px 72px;
		background-position: -1px -1px;
		background-attachment: fixed;
	}
	:global(:root) {
		--chart-line: light-dark(rgb(18 40 74 / 0.028), rgb(196 214 235 / 0.022));
	}

	.skip {
		position: absolute;
		left: var(--s-2);
		top: -100px;
		z-index: 50;
		padding: var(--s-2) var(--s-3);
		background: var(--surface-raised);
		border-radius: var(--radius-sm);
		box-shadow: var(--elev-2);
	}
	.skip:focus {
		top: var(--s-2);
	}

	.progress {
		position: fixed;
		top: 0;
		left: 0;
		z-index: 60;
		height: 2px;
		width: 40%;
		background: linear-gradient(90deg, transparent, var(--sea), transparent);
		animation: slide 1s var(--ease-in-out) infinite;
	}
	@keyframes slide {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(260%);
		}
	}

	/* Phone first: a light top bar that scrolls away, and the tab bar fixed below. */
	.rail {
		display: grid;
		grid-template-columns: 1fr auto;
		grid-template-areas:
			'brand tools'
			'mode mode';
		align-items: center;
		column-gap: var(--s-3);
		padding: calc(env(safe-area-inset-top) + var(--s-2)) var(--s-4) 0;
	}
	.brand {
		grid-area: brand;
		display: inline-flex;
		align-items: center;
		gap: var(--s-3);
		min-height: 52px;
		color: var(--ink);
		text-decoration: none;
		justify-self: start;
		border-radius: var(--radius-sm);
	}
	.wordmark {
		font-family: var(--font-display);
		font-style: italic;
		font-size: 1.375rem;
		font-weight: 560;
		letter-spacing: -0.01em;
		line-height: 1;
	}
	.tools {
		grid-area: tools;
	}

	.mode {
		grid-area: mode;
		display: flex;
		align-items: center;
		gap: var(--s-2);
		justify-self: start;
		margin: var(--s-1) 0 0;
		padding: 0.3125rem var(--s-3) 0.3125rem var(--s-2);
		border-radius: var(--radius-pill);
		background: var(--brass-soft);
		color: var(--ink-2);
		font-size: var(--text-xs);
		line-height: 1.3;
	}
	.mode strong {
		color: var(--brass);
		font-weight: 650;
	}
	.mode-dot {
		flex: none;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--brass-fill);
	}

	nav {
		position: fixed;
		z-index: 30;
		inset: auto 0 0 0;
		padding-bottom: env(safe-area-inset-bottom);
		background: var(--chrome);
		backdrop-filter: saturate(1.6) blur(18px);
		-webkit-backdrop-filter: saturate(1.6) blur(18px);
		box-shadow: 0 -1px 0 var(--line);
	}
	nav ul {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		height: var(--tabbar-h);
		max-width: 36rem;
		margin: 0 auto;
	}
	.tab {
		position: relative;
		display: grid;
		justify-items: center;
		align-content: center;
		gap: 3px;
		height: 100%;
		color: var(--ink-3);
		text-decoration: none;
		transition: color var(--dur-1) var(--ease);
	}
	.tab-icon {
		display: grid;
		place-items: center;
		width: 3.5rem;
		height: 1.875rem;
		border-radius: var(--radius-pill);
		transition: background-color var(--dur-2) var(--ease);
	}
	.tab-label {
		font-size: var(--text-2xs);
		font-weight: 600;
		letter-spacing: 0.01em;
	}
	.tab[aria-current='page'] {
		color: var(--ink);
	}
	.tab[aria-current='page'] .tab-icon {
		background: var(--sea-soft);
		color: var(--sea-strong);
	}
	.tab:focus-visible {
		outline-offset: -4px;
		border-radius: var(--radius);
	}
	.tab .count {
		position: absolute;
		top: 6px;
		left: calc(50% + 6px);
		height: 1.125rem;
		min-width: 1.125rem;
		padding: 0 5px;
		font-size: 0.6875rem;
		box-shadow: 0 0 0 2px var(--bg);
	}
	.dot {
		position: absolute;
		top: 9px;
		left: calc(50% + 9px);
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--brass-fill);
		box-shadow: 0 0 0 2px var(--bg);
	}

	main {
		min-width: 0;
		max-width: calc(var(--content) + 2 * var(--s-4));
		margin: 0 auto;
		padding: var(--s-6) var(--s-4) calc(var(--dock) + var(--s-12));
	}
	main.wide {
		max-width: calc(var(--content-wide) + 2 * var(--s-4));
	}
	main:focus {
		outline: none;
	}

	/* Desktop: the rail becomes a sidebar and the tabs a list. */
	@media (min-width: 60rem) {
		.shell {
			display: grid;
			grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
			min-height: 100dvh;
		}
		.rail {
			position: sticky;
			top: 0;
			height: 100dvh;
			display: flex;
			flex-direction: column;
			align-items: stretch;
			gap: var(--s-6);
			padding: var(--s-5) var(--s-4) var(--s-4);
			background: color-mix(in srgb, var(--surface) 55%, transparent);
			box-shadow: 1px 0 0 var(--line);
		}
		.brand {
			padding: 0 var(--s-2);
			min-height: 44px;
		}
		nav {
			position: static;
			padding: 0;
			background: none;
			backdrop-filter: none;
			-webkit-backdrop-filter: none;
			box-shadow: none;
		}
		nav ul {
			display: grid;
			grid-template-columns: none;
			gap: 2px;
			height: auto;
			max-width: none;
		}
		.tab {
			display: flex;
			align-items: center;
			justify-items: start;
			gap: var(--s-3);
			height: 2.75rem;
			padding: 0 var(--s-2);
			border-radius: var(--radius);
			color: var(--ink-2);
		}
		.tab:hover {
			background: var(--sea-wash);
			color: var(--ink);
		}
		.tab-icon {
			width: auto;
			height: auto;
			background: none !important;
		}
		.tab-label {
			font-size: var(--text-sm);
			font-weight: 550;
			letter-spacing: 0;
		}
		.tab[aria-current='page'] {
			background: var(--surface-raised);
			box-shadow: var(--elev-1);
			color: var(--ink);
		}
		.tab[aria-current='page'] .tab-label {
			font-weight: 650;
		}
		.tab .count,
		.dot {
			position: static;
			margin-left: auto;
			box-shadow: none;
		}
		.tab .count {
			height: 1.375rem;
			min-width: 1.375rem;
			padding: 0 6px;
			font-size: var(--text-xs);
		}
		.dot {
			width: 8px;
			height: 8px;
			margin-right: 7px;
		}
		.mode {
			margin-top: auto;
			display: grid;
			grid-template-columns: auto 1fr;
			align-items: start;
			padding: var(--s-3);
			border-radius: var(--radius);
		}
		.mode-dot {
			margin-top: 5px;
		}
		.tools {
			margin-top: 0;
		}
		.rail:not(:has(.mode)) .tools {
			margin-top: auto;
		}
		main {
			width: 100%;
			padding: var(--s-10) var(--s-8) var(--s-16);
		}
		main.wide {
			max-width: calc(var(--content-wide) + 2 * var(--s-8));
		}
	}
</style>
