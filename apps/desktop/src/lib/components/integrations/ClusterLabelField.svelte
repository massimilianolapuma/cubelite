<script lang="ts">
	import { INPUT_CLASS } from '#lib/integration-form.svelte.ts';

	// Prometheus `cluster` label of a context (#528): typed, or picked from
	// the values Test connection found in a shared workspace.
	let {
		value = $bindable(),
		found,
		placeholder
	}: {
		value: string;
		/** `cluster` values found by Test connection; null before a test. */
		found: string[] | null;
		placeholder: string;
	} = $props();
</script>

<input class={INPUT_CLASS} aria-label="Cluster label" {placeholder} bind:value />
{#if found && found.length > 0}
	<div class="grid grid-cols-[auto_1fr] items-center gap-2">
		<span class="type-label text-text-muted">Clusters found</span>
		<select class={INPUT_CLASS} aria-label="Clusters found" bind:value>
			<option value="">none (every cluster)</option>
			{#each found as cluster (cluster)}
				<option value={cluster}>{cluster}</option>
			{/each}
		</select>
	</div>
{/if}
