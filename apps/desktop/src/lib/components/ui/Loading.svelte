<script lang="ts">
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';

	// Work in progress beside a heading: a turning circle whose words are read
	// out. With reduced motion the circle stands still (app.css), so the words
	// show beside it (Tonal §9.1).
	let { label }: { label: string } = $props();
</script>

<span class="inline-flex items-center gap-1.5 text-text-muted" data-loading>
	<LoaderCircle class="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
	<span class="type-body-sm sr-only motion-reduce:not-sr-only">{label}</span>
</span>
