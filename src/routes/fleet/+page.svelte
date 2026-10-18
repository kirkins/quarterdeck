<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import RefreshButton from '#lib/components/RefreshButton.svelte';
	import { formatUpdated, routeLabel } from '#lib/fleet.ts';
	import { formatSpan } from '#lib/time.ts';
	import { SvelteSet } from 'svelte/reactivity';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const POLL_MS = 15_000;
	const DEPENDS = 'quarterdeck:fleet';

	// Relative times tick on the client; the first render uses the server's clock.
	let clock = $state(0);
	const now = $derived(Math.max(data.now, clock));
	let loadedAt = $state(0);
	let refreshing = $state(false);
	/** Machines the captain has folded away. Kept across refreshes, which only re-run the load. */
	const collapsed = new SvelteSet<string>();

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
		// Poll only while the tab is visible; coming back to it refreshes at once.
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

	function toggle(name: string) {
		if (collapsed.has(name)) collapsed.delete(name);
		else collapsed.add(name);
	}

	const view = $derived(data.view);
	const stats = $derived(view?.summary);
</script>

<svelte:head>
	<title>Fleet · Quarterdeck</title>
</svelte:head>

<PageHeader title="Fleet">
	{#snippet summary()}
		{#if stats}
			<p class="summary" aria-live="polite">
				{#if stats.needs > 0}
					<span class="need"
						><a href={resolve('/triage')}
							><strong>{stats.needs}</strong>
							{stats.needs === 1 ? 'item needs' : 'items need'} you</a
						></span
					>
				{:else}
					<span>Nothing needs you</span>
				{/if}
				<span
					><strong>{stats.machinesReachable}</strong> of {stats.machinesTotal} machines reachable</span
				>
				<span><strong>{stats.shipsAwake}</strong> ships awake</span>
				<span><strong>{stats.crew}</strong> crew running</span>
				{#if loadedAt > 0}<span class="updated">Updated {formatUpdated(loadedAt, now)}</span>{/if}
			</p>
		{/if}
	{/snippet}
	{#snippet actions()}
		<RefreshButton label="Refresh fleet" {refreshing} onclick={refresh} />
	{/snippet}
</PageHeader>

{#if data.error}
	<EmptyState tone="error" title="Could not read the fleet">
		<p class="detail">{data.error}</p>
		<p>Check that Privateer is reachable from this machine, then try again.</p>
		{#snippet action()}
			<button type="button" class="btn btn-primary" onclick={refresh} disabled={refreshing}>
				{refreshing ? 'Trying…' : 'Try again'}
			</button>
		{/snippet}
	</EmptyState>
{:else if data.unsupported}
	<EmptyState tone="quiet" title="This Privateer does not offer a fleet map yet" icon="anchor">
		<p>
			The map reads <code>fleet.snapshot</code>, which this Privateer does not have. Decisions and
			Triage work as before.
		</p>
	</EmptyState>
{:else if view}
	{#if view.machines.length === 0}
		<EmptyState tone="quiet" title="No machines reported" icon="server">
			<p>Privateer did not list any machines in the fleet.</p>
		</EmptyState>
	{:else}
		<div class="machines">
			{#each view.machines as mv, i (mv.machine.name)}
				{@const m = mv.machine}
				{@const open = !collapsed.has(m.name)}
				<section class="machine" class:unreachable={!m.reachable} aria-labelledby="machine-{i}">
					<h2>
						<button
							type="button"
							class="machine-head"
							aria-expanded={open}
							aria-controls="machine-body-{i}"
							onclick={() => toggle(m.name)}
						>
							<span class="machine-name" id="machine-{i}">{m.name}</span>
							<span class="machine-state">
								<span class="signal" class:off={!m.reachable} aria-hidden="true"></span>
								{#if m.reachable}
									updated {formatUpdated(m.changed_ms ?? now, now)}
								{:else}
									unreachable · last seen {formatUpdated(m.changed_ms ?? now, now)}
								{/if}
							</span>
							{#if m.reachable && mv.ships.length > 0}
								<span class="awake">
									<span
										class="meter"
										role="img"
										aria-label="{mv.awake} of {mv.ships.length} ships awake"
										title="{mv.awake} of {mv.ships.length} ships awake"
									>
										<span style="width: {(mv.awake / mv.ships.length) * 100}%"></span>
									</span>
									<span class="awake-text" aria-hidden="true"
										>{mv.awake}/{mv.ships.length} awake</span
									>
								</span>
							{/if}
							<span class="chev" class:open aria-hidden="true"
								><Icon name="chevron" size={18} /></span
							>
						</button>
					</h2>

					{#if open}
						<div class="machine-body" id="machine-body-{i}">
							{#if m.reachable}
								{#if mv.ships.length === 0}
									<p class="none">No ships on this machine.</p>
								{:else}
									<ul class="ships">
										{#each mv.ships as sv (sv.ship.name)}
											{@const s = sv.ship}
											<li class="ship" data-ship={s.name} class:needs={sv.needs > 0}>
												<div class="ship-head">
													<span class="ship-name">{s.name}</span>
													<span
														class="presence"
														class:asleep={!sv.awake}
														data-presence={s.presence ?? 'unknown'}
													>
														{s.presence ?? 'unknown'}
													</span>
													<span class="tasks">{s.open_tasks} open</span>
													{#if sv.needs > 0}
														<a
															class="needs-link tag tag-brass"
															href="{resolve('/triage')}?ship={encodeURIComponent(s.name)}"
														>
															{sv.needs}
															{sv.needs === 1 ? 'item needs' : 'items need'} you
														</a>
													{/if}
												</div>
												{#if s.scope}<p class="scope">{s.scope}</p>{/if}
												{#if s.jobs.length > 0}
													<ul class="crew" aria-label="Crew on {s.name}">
														{#each s.jobs as job (job.id)}
															<li
																class="job"
																class:heavy={job.heavy}
																class:waits={job.waits !== null}
															>
																<p class="job-title">{job.task_title ?? job.task_id ?? job.id}</p>
																{#if job.doing_now}<p class="doing">{job.doing_now}</p>{/if}
																<p class="job-meta">
																	{#if job.started_ms !== null}
																		<span
																			><Icon name="clock" size={13} /> running {formatSpan(
																				now - job.started_ms
																			)}</span
																		>
																	{/if}
																	{#if job.heavy}<span class="tag heavy">heavy</span>{/if}
																	{#if job.waits}<span class="tag tag-warn waits">{job.waits}</span
																		>{/if}
																</p>
															</li>
														{/each}
													</ul>
												{/if}
											</li>
										{/each}
									</ul>
								{/if}
								{#if m.routes.length > 0}
									<p class="routes">
										<span class="routes-label">Routes</span>
										{m.routes.map((r) => `${r.name} ${routeLabel(r, now)}`).join(', ')}
									</p>
								{/if}
							{:else}
								<p class="none">Not reachable from here. Showing ship names only.</p>
								<ul class="ship-names">
									{#each mv.ships as sv (sv.ship.name)}
										<li class="tag tag-outline">{sv.ship.name}</li>
									{/each}
								</ul>
							{/if}
						</div>
					{/if}
				</section>
			{/each}
		</div>
	{/if}
{/if}

<style>
	.machines {
		display: grid;
		gap: var(--s-4);
		align-items: start;
	}
	@media (min-width: 72rem) {
		.machines {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	.machine {
		min-width: 0;
		border-radius: var(--radius-xl);
		background: var(--surface);
		box-shadow: var(--elev-1);
	}
	.machine.unreachable {
		background: transparent;
		box-shadow: none;
		outline: 1.5px dashed var(--line-strong);
		outline-offset: -1.5px;
		color: var(--ink-3);
	}
	.machine h2 {
		font-size: inherit;
		font-weight: inherit;
	}
	.machine-head {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-areas:
			'name chev'
			'state chev'
			'awake awake';
		align-items: center;
		gap: 2px var(--s-3);
		width: 100%;
		min-height: var(--tap);
		padding: var(--s-4) var(--s-5);
		border: 0;
		border-radius: var(--radius-xl);
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.machine-head:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: -2px;
	}
	.machine-name {
		grid-area: name;
		font-family: var(--font-display);
		font-size: var(--text-xl);
		font-weight: 560;
		letter-spacing: -0.015em;
		color: var(--ink);
		overflow-wrap: anywhere;
	}
	.unreachable .machine-name {
		color: var(--ink-2);
	}
	.machine-state {
		grid-area: state;
		display: inline-flex;
		align-items: center;
		gap: var(--s-2);
		min-width: 0;
		font-size: var(--text-xs);
		color: var(--ink-3);
		overflow-wrap: anywhere;
	}
	.signal {
		flex: none;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--ok);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 20%, transparent);
	}
	.signal.off {
		background: var(--ink-3);
		box-shadow: none;
	}
	.awake {
		grid-area: awake;
		display: flex;
		align-items: center;
		gap: var(--s-3);
		margin-top: var(--s-3);
	}
	.meter {
		flex: 1;
		display: block;
		height: 4px;
		border-radius: var(--radius-pill);
		background: var(--well);
		overflow: hidden;
	}
	.meter span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--sea);
	}
	.awake-text {
		font-size: var(--text-xs);
		color: var(--ink-3);
		font-variant-numeric: tabular-nums;
	}
	.chev {
		grid-area: chev;
		display: inline-flex;
		justify-self: end;
		color: var(--ink-3);
		transition: transform var(--dur-2) var(--ease);
	}
	.chev.open {
		transform: rotate(180deg);
	}
	.machine-body {
		padding: 0 var(--s-5) var(--s-5);
		display: grid;
		gap: var(--s-4);
		animation: rise var(--dur-3) var(--ease);
	}
	.none {
		font-size: var(--text-sm);
		color: var(--ink-3);
	}
	.ship-names {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-2);
	}

	/* Ships are rows on the machine, not boxes in a box. */
	.ships {
		display: grid;
	}
	.ship {
		min-width: 0;
		padding: var(--s-4) 0;
		border-top: 1px solid var(--line);
	}
	.ship:first-child {
		border-top: 0;
		padding-top: var(--s-1);
	}
	.ship:last-child {
		padding-bottom: 0;
	}
	.ship-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-1) var(--s-3);
	}
	.ship-name {
		font-weight: 650;
		color: var(--ink);
		overflow-wrap: anywhere;
	}
	.presence {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: var(--text-xs);
		font-weight: 550;
		color: var(--sea-strong);
	}
	.presence::before {
		content: '';
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--sea);
	}
	.presence.asleep {
		color: var(--ink-3);
	}
	.presence.asleep::before {
		background: transparent;
		box-shadow: inset 0 0 0 1.5px var(--ink-3);
	}
	.tasks {
		font-size: var(--text-xs);
		color: var(--ink-3);
		font-variant-numeric: tabular-nums;
	}
	.needs-link {
		margin-left: auto;
		min-height: 1.75rem;
		text-decoration: none;
	}
	.needs-link:hover {
		background: color-mix(in srgb, var(--brass-fill) 30%, var(--brass-soft));
	}
	.scope {
		margin-top: var(--s-1);
		font-size: var(--text-sm);
		color: var(--ink-2);
		overflow-wrap: anywhere;
		text-wrap: pretty;
	}

	/* Crew hang off the ship on a thin line, like a log entry. */
	.crew {
		display: grid;
		gap: var(--s-3);
		margin: var(--s-3) 0 0 3px;
		padding: 0 0 0 var(--s-4);
		border-left: 1px solid color-mix(in srgb, var(--sea) 55%, transparent);
	}
	.job {
		position: relative;
	}
	.job::before {
		content: '';
		position: absolute;
		left: calc(-1 * var(--s-4) - 4px);
		top: 0.45em;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--surface);
		box-shadow: inset 0 0 0 1.5px var(--sea);
	}
	.job.waits::before {
		box-shadow: inset 0 0 0 1.5px var(--warn);
	}
	.job p {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.job-title {
		font-size: var(--text-sm);
		font-weight: 620;
		color: var(--ink);
	}
	.doing {
		font-size: var(--text-sm);
		color: var(--ink-2);
	}
	.job-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-1) var(--s-2);
		margin-top: 3px !important;
		font-size: var(--text-xs);
		color: var(--ink-3);
		font-variant-numeric: tabular-nums;
	}
	.job-meta > span:first-child {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.tag.heavy {
		background: var(--brass-soft);
		color: var(--brass);
	}
	.job.waits .job-title {
		color: var(--warn);
	}

	.routes {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-1) var(--s-2);
		margin: 0;
		padding-top: var(--s-3);
		border-top: 1px dashed var(--line-strong);
		font-size: var(--text-xs);
		color: var(--ink-3);
		overflow-wrap: anywhere;
	}
	.routes-label {
		font-size: var(--text-2xs);
		font-weight: 650;
		letter-spacing: var(--track-caps);
		text-transform: uppercase;
		color: var(--ink-2);
	}
</style>
