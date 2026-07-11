<script lang="ts">
	let { message }: { message: string } = $props();
</script>

<div class="flex flex-1 items-center justify-center">
	<p class="text-xs text-text-disabled">{message}</p>
</div>
