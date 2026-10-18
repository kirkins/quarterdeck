<!--
	Dismiss one ask without a reply.

	A quiet summary opens a confirm step with an optional note; only its submit
	sends anything, so a stray tap on a phone closes nothing. It is a native
	<details>, so it works without JavaScript; a failed dismiss reopens it so the
	error is on screen.
-->
<script lang="ts">
	import type { Failure } from '#lib/form.ts';
	import { dismissDetail } from '#lib/dismiss.ts';
	import Icon from './Icon.svelte';

	let {
		from,
		id,
		label,
		failure = null
	}: { from: string; id: string; label: string; failure?: Failure | null } = $props();

	const detail = $derived(dismissDetail(label));
</script>

<details class="dismiss" open={failure !== null}>
	<summary class="btn btn-quiet">{label}</summary>
	<form method="POST" action="?/dismiss" class="confirm">
		<input type="hidden" name="from" value={from} />
		<input type="hidden" name="id" value={id} />
		<label>
			<span class="label">Note (optional)</span>
			<textarea
				name="note"
				rows="2"
				maxlength="2000"
				placeholder="Why it can be closed, if it helps">{failure?.text ?? ''}</textarea
			>
		</label>
		<p class="detail">{detail}</p>
		{#if failure}<p class="error" role="alert">
				<Icon name="alert" size={16} />{failure.error}
			</p>{/if}
		<div class="actions">
			<button type="submit" class="btn btn-primary">{label}</button>
		</div>
	</form>
</details>

<style>
	.dismiss {
		display: grid;
		gap: var(--s-2);
		justify-items: start;
	}
	summary {
		list-style: none;
		cursor: pointer;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	.confirm {
		display: grid;
		gap: var(--s-2);
		width: 100%;
		padding: var(--s-3);
		border-radius: var(--radius);
		background: var(--surface-2);
		border: 1px solid var(--line);
	}
	.confirm label {
		display: grid;
		gap: var(--s-1);
	}
	.confirm textarea {
		width: 100%;
		padding: var(--s-2) var(--s-3);
		font: inherit;
		color: var(--ink);
		background: var(--surface);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-sm);
		resize: vertical;
	}
	.confirm textarea:focus-visible {
		outline: 2px solid var(--sea);
		outline-offset: 1px;
	}
	.label {
		font-size: var(--text-xs);
		font-weight: 650;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--ink-2);
	}
	.detail {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--ink-2);
	}
	.error {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		margin: 0;
		color: var(--danger);
		font-size: var(--text-sm);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
	}
</style>
