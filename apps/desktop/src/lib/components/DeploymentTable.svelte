<script lang="ts">
	import type { Snippet } from 'svelte';
	import Minus from '@lucide/svelte/icons/minus';
	import Plus from '@lucide/svelte/icons/plus';
	import RotateCw from '@lucide/svelte/icons/rotate-cw';
	import Button from '#lib/components/ui/Button.svelte';
	import ResourceList from '#lib/components/ui/ResourceList.svelte';
	import SortHeader from '#lib/components/ui/SortHeader.svelte';
	import StatusBadge from '#lib/components/ui/StatusBadge.svelte';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';
	import Sparkline from '#lib/components/metrics/Sparkline.svelte';
	import { formatAge } from '#lib/age.ts';
	import type { DeploymentInfo } from '#lib/tauri.ts';
	import { deploymentStatus, STATUS_CHIPS, toneGlyph } from '#lib/status.ts';
	import { matchesSelector } from '#lib/k8s-match.ts';
	import { sumPoints } from '#lib/metrics.ts';
	import { app } from '#lib/stores/app.svelte.ts';
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
	const tracks = $derived(['2.2fr', '1fr', '0.6fr', '1.1fr', '0.55fr', ...(withCpu ? ['0.6fr'] : []), 'minmax(17rem, 1.6fr)']);

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

	/** Replica segments shown next to the stepper (more render as "+N"). */
	const MAX_SEGMENTS = 8;

	function scale(dep: DeploymentInfo, delta: number) {
		mutations.nudgeScale(dep.namespace, dep.name, dep.replicas, delta);
	}

	const STEP =
		'focus-ring-inset hover-layer flex h-(--control-inline-h) w-(--control-inline-h) items-center justify-center text-text-muted disabled:opacity-45';
</script>

<ResourceList
	list="deployments"
	title="Deployments"
	nouns={['deployment', 'deployments']}
	rows={deployments}
	{total}
	{filter}
	{tracks}
	minWidth={withCpu ? 980 : 900}
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
		{#if withCpu}
			<span class="truncate" title="last hour, from Prometheus">CPU · 1h</span>
		{/if}
		<span class="truncate">Replicas · Actions</span>
	{/snippet}

	{#snippet cells(dep)}
		{@const status = deploymentStatus(dep)}
		{@const pendingScale = mutations.pendingScale(dep.namespace, dep.name)}
		{@const applying = mutations.isApplyingScale(dep.namespace, dep.name)}
		{@const target = pendingScale ?? dep.replicas}
		{@const restarting = mutations.isRestarting(dep.namespace, dep.name)}
		<span class="type-data-sm text-text-muted">{dep.ready_replicas}/{dep.replicas}</span>
		<span class="flex min-w-0 items-center"><StatusBadge state={toneGlyph(status.tone)} label={status.label} /></span>
		<span class="type-data-sm text-text-muted">{formatAge(dep.creation_timestamp)}</span>
		{#if withCpu}
			<span class="flex items-center"><Sparkline points={cpuByDeployment[`${dep.namespace}/${dep.name}`] ?? null} label="CPU, last hour" /></span>
		{/if}
		<span class="flex min-w-0 items-center gap-2">
			<span class="flex shrink-0 items-center overflow-hidden rounded-full border border-outline-strong">
				<button
					type="button"
					aria-label="Scale down"
					disabled={applying || target <= 0}
					class={STEP}
					onclick={(e) => {
						e.stopPropagation();
						scale(dep, -1);
					}}
				>
					<Minus class="h-3 w-3" aria-hidden="true" />
				</button>
				<!-- A replica count not applied yet is bold with a triangle, not coloured. -->
				<span
					class="type-data-sm flex min-w-7 items-center justify-center gap-1 px-1 {pendingScale !== null
						? 'font-semibold text-text'
						: 'text-text-muted'}"
					data-pending={pendingScale !== null}
				>
					{#if pendingScale !== null}<StatusGlyph state="warn" size={8} class="text-warning" />{/if}
					{target}
				</span>
				<button
					type="button"
					aria-label="Scale up"
					disabled={applying}
					class={STEP}
					onclick={(e) => {
						e.stopPropagation();
						scale(dep, 1);
					}}
				>
					<Plus class="h-3 w-3" aria-hidden="true" />
				</button>
			</span>
			<!-- One segment per target replica: filled = ready, outlined = not yet ready. -->
			<span
				class="flex shrink-0 items-center gap-0.5"
				aria-label="{dep.ready_replicas} of {target} replicas ready"
				role="img"
			>
				{#each Array.from({ length: Math.min(target, MAX_SEGMENTS) }, (_, i) => i) as i (i)}
					<span
						class="h-2.5 w-1.5 rounded-[1px] border {i < dep.ready_replicas
							? 'border-success bg-success'
							: pendingScale !== null
								? 'border-warning'
								: 'border-outline-strong'}"
					></span>
				{/each}
				{#if target > MAX_SEGMENTS}
					<span class="type-micro font-mono text-text-subtle">+{target - MAX_SEGMENTS}</span>
				{/if}
			</span>
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
	{/snippet}
</ResourceList>
