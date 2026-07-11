<script lang="ts">
	let { label }: { label: string } = $props();
</script>

<kbd
	class="inline-flex items-center rounded-sm border border-border-default bg-surface-raised px-1 font-mono text-[10px] font-medium text-text-disabled"
>
	{label}
</kbd>
