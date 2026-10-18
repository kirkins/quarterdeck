<script lang="ts">
	import { askKey, buildCards, reportTitle, toQuestion } from '#lib/decision.ts';
	import { dismissLabel } from '#lib/dismiss.ts';
	import type { Failure } from '#lib/form.ts';
	import { formatAge, formatDeadline, isoTime, urgencyOf } from '#lib/time.ts';
	import { KIND_LABELS, type TriageKind, type TriageRow } from '#lib/triage.ts';
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
	<button type="button" class="head" aria-expanded={open} aria-controls={panel} onclick={ontoggle}>
		<span class="line top">
			<span class="kind">
				<Icon name={ICON[row.kind]} size={15} />
				{KIND_LABELS[row.kind]}
			</span>
			{#if row.urgency === 'high'}
				<span class="flag high"><span class="visually-hidden">Urgency: </span>High</span>
			{/if}
			{#if row.needsHands}
				<span class="flag hands"><Icon name="hand" size={13} /> Your hands</span>
			{/if}
			{#if report}
				<span class="flag report"><Icon name="doc" size={13} /> Report</span>
			{/if}
			<span class="age">
				<time datetime={isoTime(row.asked_ms)} title={isoTime(row.asked_ms)}
					>{formatAge(row.asked_ms, now)}</time
				>
			</span>
			<span class="deadline deadline-{urgency}">
				{#if urgency === 'overdue'}<Icon name="alert" size={13} />{:else}<Icon
						name="clock"
						size={13}
					/>{/if}
				{formatDeadline(row.deadline_ms, now)}
			</span>
		</span>
		<span class="line ship">
			<Icon name="ship" size={14} />
			<span class="ship-name">{item.from || 'Unknown ship'}</span>
		</span>
		<span class="summary">{question.question}</span>
	</button>

	{#if open}
		<div class="panel" id={panel}>
			{#if row.kind === 'decision' && card}
				<DecisionCard {card} {now} failure={failed} dismissFailure={dismissed} />
			{:else if row.kind === 'request'}
				{#if report}
					<a class="btn btn-primary open-report" href={reportHref}>
						<Icon name="doc" size={14} /> Open report: {report}
					</a>
				{/if}

				{#if step}
					<section class="step" aria-label="The step for you">
						<p class="label"><Icon name="hand" size={14} /> The step only you can do</p>
						<pre class="command"><code>{step}</code></pre>
						<div class="step-actions">
							<CopyStep text={step} />
							<form method="POST" action="?/reply">
								<input type="hidden" name="from" value={item.from} />
								<input type="hidden" name="id" value={item.id} />
								<input type="hidden" name="text" value="Done." />
								<button type="submit" class="btn btn-primary">
									<Icon name="check" size={14} /> Done, I did this
								</button>
							</form>
						</div>
					</section>
				{/if}

				{#if question.why}
					<p class="context">{question.why}</p>
				{/if}

				<form method="POST" action="?/reply" class="reply">
					<input type="hidden" name="from" value={item.from} />
					<input type="hidden" name="id" value={item.id} />
					<label>
						<span class="label">Reply to {item.from || 'the ship'}</span>
						<textarea
							name="text"
							rows="3"
							maxlength="4096"
							placeholder="Write your reply in your own words">{failed?.text ?? ''}</textarea
						>
					</label>
					{#if failed}<p class="error" role="alert">{failed.error}</p>{/if}
					<button type="submit" class="btn btn-primary">Send reply</button>
				</form>

				<Dismiss from={item.from} id={item.id} label={dismissText} failure={dismissed} />
			{:else if row.kind === 'approval'}
				<p class="context">
					Production approvals are answered in Privateer, where the exact grant or denial is
					recorded. Quarterdeck only shows what is being asked.
				</p>
				{#if dl.length > 0}
					<dl class="facts">
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
						<Icon name="doc" size={14} /> Open report: {report}
					</a>
				{/if}

				{#if question.why}
					<p class="context">{question.why}</p>
				{/if}

				<Dismiss from={item.from} id={item.id} label={dismissText} failure={dismissed} />
			{:else}
				<p class="context">
					Quarterdeck has no action for this yet. Privateer reports it until its owner clears it.
					{#if typeof item.status === 'string'}Status: {item.status}.{/if}
				</p>
			{/if}
		</div>
	{/if}
</li>

<style>
	.row {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		box-shadow: var(--shadow);
		overflow: hidden;
		position: relative;
	}
	.row::before {
		content: '';
		position: absolute;
		inset: 0 auto 0 0;
		width: 4px;
		background: transparent;
	}
	.row.kind-decision::before {
		background: var(--sea);
	}
	.row.kind-request::before {
		background: var(--brass);
	}
	.row.kind-approval::before {
		background: var(--ink-3);
	}
	.row.kind-notice::before {
		background: var(--sea);
	}
	.row.kind-blocker::before {
		background: var(--danger);
	}
	.row.open {
		box-shadow: none;
	}

	.head {
		display: grid;
		gap: var(--s-1);
		width: 100%;
		padding: var(--s-3) var(--s-4) var(--s-3) calc(var(--s-4) + 4px);
		text-align: start;
		background: none;
		border: 0;
		color: inherit;
		cursor: pointer;
	}
	.head:focus-visible {
		outline: 2px solid var(--sea);
		outline-offset: -2px;
	}
	.line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-1) var(--s-2);
		font-size: var(--text-xs);
		color: var(--ink-3);
	}
	.line.top {
		justify-content: space-between;
	}
	.kind {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-weight: 650;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--ink-2);
	}
	.flag {
		padding: 1px 8px;
		border-radius: 999px;
		font-weight: 650;
		font-size: var(--text-xs);
		border: 1px solid var(--line);
	}
	.flag.high {
		background: var(--danger-soft);
		color: var(--danger);
		border-color: color-mix(in srgb, var(--danger) 35%, transparent);
	}
	.flag.report {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		background: var(--sea-soft);
		color: var(--sea-strong);
		border-color: color-mix(in srgb, var(--sea) 35%, transparent);
	}
	.flag.hands {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		background: var(--brass-soft);
		color: var(--brass);
		border-color: var(--brass-line);
	}
	.age {
		font-variant-numeric: tabular-nums;
	}
	.deadline {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 1px 8px;
		border-radius: 999px;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
		background: var(--surface-2);
		color: var(--ink-2);
		border: 1px solid var(--line);
	}
	.deadline-overdue {
		background: var(--danger-soft);
		color: var(--danger);
		border-color: color-mix(in srgb, var(--danger) 35%, transparent);
	}
	.deadline-soon {
		background: var(--warn-soft);
		color: var(--warn);
		border-color: color-mix(in srgb, var(--warn) 35%, transparent);
	}
	.deadline-none {
		color: var(--ink-3);
		background: transparent;
	}
	.ship {
		color: var(--ink);
		font-weight: 650;
		font-size: var(--text-sm);
	}
	.ship :global(.icon) {
		color: var(--sea);
	}
	.summary {
		font-size: var(--text-base);
		line-height: 1.4;
		color: var(--ink);
		overflow-wrap: anywhere;
	}

	.panel {
		display: grid;
		gap: var(--s-4);
		padding: var(--s-2) var(--s-4) var(--s-4) calc(var(--s-4) + 4px);
		border-top: 1px solid var(--line);
	}
	.panel :global(.card) {
		box-shadow: none;
		border: 0;
		padding: 0;
		background: none;
	}
	.label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: var(--text-xs);
		font-weight: 650;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--ink-2);
	}
	.context {
		color: var(--ink-2);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}
	.step {
		display: grid;
		gap: var(--s-2);
		padding: var(--s-3);
		border-radius: var(--radius);
		background: var(--brass-soft);
		border: 1px solid var(--brass-line);
	}
	.step .label {
		color: var(--brass);
	}
	.command {
		margin: 0;
		padding: var(--s-3);
		border-radius: var(--radius-sm);
		background: var(--surface);
		border: 1px solid var(--line);
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
	}
	.step-actions form {
		margin: 0;
	}
	.reply {
		display: grid;
		gap: var(--s-2);
	}
	.reply label {
		display: grid;
		gap: var(--s-1);
	}
	.reply textarea {
		width: 100%;
		padding: var(--s-2) var(--s-3);
		font: inherit;
		color: var(--ink);
		background: var(--surface-2);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-sm);
		resize: vertical;
	}
	.reply textarea:focus-visible {
		outline: 2px solid var(--sea);
		outline-offset: 1px;
	}
	.reply .btn {
		justify-self: start;
	}
	.error {
		color: var(--danger);
		font-size: var(--text-sm);
	}
	.facts {
		display: grid;
		gap: var(--s-2);
		margin: 0;
	}
	.facts div {
		display: grid;
		gap: 2px;
	}
	.facts dt {
		font-size: var(--text-xs);
		color: var(--ink-3);
	}
	.facts dd {
		margin: 0;
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}
</style>
