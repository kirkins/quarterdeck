<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidate } from '$app/navigation';
	import Icon from '#lib/components/Icon.svelte';
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

<div class="head">
	<div>
		<h1>Spend</h1>
		<p class="summary" aria-live="polite">
			<span>Routes and usage across the fleet</span>
			{#if loadedAt > 0}<span class="updated">Updated {formatUpdated(loadedAt, now)}</span>{/if}
		</p>
	</div>
	<button
		type="button"
		class="btn btn-quiet refresh"
		onclick={refresh}
		disabled={refreshing}
		aria-label="Refresh spend"
	>
		<span class:spin={refreshing}><Icon name="refresh" /></span>
		<span class="refresh-text">{refreshing ? 'Refreshing…' : 'Refresh'}</span>
	</button>
</div>

<section class="block" aria-labelledby="routes-title">
	<h2 id="routes-title">Routes now</h2>
	<p class="hint">In the order crew try them. Throttled routes come first.</p>

	{#if routes.status === 'unsupported'}
		<div class="state quiet">
			<Icon name="compass" size={28} />
			<h3>This Privateer does not report routes yet</h3>
			<p><code>fleet.snapshot</code> is not offered here, so route state cannot be shown.</p>
		</div>
	{:else if routes.status === 'error'}
		<div class="state error" role="alert">
			<Icon name="alert" size={28} />
			<h3>Could not read the routes</h3>
			<p class="detail">{routes.message}</p>
		</div>
	{:else if routes.rows.length === 0}
		<p class="none">No routes reported.</p>
	{:else}
		{#if routes.notesUnavailable}
			<p class="notice">Route notes and try order are not offered by this Privateer.</p>
		{/if}
		<ol class="routes">
			{#each routes.rows as row (row.name)}
				<li class="route" data-route={row.name} data-throttled={row.throttled}>
					<div class="route-head">
						<span class="route-name">{row.name}</span>
						<span class="cost cost-{row.cost}">{costChip[row.cost]}</span>
						{#if row.tryOrder !== null}
							<span class="order">Try {row.tryOrder + 1}</span>
						{/if}
					</div>
					{#if row.note}<p class="note">{row.note}</p>{/if}
					{#if row.harnesses.length > 0 || row.models.length > 0}
						<p class="meta">
							{#if row.harnesses.length > 0}{row.harnesses.join(', ')}{/if}
							{#if row.models.length > 0}
								· {row.models.join(', ')}{/if}
						</p>
					{/if}
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
	<h2 id="usage-title">Usage</h2>

	<div class="switches">
		<nav class="switch" aria-label="Period">
			<span class="switch-label">Period</span>
			<ul>
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
			<ul>
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
		<div class="state quiet">
			<Icon name="compass" size={28} />
			<h3>This Privateer does not report usage yet</h3>
			<p><code>usage.summary</code> is not offered here, so token totals cannot be shown.</p>
		</div>
	{:else if usage.status === 'error'}
		<div class="state error" role="alert">
			<Icon name="alert" size={28} />
			<h3>Could not read usage</h3>
			<p class="detail">{usage.message}</p>
		</div>
	{:else if view}
		<p class="period" aria-live="polite">
			Tokens for {PERIODS[data.period].long}, {view.jobs} jobs
		</p>

		<dl class="totals">
			<div>
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
			<p class="gap" role="note">
				<Icon name="alert" size={16} />
				{view.gaps.join(', ')}
				{view.gaps.length === 1 ? 'reports' : 'report'} no usage, so
				{view.gaps.length === 1 ? 'its' : 'their'} tokens are missing from these numbers.
			</p>
		{/if}

		{#if view.rows.length === 0}
			<p class="none">No usage in {PERIODS[data.period].long}.</p>
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
	.head {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: var(--s-4);
		margin-bottom: var(--s-5);
	}
	h1 {
		font-family: var(--font-display);
		font-size: var(--text-2xl);
		font-weight: 600;
		letter-spacing: -0.02em;
		line-height: 1.1;
		font-variation-settings: 'opsz' 72;
	}
	h2 {
		font-family: var(--font-display);
		font-size: var(--text-lg);
		font-weight: 600;
		letter-spacing: -0.01em;
	}
	.summary {
		margin-top: var(--s-2);
		color: var(--ink-2);
		font-size: var(--text-sm);
	}
	.summary .updated {
		color: var(--ink-3);
	}
	.summary .updated::before {
		content: '·';
		margin: 0 var(--s-3);
	}
	.refresh {
		flex: none;
	}
	.spin {
		display: inline-flex;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.block {
		margin-bottom: var(--s-8);
	}
	.hint,
	.period,
	.cache,
	.none,
	.notice,
	.budget,
	.meta {
		color: var(--ink-2);
		font-size: var(--text-sm);
	}
	.hint {
		margin: var(--s-1) 0 var(--s-4);
	}
	.none {
		padding: var(--s-4) 0;
	}
	.notice {
		margin-bottom: var(--s-3);
	}

	/* Routes */
	.routes {
		display: grid;
		gap: var(--s-3);
	}
	.route {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: var(--s-4);
	}
	.route[data-throttled='true'] {
		border-color: var(--warn);
	}
	.route-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2) var(--s-3);
	}
	.route-name {
		font-family: var(--font-mono);
		font-size: var(--text-md);
		overflow-wrap: anywhere;
	}
	.cost {
		font-size: var(--text-xs);
		font-weight: 600;
		padding: 2px var(--s-2);
		border-radius: 999px;
		border: 1px solid var(--line-strong);
		color: var(--ink-2);
	}
	.cost-free {
		background: var(--sea-soft);
		border-color: var(--sea-soft);
		color: var(--sea-strong);
	}
	.cost-plan {
		background: var(--brass-soft);
		border-color: var(--brass-line);
		color: var(--ink);
	}
	.cost-credits {
		background: var(--navy);
		border-color: var(--navy);
		color: var(--navy-ink);
	}
	.order {
		margin-left: auto;
		color: var(--ink-3);
		font-size: var(--text-xs);
	}
	.note {
		margin-top: var(--s-2);
		font-size: var(--text-sm);
	}
	.meta {
		margin-top: var(--s-1);
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		overflow-wrap: anywhere;
	}
	.states {
		margin-top: var(--s-3);
		display: grid;
		gap: var(--s-2);
	}
	.state-line {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: baseline;
		gap: var(--s-1) var(--s-3);
		font-size: var(--text-sm);
	}
	.state-line .machine {
		color: var(--ink-2);
		overflow-wrap: anywhere;
	}
	.state-line .kind {
		display: inline-flex;
		align-items: center;
		gap: var(--s-2);
		white-space: nowrap;
	}
	.state-line .error-detail {
		grid-column: 1 / -1;
		font-size: var(--text-xs);
		color: var(--ink-2);
	}
	.state-line .error-detail p {
		margin-top: var(--s-1);
	}
	.dot {
		width: 9px;
		height: 9px;
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
		margin-top: var(--s-3);
		font-style: italic;
	}

	/* Usage */
	.switches {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-3) var(--s-5);
		margin-bottom: var(--s-4);
	}
	.switch {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2);
	}
	.switch-label {
		font-size: var(--text-xs);
		color: var(--ink-3);
	}
	.switch ul {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-1);
	}
	.switch a {
		display: inline-flex;
		align-items: center;
		min-height: var(--tap);
		padding: 0 var(--s-3);
		border: 1px solid var(--line-strong);
		border-radius: 999px;
		color: var(--ink);
		text-decoration: none;
		font-size: var(--text-sm);
	}
	.switch a[aria-current='true'] {
		background: var(--sea-soft);
		border-color: var(--sea);
		color: var(--sea-ink);
		font-weight: 600;
	}
	.totals {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--s-3);
		margin-top: var(--s-2);
	}
	.totals div {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		padding: var(--s-3);
		min-width: 0;
	}
	.totals dt {
		font-size: var(--text-xs);
		color: var(--ink-3);
	}
	.totals dd {
		font-family: var(--font-display);
		font-size: var(--text-lg);
		font-variant-numeric: tabular-nums;
		overflow-wrap: anywhere;
	}
	.cache {
		margin-top: var(--s-2);
	}
	.gap {
		display: flex;
		align-items: flex-start;
		gap: var(--s-2);
		margin: var(--s-3) 0;
		padding: var(--s-3);
		border-radius: var(--radius-sm);
		background: var(--warn-soft);
		font-size: var(--text-sm);
	}
	.gap-tag {
		color: var(--warn);
		font-weight: 600;
	}

	.ranked {
		display: grid;
		gap: var(--s-3);
	}
	.rank {
		display: grid;
		gap: var(--s-1);
	}
	.rank-head {
		display: flex;
		justify-content: space-between;
		gap: var(--s-3);
		min-width: 0;
	}
	.rank-name {
		overflow-wrap: anywhere;
	}
	.rank-value {
		font-variant-numeric: tabular-nums;
		font-weight: 600;
		white-space: nowrap;
	}
	.bar,
	.day-bar {
		display: block;
		background: var(--surface-2);
		border-radius: 999px;
		overflow: hidden;
	}
	.bar {
		height: 8px;
	}
	.bar > span,
	.day-bar > span {
		display: block;
		height: 100%;
		background: var(--sea);
		border-radius: 999px;
	}
	.rank-meta {
		font-size: var(--text-xs);
		color: var(--ink-2);
	}

	/* One row of bars. On a phone it scrolls sideways rather than squeezing 30 days into 343 px. */
	.days-scroll {
		overflow-x: auto;
		padding-bottom: var(--s-2);
	}
	.days {
		display: grid;
		grid-auto-flow: column;
		grid-auto-columns: 44px;
		gap: var(--s-1);
		align-items: end;
		height: 220px;
	}
	.day {
		display: grid;
		grid-template-rows: auto 1fr auto auto;
		justify-items: center;
		min-width: 0;
		height: 100%;
		font-size: var(--text-xs);
	}
	.day-value {
		font-variant-numeric: tabular-nums;
		color: var(--ink-2);
		white-space: nowrap;
	}
	.day-bar {
		width: 100%;
		height: 100%;
		position: relative;
		align-self: stretch;
	}
	.day-bar > span {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		border-radius: 4px 4px 0 0;
	}
	.day.empty .day-bar {
		background: repeating-linear-gradient(
			45deg,
			var(--surface-2),
			var(--surface-2) 4px,
			var(--surface) 4px,
			var(--surface) 8px
		);
	}
	.day-label {
		color: var(--ink-3);
		white-space: nowrap;
	}
	.day-gap {
		color: var(--warn);
		font-weight: 600;
	}

	.state {
		display: grid;
		justify-items: start;
		gap: var(--s-2);
		padding: var(--s-5);
		border-radius: var(--radius);
		background: var(--surface);
		border: 1px solid var(--line);
	}
	.state.error {
		border-color: var(--danger);
	}
	.state h3 {
		font-family: var(--font-display);
		font-size: var(--text-lg);
	}
	.detail {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		overflow-wrap: anywhere;
	}

	@media (min-width: 720px) {
		.routes {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.days {
			height: 260px;
		}
	}
</style>
