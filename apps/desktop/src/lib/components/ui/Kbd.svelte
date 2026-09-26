<script lang="ts">
	let { label }: { label: string } = $props();
</script>

<kbd
	class="inline-flex items-center rounded-sm border border-border-default bg-surface-raised px-1 type-micro font-mono text-text-disabled"
>
	{label}
</kbd>
