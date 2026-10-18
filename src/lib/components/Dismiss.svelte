<!--
	Dismiss one ask without a reply.

	A quiet summary opens a confirm step with an optional note; only its submit
	sends anything, so a stray tap on a phone closes nothing. It is a native
	<details>, so it works without JavaScript; a failed dismiss reopens it so the
	error is on screen.
-->
<script lang="ts">
	import { enhance } from '$app/forms';
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
	let pending = $state(false);
</script>

<details class="dismiss" open={failure !== null}>
	<summary class="btn btn-quiet btn-sm">{label}</summary>
	<form
		method="POST"
		action="?/dismiss"
		class="confirm"
		use:enhance={() => {
			pending = true;
			return async ({ update }) => {
				pending = false;
				await update();
			};
		}}
	>
		<input type="hidden" name="from" value={from} />
		<input type="hidden" name="id" value={id} />
		<label>
			<span class="field-label">Note (optional)</span>
			<textarea
				class="field"
				name="note"
				rows="2"
				maxlength="2000"
				placeholder="Why it can be closed, if it helps">{failure?.text ?? ''}</textarea
			>
		</label>
		<p class="detail">{detail}</p>
		{#if failure}<p class="callout callout-danger" role="alert">
				<Icon name="alert" size={16} />{failure.error}
			</p>{/if}
		<div class="actions">
			<button type="submit" class="btn btn-primary" disabled={pending}>{label}</button>
		</div>
	</form>
</details>

<style>
	.dismiss {
		display: grid;
		gap: var(--s-2);
		justify-items: start;
		width: 100%;
	}
	summary {
		list-style: none;
		margin-left: calc(-1 * var(--s-2));
		color: var(--ink-3);
	}
	summary::-webkit-details-marker {
		display: none;
	}
	.dismiss[open] summary {
		color: var(--ink);
	}
	.confirm {
		display: grid;
		gap: var(--s-3);
		width: 100%;
		padding: var(--s-4);
		border-radius: var(--radius);
		background: var(--surface-2);
		box-shadow: inset 0 0 0 1px var(--line);
		animation: rise var(--dur-3) var(--ease);
	}
	.confirm label {
		display: grid;
	}
	.detail {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--ink-2);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
	}
	@media (max-width: 36rem) {
		.actions .btn {
			flex: 1;
		}
	}
</style>
