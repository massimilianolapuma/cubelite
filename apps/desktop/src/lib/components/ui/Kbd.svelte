<script lang="ts">
	let { label }: { label: string } = $props();
</script>

<kbd
	class="type-micro inline-flex shrink-0 items-center rounded-xs bg-surface-container-top px-1.5 py-px font-mono text-text-subtle"
>
	{label}
</kbd>
