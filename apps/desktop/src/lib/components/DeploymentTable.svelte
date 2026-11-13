<script lang="ts">
	import type { Snippet } from 'svelte';
	import RotateCw from '@lucide/svelte/icons/rotate-cw';
	import ReplicaStepper from '#lib/components/deployments/ReplicaStepper.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import ResourceList from '#lib/components/ui/ResourceList.svelte';
	import SortHeader from '#lib/components/ui/SortHeader.svelte';
	import StatusBadge from '#lib/components/ui/StatusBadge.svelte';
	import Sparkline from '#lib/components/metrics/Sparkline.svelte';
	import { formatAge } from '#lib/age.ts';
	import type { DeploymentInfo } from '#lib/tauri.ts';
	import { deploymentStatus, STATUS_CHIPS, toneGlyph } from '#lib/status.ts';
	import { matchesSelector } from '#lib/k8s-match.ts';
	import { sumPoints } from '#lib/metrics.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { layout } from '#lib/stores/layout.svelte.ts';
	import { mutations } from '#lib/stores/mutations.svelte.ts';
	import { prometheus } from '#lib/stores/prometheus.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';

	let {
		deployments,
		total,
		filter = '',
		selected = null,
		onRowClick,
		loaded = true,
		error = null,
		busy = false,
		onRetry,
		onClearFilter,
		tools
	}: {
		/** Deployments after the text filter. */
		deployments: DeploymentInfo[];
		/** Deployments before it. */
		total?: number;
		/** Filter text behind `deployments`; a non-empty one expands every namespace group. */
		filter?: string;
		selected?: DeploymentInfo | null;
		onRowClick?: (dep: DeploymentInfo) => void;
		loaded?: boolean;
		error?: string | null;
		busy?: boolean;
		onRetry?: () => void;
		onClearFilter?: () => void;
		tools?: Snippet;
	} = $props();

	// NAME / NAMESPACE / READY / STATUS / AGE / [CPU · 1h] / REPLICAS · ACTIONS
	const withCpu = $derived(prometheus.active !== null);
	// The last column holds the stepper, the replica segments and Restart.
	// Beside the docked panel the list keeps its identifying columns; scale and
	// restart are then in the panel (Tonal §3 #2 #11).
	const narrow = $derived(layout.docked && selected !== null);
	const tracks = $derived(
		narrow
			? ['2.2fr', '1fr', '0.6fr', '1.1fr', '0.55fr']
			: ['2.2fr', '1fr', '0.6fr', '1.1fr', '0.55fr', ...(withCpu ? ['0.6fr'] : []), 'minmax(17rem, 1.6fr)']
	);

	// Last hour of CPU from Prometheus, summed over each deployment's pods (#510).
	$effect(() => {
		void deployments;
		void prometheus.loadSparklines(app.namespace);
	});
	// Current pods only: a rollout within the hour shows the new pods' part.
	const cpuByDeployment = $derived.by(() => {
		const out: Record<string, ReturnType<typeof sumPoints>> = {};
		if (!withCpu || !prometheus.sparklines) return out;
		for (const dep of deployments) {
			const series = resources.pods
				.filter((p) => p.namespace === dep.namespace && matchesSelector(p.labels, dep.selector))
				.map((p) => prometheus.cpuFor(p.namespace, p.name))
				.filter((s) => s !== null);
			if (series.length > 0) out[`${dep.namespace}/${dep.name}`] = sumPoints(series);
		}
		return out;
	});

</script>

<ResourceList
	list="deployments"
	title="Deployments"
	nouns={['deployment', 'deployments']}
	rows={deployments}
	{total}
	{filter}
	{tracks}
	minWidth={narrow ? undefined : withCpu ? 980 : 900}
	namespaceColumn={!narrow || app.namespace === null}
	accessors={{
		name: (x) => x.name,
		namespace: (x) => x.namespace,
		created: (x) => x.creation_timestamp,
		status: (x) => deploymentStatus(x).tone
	}}
	chipDefs={STATUS_CHIPS.replicas}
	chipOf={(dep) => deploymentStatus(dep).tone}
	{loaded}
	{error}
	{busy}
	{onRetry}
	{onClearFilter}
	selected={(dep) => selected?.name === dep.name && selected?.namespace === dep.namespace}
	onSelect={(dep) => onRowClick?.(dep)}
	{tools}
>
	{#snippet head()}
		<span class="truncate">Ready</span>
		<SortHeader list="deployments" field="status" label="Status" />
		<SortHeader list="deployments" field="age" label="Age" />
		{#if !narrow}
			{#if withCpu}
				<span class="truncate" title="last hour, from Prometheus">CPU · 1h</span>
			{/if}
			<span class="truncate">Replicas · Actions</span>
		{/if}
	{/snippet}

	{#snippet nameSuffix(dep)}
		<!-- An override made from CubeLite shows wherever the workload does (#650 §3.3). -->
		{#if dep.resources_override}
			<StatusBadge state="warn" label="Override" />
		{/if}
	{/snippet}

	{#snippet cells(dep)}
		{@const status = deploymentStatus(dep)}
		{@const restarting = mutations.isRestarting(dep.namespace, dep.name)}
		<span class="type-data-sm text-text-muted">{dep.ready_replicas}/{dep.replicas}</span>
		<span class="flex min-w-0 items-center"><StatusBadge state={toneGlyph(status.tone)} label={status.label} /></span>
		<span class="type-data-sm text-text-muted">{formatAge(dep.creation_timestamp)}</span>
		{#if !narrow}
			{#if withCpu}
				<span class="flex items-center"><Sparkline points={cpuByDeployment[`${dep.namespace}/${dep.name}`] ?? null} label="CPU, last hour" /></span>
			{/if}
			<span class="flex min-w-0 items-center gap-2">
				<ReplicaStepper deployment={dep} />
				<Button
					variant="text"
					size="inline"
					pending={restarting}
					onclick={(e) => {
						e.stopPropagation();
						void mutations.restartDeployment(dep.namespace, dep.name);
					}}
				>
					{#snippet icon()}<RotateCw class="h-3 w-3" aria-hidden="true" />{/snippet}
					Restart
				</Button>
			</span>
		{/if}
	{/snippet}
</ResourceList>
