<!--
	The way in. One field, the passphrase, on a calm card over the chart grid.
	The error says only that the passphrase did not work, never why; a run of
	failures says how long to wait. See docs/DECISIONS.md, section 18.
-->
<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from '#lib/components/Icon.svelte';
	import Mark from '#lib/components/Mark.svelte';
	import ThemeToggle from '#lib/components/ThemeToggle.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let show = $state(false);
	let pending = $state(false);
	let field = $state<HTMLInputElement>();

	const limited = $derived(
		form?.error === 'limited' ? form.retryMinutes : form ? null : data.retryMinutes
	);
	const wrong = $derived(form?.error === 'wrong');

	function wait(minutes: number): string {
		if (minutes < 60) return minutes === 1 ? 'a minute' : `${minutes} minutes`;
		const hours = Math.ceil(minutes / 60);
		return hours === 1 ? 'an hour' : `${hours} hours`;
	}

	function duration(hours: number): string {
		return hours === 1 ? '1 hour' : `${Number(hours.toFixed(1))} hours`;
	}

	// The field is the only thing to do here: focus it on arrival and after a miss.
	$effect(() => {
		void form;
		field?.focus();
	});
</script>

<svelte:head>
	<title>Sign in · Quarterdeck</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="page">
	<div class="theme"><ThemeToggle initial={data.theme} /></div>

	<section class="card" aria-labelledby="login-title">
		<div class="brand">
			<Mark size={40} />
			<span class="wordmark">Quarterdeck</span>
		</div>

		<header>
			<p class="eyebrow">The captain's portal</p>
			<h1 id="login-title" class="display">Come aboard</h1>
			<p class="lede">Quarterdeck answers your fleet as you. Your passphrase keeps it that way.</p>
		</header>

		{#if limited !== null}
			<p class="callout callout-warn" role="alert">
				<Icon name="clock" size={16} />
				<span
					>Too many tries. Wait {wait(limited)}, then try again. The portal stays locked meanwhile,
					even with the right passphrase.</span
				>
			</p>
		{:else if wrong}
			<p class="callout callout-danger" role="alert">
				<Icon name="alert" size={16} />
				<span>That passphrase did not open the portal. Check it and try again.</span>
			</p>
		{:else if data.signedOut}
			<p class="callout callout-ok" role="status">
				<Icon name="check" size={16} />
				<span>Signed out. The session is closed on the server too.</span>
			</p>
		{/if}

		<form
			method="POST"
			use:enhance={() => {
				pending = true;
				return async ({ update }) => {
					await update({ reset: false });
					pending = false;
					show = false;
				};
			}}
		>
			{#if data.next}<input type="hidden" name="next" value={data.next} />{/if}
			<label class="field-label" for="passphrase">Passphrase</label>
			<div class="secret" class:invalid={wrong}>
				<input
					bind:this={field}
					id="passphrase"
					name="passphrase"
					class="field"
					type={show ? 'text' : 'password'}
					autocomplete="current-password"
					autocapitalize="off"
					spellcheck="false"
					required
					maxlength="1024"
					aria-invalid={wrong ? 'true' : undefined}
					aria-describedby="login-help"
				/>
				<button
					type="button"
					class="reveal"
					aria-label={show ? 'Hide passphrase' : 'Show passphrase'}
					aria-pressed={show}
					aria-controls="passphrase"
					onclick={() => (show = !show)}
				>
					<Icon name={show ? 'eye-off' : 'eye'} size={20} />
				</button>
			</div>

			<button class="btn btn-primary submit" type="submit" disabled={pending}>
				{#if pending}
					<span class="spinner" aria-hidden="true"></span> Checking…
				{:else}
					<Icon name="lock" size={16} /> Sign in
				{/if}
			</button>
		</form>

		<p id="login-help" class="help">
			A session lasts {duration(data.sessionHours)}, or until {data.idleMinutes >= 60
				? duration(data.idleMinutes / 60)
				: `${data.idleMinutes} minutes`} pass without a visit. Restarting the server signs you out.
		</p>
	</section>
</div>

<style>
	.page {
		position: relative;
		display: grid;
		place-items: center;
		min-height: 100dvh;
		padding: calc(env(safe-area-inset-top) + var(--s-16)) var(--s-4)
			calc(env(safe-area-inset-bottom) + var(--s-10));
	}
	.theme {
		position: absolute;
		top: calc(env(safe-area-inset-top) + var(--s-2));
		right: var(--s-3);
	}
	@media (min-width: 60rem) {
		.theme {
			top: var(--s-5);
			right: var(--s-5);
			width: 10rem;
		}
	}

	.card {
		width: 100%;
		max-width: 26rem;
		padding: var(--s-8) var(--s-6) var(--s-6);
		border-radius: var(--radius-xl);
		background: var(--surface-raised);
		box-shadow: var(--elev-2);
		/* A brass edge, as on what waits for the captain: here, the captain waits for the portal. */
		border-top: 3px solid var(--brass-fill);
		animation: rise var(--dur-3) var(--ease) both;
	}
	@media (min-width: 40rem) {
		.card {
			padding: var(--s-10) var(--s-8) var(--s-8);
		}
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.card {
			animation: none;
		}
	}

	.brand {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		margin-bottom: var(--s-8);
	}
	.wordmark {
		font-family: var(--font-display);
		font-style: italic;
		font-size: 1.5rem;
		font-weight: 560;
		letter-spacing: -0.01em;
		line-height: 1;
		color: var(--ink);
	}

	header {
		margin-bottom: var(--s-6);
	}
	.eyebrow {
		margin: 0 0 var(--s-2);
		color: var(--brass);
	}
	h1 {
		margin: 0;
		font-size: var(--text-3xl);
		line-height: 1.1;
		color: var(--ink);
	}
	.lede {
		margin: var(--s-3) 0 0;
		color: var(--ink-2);
		font-size: var(--text-base);
		line-height: 1.5;
	}

	.callout {
		margin: 0 0 var(--s-5);
		animation: rise var(--dur-2) var(--ease) both;
	}

	.secret {
		position: relative;
	}
	.secret .field {
		padding-right: calc(var(--tap) + var(--s-1));
		font-size: var(--text-md);
		letter-spacing: 0.02em;
	}
	.secret.invalid .field {
		box-shadow: inset 0 0 0 1.5px var(--danger);
	}
	.secret.invalid .field:focus {
		box-shadow:
			inset 0 0 0 1.5px var(--danger),
			0 0 0 4px color-mix(in srgb, var(--danger) 16%, transparent);
	}
	.reveal {
		position: absolute;
		top: 0;
		right: 0;
		display: grid;
		place-items: center;
		width: var(--tap);
		height: 100%;
		min-height: var(--tap);
		border: 0;
		border-radius: 0 var(--radius) var(--radius) 0;
		background: none;
		color: var(--ink-3);
		cursor: pointer;
		transition: color var(--dur-1) var(--ease);
	}
	.reveal:hover {
		color: var(--ink);
	}
	.reveal:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}

	.submit {
		width: 100%;
		margin-top: var(--s-5);
		min-height: 3rem;
		font-size: var(--text-base);
	}
	.spinner {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		border: 2px solid currentColor;
		border-right-color: transparent;
		animation: spin 0.7s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation-duration: 2s;
		}
	}

	.help {
		margin: var(--s-6) 0 0;
		padding-top: var(--s-4);
		border-top: 1px solid var(--line);
		color: var(--ink-3);
		font-size: var(--text-xs);
		line-height: 1.5;
	}
</style>
