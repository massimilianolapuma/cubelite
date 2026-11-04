<script lang="ts">
	import { INPUT_CLASS } from '#lib/integration-form.svelte.ts';

	// Elasticsearch cluster filter of a context (#528): one `field: value`
	// term narrowing a deployment shared by many clusters.
	let {
		field = $bindable(),
		value = $bindable(),
		fieldHint
	}: {
		field: string;
		value: string;
		/** The field used when left blank. */
		fieldHint: string;
	} = $props();
</script>

<div class="grid grid-cols-[1fr_1fr] gap-2">
	<input class={INPUT_CLASS} aria-label="Cluster filter field" placeholder={fieldHint} bind:value={field} />
	<input
		class={INPUT_CLASS}
		aria-label="Cluster filter value"
		placeholder="cluster name (optional, shared deployments)"
		bind:value
	/>
</div>
