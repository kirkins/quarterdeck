<!--
	A ship's tools, read only: model routes, charter, permissions, skills, MCP
	servers, plugins, and sleep and hosting. Secret values never reach the page;
	a credential shows as set or not set. Editing comes later.
-->
<script lang="ts">
	import Collapsible from '#lib/components/Collapsible.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { matchTools } from '#lib/ship.ts';
	import type { ShipView } from '#lib/server/ship.ts';
	import type { ProfileRoutes, ShipProfile } from '#lib/shapes.ts';

	let { view }: { view: ShipView } = $props();

	let query = $state('');
	const profile = $derived(view.profile);
	const matches = $derived(profile ? matchTools(profile, query) : null);
	const searching = $derived(query.trim() !== '');

	const ROUTE_KINDS: Record<string, string> = {
		first_mate: 'First mate',
		crew: 'Crew',
		errand: 'Errands'
	};

	function routeLabel(route: ProfileRoutes): string {
		return ROUTE_KINDS[route.kind] ?? route.kind.replaceAll('_', ' ');
	}

	function listLabel(list: ProfileRoutes['list']): string {
		if (list === 'ship') return "This ship's list";
		if (list === 'fleet') return 'Fleet default';
		return 'List not reported';
	}

	function sleepLabel(sleep: ShipProfile['sleep']): string {
		if (sleep.policy === 'after_idle') {
			return sleep.idle_minutes === null
				? 'Sleeps when idle'
				: `Sleeps after ${sleep.idle_minutes} min idle`;
		}
		if (sleep.policy === 'never') return 'Stays awake';
		if (sleep.policy === 'not_hosted') return 'Not hosted: woken for each turn';
		return sleep.policy ?? 'Not reported';
	}

	/** A plugin's name is a path such as `attended/mail.ts`: the folder is shown quieter than the file. */
	function pluginParts(name: string): { dir: string; base: string } {
		const at = name.lastIndexOf('/');
		return at < 0
			? { dir: '', base: name }
			: { dir: name.slice(0, at + 1), base: name.slice(at + 1) };
	}

	function yesNo(value: boolean | null): string {
		return value === null ? 'Not reported' : value ? 'Yes' : 'No';
	}

	/** Groups that exist on the page; the search reaches the three tool lists. */
	const GROUPS = [
		{ id: 'routes', title: 'Model routes' },
		{ id: 'charter', title: 'Charter' },
		{ id: 'permissions', title: 'Permissions' },
		{ id: 'skills', title: 'Skills' },
		{ id: 'mcp', title: 'MCP servers' },
		{ id: 'plugins', title: 'Plugins' },
		{ id: 'hosting', title: 'Sleep and hosting' }
	];

	function none(p: ShipProfile): boolean {
		return p.skills.length + p.mcpServers.length + p.plugins.length === 0;
	}

	/** Privateer lists skills and servers only for a bounded plan; otherwise the harness loads its own. */
	const bounded = $derived(profile?.toolBundles.bounded !== false);
</script>

