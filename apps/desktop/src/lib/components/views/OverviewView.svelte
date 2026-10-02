<script lang="ts">
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Box from '@lucide/svelte/icons/box';
	import FileText from '@lucide/svelte/icons/file-text';
	import FolderTree from '@lucide/svelte/icons/folder-tree';
	import Globe from '@lucide/svelte/icons/globe';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Layers from '@lucide/svelte/icons/layers';
	import Network from '@lucide/svelte/icons/network';
	import Package from '@lucide/svelte/icons/package';
	import Server from '@lucide/svelte/icons/server';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { onMount } from 'svelte';
	import { formatAge } from '#lib/age.ts';
	import MeterBar from '#lib/components/ui/MeterBar.svelte';
	import ResourceSummaryCard from '#lib/components/ui/ResourceSummaryCard.svelte';
	import StatCard from '#lib/components/ui/StatCard.svelte';
	import { coresDetail, memoryDetail, summarize } from '#lib/overview-summary.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources, type ExtraKind } from '#lib/stores/resources.svelte.ts';
	import { percentOf } from '#lib/units.ts';

	const WORKLOADS = 'var(--color-cluster-blue)';
	const NETWORK = 'var(--color-cluster-violet)';
	const CONFIG = 'var(--color-status-warn)';
	const NAMESPACES = 'var(--color-accent-alt-teal)';

	onMount(() => void resources.loadOverviewExtras());

	const warnings = $derived(resources.warningEvents);
	const capacity = $derived(resources.capacityTotals);

	/** The list when loaded for the current cluster + namespace, else null. */
	function loaded<T>(kind: ExtraKind, list: T[]): T[] | null {
		return resources.kindCount(kind) === null ? null : list;
	}

	const summary = $derived(
		summarize({
			pods: resources.pods,
			deployments: resources.deployments,
			namespaces: resources.namespaces,
			services: loaded('services', resources.services),
			secrets: loaded('secrets', resources.secrets),
			configmaps: loaded('configmaps', resources.configmaps),
			ingresses: loaded('ingresses', resources.ingresses),
			helm: loaded('helm', resources.helmReleases),
			nodes:
				resources.kindCount('nodes') ??
				(resources.metricsAvailable ? resources.nodes.length : null)
		})
	);
	const forbidden = (kind: ExtraKind): boolean => resources.forbiddenKinds.has(kind);
</script>

