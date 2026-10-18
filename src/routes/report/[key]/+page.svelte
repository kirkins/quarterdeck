<!--
	One report, read and annotated by the captain.

	The report runs in a sandboxed frame (see src/lib/server/render.ts), so
	nothing in it can act as this page. Comments are made in the frame and
	reach this page as postMessage; this page keeps them, saves a draft in
	localStorage, and sends them all as one reply. Without JavaScript the
	reader shows the report's title and state, but not the report: the frame
	is built in the browser, so its guards are in place before it loads.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import Icon from '#lib/components/Icon.svelte';
	import {
		checkAnnotation,
		checkAnnotations,
		findQuote,
		parseFromFrame,
		REPORT_LIMITS,
		type Anchor
	} from '#lib/report.ts';
	import { formatAge, formatDeadline } from '#lib/time.ts';
	import { KIND_LABELS } from '#lib/triage.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/** A comment as the captain makes it: where it points, and what they say. */
	interface Note {
		id: string;
		anchor: Anchor;
		comment: string;
	}

	/** What is kept between visits, per report, until the reply is sent. */
	interface Draft {
		notes: { anchor: Anchor; comment: string }[];
		note: string;
	}

	/** The comment being written: a new one on an anchor, or an edit of one by id. */
	interface Composer {
		anchor: Anchor;
		editing: string | null;
		text: string;
		error: string | null;
	}

	const LIMIT = REPORT_LIMITS.annotations;
	/** The draft's key in localStorage: this report's ask key. */
	const storageKey = () => `quarterdeck.report.${data.ask?.key ?? ''}`;

	let frameEl: HTMLIFrameElement | undefined = $state();
	/** The report's flattened text, as the frame reports it. Null until the frame has loaded. */
	let frameText = $state<string | null>(null);
	let notes = $state<Note[]>([]);
	let overall = $state('');
	let composer = $state<Composer | null>(null);
	let confirming = $state(false);
	let sending = $state(false);
	let sheetOpen = $state(false);
	let limitNote = $state<string | null>(null);
	let restored = $state(false);
	let mounted = $state(false);
	/** The frame loaded a second document: something in the report navigated it away. */
	let stopped = $state(false);
	let reloading = $state(false);
	let counter = 0;

	const ask = $derived(data.ask);
	const composing = $derived(ask !== null && ask.canComment && ask.answered === null);
	/** Each comment with where it sits now, or null where its text is gone. */
	const placed = $derived(
		notes.map((note) => ({
			note,
			span: frameText === null ? null : findQuote(frameText, note.anchor)
		}))
	);
	const lost = $derived(placed.filter((p) => frameText !== null && p.span === null).length);
	const sendable = $derived(notes.length > 0 || overall.trim() !== '');

	function nextId(): string {
		counter += 1;
		return `c${Date.now().toString(36)}${counter}`;
	}

	/** Restore a saved draft. Anything that no longer checks is dropped, not shown. */
	function restore(): void {
		try {
			const raw = localStorage.getItem(storageKey());
			if (!raw) return;
			const saved = JSON.parse(raw) as Partial<Draft>;
			const entries = Array.isArray(saved.notes) ? saved.notes : [];
			notes = entries.flatMap((entry) => {
				const checked = checkAnnotation(entry);
				return checked.ok
					? [{ id: nextId(), anchor: checked.value.anchor, comment: checked.value.comment }]
					: [];
			});
			if (typeof saved.note === 'string') overall = saved.note.slice(0, REPORT_LIMITS.note);
		} catch {
			// No storage, or a draft it cannot read: start empty.
		}
	}

	function clearDraft(): void {
		try {
			localStorage.removeItem(storageKey());
		} catch {
			// Nothing was saved, so nothing to clear.
		}
	}

	onMount(() => {
		restore();
		restored = true;
		mounted = true;
	});

	/**
	 * Build the report's frame. It is made here rather than in the markup so
	 * the order is certain: the sandbox and the load listener are in place
	 * before the srcdoc is set and the frame joins the page. The first load is
	 * the report. Any later load means the frame was navigated away from it,
	 * so the frame is torn down and nothing more from it is heard.
	 */
	function reportFrame(srcdoc: string, title: string): Attachment<HTMLElement> {
		return (host) => {
			const frame = document.createElement('iframe');
			frame.className = 'frame';
			frame.title = `Report: ${title}`;
			frame.setAttribute('sandbox', 'allow-scripts');
			frame.referrerPolicy = 'no-referrer';
			let loads = 0;
			frame.addEventListener('load', () => {
				loads += 1;
				if (loads > 1) stopFrame();
			});
			frame.srcdoc = srcdoc;
			host.append(frame);
			frameEl = frame;
			frameText = null;
			return () => {
				frame.remove();
				if (frameEl === frame) frameEl = undefined;
			};
		};
	}

	function stopFrame() {
		stopped = true;
		frameEl = undefined;
		frameText = null;
	}

	/** Render the report again, with a fresh nonce and token, and a new frame. */
	async function reloadReport() {
		reloading = true;
		try {
			await invalidateAll();
			stopped = false;
		} finally {
			reloading = false;
		}
	}

	// Keep the draft as the captain works, so a reload or a closed tab loses nothing.
	$effect(() => {
		if (!restored) return;
		const draft: Draft = {
			notes: notes.map(({ anchor, comment }) => ({ anchor, comment })),
			note: overall
		};
		try {
			if (draft.notes.length === 0 && draft.note === '') localStorage.removeItem(storageKey());
			else localStorage.setItem(storageKey(), JSON.stringify(draft));
		} catch {
			// Storage is refused: the comments still work for this visit.
		}
	});

	// Tell the frame where every comment sits, whenever the comments or the text change.
	// Only once the annotator has said hello with this render's token, so nothing goes to another document.
	$effect(() => {
		const marks = placed.flatMap(({ note, span }) => (span ? [{ id: note.id, ...span }] : []));
		if (frameText !== null) frameEl?.contentWindow?.postMessage({ type: 'marks', marks }, '*');
	});

	function currentTheme(): 'light' | 'dark' | 'system' {
		const theme = document.documentElement.dataset.theme;
		return theme === 'light' || theme === 'dark' ? theme : 'system';
	}

	function onMessage(event: MessageEvent) {
		// Only the frame's own window, and only with this render's token: a document the frame
		// was navigated to shares the window but cannot know the token.
		if (stopped || !frameEl || event.source !== frameEl.contentWindow) return;
		const message = parseFromFrame(event.data, data.frame?.token ?? '');
		if (!message) return;
		if (message.type === 'text') {
			frameText = message.text;
			frameEl.contentWindow?.postMessage({ type: 'theme', theme: currentTheme() }, '*');
			return;
		}
		if (!composing) return;
		if (notes.length >= LIMIT) {
			limitNote = `A reply carries at most ${LIMIT} comments. Send these first, then comment on more.`;
			return;
		}
		limitNote = null;
		composer = { anchor: message.anchor, editing: null, text: '', error: null };
		sheetOpen = true;
	}

	function saveComposer() {
		if (!composer) return;
		if (composer.text.trim() === '') {
			composer = { ...composer, error: 'Write a comment first.' };
			return;
		}
		const checked = checkAnnotation({ anchor: composer.anchor, comment: composer.text });
		if (!checked.ok) {
			composer = { ...composer, error: checked.error };
			return;
		}
		if (composer.editing) {
			const id = composer.editing;
			notes = notes.map((n) => (n.id === id ? { ...n, comment: checked.value.comment } : n));
		} else {
			notes = [
				...notes,
				{ id: nextId(), anchor: checked.value.anchor, comment: checked.value.comment }
			];
		}
		composer = null;
	}

	function editNote(note: Note) {
		composer = { anchor: note.anchor, editing: note.id, text: note.comment, error: null };
		sheetOpen = true;
	}

	function removeNote(id: string) {
		notes = notes.filter((n) => n.id !== id);
		if (composer?.editing === id) composer = null;
	}

	function jump(id: string) {
		if (frameText !== null) frameEl?.contentWindow?.postMessage({ type: 'focus', id }, '*');
	}

	function excerpt(text: string, max = 240): string {
		const chars = [...text];
		return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
	}

	const payload = $derived(
		JSON.stringify(notes.map(({ anchor, comment }) => ({ anchor, comment })))
	);

	let confirmError = $state<string | null>(null);

	function startSend() {
		const checked = checkAnnotations(notes.map(({ anchor, comment }) => ({ anchor, comment })));
		if (!checked.ok) {
			confirmError = checked.error;
			return;
		}
		confirmError = null;
		confirming = true;
	}

	const enhanced: SubmitFunction = () => {
		sending = true;
		return async ({ result, update }) => {
			sending = false;
			if (result.type === 'success') {
				clearDraft();
				notes = [];
				overall = '';
				composer = null;
				confirming = false;
			}
			await update({ reset: false });
		};
	};

	const sent = $derived(form && 'sent' in form && form.action === 'send' ? form : null);
	const failure = $derived(form && 'error' in form && form.action === 'send' ? form.error : null);
	const count = $derived(notes.length);
