<!--
	One question and its answer form.

	Answering takes two deliberate steps so a stray tap on a phone sends
	nothing: pick an option (or write an answer), then press Send. The form is
	a plain POST to ?/answer and works without JavaScript; with it, the page
	updates in place.
-->
<script lang="ts">
	import { enhance } from '$app/forms';
	import { onMount, tick } from 'svelte';
	import type { Question } from '#lib/decision.ts';
	import { dismissLabel } from '#lib/dismiss.ts';
	import type { Failure } from '#lib/form.ts';
	import { formatAge, formatDeadline, urgencyOf } from '#lib/time.ts';
	import Blocked from './Blocked.svelte';
	import Dismiss from './Dismiss.svelte';
	import Icon from './Icon.svelte';

	interface Props {
		question: Question;
		now: number;
		/** Inside a group card: show this question's own deadline and number. */
		index?: number | null;
		total?: number;
		/** False when the card already shows these (shared by every question in a group). */
		showBlocked?: boolean;
		showDeadline?: boolean;
		/** A failed answer for this question, echoed back by the action. */
		failure?: Failure | null;
		/** A failed dismiss for this question. */
		dismissFailure?: Failure | null;
	}

	let {
		question,
		now,
		index = null,
		total = 1,
		showBlocked = true,
		showDeadline = true,
		failure = null,
		dismissFailure = null
	}: Props = $props();

	// svelte-ignore state_referenced_locally
	let selected = $state<string | null>(failure?.option_id ?? null);
	// svelte-ignore state_referenced_locally
	let text = $state(failure?.text ?? '');
	/** The captain opened their own answer instead of picking an option. */
	let writing = $state(false);
	let pending = $state(false);
	let error = $state<string | null>(null);
	let field = $state<HTMLTextAreaElement | null>(null);
	/** False until the page's JavaScript runs; the plain form shows every field then. */
	let enhanced = $state(false);

	onMount(() => {
		enhanced = true;
	});

	const uid = $derived(`q-${question.id}`);
	const chosen = $derived(question.options.find((o) => o.id === selected) ?? null);
	const ready = $derived(chosen !== null || text.trim() !== '');
	// The note or own-answer field appears once it is wanted: always when there is
	// nothing to pick or without JavaScript, otherwise after an option or an own
	// answer is in play.
	const showField = $derived(
		!enhanced || question.options.length === 0 || chosen !== null || writing || text !== ''
	);
	const shownError = $derived(error ?? failure?.error ?? null);
	const textLabel = $derived(
		question.options.length === 0
			? 'Your answer'
			: chosen
				? 'Add a note (optional)'
				: enhanced
					? 'Your own answer'
					: 'Your own answer or a note'
	);

	/** Escape backs out of a half-made answer. */
	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && (selected !== null || text !== '' || writing)) {
			event.preventDefault();
			clear();
		}
	}

	/** Picking an option ends writing your own answer; any text stays as a note. */
	function onpick() {
		writing = false;
	}

	/** Writing your own answer replaces any option picked so far. */
	async function openOwn() {
		selected = null;
		writing = true;
		await tick();
		field?.focus();
	}

	function clear() {
		selected = null;
		text = '';
		writing = false;
		error = null;
	}
</script>

<section
	class="question"
	class:answered={question.answered}
	aria-labelledby="{uid}-title"
	data-question={question.id}
