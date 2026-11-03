<script lang="ts">
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import { UI_LINK_CLASS } from '#lib/integration.ts';
	import {
		canOpenGrafana,
		canOpenKibana,
		openGrafanaFor,
		openKibanaFor,
		toastErrors,
		type LinkedWorkload
	} from '#lib/integration-links.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { elastic } from '#lib/stores/elastic.svelte.ts';
	import { prometheus } from '#lib/stores/prometheus.svelte.ts';

	// "Logs in Kibana" and "Metrics in Grafana" in a pod or deployment drawer
	// (#526), only when the context's endpoint can open that UI.
	let { namespace, workload }: { namespace: string; workload: LinkedWorkload } = $props();

	const es = $derived(elastic.endpointFor(app.activeCluster));
	const prom = $derived(prometheus.active);
</script>

{#if canOpenKibana(es) || canOpenGrafana(prom)}
	<div class="flex items-center gap-3" data-testid="workload-links">
		{#if canOpenKibana(es)}
			<button
				type="button"
				class={UI_LINK_CLASS}
				onclick={() => void toastErrors(() => openKibanaFor(es, namespace, workload))}
			>
				<ExternalLink class="h-3 w-3" /> Logs in Kibana
			</button>
		{/if}
		{#if canOpenGrafana(prom)}
			<button
				type="button"
				class={UI_LINK_CLASS}
				onclick={() => void toastErrors(() => openGrafanaFor(prom, namespace, workload))}
			>
				<ExternalLink class="h-3 w-3" /> Metrics in Grafana
			</button>
		{/if}
	</div>
{/if}
