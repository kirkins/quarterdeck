<!--
	One message in the Feed, drawn as a chat bubble. An open ask is a short
	message with an Answer button; Answer opens the same form as Decisions inline
	(a needs_hands step with its copy and Done). A notice or report is closed
	with Mark read or Open report. Closed asks keep their words and show what
	happened to them.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { askKey, toQuestion } from '#lib/decision.ts';
	import { dismissLabel } from '#lib/dismiss.ts';
	import type { Failure } from '#lib/form.ts';
	import {
		FEED_KIND_LABELS,
		anchorOf,
		clockOf,
		feedKindOf,
		handsTextOf,
		isOpen,
		reportTitleOf,
		segmentsOf,
		shipMark,
		toMailItem
	} from '#lib/feed.ts';
	import type { FeedEntry } from '#lib/shapes.ts';
	import { isoTime } from '#lib/time.ts';
	import { resolve } from '$app/paths';
	import CopyStep from './CopyStep.svelte';
	import Dismiss from './Dismiss.svelte';
	import Icon from './Icon.svelte';
	import QuestionForm from './QuestionForm.svelte';

	interface Props {
		entry: FeedEntry;
		/** Starts a run from one side: the name and mark show. */
		first: boolean;
		/** Ends a run. */
		last: boolean;
		/** The captain's own reply. */
		mine: boolean;
		shipToShip: boolean;
		/** More than one machine is in the feed, so say which one a message came from. */
		multiMachine: boolean;
		/** The ask a reply answers, for the quote; null when it is not in the feed. */
		quote: { key: string; text: string } | null;
		now: number;
		failure: Failure | null;
		dismissFailure: Failure | null;
		/** A message the poll just brought in, for a moment's highlight. */
		fresh?: boolean;
		/** What happened to a closed ask, in words (outcomesOf); null while open or for a plain message. */
		outcome: string | null;
		/** An open ask whose form is showing. A failed answer opens it too. */
		expanded: boolean;
		/** Opens or closes an open ask's form. */
		ontoggle: () => void;
	}

	let {
		entry,
		first,
		last,
		mine,
		shipToShip,
		multiMachine,
		quote,
		now,
		failure,
		dismissFailure,
		fresh = false,
		outcome,
		expanded,
		ontoggle
	}: Props = $props();

	// Clock times depend on the viewer's zone, so they are drawn only once the page runs.
	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});

	const key = $derived(askKey(entry.from, entry.id));
	const kind = $derived(feedKindOf(entry));
	const open = $derived(isOpen(entry));
	const question = $derived(toQuestion(toMailItem(entry), now));
	const title = $derived(reportTitleOf(entry));
	const mark = $derived(shipMark(entry.ship));
	const asks = $derived(
		open && (kind === 'decision' || kind === 'request' || kind === 'needs_hands')
	);
	const formFailure = $derived(
		failure && failure.from === entry.from && failure.id === entry.id ? failure : null
	);
	const closeFailure = $derived(
		dismissFailure && dismissFailure.from === entry.from && dismissFailure.id === entry.id
			? dismissFailure
			: null
	);
	const recommended = $derived(question.options.find((o) => o.recommended) ?? null);
	const panel = $derived(`ask-${anchorOf(key)}`);
	const handsText = $derived(handsTextOf(entry.payload) ?? 'Take the step, then mark it done.');
	const askLabel = $derived(
		kind === 'notice' || kind === 'report'
			? dismissLabel('notice', false)
			: dismissLabel('request', kind === 'needs_hands')
	);
</script>

<li
	class="msg"
	class:mine
	class:s2s={shipToShip}
	class:open
	class:first
	class:last
	class:fresh
	class:closed={!open && !mine}
	id={anchorOf(key)}
	data-entry={entry.id}
	data-kind={kind}
	data-open={open}