<div class="flex flex-col gap-4 p-4">
	<h1 class="type-title">Overview</h1>

	<div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
		<StatCard
			label="Nodes"
			value={summary.nodes ?? '—'}
			icon={Server}
			tint="var(--color-accent-alt-teal)"
		/>
		<StatCard
			label="Pods running"
			value="{summary.pods.running}/{summary.pods.total}"
			icon={Box}
			tint="var(--color-cluster-blue)"
		/>
		<StatCard
			label="Deploys healthy"
			value="{summary.deployments.healthy}/{summary.deployments.total}"
			icon={Layers}
			tint="var(--color-cluster-violet)"
		/>
		<StatCard
			label="Warnings"
			value={warnings.length}
			tone={warnings.length > 0 ? 'warn' : 'ok'}
			icon={TriangleAlert}
			tint={warnings.length > 0 ? 'var(--color-status-warn)' : 'var(--color-text-tertiary)'}
		/>
	</div>

	<div class="grid gap-3 xl:grid-cols-2">
		<div class="flex flex-col gap-2.5 rounded-xl border border-border-default bg-surface-surface p-4">
			<div class="type-colhead">Capacity</div>
			<MeterBar
				label="CPU"
				percent={capacity ? percentOf(capacity.cpuUsed, capacity.cpuAllocatable) : null}
				detail={capacity ? coresDetail(capacity.cpuUsed, capacity.cpuAllocatable) : null}
			/>
			<MeterBar
				label="MEM"
				percent={capacity ? percentOf(capacity.memUsed, capacity.memAllocatable) : null}
				detail={capacity ? memoryDetail(capacity.memUsed, capacity.memAllocatable) : null}
			/>
			{#if !capacity}
				<p class="type-caption text-text-disabled">
					metrics unavailable — metrics-server not detected in this cluster
				</p>
			{/if}
		</div>

		<div class="rounded-xl border border-border-default bg-surface-surface p-4">
			<div class="mb-2 flex items-center">
				<div class="type-colhead flex-1">Recent warnings</div>
				<button
					type="button"
					class="focus-ring type-caption flex items-center gap-1 rounded-sm text-text-tertiary hover:text-text-secondary"
					onclick={() => app.navigate('events')}
				>
					All events
					<ArrowRight class="h-3 w-3" />
				</button>
			</div>
			{#if warnings.length === 0}
				<p class="type-caption text-text-disabled">No warning events.</p>
			{:else}
				<div class="flex flex-col">
					{#each warnings.slice(0, 5) as event, i (i)}
						<button
							type="button"
							class="flex items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-surface-row-hover"
							onclick={() => app.navigate('events')}
						>
							<span
								class="h-1.5 w-1.5 shrink-0 rounded-full"
								style="background: var(--color-status-warn);"
							></span>
							<span class="type-data-sm w-40 shrink-0 truncate text-text-secondary">{event.object}</span>
							<span class="type-caption flex-1 truncate text-text-tertiary">
								{event.message ?? event.reason ?? '—'}
							</span>
							<span class="type-caption text-text-tertiary">{formatAge(event.last_timestamp)}</span>
						</button>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	<div class="grid gap-3 xl:grid-cols-2" data-testid="resource-grid">
		<ResourceSummaryCard
			title="Pods"
			icon={Box}
			tint={WORKLOADS}
			rows={[
				{ label: 'Total', value: summary.pods.total },
				{ label: 'Running', value: summary.pods.running, tone: 'ok' },
				{ label: 'Pending', value: summary.pods.pending, tone: 'warn' },
				{ label: 'Failed', value: summary.pods.failed, tone: 'err' }
			]}
		/>
		<ResourceSummaryCard
			title="Deployments"
			icon={Layers}
			tint={WORKLOADS}
			rows={[
				{ label: 'Total', value: summary.deployments.total },
				{ label: 'Healthy', value: summary.deployments.healthy, tone: 'ok' },
				{ label: 'Degraded', value: summary.deployments.degraded, tone: 'warn' }
			]}
		/>
		<ResourceSummaryCard
			title="Services"
			icon={Network}
			tint={NETWORK}
			forbidden={forbidden('services')}
			rows={[
				{ label: 'Total', value: summary.services?.total ?? null },
				{ label: 'ClusterIP', value: summary.services?.clusterIP ?? null },
				{ label: 'NodePort', value: summary.services?.nodePort ?? null, tone: 'warn' },
				{ label: 'LoadBalancer', value: summary.services?.loadBalancer ?? null, tone: 'accent' }
			]}
		/>
		<ResourceSummaryCard
			title="Namespaces"
			icon={FolderTree}
			tint={NAMESPACES}
			rows={[
				{ label: 'Total', value: summary.namespaces.total },
				{ label: 'Active', value: summary.namespaces.active, tone: 'ok' }
			]}
		/>
		<ResourceSummaryCard
			title="Secrets"
			icon={KeyRound}
			tint={CONFIG}
			forbidden={forbidden('secrets')}
			rows={[
				{ label: 'Total', value: summary.secrets?.total ?? null },
				{ label: 'Opaque', value: summary.secrets?.opaque ?? null },
				{ label: 'TLS', value: summary.secrets?.tls ?? null, tone: 'accent' },
				{ label: 'Docker', value: summary.secrets?.docker ?? null, tone: 'warn' }
			]}
		/>
		<ResourceSummaryCard
			title="ConfigMaps"
			icon={FileText}
			tint={CONFIG}
			forbidden={forbidden('configmaps')}
			rows={[{ label: 'Total', value: summary.configmaps?.total ?? null }]}
		/>
		<ResourceSummaryCard
			title="Ingresses"
			icon={Globe}
			tint={NETWORK}
			forbidden={forbidden('ingresses')}
			rows={[
				{ label: 'Total', value: summary.ingresses?.total ?? null },
				{ label: 'with TLS', value: summary.ingresses?.tls ?? null, tone: 'accent' }
			]}
		/>
		<ResourceSummaryCard
			title="Helm Releases"
			icon={Package}
			tint={WORKLOADS}
			forbidden={forbidden('helm')}
			rows={[
				{ label: 'Total', value: summary.helm?.total ?? null },
				{ label: 'deployed', value: summary.helm?.deployed ?? null, tone: 'ok' },
				{ label: 'failed', value: summary.helm?.failed ?? null, tone: 'err' }
			]}
		/>
	</div>
</div>