</script>

<svelte:window onmessage={onMessage} />

<svelte:head>
	<title>{ask ? `${ask.title} · Quarterdeck` : 'Report · Quarterdeck'}</title>
</svelte:head>

{#if data.error}
	<section class="page">
		<p class="back"><a href={resolve('/triage')}>← Triage</a></p>
		<p class="error" role="alert">{data.error}</p>
	</section>
{:else if ask && data.frame}
	<section class="page">
		<header class="head">
			<p class="back"><a href={resolve('/triage')}>← Triage</a></p>
			<p class="kind">
				<Icon name="doc" size={15} />
				Report
				<span class="sep" aria-hidden="true">·</span>
				{KIND_LABELS[ask.kind]}
			</p>
			<h1>{ask.title}</h1>
			<p class="meta">
				<span class="ship"><Icon name="ship" size={14} /> {ask.from || 'Unknown ship'}</span>
				<span>{formatAge(ask.asked_ms, data.now)}</span>
				<span class="deadline">{formatDeadline(ask.deadline_ms, data.now)}</span>
			</p>
			{#if ask.body}<p class="context">{ask.body}</p>{/if}
		</header>

		{#if ask.answered}
			<p class="done" role="status">
				<Icon name="check" size={15} />
				Already answered{ask.answered.sent ? '' : ' (logged, not sent)'}:
				{ask.answered.text ?? ask.answered.label ?? 'closed'}
			</p>
		{/if}

		<div class="reader">
			<section class="document" aria-label="The report">
				<p class="hint">
					{#if composing}
						Select a passage to comment on it. On a phone, tap a paragraph.
					{:else}
						Read-only here: {ask.canComment
							? 'this report was already answered.'
							: 'comments are taken on requests and notices.'}
					{/if}
				</p>
				{#if stopped}
					<div class="stopped" role="alert">
						<Icon name="alert" size={24} />
						<h2>This report tried to leave the page and was stopped</h2>
						<p>
							Something in it tried to load another page in its place. Quarterdeck closed it and
							ignores anything it sends. Your comments are kept.
						</p>
						<button
							type="button"
							class="btn btn-primary"
							onclick={reloadReport}
							disabled={reloading}
						>
							<Icon name="refresh" size={16} />
							{reloading ? 'Loading…' : 'Load the report again'}
						</button>
					</div>
				{:else if mounted}
					<div class="frame-box" {@attach reportFrame(data.frame.srcdoc, ask.title)}></div>
				{:else}
					<div class="frame-box loading">Loading the report…</div>
				{/if}
			</section>

			{#if composing}
				<aside class="notes" class:open={sheetOpen} aria-label="Your comments">
					<button
						type="button"
						class="sheet-toggle"
						aria-expanded={sheetOpen}
						onclick={() => (sheetOpen = !sheetOpen)}
					>
						<Icon name="chevron" size={16} />
						Comments
						<span class="count" aria-label="{count} comments">{count}</span>
					</button>

					<div class="sheet-body">
						<h2 class="heading">Your comments <span class="count">{count}</span></h2>

						{#if limitNote}<p class="note-warn" role="status">{limitNote}</p>{/if}

						{#if composer}
							<form
								class="composer"
								onsubmit={(event) => {
									event.preventDefault();
									saveComposer();
								}}
							>
								<p class="label">{composer.editing ? 'Edit comment' : 'Comment on this'}</p>
								<blockquote class="quote">{excerpt(composer.anchor.quote, 400)}</blockquote>
								<label>
									<span class="visually-hidden">Your comment</span>
									<textarea
										bind:value={composer.text}
										rows="4"
										maxlength={REPORT_LIMITS.comment}
										placeholder="What should change, or what do you need to know?"></textarea>
								</label>
								{#if composer.error}<p class="error" role="alert">{composer.error}</p>{/if}
								<div class="row">
									<button type="button" class="btn btn-quiet" onclick={() => (composer = null)}
										>Cancel</button
									>
									<button type="submit" class="btn btn-primary">Save comment</button>
								</div>
							</form>
						{/if}

						<ol class="list">
							{#each placed as { note, span } (note.id)}
								<li class="note" class:lost={frameText !== null && span === null}>
									<blockquote class="quote">{excerpt(note.anchor.quote)}</blockquote>
									<p class="comment">{note.comment}</p>
									<div class="actions">
										{#if frameText !== null && span === null}
											<span class="flag">No longer in the report</span>
										{:else}
											<button type="button" class="btn btn-quiet" onclick={() => jump(note.id)}
												>Show in report</button
											>
										{/if}
										<button type="button" class="btn btn-quiet" onclick={() => editNote(note)}
											>Edit</button
										>
										<button
											type="button"
											class="btn btn-quiet danger"
											onclick={() => removeNote(note.id)}>Delete</button
										>
									</div>
								</li>
							{:else}
								<li class="empty">
									Nothing yet. Select a passage, or tap a paragraph, and say what should change.
								</li>
							{/each}
						</ol>
						{#if lost > 0}
							<p class="detail">
								{lost}
								{lost === 1 ? 'comment has' : 'comments have'} lost their text. They are kept, not sent
								in a different place.
							</p>
						{/if}

						{#if sent}
							<p class="done" role="status">
								<Icon name="check" size={15} />
								{sent.sent
									? `Sent ${sent.count} ${sent.count === 1 ? 'comment' : 'comments'} to ${ask.from}.`
									: 'Logged, not sent: this portal is reading fixtures, so nothing reached the ship.'}
							</p>
						{/if}

						{#if composing}
							{#if !confirming}
								<button
									type="button"
									class="btn btn-primary send"
									disabled={!sendable}
									onclick={startSend}
								>
									Send {count}
									{count === 1 ? 'comment' : 'comments'}
								</button>
								{#if confirmError}<p class="error" role="alert">{confirmError}</p>{/if}
							{:else}
								<form method="POST" action="?/send" use:enhance={enhanced} class="confirm">
									<input type="hidden" name="from" value={ask.from} />
									<input type="hidden" name="id" value={ask.id} />
									<input type="hidden" name="annotations" value={payload} />
									<label>
										<span class="label">Note to {ask.from || 'the ship'} (optional)</span>
										<textarea
											name="note"
											rows="2"
											maxlength={REPORT_LIMITS.note}
											bind:value={overall}
											placeholder="Anything that does not belong on a passage"></textarea>
									</label>
									<p class="detail">
										This sends {count}
										{count === 1 ? 'comment' : 'comments'} as one reply. It cannot be unsent.
									</p>
									{#if failure}<p class="error" role="alert">{failure}</p>{/if}
									<div class="row">
										<button type="button" class="btn btn-quiet" onclick={() => (confirming = false)}
											>Back</button
										>
										<button type="submit" class="btn btn-primary" disabled={sending}>
											{sending ? 'Sending…' : 'Send all'}
										</button>
									</div>
								</form>
							{/if}
						{/if}
					</div>
				</aside>
			{/if}
		</div>
	</section>
{/if}

<style>
	.page {
		max-width: 72rem;
		margin: 0 auto;
		padding: var(--s-4) var(--s-4) calc(var(--s-12) + 4rem);
		min-width: 0;
	}
	.back {
		margin: 0 0 var(--s-2);
		font-size: var(--text-sm);
	}
	.back a {
		color: var(--ink-3);
		text-decoration: none;
		display: inline-flex;
		align-items: center;
		min-height: var(--tap);
	}
	.back a:hover {
		color: var(--ink);
	}
	.head {
		margin-bottom: var(--s-4);
	}
	.kind {
		display: inline-flex;
		align-items: center;
		gap: var(--s-2);
		margin: 0;
		font-size: var(--text-xs);
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--sea);
	}
	.sep {
		color: var(--ink-3);
	}
	h1 {
		margin: var(--s-1) 0 var(--s-2);
		font-family: var(--font-display);
		font-size: var(--text-2xl);
		line-height: 1.15;
		overflow-wrap: anywhere;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-2) var(--s-4);
		margin: 0;
		font-size: var(--text-sm);
		color: var(--ink-3);
	}
	.meta .ship {
		display: inline-flex;
		align-items: center;
		gap: var(--s-1);
		color: var(--ink-2);
	}
	.context {
		margin: var(--s-3) 0 0;
		color: var(--ink-2);
	}
	.reader {
		display: grid;
		gap: var(--s-4);
		min-width: 0;
	}
	.document {
		min-width: 0;
	}
	.hint {
		margin: 0 0 var(--s-2);
		font-size: var(--text-sm);
		color: var(--ink-3);
	}
	.frame-box {
		height: 62svh;
		min-height: 22rem;
		overflow: hidden;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.frame-box :global(.frame) {
		display: block;
		width: 100%;
		height: 100%;
		border: 0;
	}
	.loading {
		display: grid;
		place-items: center;
		font-size: var(--text-sm);
		color: var(--ink-3);
	}
	.stopped {
		display: grid;
		justify-items: start;
		gap: var(--s-3);
		padding: var(--s-6);
		border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
		border-radius: var(--radius);
		background: var(--warn-soft);
		color: var(--ink-2);
	}
	.stopped > :global(.icon) {
		color: var(--warn);
	}
	.stopped h2 {
		margin: 0;
		font-family: var(--font-display);
		font-size: var(--text-lg);
		font-weight: 600;
		color: var(--ink);
	}
	.stopped p {
		margin: 0;
		max-width: 38rem;
	}

	.notes {
		position: fixed;
		inset: auto 0 0 0;
		z-index: 20;
		max-height: 70svh;
		display: flex;
		flex-direction: column;
		background: var(--surface);
		border-top: 1px solid var(--line-strong);
		border-radius: var(--radius-lg) var(--radius-lg) 0 0;
		box-shadow: 0 -8px 24px var(--shadow-color);
		transform: translateY(calc(100% - 3.5rem));
		transition: transform 0.2s var(--ease);
	}
	.notes.open {
		transform: none;
	}
	.sheet-toggle {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		min-height: 3.5rem;
		padding: 0 var(--s-4);
		border: 0;
		background: none;
		color: var(--ink);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}
	.sheet-toggle :global(svg) {
		transition: transform 0.2s var(--ease);
	}
	.notes.open .sheet-toggle :global(svg) {
		transform: rotate(180deg);
	}
	.sheet-body {
		overflow-y: auto;
		padding: 0 var(--s-4) var(--s-6);
	}
	.heading {
		display: none;
	}
	.count {
		display: inline-block;
		min-width: 1.5em;
		padding: 0 0.4em;
		border-radius: 999px;
		text-align: center;
		font-size: var(--text-xs);
		background: var(--sea-soft);
		color: var(--sea-strong);
	}

	.composer,
	.confirm {
		display: grid;
		gap: var(--s-2);
		margin: var(--s-2) 0 var(--s-4);
		padding: var(--s-3);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--surface-2);
	}
	.label {
		margin: 0;
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--ink-2);
	}
	.quote {
		margin: 0;
		padding: 0.1rem 0 0.1rem var(--s-3);
		border-left: 3px solid var(--brass-line);
		color: var(--ink-2);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}
	textarea {
		width: 100%;
		box-sizing: border-box;
		padding: var(--s-2) var(--s-3);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: var(--ink);
		font: inherit;
		resize: vertical;
	}
	textarea:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 1px;
	}
	.row,
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-2);
		justify-content: flex-end;
	}
	.actions {
		justify-content: flex-start;
	}
	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--s-3);
	}
	.note {
		padding: var(--s-3);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.note.lost {
		border-style: dashed;
	}
	.comment {
		margin: var(--s-2) 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.empty,
	.detail,
	.note-warn {
		font-size: var(--text-sm);
		color: var(--ink-3);
	}
	.note-warn {
		color: var(--warn);
	}
	.flag {
		font-size: var(--text-xs);
		font-weight: 600;
		color: var(--warn);
	}
	.danger {
		color: var(--danger);
	}
	.error {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--danger);
	}
	.done {
		display: inline-flex;
		align-items: center;
		gap: var(--s-2);
		margin: var(--s-3) 0;
		padding: var(--s-2) var(--s-3);
		border-radius: var(--radius-sm);
		background: var(--ok-soft);
		color: var(--ok);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}
	.send {
		width: 100%;
		margin-top: var(--s-3);
	}
	.confirm label {
		display: grid;
		gap: var(--s-1);
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}

	/* Wider screens: the notes become a column beside the report. */
	@media (min-width: 60rem) {
		.reader {
			grid-template-columns: minmax(0, 1fr) minmax(18rem, 22rem);
			align-items: start;
		}
		.frame-box {
			height: max(32rem, calc(100svh - 15rem));
		}
		.notes {
			position: sticky;
			top: var(--s-4);
			inset: auto;
			max-height: none;
			transform: none;
			border: 1px solid var(--line);
			border-radius: var(--radius-lg);
			box-shadow: var(--shadow);
		}
		.sheet-toggle {
			display: none;
		}
		.sheet-body {
			overflow: visible;
		}
		.heading {
			display: block;
			margin: var(--s-4) 0 var(--s-2);
			font-size: var(--text-md);
			font-weight: 600;
		}
		.page {
			padding: var(--s-6) var(--s-4) var(--s-12);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.notes,
		.sheet-toggle :global(svg) {
			transition: none;
		}
	}
</style>
