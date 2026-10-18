<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import Icon from '#lib/components/Icon.svelte';
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
	const summary = $derived(view?.summary);
</script>

<svelte:head>
	<title>Fleet · Quarterdeck</title>
</svelte:head>

<div class="head">
	<div>
		<h1>Fleet</h1>
		{#if summary}
			<p class="summary" aria-live="polite">
				<span
					><strong>{summary.machinesReachable}</strong> of {summary.machinesTotal} machines reachable</span
				>
				<span><strong>{summary.shipsAwake}</strong> ships awake</span>
				<span><strong>{summary.crew}</strong> crew running</span>
				{#if summary.needs > 0}
					<span class="needs"
						><a href={resolve('/triage')}
							><strong>{summary.needs}</strong>
							{summary.needs === 1 ? 'item needs' : 'items need'} you</a
						></span
					>
				{:else}
					<span>Nothing needs you</span>
				{/if}
				{#if loadedAt > 0}<span class="updated">Updated {formatUpdated(loadedAt, now)}</span>{/if}
			</p>
		{/if}
	</div>
	<button
		type="button"
		class="btn btn-quiet refresh"
		onclick={refresh}
		disabled={refreshing}
		aria-label="Refresh fleet"
	>
		<span class:spin={refreshing}><Icon name="refresh" /></span>
		<span class="refresh-text">{refreshing ? 'Refreshing…' : 'Refresh'}</span>
	</button>
</div>

{#if data.error}
	<div class="state error" role="alert">
		<Icon name="alert" size={28} />
		<h2>Could not read the fleet</h2>
		<p class="detail">{data.error}</p>
		<p>Check that Privateer is reachable from this machine, then try again.</p>
		<button type="button" class="btn btn-primary" onclick={refresh} disabled={refreshing}>
			{refreshing ? 'Trying…' : 'Try again'}
		</button>
	</div>
{:else if data.unsupported}
	<div class="state quiet">
		<Icon name="compass" size={28} />
		<h2>This Privateer does not offer a fleet map yet</h2>
		<p>
			The map reads <code>fleet.snapshot</code>, which this Privateer does not have. Decisions and
			Triage work as before.
		</p>
	</div>
{:else if view}
	{#if view.machines.length === 0}
		<div class="state quiet">
			<Icon name="ship" size={28} />
			<h2>No machines reported</h2>
			<p>Privateer did not list any machines in the fleet.</p>
		</div>
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
								{#if m.reachable}
									updated {formatUpdated(m.changed_ms ?? now, now)}
								{:else}
									unreachable · last seen {formatUpdated(m.changed_ms ?? now, now)}
								{/if}
							</span>
							{#if m.reachable && mv.ships.length > 0}
								<span
									class="meter"
									role="img"
									aria-label="{mv.awake} of {mv.ships.length} ships awake"
									title="{mv.awake} of {mv.ships.length} ships awake"
								>
									<span style="width: {(mv.awake / mv.ships.length) * 100}%"></span>
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
															class="needs-link"
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
																			><Icon name="clock" size={14} /> running {formatSpan(
																				now - job.started_ms
																			)}</span
																		>
																	{/if}
																	{#if job.heavy}<span class="tag heavy">heavy</span>{/if}
																	{#if job.waits}<span class="tag waits">{job.waits}</span>{/if}
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
										Routes: {m.routes.map((r) => `${r.name} ${routeLabel(r, now)}`).join(', ')}
									</p>
								{/if}
							{:else}
								<p class="none">Not reachable from here. Showing ship names only.</p>
								<ul class="ship-names">
									{#each mv.ships as sv (sv.ship.name)}
										<li>{sv.ship.name}</li>
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
	.summary {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-1) var(--s-3);
		margin-top: var(--s-2);
		color: var(--ink-2);
		font-size: var(--text-sm);
	}
	.summary span + span::before {
		content: '·';
		margin-right: var(--s-3);
		color: var(--ink-3);
	}
	.summary strong {
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}
	.summary .needs a {
		color: var(--sea-strong);
		font-weight: 600;
	}
	.summary .updated {
		color: var(--ink-3);
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
	@media (max-width: 30rem) {
		.refresh-text {
			display: none;
		}
	}

	.machines {
		display: grid;
		gap: var(--s-4);
	}
	.machine {
		min-width: 0;
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		background: var(--surface);
		overflow: hidden;
	}
	.machine.unreachable {
		background: var(--surface-2);
		color: var(--ink-3);
	}
	.machine h2 {
		font-size: inherit;
		font-weight: inherit;
	}
	.machine-head {
		display: grid;
		grid-template-columns: minmax(0, auto) minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--s-2) var(--s-3);
		width: 100%;
		min-height: var(--tap);
		padding: var(--s-3) var(--s-4);
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.machine-head:focus-visible {
		outline: 2px solid var(--sea);
		outline-offset: -2px;
	}
	.machine-name {
		font-family: var(--font-display);
		font-size: var(--text-lg);
		font-weight: 600;
		color: var(--ink);
		overflow-wrap: anywhere;
	}
	.unreachable .machine-name {
		color: var(--ink-2);
	}
	.machine-state {
		min-width: 0;
		font-size: var(--text-xs);
		color: var(--ink-3);
		overflow-wrap: anywhere;
	}
	.meter {
		grid-column: 1 / -1;
		display: block;
		height: 4px;
		border-radius: 999px;
		background: var(--surface-2);
		overflow: hidden;
	}
	.meter span {
		display: block;
		height: 100%;
		background: var(--sea);
	}
	.chev {
		grid-column: 3;
		grid-row: 1;
		display: inline-flex;
		justify-self: end;
		color: var(--ink-3);
		transition: transform 0.15s ease;
	}
	.chev.open {
		transform: rotate(180deg);
	}
	.machine-body {
		padding: 0 var(--s-4) var(--s-4);
		display: grid;
		gap: var(--s-3);
	}
	.none {
		font-size: var(--text-sm);
		color: var(--ink-3);
	}
	.ship-names {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-2);
		padding: 0;
		margin: 0;
		list-style: none;
		font-size: var(--text-sm);
	}
	.ship-names li {
		padding: 2px 10px;
		border: 1px solid var(--line);
		border-radius: 999px;
		overflow-wrap: anywhere;
	}

	.ships {
		display: grid;
		gap: var(--s-2);
		padding: 0;
		margin: 0;
		list-style: none;
	}
	.ship {
		min-width: 0;
		padding: var(--s-3);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--bg);
	}
	.ship.needs {
		border-color: color-mix(in srgb, var(--brass) 55%, transparent);
	}
	.ship-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-1) var(--s-2);
	}
	.ship-name {
		font-weight: 650;
		color: var(--ink);
		overflow-wrap: anywhere;
	}
	.presence {
		padding: 1px 8px;
		border-radius: 999px;
		background: var(--sea-soft);
		color: var(--sea-strong);
		font-size: var(--text-xs);
	}
	.presence.asleep {
		background: var(--surface-2);
		color: var(--ink-3);
	}
	.tasks {
		font-size: var(--text-xs);
		color: var(--ink-3);
		font-variant-numeric: tabular-nums;
	}
	.needs-link {
		margin-left: auto;
		padding: 2px 10px;
		border-radius: 999px;
		background: var(--brass-soft);
		color: var(--ink);
		font-size: var(--text-xs);
		font-weight: 600;
		text-decoration: none;
	}
	.needs-link:focus-visible {
		outline: 2px solid var(--sea);
		outline-offset: 2px;
	}
	.scope {
		margin-top: var(--s-1);
		font-size: var(--text-sm);
		color: var(--ink-2);
		overflow-wrap: anywhere;
	}

	.crew {
		display: grid;
		gap: var(--s-2);
		margin: var(--s-3) 0 0;
		padding: 0 0 0 var(--s-3);
		list-style: none;
		border-left: 2px solid var(--sea);
	}
	.job p {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.job-title {
		font-size: var(--text-sm);
		font-weight: 650;
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
		gap: var(--s-1) var(--s-3);
		font-size: var(--text-xs);
		color: var(--ink-3);
		font-variant-numeric: tabular-nums;
	}
	.job-meta span {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.tag {
		padding: 1px 8px;
		border-radius: 999px;
		background: var(--surface-2);
		color: var(--ink-2);
	}
	.tag.heavy {
		background: var(--brass-soft);
		color: var(--ink);
	}
	.tag.waits {
		background: var(--warn-soft);
		color: var(--warn);
	}
	.job.waits .job-title {
		color: var(--warn);
	}

	.routes {
		margin: 0;
		font-size: var(--text-xs);
		color: var(--ink-3);
		overflow-wrap: anywhere;
	}

	.state {
		display: grid;
		justify-items: center;
		gap: var(--s-3);
		padding: var(--s-12) var(--s-6);
		text-align: center;
		border: 1px dashed var(--line-strong);
		border-radius: var(--radius-lg);
		color: var(--ink-2);
	}
	.state h2 {
		font-family: var(--font-display);
		font-size: var(--text-xl);
		font-weight: 600;
		color: var(--ink);
	}
	.state.error {
		border-style: solid;
		border-color: color-mix(in srgb, var(--danger) 35%, transparent);
		background: var(--danger-soft);
	}
	.state.error > :global(.icon) {
		color: var(--danger);
	}
	.detail {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		color: var(--danger);
		overflow-wrap: anywhere;
	}
	code {
		font-family: var(--font-mono);
		font-size: 0.92em;
	}
</style>
