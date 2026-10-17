<!-- Quarterdeck's mark: a four-point compass star on a navy tile. -->
<script lang="ts">
	let { size = 32 }: { size?: number } = $props();
</script>

<svg class="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
	<rect width="32" height="32" rx="8" class="tile" />
	<path d="M16 4.5 18.6 13.4 27.5 16 18.6 18.6 16 27.5 13.4 18.6 4.5 16 13.4 13.4Z" class="star" />
	<path
		d="M16 4.5 18.6 13.4 16 16Z M27.5 16 18.6 18.6 16 16Z M16 27.5 13.4 18.6 16 16Z M4.5 16 13.4 13.4 16 16Z"
		class="shade"
	/>
	<circle cx="16" cy="16" r="1.6" class="tile" />
</svg>

<style>
	.mark {
		flex: none;
		display: block;
	}
	.tile {
		fill: light-dark(#13294b, #e9eef5);
	}
	.star {
		fill: light-dark(#f2ead8, #13294b);
	}
	.shade {
		fill: light-dark(#c9a24e, #b48a32);
	}
</style>