>
	{#if !mine && !shipToShip}
		<span class="mark" class:hidden={!first} style:--hue={mark.hue} aria-hidden="true"
			>{mark.initial}</span
		>
	{/if}

	<div class="col">
		{#if first}
			<header class="meta">
				{#if mine}
					<span class="who">You</span>
				{:else if shipToShip}
					<span class="who route">{entry.from} → {entry.to}</span>
				{:else}
					<a class="who" href={resolve('/ship/[name]', { name: entry.ship })}>{entry.ship}</a>
				{/if}
				{#if multiMachine && entry.machine}<span class="machine">{entry.machine}</span>{/if}
				{#if mounted && entry.created_ms !== null}
					<time datetime={isoTime(entry.created_ms)}>{clockOf(entry.created_ms)}</time>
				{/if}
			</header>
		{/if}

		<div class="bubble" class:ask={asks} class:urgent={entry.urgency === 'high'}>
			{#if quote && mine}
				<button
					type="button"
					class="quote"
					onclick={() =>
						document
							.getElementById(anchorOf(quote.key))
							?.scrollIntoView({ block: 'center', behavior: 'smooth' })}
				>
					<span class="visually-hidden">Jump to the ask: </span>{quote.text}
				</button>
			{/if}

			{#if kind !== 'reply'}
				<p class="marker">
					<span class="kind kind-{kind}">{FEED_KIND_LABELS[kind]}</span>
					{#if entry.urgency === 'high'}<span class="urgent-tag tag tag-danger">High urgency</span
						>{/if}
					{#if open}
						<span class="waiting tag tag-brass">Waiting on you</span>
					{:else if outcome}
						<span class="outcome tag tag-ok">{outcome}</span>
					{/if}
				</p>
			{/if}

			{#if asks}
				{#if !expanded}
					<p class="summary">{question.question}</p>
					{#if recommended}
						<p class="recommended">
							<Icon name="star" size={14} />
							<span>Recommended: <strong>{recommended.label}</strong></span>
						</p>
					{/if}
					<button
						type="button"
						class="btn btn-primary answer-btn"
						aria-expanded="false"
						aria-controls={panel}
						onclick={ontoggle}>Answer <Icon name="chevron-right" size={16} /></button
					>
				{/if}

				<!-- Kept in the page while collapsed, so a half-written answer survives. -->
				<div id={panel} class="ask-panel" hidden={!expanded}>
					{#if expanded}
						<button
							type="button"
							class="btn btn-quiet btn-sm collapse"
							aria-expanded="true"
							aria-controls={panel}
							onclick={ontoggle}><Icon name="chevron" size={16} />Collapse</button
						>
					{/if}
					{#if kind === 'decision' || kind === 'request'}
						<QuestionForm
							{question}
							{now}
							failure={formFailure}
							dismissFailure={closeFailure}
							formatNote={false}
						/>
					{:else}
						<p class="body">{question.question}</p>
						<div class="hands" role="note">
							<Icon name="hand" size={20} />
							<div>
								<strong>Needs your hands</strong>
								<p>{handsText}</p>
								<div class="hands-actions">
									<CopyStep text={handsText} />
								</div>
							</div>
						</div>
						<Dismiss from={entry.from} id={entry.id} label={askLabel} failure={closeFailure} />
					{/if}
				</div>
			{:else}
				{#if entry.body}
					<!-- eslint-disable svelte/no-navigation-without-resolve -- a link written in a ship's message, not app navigation -->
					<p class="body">
						{#each segmentsOf(entry.body) as seg, i (i)}{#if seg.href}<a
									href={seg.href}
									rel="noopener noreferrer nofollow">{seg.text}</a
								>{:else}{seg.text}{/if}{/each}
					</p>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
				{/if}

				{#if kind === 'report' && title}
					<p class="report">
						<a class="open-report" href={resolve('/report/[key]', { key })}>
							<Icon name="doc" size={15} /> Open report: {title}
						</a>
					</p>
				{/if}

				{#if entry.local && !entry.local.sent}
					<p class="note">Logged, not sent</p>
				{/if}

				{#if open && kind !== 'reply'}
					<Dismiss from={entry.from} id={entry.id} label={askLabel} failure={closeFailure} />
				{/if}
			{/if}
		</div>
	</div>
</li>

<style>
	.msg {
		display: flex;
		align-items: flex-end;
		gap: var(--s-3);
		list-style: none;
		margin: 3px 0 0;
		padding: 0;
	}
	.msg.first {
		margin-top: var(--s-5);
	}
	.msg.s2s {
		justify-content: center;
		font-size: var(--text-sm);
	}
	.msg.mine {
		justify-content: flex-end;
	}
	.msg.fresh .bubble {
		animation: arrive 1.6s var(--ease);
	}
	@keyframes arrive {
		from {
			background-color: var(--sea-soft);
		}
	}

	/* The ship's monogram: a soft tile in its own hue, drawn from the palette's depth. */
	.mark {
		flex: none;
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border-radius: 10px;
		background: light-dark(hsl(var(--hue) 38% 90%), hsl(var(--hue) 28% 20%));
		box-shadow: inset 0 0 0 1px light-dark(hsl(var(--hue) 30% 80%), hsl(var(--hue) 30% 30%));
		color: light-dark(hsl(var(--hue) 48% 28%), hsl(var(--hue) 55% 80%));
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 0.9375rem;
		user-select: none;
	}
	.mark.hidden {
		visibility: hidden;
	}

	.col {
		display: grid;
		gap: var(--s-1);
		min-width: 0;
		max-width: min(84%, 34rem);
	}
	.msg.mine .col {
		justify-items: end;
	}
	.msg.s2s .col {
		max-width: 86%;
		justify-items: center;
	}
	.msg.open .col {
		max-width: 100%;
		flex: 1;
	}

	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--s-1) var(--s-2);
		padding: 0 var(--s-1);
		font-size: var(--text-xs);
		color: var(--ink-3);
	}
	.who {
		font-weight: 650;
		color: var(--ink);
		text-decoration: none;
	}
	a.who:hover {
		text-decoration: underline;
	}
	.route {
		color: var(--ink-3);
		font-weight: 550;
	}
	.machine {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
	}
	time {
		font-variant-numeric: tabular-nums;
	}

	.bubble {
		display: grid;
		gap: var(--s-2);
		min-width: 0;
		max-width: 100%;
		padding: var(--s-3) var(--s-4);
		background: var(--surface);
		border-radius: var(--radius-lg);
		border-bottom-left-radius: 6px;
		box-shadow: var(--elev-1);
		overflow-wrap: anywhere;
		line-height: 1.5;
	}
	.msg.mine .bubble {
		background: var(--sea-soft);
		color: var(--ink);
		box-shadow: none;
		border-bottom-left-radius: var(--radius-lg);
		border-bottom-right-radius: 6px;
	}
	.msg.s2s .bubble {
		background: transparent;
		box-shadow: inset 0 0 0 1px var(--line);
		color: var(--ink-2);
		font-size: var(--text-sm);
		padding: var(--s-2) var(--s-4);
		border-radius: var(--radius-lg);
	}
	/* What is done recedes: no lift, quieter ink. */
	.msg.closed .bubble {
		background: color-mix(in srgb, var(--surface) 55%, transparent);
		box-shadow: inset 0 0 0 1px var(--line);
		color: var(--ink-2);
	}
	/* What waits on the captain is lifted, with a brass edge. */
	.msg.open .bubble {
		background: var(--surface-raised);
		box-shadow:
			inset 3px 0 0 var(--brass-fill),
			var(--elev-2);
		border-bottom-left-radius: var(--radius-lg);
	}
	.bubble.ask {
		gap: var(--s-3);
		padding: var(--s-4) var(--s-4) var(--s-4) var(--s-5);
	}
	.msg.open .bubble.urgent {
		box-shadow:
			inset 3px 0 0 var(--danger),
			var(--elev-2);
	}

	.marker {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-1) var(--s-2);
		margin: 0;
		min-height: 1.375rem;
	}
	.kind {
		font-size: var(--text-2xs);
		font-weight: 650;
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		color: var(--ink-3);
	}
	.kind-needs_hands,
	.kind-approval {
		color: var(--brass);
	}
	.waiting {
		margin-left: auto;
	}
	.outcome {
		height: auto;
		min-height: 1.375rem;
		padding: 3px var(--s-2);
		line-height: 1.35;
		white-space: normal;
	}
	.waiting::before {
		content: '';
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--brass-fill);
	}

	.body {
		margin: 0;
		white-space: pre-wrap;
	}
	.body a,
	.quote {
		color: var(--sea-strong);
	}
	.quote {
		display: block;
		width: 100%;
		text-align: start;
		padding: var(--s-1) var(--s-2);
		border: 0;
		border-inline-start: 2px solid var(--sea);
		border-radius: 0 var(--radius-xs) var(--radius-xs) 0;
		background: color-mix(in srgb, var(--surface) 60%, transparent);
		color: var(--ink-2);
		font: inherit;
		font-size: var(--text-xs);
		cursor: pointer;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.quote:hover {
		color: var(--ink);
	}
	.note {
		margin: 0;
		font-size: var(--text-xs);
		color: var(--warn);
	}

	.hands {
		display: flex;
		gap: var(--s-3);
		padding: var(--s-3) var(--s-4);
		border-radius: var(--radius);
		background: var(--brass-soft);
	}
	.hands > :global(.icon) {
		color: var(--brass);
		margin-top: 2px;
	}
	.hands strong {
		display: block;
		font-size: var(--text-sm);
		color: var(--brass);
	}
	.hands p {
		margin: var(--s-1) 0 0;
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		white-space: pre-wrap;
	}
	.hands-actions {
		margin-top: var(--s-2);
		margin-left: calc(-1 * var(--s-3));
	}

	.summary {
		display: -webkit-box;
		line-clamp: 3;
		-webkit-line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
		margin: 0;
		font-size: var(--text-md);
		font-weight: 500;
		line-height: 1.45;
		color: var(--ink);
		white-space: pre-wrap;
		text-wrap: pretty;
	}
	.recommended {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		margin: 0;
		font-size: var(--text-sm);
		color: var(--ink-2);
	}
	.recommended > :global(.icon) {
		color: var(--brass);
	}
	.answer-btn {
		justify-self: start;
		margin-top: var(--s-1);
		padding-right: var(--s-3);
	}
	.ask-panel {
		display: grid;
		gap: var(--s-3);
		animation: rise var(--dur-3) var(--ease);
	}
	.ask-panel[hidden] {
		display: none;
	}
	.collapse {
		justify-self: end;
		margin: calc(-1 * var(--s-3)) calc(-1 * var(--s-2)) calc(-1 * var(--s-2)) 0;
	}
	.collapse :global(.icon) {
		transform: rotate(180deg);
	}

	.report {
		margin: 0;
	}
	.open-report {
		display: inline-flex;
		align-items: center;
		gap: var(--s-2);
		min-height: var(--tap);
		color: var(--sea-strong);
		font-weight: 600;
		text-decoration: none;
	}
	.open-report:hover {
		text-decoration: underline;
	}
</style>
