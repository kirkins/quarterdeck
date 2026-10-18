<script lang="ts">
	import { askKey, buildCards, reportTitle, toQuestion } from '#lib/decision.ts';
	import { dismissLabel } from '#lib/dismiss.ts';
	import type { Failure } from '#lib/form.ts';
	import { formatAge, formatDeadline, isoTime, urgencyOf } from '#lib/time.ts';
	import { KIND_LABELS, type TriageKind, type TriageRow } from '#lib/triage.ts';
	import { enhance } from '$app/forms';
	import CopyStep from './CopyStep.svelte';
	import DecisionCard from './DecisionCard.svelte';
	import Dismiss from './Dismiss.svelte';
	import { resolve } from '$app/paths';
	import Icon, { type IconName } from './Icon.svelte';

	let {
		row,
		now,
		open,
		failure = null,
		dismissFailure = null,
		ontoggle
	}: {
		row: TriageRow;
		now: number;
		open: boolean;
		failure?: Failure | null;
		dismissFailure?: Failure | null;
		ontoggle: () => void;
	} = $props();

	const ICON: Record<TriageKind, IconName> = {
		decision: 'compass',
		request: 'hand',
		approval: 'lock',
		notice: 'bell',
		blocker: 'alert'
	};

	const item = $derived(row.item);
	const question = $derived(toQuestion(item, now));
	const urgency = $derived(urgencyOf(row.deadline_ms, now));
	const card = $derived(row.kind === 'decision' ? buildCards([item], now)[0] : null);
	/** A failure belongs to this row only when it names this ask. */
	const forThisAsk = (f: Failure | null) =>
		f && f.from === item.from && f.id === item.id ? f : null;
	const failed = $derived(forThisAsk(failure));
	const dismissed = $derived(forThisAsk(dismissFailure));
	const dismissText = $derived(dismissLabel(row.kind, row.needsHands));
	const step = $derived(typeof item.hands_on === 'string' ? item.hands_on.trim() : '');
	const panel = $derived(`triage-${encodeURIComponent(item.from)}-${encodeURIComponent(item.id)}`);
	const report = $derived(reportTitle(item.payload));
	const reportHref = $derived(resolve('/report/[key]', { key: askKey(item.from, item.id) }));

	const dl = $derived.by(() => {
		const payload = item.payload ?? {};
		return [
			['Artifact', payload.artifact],
			['Environment', payload.environment]
		].filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '');
	});
</script>

