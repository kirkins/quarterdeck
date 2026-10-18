<script lang="ts">
	import type { Card } from '#lib/decision.ts';
	import type { Failure } from '#lib/form.ts';
	import { formatAge, formatDeadline, isoTime, urgencyOf } from '#lib/time.ts';
	import Blocked from './Blocked.svelte';
	import Icon from './Icon.svelte';
	import QuestionForm from './QuestionForm.svelte';

	let {
		card,
		now,
		failure = null,
		dismissFailure = null
	}: {
		card: Card;
		now: number;
		failure?: Failure | null;
		dismissFailure?: Failure | null;
	} = $props();

	/** A failure belongs to one question: the sender and id must both match. */
	const forQuestion = (f: Failure | null, q: Card['questions'][number]) =>
		f && f.from === q.from && f.id === q.id ? f : null;

	const answered = $derived(card.questions.filter((q) => q.answered).length);
	const done = $derived(answered === card.questions.length);
	const urgency = $derived(done ? 'none' : urgencyOf(card.deadline_ms, now));
	const grouped = $derived(card.questions.length > 1);

	// In a group, say what every question shares once, on the card.
	const sharedBlocked = $derived.by(() => {
		const [first, ...rest] = card.questions;
		const same = rest.every((q) => q.blocked.join('\u0000') === first.blocked.join('\u0000'));
		return grouped && same && first.blocked.length > 0 ? first.blocked : null;
	});
	const sharedDeadline = $derived(
		card.questions.every((q) => q.deadline_ms === card.questions[0].deadline_ms)
	);
</script>

<article
	class="card urgency-{urgency}"
	class:done
	aria-label="{card.from}: {grouped
		? `${card.questions.length} questions`
		: card.questions[0].question}"
	data-card={card.key}
>
	<header class="meta">
		<span class="ship">
			<Icon name="ship" size={16} />
			<span class="ship-name">{card.from}</span>
		</span>
		<span class="age">
			<span class="visually-hidden">asked</span>
			<time datetime={isoTime(card.asked_ms)} title={isoTime(card.asked_ms)}
				>{formatAge(card.asked_ms, now)}</time
			>
		</span>
		{#if !done}
			<span
				class="deadline deadline-{urgency} tag"
				class:tag-danger={urgency === 'overdue'}
				class:tag-warn={urgency === 'soon'}
			>
				<Icon name={urgency === 'overdue' ? 'alert' : 'clock'} size={13} />
				{#if card.deadline_ms !== null}
					<time datetime={isoTime(card.deadline_ms)}>{formatDeadline(card.deadline_ms, now)}</time>
				{:else}
					No deadline
				{/if}
			</span>
		{/if}
	</header>

	{#if grouped}
		<p class="group">
			{card.questions.length} related questions{#if answered > 0}<span class="progress-text">
					· {answered} answered</span
				>{/if}
		</p>
	{/if}

	{#if sharedBlocked}
		<Blocked who={sharedBlocked} />
	{/if}

	<div class="questions">
		{#each card.questions as question, i (question.id)}
			<QuestionForm
				{question}
				{now}
				index={grouped ? i : null}
				total={card.questions.length}
				showBlocked={!sharedBlocked}
				showDeadline={!sharedDeadline}
				failure={forQuestion(failure, question)}
				dismissFailure={forQuestion(dismissFailure, question)}
			/>
		{/each}
	</div>
</article>

<style>
	.card {
		--edge: transparent;
		position: relative;
		display: grid;
		gap: var(--s-4);
		padding: var(--s-5) var(--s-4);
		border-radius: var(--radius-xl);
		background: var(--surface);
		box-shadow:
			inset 3px 0 0 var(--edge),
			var(--elev-2);
	}
	.urgency-overdue {
		--edge: var(--danger);
	}
	.urgency-soon {
		--edge: var(--warn);
	}
	.card.done {
		box-shadow: inset 0 0 0 1px var(--line);
		background: color-mix(in srgb, var(--surface) 50%, transparent);
	}
	@media (min-width: 36rem) {
		.card {
			padding: var(--s-6) var(--s-6) var(--s-6) calc(var(--s-6) + 2px);
		}
	}

	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-1) var(--s-3);
		font-size: var(--text-sm);
		color: var(--ink-3);
	}
	.ship {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--ink);
		font-weight: 650;
	}
	.ship :global(.icon) {
		color: var(--sea);
	}
	.age {
		font-variant-numeric: tabular-nums;
	}
	.deadline {
		margin-left: auto;
	}
	.deadline-none {
		background: transparent;
		color: var(--ink-3);
		font-weight: 550;
	}
	.deadline-later {
		background: var(--well);
	}

	.group {
		font-size: var(--text-2xs);
		font-weight: 650;
		letter-spacing: var(--track-caps);
		text-transform: uppercase;
		color: var(--sea);
		margin-top: calc(-1 * var(--s-2));
	}
	.progress-text {
		color: var(--ink-3);
	}

	.questions {
		display: grid;
		gap: var(--s-6);
	}
	.questions > :global(* + *) {
		padding-top: var(--s-6);
		border-top: 1px dashed var(--line-strong);
	}
</style>
