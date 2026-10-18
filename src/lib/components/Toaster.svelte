<!--
	Where toasts appear: bottom centre on a phone, above the tab bar, and
	bottom right on a desktop. The region is polite and holds no role, so a
	toast never stands in for the status shown where the action was made.
-->
<script lang="ts">
	import { dropToast, toasts } from '#lib/toast.svelte.ts';
	import Icon from './Icon.svelte';
</script>

<div class="toaster" aria-live="polite" aria-relevant="additions">
	{#each toasts as t (t.id)}
		<div class="toast tone-{t.tone}">
			<span class="mark" aria-hidden="true">
				<Icon name={t.tone === 'ok' ? 'check' : t.tone === 'warn' ? 'alert' : 'send'} size={15} />
			</span>
			<span class="text">{t.text}</span>
			<button type="button" class="close" onclick={() => dropToast(t.id)}>
				<Icon name="x" size={14} />
				<span class="visually-hidden">Close</span>
			</button>
		</div>
	{/each}
</div>

<style>
	.toaster {
		position: fixed;
		z-index: 40;
		left: 50%;
		bottom: calc(var(--dock, 0px) + var(--s-4));
		transform: translateX(-50%);
		display: grid;
		gap: var(--s-2);
		justify-items: center;
		width: min(26rem, calc(100vw - 2 * var(--s-4)));
		pointer-events: none;
	}
	.toast {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		min-height: 3rem;
		padding: var(--s-2) var(--s-2) var(--s-2) var(--s-3);
		border-radius: var(--radius-lg);
		background: light-dark(#12284a, #e8edf3);
		color: light-dark(#f4f1ea, #0e1b2c);
		box-shadow: var(--elev-3);
		font-size: var(--text-sm);
		font-weight: 550;
		pointer-events: auto;
		animation: rise var(--dur-3) var(--ease);
	}
	.mark {
		display: grid;
		place-items: center;
		width: 1.625rem;
		height: 1.625rem;
		border-radius: 50%;
		background: light-dark(#6fd0c1, #17675e);
		color: light-dark(#04201c, #ffffff);
	}
	.tone-info .mark {
		background: light-dark(#e5c278, #835a0c);
		color: light-dark(#1d1505, #ffffff);
	}
	.tone-warn .mark {
		background: light-dark(#ff9ca1, #a3222d);
		color: light-dark(#351519, #ffffff);
	}
	.text {
		flex: 1;
		min-width: 0;
	}
	.close {
		display: grid;
		place-items: center;
		width: 2.25rem;
		height: 2.25rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: inherit;
		opacity: 0.7;
	}
	.close:hover {
		opacity: 1;
	}
	@media (min-width: 60rem) {
		.toaster {
			left: auto;
			right: var(--s-6);
			bottom: var(--s-6);
			transform: none;
			justify-items: end;
		}
	}
</style>
