<script lang="ts">
	import type { ServiceRef } from '#lib/tauri.ts';

	// The in-cluster web UI picked from Detect (Kibana #505, Grafana #525):
	// opened through a port-forward unless a URL is configured.
	let {
		name,
		service,
		urlSet,
		testid,
		onClear
	}: {
		/** `Kibana`, `Grafana`. */
		name: string;
		service: ServiceRef;
		/** A configured URL wins over the service. */
		urlSet: boolean;
		testid: string;
		onClear: () => void;
	} = $props();
</script>

<div class="flex items-center gap-2" data-testid={testid}>
	<span class="type-caption flex-1 truncate text-text-tertiary">
		{name} in the cluster: {service.namespace}/{service.service}:{service.port}
		{urlSet ? '(the URL above wins)' : '— opened through a port-forward'}
	</span>
	<button
		type="button"
		class="focus-ring type-caption rounded-sm text-text-tertiary hover:text-text-secondary"
		aria-label="Clear the in-cluster {name}"
		onclick={onClear}>Clear</button
	>
</div>