<li class="row kind-{row.kind}" class:open data-row={item.id} data-kind={row.kind}>
	<div class="head">
		<span class="glyph" aria-hidden="true"><Icon name={ICON[row.kind]} size={18} /></span>
		<span class="main">
			<span class="line top">
				{#if item.from}
					<a class="ship-name" href={resolve('/ship/[name]', { name: item.from })}>{item.from}</a>
				{:else}
					<span class="ship-name">Unknown ship</span>
				{/if}
				<span
					class="deadline deadline-{urgency} tag"
					class:tag-danger={urgency === 'overdue'}
					class:tag-warn={urgency === 'soon'}
				>
					{#if urgency === 'overdue'}<Icon
							name="alert"
							size={12}
						/>{:else if urgency !== 'none'}<Icon name="clock" size={12} />{/if}
					{formatDeadline(row.deadline_ms, now)}
				</span>
			</span>
			<button
				type="button"
				class="toggle"
				aria-expanded={open}
				aria-controls={panel}
				onclick={ontoggle}
			>
				<span class="text">
					<span class="summary">{question.question}</span>
					<span class="line facts">
						<span class="kind">{KIND_LABELS[row.kind]}</span>
						<span class="age">
							<time datetime={isoTime(row.asked_ms)} title={isoTime(row.asked_ms)}
								>{formatAge(row.asked_ms, now)}</time
							>
						</span>
						{#if row.urgency === 'high'}
							<span class="flag high tag tag-danger"
								><span class="visually-hidden">Urgency: </span>High</span
							>
						{/if}
						{#if row.needsHands}
							<span class="flag hands tag tag-brass"><Icon name="hand" size={12} /> Your hands</span
							>
						{/if}
						{#if report}
							<span class="flag report tag tag-sea"><Icon name="doc" size={12} /> Report</span>
						{/if}
					</span>
				</span>
				<span class="chev" aria-hidden="true"><Icon name="chevron" size={18} /></span>
			</button>
		</span>
	</div>

	{#if open}
		<div class="panel" id={panel}>
			{#if row.kind === 'decision' && card}
				<DecisionCard {card} {now} failure={failed} dismissFailure={dismissed} />
			{:else if row.kind === 'request'}
				{#if report}
					<a class="btn btn-primary open-report" href={reportHref}>
						<Icon name="doc" size={16} /> Open report: {report}
					</a>
				{/if}

				{#if step}
					<section class="step" aria-label="The step for you">
						<p class="label"><Icon name="hand" size={14} /> The step only you can do</p>
						<pre class="command"><code>{step}</code></pre>
						<div class="step-actions">
							<CopyStep text={step} />
							<form method="POST" action="?/reply" use:enhance>
								<input type="hidden" name="from" value={item.from} />
								<input type="hidden" name="id" value={item.id} />
								<input type="hidden" name="text" value="Done." />
								<button type="submit" class="btn btn-primary">
									<Icon name="check" size={16} /> Done, I did this
								</button>
							</form>
						</div>
					</section>
				{/if}

				{#if question.why}
					<p class="context">{question.why}</p>
				{/if}

				<form method="POST" action="?/reply" class="reply" use:enhance>
					<input type="hidden" name="from" value={item.from} />
					<input type="hidden" name="id" value={item.id} />
					<label>
						<span class="field-label">Reply to {item.from || 'the ship'}</span>
						<textarea
							class="field"
							name="text"
							rows="3"
							maxlength="4096"
							placeholder="Write your reply in your own words">{failed?.text ?? ''}</textarea
						>
					</label>
					{#if failed}<p class="callout callout-danger" role="alert">
							<Icon name="alert" size={16} />{failed.error}
						</p>{/if}
					<div class="reply-actions">
						<button type="submit" class="btn btn-primary"
							><Icon name="send" size={16} /> Send reply</button
						>
					</div>
				</form>

				<Dismiss from={item.from} id={item.id} label={dismissText} failure={dismissed} />
			{:else if row.kind === 'approval'}
				<p class="callout">
					<Icon name="lock" size={16} />
					<span
						>Production approvals are answered in Privateer, where the exact grant or denial is
						recorded. Quarterdeck only shows what is being asked.</span
					>
				</p>
				{#if dl.length > 0}
					<dl class="facts-list">
						{#each dl as [term, value] (term)}
							<div>
								<dt>{term}</dt>
								<dd>{value}</dd>
							</div>
						{/each}
					</dl>
				{/if}

				<Dismiss from={item.from} id={item.id} label={dismissText} failure={dismissed} />
			{:else if row.kind === 'notice'}
				{#if report}
					<a class="btn btn-primary open-report" href={reportHref}>
						<Icon name="doc" size={16} /> Open report: {report}
					</a>
				{/if}

				{#if question.why}
					<p class="context">{question.why}</p>
				{/if}

				<Dismiss from={item.from} id={item.id} label={dismissText} failure={dismissed} />
			{:else}
				<p class="callout">
					<Icon name="alert" size={16} />
					<span>
						Quarterdeck has no action for this yet. Privateer reports it until its owner clears it.
						{#if typeof item.status === 'string'}Status: {item.status}.{/if}
					</span>
				</p>
			{/if}
		</div>
	{/if}
</li>

<style>
	.row {
		--tone: var(--sea);
		--tone-soft: var(--sea-soft);
		position: relative;
		border-radius: var(--radius-lg);
		background: var(--surface);
		box-shadow: var(--elev-1);
		transition: box-shadow var(--dur-2) var(--ease);
	}
	.row.kind-request {
		--tone: var(--brass);
		--tone-soft: var(--brass-soft);
	}
	.row.kind-approval {
		--tone: var(--ink-2);
		--tone-soft: var(--well);
	}
	.row.kind-blocker {
		--tone: var(--danger);
		--tone-soft: var(--danger-soft);
	}
	.row:hover {
		box-shadow: var(--elev-2);
	}
	.row.open {
		box-shadow: var(--elev-2);
	}

	/* The head is not a button: the ship's name is a link, so only the toggle inside is one. */
	.head {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: var(--s-3);
		align-items: start;
		width: 100%;
		padding: var(--s-4);
		border-radius: var(--radius-lg);
	}
	.toggle {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: var(--s-3);
		align-items: start;
		width: 100%;
		margin: 0;
		padding: 0;
		text-align: start;
		background: none;
		border: 0;
		border-radius: var(--radius);
		color: inherit;
		font: inherit;
		cursor: pointer;
	}
	.text {
		display: grid;
		gap: 5px;
		min-width: 0;
	}
	.ship-name:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.ship-name:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
		border-radius: 4px;
	}
	a.ship-name {
		text-decoration: none;
	}
	.toggle:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 4px;
	}
	.glyph {
		display: grid;
		place-items: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 11px;
		background: var(--tone-soft);
		color: var(--tone);
	}
	.main {
		display: grid;
		gap: 5px;
		min-width: 0;
	}
	.line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-1) var(--s-2);
		min-width: 0;
	}
	.line.top {
		justify-content: space-between;
		flex-wrap: nowrap;
	}
	.ship-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 650;
		font-size: var(--text-sm);
		color: var(--ink);
	}
	.deadline {
		flex: none;
	}
	.deadline-none {
		background: transparent;
		color: var(--ink-3);
		font-weight: 500;
		padding: 0;
	}
	.summary {
		display: -webkit-box;
		line-clamp: 2;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		font-size: var(--text-base);
		line-height: 1.4;
		color: var(--ink);
		overflow-wrap: anywhere;
		text-wrap: pretty;
	}
	.row.open .summary {
		display: block;
		-webkit-line-clamp: unset;
		line-clamp: unset;
	}
	.facts {
		font-size: var(--text-xs);
		color: var(--ink-3);
	}
	.kind {
		font-size: var(--text-2xs);
		font-weight: 650;
		letter-spacing: var(--track-caps);
		text-transform: uppercase;
		color: var(--tone);
	}
	.age {
		font-variant-numeric: tabular-nums;
	}
	.age::before {
		content: '·';
		margin-right: var(--s-2);
	}
	.flag {
		height: 1.25rem;
		min-height: 0;
		font-size: var(--text-2xs);
	}
	.chev {
		align-self: center;
		color: var(--ink-3);
		transition: transform var(--dur-2) var(--ease);
	}
	.row.open .chev {
		transform: rotate(180deg);
	}

	.panel {
		display: grid;
		gap: var(--s-4);
		margin: 0 var(--s-4);
		padding: var(--s-4) 0 var(--s-4);
		border-top: 1px solid var(--line);
		animation: rise var(--dur-3) var(--ease);
	}
	.panel :global(.card) {
		box-shadow: none;
		padding: 0;
		background: none;
		border-radius: 0;
	}
	.label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: var(--text-2xs);
		font-weight: 650;
		letter-spacing: var(--track-caps);
		text-transform: uppercase;
		color: var(--ink-2);
	}
	.context {
		color: var(--ink-2);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
		text-wrap: pretty;
	}
	.open-report {
		justify-self: start;
		max-width: 100%;
		white-space: normal;
		text-align: left;
		line-height: 1.3;
	}
	.step {
		display: grid;
		gap: var(--s-3);
		padding: var(--s-4);
		border-radius: var(--radius);
		background: var(--brass-soft);
	}
	.step .label {
		color: var(--brass);
	}
	.command {
		margin: 0;
		padding: var(--s-3);
		border-radius: var(--radius-sm);
		background: var(--surface-raised);
		box-shadow: inset 0 0 0 1px var(--line);
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.step-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-2);
		align-items: center;
		justify-content: space-between;
	}
	.step-actions form {
		margin: 0;
	}
	.reply {
		display: grid;
		gap: var(--s-3);
	}
	.reply label {
		display: grid;
	}
	.reply-actions {
		display: flex;
		justify-content: flex-end;
	}
	@media (max-width: 36rem) {
		.reply-actions .btn {
			flex: 1;
		}
	}
	.facts-list {
		display: grid;
		gap: var(--s-2);
		margin: 0;
	}
	.facts-list div {
		display: grid;
		gap: 2px;
	}
	.facts-list dt {
		font-size: var(--text-xs);
		color: var(--ink-3);
	}
	.facts-list dd {
		margin: 0;
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}
</style>