{#if view.profileState === 'unsupported'}
	<EmptyState tone="quiet" title="Tools are not on this Privateer yet" icon="ship">
		<p>
			This Privateer does not offer <code>ship.profile</code>. The conversation still works; the
			tools appear once Privateer has them.
		</p>
	</EmptyState>
{:else if view.profileState === 'not_found'}
	<EmptyState tone="quiet" title="Privateer has no profile for {view.name}" icon="ship">
		<p>The fleet knows this ship, but it has not reported its tools.</p>
	</EmptyState>
{:else if view.profileState === 'elsewhere'}
	<EmptyState
		tone="quiet"
		title="This ship runs on {view.profileMachine ?? 'another machine'}"
		icon="ship"
	>
		<p>Its tools are read on that machine. The conversation on this page still works here.</p>
	</EmptyState>
{:else if view.profileState === 'error' || !profile}
	<p class="callout callout-danger" role="alert">
		<Icon name="alert" size={16} />{view.profileError ?? 'The ship’s tools could not be read.'}
	</p>
	<p class="hint">Check that Privateer is reachable from this machine, then reload.</p>
{:else}
	{#if profile.toolBundles.error}
		<p class="callout callout-danger">
			<Icon name="alert" size={16} />The first mate’s tool plan could not be built: {profile
				.toolBundles.error}
		</p>
	{/if}

	<div class="search">
		<label class="visually-hidden" for="tools-find">Find a skill, server or plugin</label>
		<input
			id="tools-find"
			type="search"
			class="field"
			placeholder="Find a skill, server or plugin"
			bind:value={query}
		/>
	</div>
	{#if searching && matches && matches.skills.length + matches.mcpServers.length + matches.plugins.length === 0}
		<p class="hint">Nothing matches “{query.trim()}”.</p>
	{/if}

	<nav class="jump" aria-label="Sections of the ship's tools">
		{#each GROUPS as group (group.id)}
			<a href="#tools-{group.id}">{group.title}</a>
		{/each}
	</nav>

	<div class="groups">
		<section class="group" id="tools-routes" aria-labelledby="h-routes">
			<h2 id="h-routes">Model routes</h2>
			<p class="hint">Which route each kind of job may use, and the list it comes from.</p>
			{#if profile.routes.length === 0}
				<p class="none">No routes reported.</p>
			{:else}
				<dl class="facts">
					{#each profile.routes as route (route.kind)}
						<div>
							<dt>{routeLabel(route)}</dt>
							<dd>
								{#if route.list === 'none'}
									<span class="none">No routes</span>
								{:else}
									<span class="list">{listLabel(route.list)}</span>
									{#if route.names.length > 0}
										<ul class="names" aria-label="{routeLabel(route)} routes">
											{#each route.names as name (name)}<li class="tag tag-outline">
													{name}
												</li>{/each}
										</ul>
									{:else}
										<span class="none">No routes</span>
									{/if}
								{/if}
							</dd>
						</div>
					{/each}
				</dl>
			{/if}

			<h3>First mate</h3>
			<dl class="facts">
				<div>
					<dt>Harness</dt>
					<dd>{profile.firstMate.harness ?? 'Not reported'}</dd>
				</div>
			</dl>
			{#if profile.firstMate.options.length > 0}
				<dl class="facts options">
					{#each profile.firstMate.options as option (option.name)}
						<div>
							<dt>{option.name}</dt>
							<dd>
								{#if option.secret}
									<span class="tag tag-outline">Secret</span>
									<span class="set" data-set={option.set}>{option.set ? 'set' : 'not set'}</span>
								{:else}
									{option.value ?? 'Not set'}
								{/if}
							</dd>
						</div>
					{/each}
				</dl>
			{/if}
		</section>

		<section class="group" id="tools-charter" aria-labelledby="h-charter">
			<h2 id="h-charter">Charter</h2>
			{#if profile.charter.active === false}
				<p class="hint">The charter is inactive.</p>
			{/if}
			{#if profile.charter.actions.length === 0}
				<p class="none">No charter actions reported.</p>
			{:else}
				<ul class="plain">
					{#each profile.charter.actions as action (action)}<li>{action}</li>{/each}
				</ul>
			{/if}
		</section>

		<section class="group" id="tools-permissions" aria-labelledby="h-permissions">
			<h2 id="h-permissions">Permissions</h2>
			<dl class="facts">
				<div>
					<dt>Fleet mode</dt>
					<dd>{profile.permissions.fleetMode ?? 'Not reported'}</dd>
				</div>
			</dl>
			<h3>Fleet rules</h3>
			{#if profile.permissions.fleetRules.length === 0}
				<p class="none">None.</p>
			{:else}
				<ul class="plain">
					{#each profile.permissions.fleetRules as rule (rule)}<li>{rule}</li>{/each}
				</ul>
			{/if}
		</section>

		<section class="group" id="tools-skills" aria-labelledby="h-skills">
			<h2 id="h-skills">
				Skills <span class="count">{matches?.skills.length ?? 0}</span>
			</h2>
			<p class="hint">From the first mate’s bounded plan.</p>
			{#if !bounded}
				<p class="none">Not listed: this first mate loads its own skills.</p>
			{:else if matches && matches.skills.length > 0}
				<Collapsible items={matches.skills} noun="skill" all={searching}>
					{#snippet row(skill)}
						<p class="item-name">{skill.name}</p>
						{#if skill.description}<p class="item-text">{skill.description}</p>{/if}
					{/snippet}
				</Collapsible>
			{:else}
				<p class="none">{searching ? 'No skill matches.' : 'No skills.'}</p>
			{/if}
		</section>

		<section class="group" id="tools-mcp" aria-labelledby="h-mcp">
			<h2 id="h-mcp">
				MCP servers <span class="count">{matches?.mcpServers.length ?? 0}</span>
			</h2>
			<p class="hint">From the first mate’s bounded plan.</p>
			{#if !bounded}
				<p class="none">Not listed: this first mate loads its own servers.</p>
			{:else if matches && matches.mcpServers.length > 0}
				<Collapsible items={matches.mcpServers} noun="server" all={searching}>
					{#snippet row(server)}
						<p class="item-name">{server.name}</p>
						{#if server.description}<p class="item-text">{server.description}</p>{/if}
						{#if server.url}<p class="item-text url">{server.url}</p>{/if}
						{#if server.credentials.length > 0}
							<p class="creds">
								<Icon name="lock" size={14} />
								<span class="visually-hidden">Credentials: </span>
								{#each server.credentials as cred (cred)}<span class="tag tag-outline">{cred}</span
									>{/each}
							</p>
						{/if}
					{/snippet}
				</Collapsible>
			{:else}
				<p class="none">{searching ? 'No server matches.' : 'No MCP servers.'}</p>
			{/if}
		</section>

		<section class="group" id="tools-plugins" aria-labelledby="h-plugins">
			<h2 id="h-plugins">
				Plugins <span class="count">{matches?.plugins.length ?? 0}</span>
			</h2>
			{#if matches && matches.plugins.length > 0}
				<Collapsible items={matches.plugins} noun="plugin" all={searching}>
					{#snippet row(plugin)}
						{@const parts = pluginParts(plugin.name)}
						<p class="item-name">
							{#if parts.dir}<span class="dir">{parts.dir}</span>{/if}{parts.base}
						</p>
						{#if plugin.description}<p class="item-text">{plugin.description}</p>{/if}
					{/snippet}
				</Collapsible>
			{:else}
				<p class="none">{searching ? 'No plugin matches.' : 'No plugins.'}</p>
			{/if}
		</section>

		<section class="group" id="tools-hosting" aria-labelledby="h-hosting">
			<h2 id="h-hosting">Sleep and hosting</h2>
			<dl class="facts">
				<div>
					<dt>Machine</dt>
					<dd>{profile.machine ?? 'Not reported'}</dd>
				</div>
				<div>
					<dt>Hosted</dt>
					<dd>{yesNo(profile.hosted)}</dd>
				</div>
				<div>
					<dt>Sleep</dt>
					<dd>{sleepLabel(profile.sleep)}</dd>
				</div>
			</dl>
		</section>
	</div>

	{#if bounded && none(profile) && !searching}
		<p class="hint">This ship carries no skills, servers or plugins.</p>
	{/if}
{/if}

<style>
	.search {
		position: relative;
		display: flex;
		align-items: center;
		margin-bottom: var(--s-3);
		color: var(--sea);
	}
	.jump {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-2);
		margin-bottom: var(--s-4);
	}
	.jump a {
		flex: none;
		display: inline-flex;
		align-items: center;
		min-height: var(--tap);
		padding: 0 var(--s-3);
		border-radius: var(--radius-pill);
		background: var(--well);
		color: var(--ink-2);
		font-size: var(--text-sm);
		font-weight: 600;
		text-decoration: none;
	}
	.jump a:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}

	.groups {
		display: grid;
		gap: var(--s-4);
	}
	.group {
		padding: var(--s-4);
		border-radius: var(--radius-lg);
		background: var(--surface);
		box-shadow: var(--elev-1);
		scroll-margin-top: var(--s-6);
	}
	@media (min-width: 40rem) {
		.group {
			padding: var(--s-6);
		}
	}
	h2 {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		margin: 0 0 var(--s-3);
		font-size: var(--text-base);
		font-weight: 650;
		color: var(--ink);
	}
	h3 {
		margin: var(--s-4) 0 var(--s-2);
		font-size: var(--text-2xs);
		font-weight: 650;
		letter-spacing: var(--track-caps);
		text-transform: uppercase;
		color: var(--ink-3);
	}
	.count {
		padding: 1px var(--s-2);
		border-radius: var(--radius-pill);
		background: var(--well);
		color: var(--ink-2);
		font-size: var(--text-2xs);
		font-variant-numeric: tabular-nums;
	}
	.hint,
	.none {
		margin: 0 0 var(--s-2);
		font-size: var(--text-sm);
		color: var(--ink-3);
	}
	.plain {
		margin: 0;
		padding-left: 1.1rem;
		font-size: var(--text-sm);
		color: var(--ink-2);
	}
	.plain li {
		padding: 2px 0;
	}
	.facts {
		display: grid;
		gap: var(--s-2);
		margin: 0;
	}
	.facts > div {
		display: grid;
		gap: 2px;
	}
	@media (min-width: 40rem) {
		.facts > div {
			grid-template-columns: 10rem 1fr;
			gap: var(--s-3);
		}
	}
	dt {
		font-size: var(--text-sm);
		color: var(--ink-3);
	}
	dd {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--ink);
		overflow-wrap: anywhere;
	}
	.list {
		color: var(--ink-2);
	}
	.names {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-1);
		margin: var(--s-1) 0 0;
		padding: 0;
		list-style: none;
	}
	.options dd .set {
		margin-left: var(--s-2);
		color: var(--ink-2);
	}
	.item-name {
		margin: 0;
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--ink);
		overflow-wrap: anywhere;
	}
	.item-text {
		margin: 2px 0 0;
		font-size: var(--text-sm);
		color: var(--ink-2);
		overflow-wrap: anywhere;
	}
	.url {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--ink-3);
	}
	.creds {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-1);
		margin: var(--s-2) 0 0;
		font-size: var(--text-xs);
		color: var(--ink-3);
	}
	.item-name .dir {
		color: var(--ink-3);
		font-weight: 400;
	}
	.creds :global(.icon) {
		color: var(--ink-3);
	}
</style>
