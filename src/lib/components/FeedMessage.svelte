<!--
	One message in the Feed, drawn as a chat bubble. An open ask is answered in
	place: a decision or request with the same form as Decisions, a needs_hands
	step with Done, a notice or report with Mark read or Open report. Closed
	asks keep their words and show what happened to them.
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
		outcomeOf,
		reportTitleOf,
		segmentsOf,
		shipMark,
		toMailItem
	} from '#lib/feed.ts';
	import type { FeedEntry } from '#lib/shapes.ts';
	import { isoTime } from '#lib/time.ts';
	import { resolve } from '$app/paths';
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
		fresh = false
	}: Props = $props();

	// Clock times depend on the viewer's zone, so they are drawn only once the page runs.
	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});

	const key = $derived(askKey(entry.from, entry.id));
	const kind = $derived(feedKindOf(entry));
	const open = $derived(isOpen(entry));
	const outcome = $derived(outcomeOf(entry));
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
					{#if entry.urgency === 'high'}<span class="urgent-tag">High urgency</span>{/if}
					{#if open}
						<span class="waiting">Waiting on you</span>
					{:else if outcome}
						<span class="outcome">{outcome}</span>
					{/if}
				</p>
			{/if}

			{#if asks && (kind === 'decision' || kind === 'request')}
				<QuestionForm
					{question}
					{now}
					failure={formFailure}
					dismissFailure={closeFailure}
					formatNote={false}
				/>
			{:else}
				{#if kind === 'needs_hands' && open}
					<p class="body">{question.question}</p>
					<div class="hands" role="note">
						<Icon name="hand" size={20} />
						<div>
							<strong>Needs your hands</strong>
							<p>{handsTextOf(entry.payload) ?? 'Take the step, then mark it done.'}</p>
						</div>
					</div>
				{:else if entry.body}
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
		gap: var(--s-2);
		list-style: none;
		margin: 0;
		padding: 0;
		margin-top: var(--s-1);
	}
	.msg.first {
		margin-top: var(--s-4);
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

	.mark {
		flex: none;
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		background: hsl(var(--hue) 45% 42%);
		color: #fff;
		font-weight: 650;
		font-size: var(--text-sm);
		user-select: none;
	}
	.mark.hidden {
		visibility: hidden;
	}

	.col {
		display: grid;
		gap: var(--s-1);
		min-width: 0;
		max-width: min(82%, 36rem);
	}
	.msg.mine .col {
		justify-items: end;
	}
	.msg.s2s .col {
		max-width: 80%;
		justify-items: center;
	}
	.msg:not(.mine):not(.s2s) .col {
		padding-left: 0;
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
		color: var(--ink-2);
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
	}

	.bubble {
		display: grid;
		gap: var(--s-2);
		min-width: 0;
		max-width: 100%;
		padding: var(--s-3) var(--s-4);
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		border-bottom-left-radius: var(--s-1);
		box-shadow: var(--shadow);
		overflow-wrap: anywhere;
	}
	.msg.mine .bubble {
		background: var(--sea-soft);
		border-color: transparent;
		border-bottom-left-radius: var(--radius-lg);
		border-bottom-right-radius: var(--s-1);
	}
	.msg.s2s .bubble {
		background: var(--surface-2);
		box-shadow: none;
		font-size: var(--text-sm);
		padding: var(--s-2) var(--s-3);
		border-radius: 999px;
	}
	.msg.closed .bubble {
		background: var(--surface-2);
		box-shadow: none;
		color: var(--ink-2);
	}
	.msg.open .bubble {
		border-color: var(--sea);
		box-shadow:
			0 0 0 1px var(--sea) inset,
			var(--shadow);
	}
	.bubble.ask {
		padding: var(--s-4);
	}
	.bubble.urgent {
		border-color: var(--warn);
	}

	.marker {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-1) var(--s-2);
		margin: 0;
		font-size: var(--text-xs);
		color: var(--ink-3);
	}
	.kind {
		font-weight: 650;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.kind-needs_hands,
	.kind-approval {
		color: var(--brass);
	}
	.urgent-tag {
		color: var(--warn);
		font-weight: 650;
	}
	.waiting {
		margin-left: auto;
		padding: 1px 8px;
		border-radius: 999px;
		background: var(--sea);
		color: var(--sea-ink);
		font-weight: 650;
	}
	.outcome {
		margin-left: auto;
		color: var(--ok);
		font-weight: 650;
	}

	.body {
		margin: 0;
		white-space: pre-wrap;
		line-height: 1.5;
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
		border-inline-start: 3px solid var(--sea);
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--ink-3);
		font: inherit;
		font-size: var(--text-xs);
		cursor: pointer;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.note {
		margin: 0;
		font-size: var(--text-xs);
		color: var(--warn);
	}

	.hands {
		display: flex;
		gap: var(--s-3);
		padding: var(--s-3);
		border-radius: var(--radius-sm);
		background: var(--brass-soft);
		border: 1px solid var(--brass-line);
	}
	.hands p {
		margin: var(--s-1) 0 0;
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
	}
</style>
