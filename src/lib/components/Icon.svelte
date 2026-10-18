<script lang="ts" module>
	/**
	 * Quarterdeck's icon set: line icons on a 24px grid with round caps,
	 * drawn to one stroke weight so they sit together. Decorative unless given
	 * a title.
	 */
	const paths = {
		ship: 'M3 17.5c1.5 1.3 3 1.3 4.5 0s3-1.3 4.5 0 3 1.3 4.5 0 3-1.3 4.5 0M5 15l-1-4h16l-1 4M12 3v8M12 4l5 5h-5',
		anchor:
			'M12 8.5V21M8.5 11.5h7M4 14a8 8 0 0 0 16 0M14 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM4 14l-1.5 1.5M20 14l1.5 1.5',
		feed: 'M20 13.5a2.5 2.5 0 0 1-2.5 2.5H9.2L4 20V6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5ZM8.5 8.5h7M8.5 12h4',
		inbox: 'M3.5 13H8l1.5 2.5h5L16 13h4.5M6 5h12l2.5 8v5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-5Z',
		chart: 'M4 20h16M7 16.5v-5M12 16.5V6M17 16.5V9',
		clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
		hand: 'M8 13V6.5a1.5 1.5 0 0 1 3 0V12m0-6.5V4.5a1.5 1.5 0 0 1 3 0V12m0-6a1.5 1.5 0 0 1 3 0v6m0-3.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.2a6 6 0 0 1-4.6-2.2L4.3 15.4a1.6 1.6 0 0 1 2.4-2.1L8 14.6',
		star: 'm12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z',
		check: 'm5 12.5 4.5 4.5L19 7.5',
		sun: 'M12 3v2M12 19v2M5.6 5.6 7 7M17 17l1.4 1.4M3 12h2M19 12h2M5.6 18.4 7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
		moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z',
		system: 'M4 5h16v11H4zM9 20h6M12 16v4',
		refresh: 'M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16m0 4v-4h-4',
		alert:
			'M12 9v4M12 17h.01M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
		lock: 'M7 11V8a5 5 0 0 1 10 0v3M6.5 11h11a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5v-7A1.5 1.5 0 0 1 6.5 11Z',
		coin: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM14.5 9.2c-.5-.8-1.4-1.2-2.5-1.2-1.5 0-2.5.8-2.5 2s1 1.6 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1.1 0-2-.4-2.5-1.2M12 6.5V8m0 8v1.5',
		link: 'M9 15 15 9M10.5 6.5l1.4-1.4a4 4 0 0 1 5.7 5.7l-1.4 1.4M13.5 17.5l-1.4 1.4a4 4 0 0 1-5.7-5.7l1.4-1.4',
		copy: 'M9 10.5A1.5 1.5 0 0 1 10.5 9h8a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 9 18.5ZM15 9V5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15H9',
		send: 'M20.5 3.5 10 14M20.5 3.5l-6.5 17-4-6.5-6.5-4Z',
		compass: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM15.5 8.5l-2 5-5 2 2-5 5-2Z',
		bell: 'M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16ZM10 20.5a2 2 0 0 0 4 0',
		chevron: 'm7 10 5 5 5-5',
		'chevron-right': 'm10 7 5 5-5 5',
		'arrow-left': 'M19 12H5M11 6l-6 6 6 6',
		'arrow-down': 'M12 5v14M6 13l6 6 6-6',
		doc: 'M7 3h7l5 5v13H7zM14 3v5h5M9.5 13h5M9.5 17h5',
		server:
			'M4.5 4h15a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM4.5 13h15a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1ZM7.5 7.5h.01M7.5 16.5h.01',
		crew: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M18.5 14.5a6.5 6.5 0 0 1 3 5.5',
		x: 'M6 6l12 12M18 6 6 18',
		eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
		'eye-off':
			'M3.5 3.5l17 17M10.6 5.6c.5-.1.9-.1 1.4-.1 6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.6 3.4M6.6 6.6C4 8.3 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3.1-.4 4.4-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2',
		'sign-out':
			'M9.5 20H5.5A1.5 1.5 0 0 1 4 18.5v-13A1.5 1.5 0 0 1 5.5 4h4M15.5 8l4 4-4 4M19.5 12H9.5'
	} as const;
	export type IconName = keyof typeof paths;
</script>

<script lang="ts">
	let {
		name,
		size = 18,
		title,
		stroke = 1.75
	}: { name: IconName; size?: number; title?: string; stroke?: number } = $props();
</script>

<svg
	class="icon"
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width={stroke}
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden={title ? undefined : 'true'}
	role={title ? 'img' : undefined}
>
	{#if title}<title>{title}</title>{/if}
	<path d={paths[name]} />
</svg>

<style>
	.icon {
		flex: none;
		display: block;
	}
</style>