>
	{#if index !== null}
		<p class="step">
			<span>Question {index + 1} of {total}</span>
			{#if showDeadline && question.deadline_ms !== null}
				<span class="due due-{urgencyOf(question.deadline_ms, now)}"
					>{formatDeadline(question.deadline_ms, now)}</span
				>
			{/if}
		</p>
	{/if}

	<h2 id="{uid}-title" class:sub={index !== null}>{question.question}</h2>

	{#if question.why}
		<p class="why">{question.why}</p>
	{/if}

	{#if question.hands_on}
		<div class="hands" role="note">
			<Icon name="hand" size={20} />
			<div>
				<strong>Needs your hands</strong>
				<p>{question.hands_on}</p>
			</div>
		</div>
	{/if}

	{#if showBlocked && question.blocked.length > 0}
		<Blocked who={question.blocked} />
	{/if}

	{#if question.kind === 'legacy'}
		<p class="format-note">Older ask format: the ship sent choices without details.</p>
	{:else if question.kind === 'invalid'}
		<details class="format-note invalid">
			<summary>
				<Icon name="alert" size={16} />
				This ask’s decision details did not validate, so it is shown from its message.
			</summary>
			<ul>
				{#each question.problems as problem (problem)}<li>{problem}</li>{/each}
			</ul>
		</details>
	{/if}

	{#if question.answered}
		{@const a = question.answered}
		<div class="done" role="status">
			<Icon name="check" size={20} />
			<div>
				{#if a.dismissed}
					<p>
						<strong>Dismissed</strong>{#if a.text}<span class="done-text"> · {a.text}</span>{/if}
					</p>
				{:else}
					<p>
						<strong>{a.label ?? 'Answered'}</strong>{#if a.text}<span class="done-text">
								“{a.text}”</span
							>{/if}
					</p>
				{/if}
				<p class="done-meta">
					{a.sent ? `Sent to ${question.from}` : 'Logged, not sent'} · {formatAge(a.at_ms, now)}
				</p>
			</div>
		</div>
	{:else}
		<form
			method="POST"
			action="?/answer"
			onreset={clear}
			use:enhance={() => {
				pending = true;
				error = null;
				return async ({ result, update }) => {
					pending = false;
					if (result.type === 'failure') {
						error = String(result.data?.error ?? 'Not sent.');
						return;
					}
					if (result.type === 'error') {
						error = result.error?.message ?? 'Something went wrong; nothing was sent.';
						return;
					}
					await update({ reset: false });
				};
			}}
		>
			<input type="hidden" name="from" value={question.from} />
			<input type="hidden" name="id" value={question.id} />

			{#if question.options.length > 0}
				<fieldset>
					<legend class="visually-hidden">Options for: {question.question}</legend>
					<div class="options">
						{#each question.options as option, i (option.id)}
							{@const oid = `${uid}-o${i}`}
							<label class="option" class:recommended={option.recommended}>
								<input
									type="radio"
									name="option_id"
									value={option.id}
									bind:group={selected}
									onchange={onpick}
									disabled={pending}
									aria-labelledby="{oid}-label{option.recommended ? ` ${oid}-rec` : ''}"
									aria-describedby={[
										option.what_happens && `${oid}-what`,
										option.cost && `${oid}-cost`
									]
										.filter(Boolean)
										.join(' ') || undefined}
									{onkeydown}
								/>
								<span class="radio" aria-hidden="true"></span>
								<span class="option-body">
									<span class="option-head">
										<span class="option-label" id="{oid}-label">{option.label}</span>
										{#if option.recommended}
											<span class="badge" id="{oid}-rec"
												><Icon name="star" size={13} />Recommended</span
											>
										{/if}
									</span>
									{#if option.what_happens}
										<span class="what" id="{oid}-what">{option.what_happens}</span>
									{/if}
									{#if option.cost}
										<span class="cost" id="{oid}-cost"
											><Icon name="coin" size={14} /><span class="visually-hidden">Cost:</span>
											{option.cost}</span
										>
									{/if}
								</span>
							</label>
						{/each}
						{#if enhanced}
							<button
								type="button"
								class="option own"
								class:open={writing}
								disabled={pending}
								onclick={openOwn}
							>
								<span class="option-body">
									<span class="option-label">
										{writing
											? 'Writing my own answer'
											: question.free_text_ok
												? 'Or write my own answer'
												: 'Write my own answer'}
									</span>
									<span class="what">Say it in your own words instead of picking one.</span>
								</span>
							</button>
						{/if}
					</div>
				</fieldset>
			{/if}

			{#if showField}
				<div class="compose">
					<label class="text-label" for="{uid}-text">{textLabel}</label>
					<textarea
						id="{uid}-text"
						name="text"
						rows="2"
						maxlength="2000"
						placeholder={chosen ? 'e.g. only after Friday' : 'Write your answer…'}
						bind:value={text}
						bind:this={field}
						disabled={pending}
						{onkeydown}></textarea>
				</div>
			{/if}

			{#if ready || !enhanced}
				<div class="confirm" aria-live="polite">
					{#if enhanced}
						<p class="confirm-summary">
							{#if chosen}
								Reply to <strong>{question.from}</strong>: {chosen.label}{text.trim()
									? ', with your note'
									: ''}
							{:else}
								Reply to <strong>{question.from}</strong> in your own words
							{/if}
						</p>
					{/if}
					<div class="confirm-actions">
						<button type="reset" class="btn btn-quiet" disabled={pending}>Cancel</button>
						<button
							type="submit"
							class="btn btn-primary"
							disabled={pending || (enhanced && !ready)}
						>
							{pending ? 'Sending…' : 'Send answer'}
						</button>
					</div>
				</div>
			{/if}

			{#if shownError}
				<p class="error" role="alert"><Icon name="alert" size={16} />{shownError}</p>
			{/if}
		</form>

		<Dismiss
			from={question.from}
			id={question.id}
			label={dismissLabel('decision', question.hands_on !== null)}
			failure={dismissFailure}
		/>
	{/if}
</section>

<style>
	.question {
		display: grid;
		gap: var(--s-4);
	}
	.step {
		display: flex;
		justify-content: space-between;
		gap: var(--s-3);
		font-size: var(--text-xs);
		font-weight: 650;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--ink-3);
	}
	.due {
		letter-spacing: 0;
		text-transform: none;
		font-weight: 600;
	}
	.due-overdue {
		color: var(--danger);
	}
	.due-soon {
		color: var(--warn);
	}

	h2 {
		font-family: var(--font-display);
		font-size: var(--text-xl);
		font-weight: 600;
		line-height: 1.25;
		letter-spacing: -0.012em;
		font-variation-settings: 'opsz' 36;
		text-wrap: balance;
	}
	h2.sub {
		font-size: var(--text-lg);
	}
	.why {
		color: var(--ink-2);
		text-wrap: pretty;
		margin-top: calc(-1 * var(--s-2));
	}

	.hands {
		display: flex;
		gap: var(--s-3);
		padding: var(--s-3) var(--s-4);
		border-radius: var(--radius);
		background: var(--warn-soft);
		color: var(--ink);
		border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent);
	}
	.hands :global(.icon) {
		color: var(--warn);
		margin-top: 2px;
	}
	.hands strong {
		display: block;
		font-size: var(--text-sm);
		color: var(--warn);
	}
	.hands p {
		font-size: var(--text-sm);
	}

	.format-note {
		font-size: var(--text-sm);
		color: var(--ink-3);
	}
	.invalid summary {
		display: inline-flex;
		gap: var(--s-2);
		align-items: center;
		cursor: pointer;
		color: var(--warn);
	}
	.invalid ul {
		margin-top: var(--s-2);
		padding-left: var(--s-6);
		list-style: disc;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
	}

	form {
		display: grid;
		gap: var(--s-3);
	}
	.options {
		display: grid;
		gap: var(--s-2);
	}
	.option {
		position: relative;
		display: grid;
		grid-template-columns: auto 1fr;
		gap: var(--s-3);
		align-items: start;
		padding: var(--s-3) var(--s-4);
		min-height: var(--tap);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius);
		background: var(--surface);
		cursor: pointer;
		transition:
			border-color 120ms var(--ease),
			background-color 120ms var(--ease),
			box-shadow 120ms var(--ease);
		-webkit-tap-highlight-color: transparent;
	}
	.option:hover {
		border-color: color-mix(in srgb, var(--sea) 55%, var(--line-strong));
	}
	.option.recommended {
		border-color: var(--brass-line);
		background: linear-gradient(90deg, var(--brass-soft), var(--surface) 70%);
	}
	.option:has(input:checked) {
		border-color: var(--sea);
		background: var(--sea-soft);
		box-shadow: inset 0 0 0 1px var(--sea);
	}
	.option:has(input:focus-visible) {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.option:has(input:disabled) {
		cursor: progress;
	}
	/* The own-answer row is a button, so it resets the look a native button brings. */
	button.option {
		width: 100%;
		font: inherit;
		color: inherit;
		text-align: left;
	}
	.option.own {
		grid-template-columns: 1fr;
		border-style: dashed;
		background: transparent;
	}
	.option.own:hover {
		border-style: dashed;
	}
	.option.own.open {
		border-style: solid;
		border-color: var(--sea);
		background: var(--sea-soft);
	}
	.option.own:disabled {
		cursor: progress;
	}
	.option input {
		position: absolute;
		opacity: 0;
		inset: 0;
		margin: 0;
		cursor: inherit;
	}
	.radio {
		width: 20px;
		height: 20px;
		margin-top: 1px;
		border-radius: 50%;
		border: 2px solid var(--line-strong);
		background: var(--surface);
		transition: border-color 120ms var(--ease);
	}
	.option:has(input:checked) .radio {
		border: 6px solid var(--sea);
		background: var(--sea-ink);
	}
	.option-body {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.option-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-1) var(--s-2);
	}
	.option-label {
		font-weight: 650;
		line-height: 1.35;
	}
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 1px 8px 1px 6px;
		border-radius: 999px;
		font-size: 0.6875rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--brass);
		background: var(--brass-soft);
		border: 1px solid var(--brass-line);
	}
	.what {
		font-size: var(--text-sm);
		color: var(--ink-2);
		text-wrap: pretty;
	}
	.cost {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		margin-top: 2px;
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--ink);
	}
	.cost :global(.icon) {
		color: var(--ink-3);
	}

	.compose {
		gap: var(--s-1);
	}
	.text-label {
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--ink-2);
	}
	textarea {
		width: 100%;
		min-height: 2.75rem;
		padding: var(--s-2) var(--s-3);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius);
		background: var(--surface);
		resize: vertical;
		font-size: var(--text-md);
		line-height: 1.4;
	}
	textarea::placeholder {
		color: var(--ink-3);
	}
	textarea:focus-visible {
		outline-offset: 0;
		border-color: var(--focus);
	}

	.confirm {
		gap: var(--s-3);
		padding: var(--s-3);
		border-radius: var(--radius);
		background: var(--surface-2);
		border: 1px solid var(--line);
		animation: rise 160ms var(--ease);
	}
	.confirm-summary {
		font-size: var(--text-sm);
		color: var(--ink-2);
	}
	.confirm-summary strong {
		color: var(--ink);
	}
	.confirm-actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--s-2);
	}
	.confirm-actions .btn-primary {
		flex: 1;
		max-width: 14rem;
	}
	@media (min-width: 36rem) {
		.confirm {
			grid-template-columns: 1fr auto;
			align-items: center;
		}
		.confirm-actions .btn-primary {
			flex: none;
		}
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
	}

	.error {
		display: flex;
		gap: var(--s-2);
		align-items: center;
		padding: var(--s-2) var(--s-3);
		border-radius: var(--radius-sm);
		background: var(--danger-soft);
		color: var(--danger);
		font-size: var(--text-sm);
		font-weight: 600;
	}

	.done {
		display: flex;
		gap: var(--s-3);
		align-items: flex-start;
		padding: var(--s-3) var(--s-4);
		border-radius: var(--radius);
		background: var(--ok-soft);
		border: 1px solid color-mix(in srgb, var(--ok) 30%, transparent);
	}
	.done :global(.icon) {
		color: var(--ok);
		margin-top: 2px;
	}
	.done-text {
		color: var(--ink-2);
	}
	.done-meta {
		font-size: var(--text-sm);
		color: var(--ink-3);
	}
	.answered h2 {
		color: var(--ink-2);
	}
</style>
