<script lang="ts" module>
	/** Small stroke icons, 24px grid. Decorative unless given a title. */
	const paths = {
		ship: 'M3 17.5c1.5 1.3 3 1.3 4.5 0s3-1.3 4.5 0 3 1.3 4.5 0 3-1.3 4.5 0M5 15l-1-4h16l-1 4M12 3v8M12 4l5 5h-5',
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
		lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
		coin: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM14.5 9.2c-.5-.8-1.4-1.2-2.5-1.2-1.5 0-2.5.8-2.5 2s1 1.6 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1.1 0-2-.4-2.5-1.2M12 6.5V8m0 8v1.5',
		link: 'M9 15 15 9M10.5 6.5l1.4-1.4a4 4 0 0 1 5.7 5.7l-1.4 1.4M13.5 17.5l-1.4 1.4a4 4 0 0 1-5.7-5.7l1.4-1.4',
		compass: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM15.5 8.5l-2 5-5 2 2-5 5-2Z',
		bell: 'M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16ZM10 20.5a2 2 0 0 0 4 0'
	} as const;
	export type IconName = keyof typeof paths;
</script>

<script lang="ts">
	let { name, size = 18, title }: { name: IconName; size?: number; title?: string } = $props();
</script>

<svg
	class="icon"
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.8"
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
