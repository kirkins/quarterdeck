<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidate } from '$app/navigation';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import RefreshButton from '#lib/components/RefreshButton.svelte';
	import { resolve } from '$app/paths';
	import { formatUpdated } from '#lib/fleet.ts';
	import { GROUPING_LABELS, PERIODS, type Period } from '#lib/spend.ts';
	import { isoTime } from '#lib/time.ts';
	import { GROUPINGS } from '#lib/usage.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const POLL_MS = 60_000;
	const DEPENDS = 'quarterdeck:spend';
	const PERIOD_KEYS = Object.keys(PERIODS) as Period[];

	// Relative times tick on the client; the first render uses the server's clock.
	let clock = $state(0);
	const now = $derived(Math.max(data.now, clock));
	let loadedAt = $state(0);
	let refreshing = $state(false);

	// Each fresh load restarts the "updated" clock.
	$effect(() => {
		void data;
		loadedAt = Date.now();
	});

	async function refresh() {
		if (refreshing) return;
		refreshing = true;
		try {
			await invalidate(DEPENDS);
		} finally {
			refreshing = false;
		}
	}

	onMount(() => {
		clock = Date.now();
		const tick = setInterval(() => (clock = Date.now()), 5_000);
		// Refresh every minute while the tab is visible; coming back to it refreshes at once.
		const poll = setInterval(() => {
			if (document.visibilityState === 'visible') refresh();
		}, POLL_MS);
		const onFocus = () => refresh();
		const onVisible = () => {
			if (document.visibilityState === 'visible') refresh();
		};
		window.addEventListener('focus', onFocus);
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			clearInterval(tick);
			clearInterval(poll);
			window.removeEventListener('focus', onFocus);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});

	const usage = $derived(data.usage);
	const routes = $derived(data.routes);
	const view = $derived(usage.status === 'ok' ? usage.view : null);
	const bars = $derived(data.grouping === 'day');
	const costChip: Record<string, string> = {
		free: 'Free',
		plan: 'Plan',
		credits: 'Credits',
		unknown: 'Cost not reported'
	};
</script>

<svelte:head>
	<title>Spend · Quarterdeck</title>
</svelte:head>

