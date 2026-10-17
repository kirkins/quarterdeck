<script lang="ts">
	import type { Card } from '#lib/decision.ts';
	import { formatAge, formatDeadline, isoTime, urgencyOf } from '#lib/time.ts';
	import Blocked from './Blocked.svelte';
	import Icon from './Icon.svelte';
	import QuestionForm from './QuestionForm.svelte';

	type Failure = { id: string; error: string; option_id: string | null; text: string | null };

	let {
		card,
		now,
		failure = null
	}: { card: Card; now: number; failure?: Failure | null } = $props();

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
		<span class="dot" aria-hidden="true">·</span>
		<span class="age">
			<span class="visually-hidden">asked</span>
			<time datetime={isoTime(card.asked_ms)} title={isoTime(card.asked_ms)}
				>{formatAge(card.asked_ms, now)}</time
			>
		</span>
		{#if !done}
			<span class="deadline deadline-{urgency}">
				<Icon name={urgency === 'overdue' ? 'alert' : 'clock'} size={14} />
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
				failure={failure?.id === question.id ? failure : null}
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
		padding: var(--s-5) var(--s-4) var(--s-5);
		border-radius: var(--radius-lg);
		background: var(--surface);
		border: 1px solid var(--line);
		box-shadow: var(--shadow);
		overflow: hidden;
	}
	.card::before {
		content: '';
		position: absolute;
		inset: 0 auto 0 0;
		width: 4px;
		background: var(--edge);
	}
	.urgency-overdue {
		--edge: var(--danger);
	}
	.urgency-soon {
		--edge: var(--warn);
	}
	.card.done {
		box-shadow: none;
		background: color-mix(in srgb, var(--surface) 60%, var(--bg));
	}
	@media (min-width: 36rem) {
		.card {
			padding: var(--s-6);
		}
	}

	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-1) var(--s-2);
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
	.deadline {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		margin-left: auto;
		padding: 2px 10px;
		border-radius: 999px;
		font-weight: 650;
		font-size: var(--text-xs);
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

	.group {
		font-size: var(--text-xs);
		font-weight: 650;
		letter-spacing: 0.06em;
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
		border-top: 1px solid var(--line);
	}
</style>
