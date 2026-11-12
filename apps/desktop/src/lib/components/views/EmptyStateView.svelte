<script lang="ts">
	let { message }: { message: string } = $props();
</script>

<div class="flex flex-1 items-center justify-center p-6">
	<p class="type-body-sm text-text-muted">{message}</p>
</div>
