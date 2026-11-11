<script lang="ts">
	import type { Snippet } from 'svelte';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import ResourceList from '#lib/components/ui/ResourceList.svelte';
	import SortHeader from '#lib/components/ui/SortHeader.svelte';
	import StatusBadge from '#lib/components/ui/StatusBadge.svelte';
	import Sparkline from '#lib/components/metrics/Sparkline.svelte';
	import { formatAge } from '#lib/age.ts';
	import type { PodInfo } from '#lib/tauri.ts';
	import { podChip, podGlyph, podStatusLabel, podTone, STATUS_CHIPS } from '#lib/status.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { mutations } from '#lib/stores/mutations.svelte.ts';
	import { prometheus } from '#lib/stores/prometheus.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';
	import { formatBytes, formatCpu } from '#lib/units.ts';

	let {
		pods,
		total,
		filter = '',
		selected = null,
		onRowClick,
		onLogs,
		loaded = true,
		error = null,
		busy = false,
		onRetry,
		onClearFilter,
		tools
	}: {
		/** Pods after the text filter. */
		pods: PodInfo[];
		/** Pods before it. */
		total?: number;
		/** Filter text behind `pods`; a non-empty one expands every namespace group. */
		filter?: string;
		selected?: PodInfo | null;
		onRowClick?: (pod: PodInfo) => void;
		/** Enter on the selected row. */
		onLogs?: (pod: PodInfo) => void;
		loaded?: boolean;
		error?: string | null;
		busy?: boolean;
		onRetry?: () => void;
		onClearFilter?: () => void;
		tools?: Snippet;
	} = $props();

	// NAME / NAMESPACE / STATUS / READY / AGE / CPU / MEMORY / RESTARTS
	const TRACKS = ['2.4fr', '1fr', '1.5fr', '0.6fr', '0.6fr', '0.8fr', '0.8fr', '0.6fr'];

	// Last hour of CPU and memory from Prometheus, after the rows (#510).
	$effect(() => {
		void pods;
		void prometheus.loadSparklines(app.namespace);
	});
	const sparkTitle = $derived(
		prometheus.sparklineError ? `sparklines unavailable: ${prometheus.sparklineError}` : 'sparkline: last hour, from Prometheus'
	);
	const noMetrics = $derived(loaded && resources.metricsKnown && !resources.metricsAvailable);
</script>

<ResourceList
	list="pods"
	title="Pods"
	nouns={['pod', 'pods']}
	rows={pods}
	{total}
	{filter}
	tracks={TRACKS}
	accessors={{
		name: (x) => x.name,
		namespace: (x) => x.namespace,
		created: (x) => x.creation_timestamp,
		status: (x) => podTone(x),
		restarts: (x) => x.restarts
	}}
	chipDefs={STATUS_CHIPS.pods}
	chipOf={podChip}
	{loaded}
	{error}
	{busy}
	{onRetry}
	{onClearFilter}
	selected={(pod) => selected?.name === pod.name && selected?.namespace === pod.namespace}
	onSelect={(pod) => onRowClick?.(pod)}
	onEnterSelected={(pod) => onLogs?.(pod)}
	{tools}
>
	{#snippet notice()}
		{#if noMetrics}
			<p class="type-body-sm text-text-muted" data-testid="metrics-notice">
				CPU and memory are unavailable: this cluster has no metrics-server.
			</p>
		{/if}
	{/snippet}

	{#snippet head()}
		<SortHeader list="pods" field="status" label="Status" />
		<span class="truncate">Ready</span>
		<SortHeader list="pods" field="age" label="Age" />
		<span class="truncate" title={prometheus.active ? sparkTitle : undefined}>CPU</span>
		<span class="truncate" title={prometheus.active ? sparkTitle : undefined}>Memory</span>
		<SortHeader list="pods" field="restarts" label="Restarts" align="end" />
	{/snippet}

	{#snippet cells(pod)}
		{@const usage = resources.metricsFor(pod.namespace, pod.name)}
		<span class="flex min-w-0 items-center gap-1.5">
			{#if mutations.isDeleting(pod.namespace, pod.name)}
				<LoaderCircle size={10} class="shrink-0 animate-spin text-text-subtle" aria-hidden="true" />
				<span class="type-body-sm truncate text-text-subtle">Terminating…</span>
			{:else}
				<StatusBadge state={podGlyph(pod)} label={podStatusLabel(pod)} />
			{/if}
		</span>
		<span class="type-data-sm text-text-muted">{pod.ready_containers}/{pod.total_containers}</span>
		<span class="type-data-sm text-text-muted">{formatAge(pod.creation_timestamp)}</span>
		<span class="flex min-w-0 items-center gap-1.5">
			<span class="type-data-sm {usage ? 'text-text-muted' : 'text-text-subtle'}">
				{usage ? formatCpu(usage.cpu_millis) : '–'}
			</span>
			{#if prometheus.active}
				<Sparkline points={prometheus.cpuFor(pod.namespace, pod.name)} label="CPU, last hour" />
			{/if}
		</span>
		<span class="flex min-w-0 items-center gap-1.5">
			<span class="type-data-sm {usage ? 'text-text-muted' : 'text-text-subtle'}">
				{usage ? formatBytes(usage.memory_bytes) : '–'}
			</span>
			{#if prometheus.active}
				<Sparkline points={prometheus.memoryFor(pod.namespace, pod.name)} label="Memory, last hour" />
			{/if}
		</span>
		<!-- A restart count that needs attention is bold, not coloured (Tonal §7). -->
		<span
			class="type-data-sm text-right {pod.restarts > 3 ? 'font-semibold text-text' : 'text-text-muted'}"
			data-attention={pod.restarts > 3}
		>
			{pod.restarts}
		</span>
	{/snippet}
</ResourceList>