<PageHeader title="Spend">
	{#snippet summary()}
		<p class="summary" aria-live="polite">
			<span>Routes and usage across the fleet</span>
			{#if loadedAt > 0}<span class="updated">Updated {formatUpdated(loadedAt, now)}</span>{/if}
		</p>
	{/snippet}
	{#snippet actions()}
		<RefreshButton label="Refresh spend" {refreshing} onclick={refresh} />
	{/snippet}
</PageHeader>

<section class="block" aria-labelledby="routes-title">
	<div class="block-head">
		<h2 id="routes-title" class="display">Routes now</h2>
		<p class="hint">In the order crew try them. Throttled routes come first.</p>
	</div>

	{#if routes.status === 'unsupported'}
		<EmptyState tone="quiet" level={3} title="This Privateer does not report routes yet">
			<p><code>fleet.snapshot</code> is not offered here, so route state cannot be shown.</p>
		</EmptyState>
	{:else if routes.status === 'error'}
		<EmptyState tone="error" level={3} title="Could not read the routes">
			<p class="detail">{routes.message}</p>
		</EmptyState>
	{:else if routes.rows.length === 0}
		<p class="none">No routes reported.</p>
	{:else}
		{#if routes.notesUnavailable}
			<p class="callout notice">
				<Icon name="alert" size={16} /> Route notes and try order are not offered by this Privateer.
			</p>
		{/if}
		<ol class="routes">
			{#each routes.rows as row (row.name)}
				<li class="route" data-route={row.name} data-throttled={row.throttled}>
					<div class="route-head">
						{#if row.tryOrder !== null}
							<span class="order" title="Try order">{row.tryOrder + 1}</span>
						{/if}
						<span class="route-name">{row.name}</span>
						<span class="cost cost-{row.cost} tag">{costChip[row.cost]}</span>
					</div>
					{#if row.note}<p class="note">{row.note}</p>{/if}
					<ul class="states">
						{#each row.states as s (s.machine)}
							<li class="state-line" data-kind={s.kind} data-machine={s.machine}>
								<span class="machine">{s.machine}</span>
								<span class="kind">
									<span class="dot" aria-hidden="true"></span>
									{#if s.clearsAt !== null}
										<time datetime={isoTime(s.clearsAt)} title={isoTime(s.clearsAt)}>{s.label}</time
										>
									{:else}
										{s.label}
									{/if}
								</span>
								{#if s.lastError}
									<details class="error-detail">
										<summary>Last error</summary>
										<p>{s.lastError}</p>
									</details>
								{/if}
							</li>
						{/each}
					</ul>
					{#if row.budget}<p class="budget">{row.budget}</p>{/if}
				</li>
			{/each}
		</ol>
	{/if}
</section>

<section class="block" aria-labelledby="usage-title">
	<div class="block-head">
		<h2 id="usage-title" class="display">Usage</h2>
	</div>

	<div class="switches">
		<nav class="switch" aria-label="Period">
			<span class="switch-label">Period</span>
			<ul class="segmented">
				{#each PERIOD_KEYS as key (key)}
					<li>
						<a
							href="{resolve('/spend')}?period={key}&group={data.grouping}"
							aria-current={data.period === key ? 'true' : undefined}
							data-sveltekit-noscroll
						>
							{PERIODS[key].label}
						</a>
					</li>
				{/each}
			</ul>
		</nav>
		<nav class="switch" aria-label="Group by">
			<span class="switch-label">Group by</span>
			<ul class="segmented">
				{#each GROUPINGS as key (key)}
					<li>
						<a
							href="{resolve('/spend')}?period={data.period}&group={key}"
							aria-current={data.grouping === key ? 'true' : undefined}
							data-sveltekit-noscroll
						>
							{GROUPING_LABELS[key]}
						</a>
					</li>
				{/each}
			</ul>
		</nav>
	</div>

	{#if usage.status === 'unsupported'}
		<EmptyState
			tone="quiet"
			level={3}
			title="This Privateer does not report usage yet"
			icon="chart"
		>
			<p><code>usage.summary</code> is not offered here, so token totals cannot be shown.</p>
		</EmptyState>
	{:else if usage.status === 'error'}
		<EmptyState tone="error" level={3} title="Could not read usage">
			<p class="detail">{usage.message}</p>
		</EmptyState>
	{:else if view}
		<p class="period" aria-live="polite">
			Tokens for {PERIODS[data.period].long}, {view.jobs} jobs
		</p>

		<dl class="totals">
			<div class="total-main">
				<dt>Total tokens</dt>
				<dd>{view.labels.total}</dd>
			</div>
			<div>
				<dt>Input</dt>
				<dd>{view.labels.input}</dd>
			</div>
			<div>
				<dt>Output</dt>
				<dd>{view.labels.output}</dd>
			</div>
		</dl>
		<p class="cache">
			Cache tokens are reported apart from input and output: read {view.labels.cacheRead}, written
			{view.labels.cacheWrite}.
		</p>

		{#if view.gaps.length > 0}
			<p class="gap callout callout-warn" role="note">
				<Icon name="alert" size={16} />
				<span>
					{view.gaps.join(', ')}
					{view.gaps.length === 1 ? 'reports' : 'report'} no usage, so
					{view.gaps.length === 1 ? 'its' : 'their'} tokens are missing from these numbers.
				</span>
			</p>
		{/if}

		{#if view.rows.length === 0}
			<EmptyState
				tone="quiet"
				level={3}
				title="No usage in {PERIODS[data.period].long}"
				icon="chart"
			></EmptyState>
		{:else if bars}
			<div class="days-scroll" role="region" aria-label="Tokens by day">
				<ol class="days">
					{#each view.rows as row (row.key)}
						<li class="day" class:empty={row.total === null}>
							<span class="day-value">{row.totalLabel}</span>
							<span class="day-bar" aria-hidden="true"
								><span style="height: {row.share}%"></span></span
							>
							<span class="day-label">{row.label}</span>
							{#if row.gaps.length > 0}
								<span
									class="day-gap"
									role="img"
									aria-label="{row.gaps.join(', ')} reports no usage on this day">!</span
								>
							{/if}
						</li>
					{/each}
				</ol>
			</div>
		{:else}
			<ol class="ranked">
				{#each view.rows as row (row.key)}
					<li class="rank" data-key={row.key}>
						<div class="rank-head">
							<span class="rank-name">{row.label}</span>
							<span class="rank-value">{row.totalLabel}</span>
						</div>
						<span class="bar" aria-hidden="true"><span style="width: {row.share}%"></span></span>
						<p class="rank-meta">
							{row.jobs ?? 0} jobs
							{#if row.total !== null}
								· in {row.input}, out {row.output}
							{/if}
							{#if row.gaps.length > 0}
								· <span class="gap-tag">{row.gaps.join(', ')} reports no usage</span>
							{/if}
						</p>
					</li>
				{/each}
			</ol>
		{/if}
	{/if}
</section>

<style>
	.block {
		margin-bottom: var(--s-12);
	}
	.block-head {
		display: grid;
		gap: 2px;
		margin-bottom: var(--s-4);
	}
	.block-head h2 {
		font-size: var(--text-xl);
		line-height: 1.2;
	}
	.hint,
	.period,
	.cache,
	.none,
	.budget,
	.meta {
		font-size: var(--text-sm);
		color: var(--ink-3);
	}
	.notice {
		margin-bottom: var(--s-3);
	}

	/* Routes */
	.routes {
		display: grid;
		gap: var(--s-3);
		align-items: start;
	}
	@media (min-width: 60rem) {
		.routes {
			grid-template-columns: repeat(auto-fill, minmax(19rem, 1fr));
		}
	}
	.route {
		display: grid;
		gap: var(--s-2);
		padding: var(--s-4);
		border-radius: var(--radius-lg);
		background: var(--surface);
		box-shadow: var(--elev-1);
	}
	.route[data-throttled='true'] {
		box-shadow:
			inset 3px 0 0 var(--warn),
			var(--elev-1);
	}
	.route-head {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		min-width: 0;
	}
	.order {
		display: grid;
		place-items: center;
		flex: none;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 50%;
		background: var(--well);
		color: var(--ink-2);
		font-size: var(--text-xs);
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}
	.route-name {
		flex: 1;
		min-width: 0;
		font-weight: 650;
		color: var(--ink);
		overflow-wrap: anywhere;
	}
	.cost-free {
		background: var(--ok-soft);
		color: var(--ok);
	}
	.cost-plan {
		background: var(--sea-soft);
		color: var(--sea-strong);
	}
	.cost-credits {
		background: var(--brass-soft);
		color: var(--brass);
	}
	.cost-unknown {
		background: var(--well);
		color: var(--ink-3);
	}
	.note {
		font-size: var(--text-sm);
		color: var(--ink-2);
		text-wrap: pretty;
	}
	.meta {
		font-size: var(--text-xs);
		font-family: var(--font-mono);
		overflow-wrap: anywhere;
	}
	.states {
		display: grid;
		margin-top: var(--s-1);
		border-top: 1px solid var(--line);
	}
	.state-line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-1) var(--s-3);
		padding: var(--s-2) 0;
		border-bottom: 1px solid var(--line);
		font-size: var(--text-sm);
	}
	.state-line .machine {
		min-width: 5rem;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--ink-2);
	}
	.state-line .kind {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}
	.state-line .error-detail {
		flex-basis: 100%;
		font-size: var(--text-xs);
	}
	.state-line .error-detail summary {
		color: var(--danger);
		cursor: pointer;
		font-weight: 600;
	}
	.state-line .error-detail p {
		margin-top: var(--s-1);
		padding: var(--s-2) var(--s-3);
		border-radius: var(--radius-sm);
		background: var(--well);
		font-family: var(--font-mono);
		color: var(--ink-2);
		overflow-wrap: anywhere;
	}
	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--ok);
	}
	.state-line[data-kind='backing_off'] .dot {
		background: var(--warn);
	}
	.state-line[data-kind='capped'] .dot {
		background: var(--danger);
	}
	.state-line[data-kind='unknown'] .dot {
		background: var(--ink-3);
	}
	.budget {
		font-size: var(--text-xs);
	}

	/* Usage */
	.switches {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-3) var(--s-6);
		margin-bottom: var(--s-5);
	}
	.switch {
		display: grid;
		gap: var(--s-1);
		min-width: 0;
	}
	.switch-label {
		font-size: var(--text-2xs);
		font-weight: 650;
		letter-spacing: var(--track-caps);
		text-transform: uppercase;
		color: var(--ink-3);
	}
	.switch ul {
		display: flex;
		flex-wrap: wrap;
	}
	.period {
		margin-bottom: var(--s-3);
	}
	.totals {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--s-2);
	}
	.totals div {
		display: grid;
		gap: 2px;
		padding: var(--s-3) var(--s-4);
		border-radius: var(--radius-lg);
		background: var(--surface);
		box-shadow: var(--elev-1);
	}
	.totals .total-main {
		grid-column: 1 / -1;
		padding: var(--s-4) var(--s-5);
		background:
			radial-gradient(120% 140% at 100% 0%, var(--sea-wash), transparent 60%), var(--surface);
	}
	@media (min-width: 40rem) {
		.totals {
			grid-template-columns: 2fr 1fr 1fr;
		}
		.totals .total-main {
			grid-column: auto;
		}
	}
	.totals dt {
		font-size: var(--text-2xs);
		font-weight: 650;
		letter-spacing: var(--track-caps);
		text-transform: uppercase;
		color: var(--ink-3);
	}
	.totals dd {
		font-size: var(--text-xl);
		font-weight: 650;
		letter-spacing: -0.02em;
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}
	.totals .total-main dd {
		font-size: var(--text-2xl);
	}
	.cache {
		margin: var(--s-3) 0 var(--s-5);
		font-size: var(--text-xs);
	}
	.gap {
		margin-bottom: var(--s-4);
	}
	.gap-tag {
		color: var(--warn);
	}

	.ranked {
		display: grid;
		gap: var(--s-4);
		padding: var(--s-5);
		border-radius: var(--radius-lg);
		background: var(--surface);
		box-shadow: var(--elev-1);
	}
	.rank {
		display: grid;
		gap: 6px;
	}
	.rank-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: var(--s-3);
	}
	.rank-name {
		font-weight: 600;
		color: var(--ink);
		overflow-wrap: anywhere;
	}
	.rank-value {
		font-weight: 650;
		font-variant-numeric: tabular-nums;
		color: var(--ink);
	}
	.bar {
		display: block;
		height: 6px;
		border-radius: var(--radius-pill);
		background: var(--well);
		overflow: hidden;
	}
	.bar > span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: linear-gradient(
			90deg,
			color-mix(in srgb, var(--sea) 72%, var(--surface)),
			var(--sea)
		);
	}
	.rank-meta {
		font-size: var(--text-xs);
		color: var(--ink-3);
		font-variant-numeric: tabular-nums;
	}

	.days-scroll {
		overflow-x: auto;
		padding: var(--s-5) var(--s-4) var(--s-4);
		border-radius: var(--radius-lg);
		background: var(--surface);
		box-shadow: var(--elev-1);
	}
	.days {
		display: flex;
		align-items: stretch;
		gap: var(--s-2);
		min-width: min-content;
		height: 13rem;
	}
	.day {
		position: relative;
		flex: 1 0 2.25rem;
		display: grid;
		grid-template-rows: auto 1fr auto;
		justify-items: center;
		gap: var(--s-1);
	}
	.day-value {
		font-size: 0.625rem;
		font-weight: 600;
		color: var(--ink-3);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.day-bar {
		position: relative;
		width: 100%;
		max-width: 1.75rem;
		border-radius: 6px 6px 2px 2px;
		background: var(--well);
		overflow: hidden;
	}
	.day-bar > span {
		position: absolute;
		inset: auto 0 0 0;
		border-radius: 6px 6px 2px 2px;
		background: linear-gradient(
			180deg,
			color-mix(in srgb, var(--sea) 72%, var(--surface)),
			var(--sea)
		);
	}
	.day.empty .day-bar {
		background: repeating-linear-gradient(-45deg, var(--well) 0 4px, transparent 4px 8px);
	}
	.day-label {
		font-size: var(--text-xs);
		color: var(--ink-3);
		white-space: nowrap;
	}
	.day-gap {
		position: absolute;
		top: 1rem;
		display: grid;
		place-items: center;
		width: 1rem;
		height: 1rem;
		border-radius: 50%;
		background: var(--warn-soft);
		color: var(--warn);
		font-size: var(--text-2xs);
		font-weight: 700;
	}
</style>
