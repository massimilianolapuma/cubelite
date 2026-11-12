<script lang="ts">
	import { EMPTY } from '#lib/empty.ts';
	import PinToggle from '#lib/components/ui/PinToggle.svelte';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';
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
	import AlertsCard from '#lib/components/metrics/AlertsCard.svelte';
	import ClusterHistory from '#lib/components/metrics/ClusterHistory.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import MeterBar from '#lib/components/ui/MeterBar.svelte';
	import ResourceSummaryCard from '#lib/components/ui/ResourceSummaryCard.svelte';
	import StatCard from '#lib/components/ui/StatCard.svelte';
	import { firingBadge } from '#lib/host-metrics.ts';
	import { coresDetail, memoryDetail, summarize } from '#lib/overview-summary.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { promOverview } from '#lib/stores/promOverview.svelte.ts';
	import { resources, type ExtraKind } from '#lib/stores/resources.svelte.ts';
	import { percentOf } from '#lib/units.ts';

	onMount(() => void resources.loadOverviewExtras());

	// Cluster history and alerts from Prometheus (#530), on the Overview's
	// refresh cadence (at most every 30 s, see the store).
	$effect(() => {
		void resources.pods;
		void promOverview.load();
	});
	// Informational alerts (Watchdog) neither count nor colour the badge.
	const firing = $derived(firingBadge(promOverview.alerts));
	const firingLabel = $derived(`${firing.count} ${firing.count === 1 ? 'alert' : 'alerts'} firing`);

	/** The badge opens the Alerts card further down (#566). */
	function showAlerts() {
		const card = document.getElementById('overview-alerts');
		card?.scrollIntoView({ block: 'start' });
		card?.focus({ preventScroll: true });
	}

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
	<div class="flex min-h-(--chip-h) flex-wrap items-center gap-3">
		<h1 class="type-display">Overview</h1>
		<div class="min-w-0 flex-1"></div>
		{#if firing.count > 0}
			<!-- Alerts firing: the pill takes the worst severity's container and shape. -->
			<button
				type="button"
				class="focus-ring forced-edge type-body flex h-(--chip-h) shrink-0 items-center gap-2 rounded-full px-4 font-semibold hover:brightness-110 {firing.tone ===
				'err'
					? 'bg-error-container text-on-error-container'
					: 'bg-warning-container text-on-warning-container'}"
				data-testid="overview-alerts-badge"
				data-tone={firing.tone}
				title="Prometheus alerts firing now: {firing.severities}. Show the list."
				aria-label="{firingLabel}: {firing.severities}. Show the alerts."
				onclick={showAlerts}
			>
				<StatusGlyph state={firing.tone === 'err' ? 'err' : 'warn'} />
				{firingLabel}
			</button>
		{/if}
		<PinToggle />
	</div>

	<div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
		<StatCard
			label="Nodes"
			value={summary.nodes ?? EMPTY}
			icon={Server}
			target="Nodes"
			onclick={() => app.navigate('nodes')}
		/>
		<StatCard
			label="Pods running"
			value="{summary.pods.running}/{summary.pods.total}"
			icon={Box}
			target="Pods"
			onclick={() => app.navigate('pods')}
		/>
		<StatCard
			label="Deploys healthy"
			value="{summary.deployments.healthy}/{summary.deployments.total}"
			icon={Layers}
			target="Deployments"
			onclick={() => app.navigate('deployments')}
		/>
		<StatCard
			label="Warnings"
			value={warnings.length}
			tone={warnings.length > 0 ? 'warn' : 'ok'}
			icon={TriangleAlert}
			target="Events"
			onclick={() => app.navigate('events')}
		/>
	</div>

	<!-- An explicit single column below xl: an implicit one would grow to its widest line. -->
	<div class="grid grid-cols-1 gap-3 xl:grid-cols-2">
		<div class="card flex flex-col gap-2.5 rounded-lg bg-surface-container-high p-4">
			<div class="type-label text-text-muted">Capacity</div>
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
				<p class="type-body-sm text-text-muted">
					Metrics unavailable: metrics-server not detected in this cluster.
				</p>
			{/if}
			<ClusterHistory />
		</div>

		<div class="card rounded-lg bg-surface-container-high p-4">
			<div class="mb-2 flex items-center">
				<div class="type-label flex-1 text-text-muted">Recent warnings</div>
				<Button variant="text" size="inline" onclick={() => app.navigate('events')}>
					All events
					<ArrowRight class="h-3.5 w-3.5" aria-hidden="true" />
				</Button>
			</div>
			{#if warnings.length === 0}
				<p class="type-body-sm text-text-muted">No warning events.</p>
			{:else}
				<div class="flex flex-col gap-0.5">
					{#each warnings.slice(0, 5) as event, i (i)}
						<button
							type="button"
							class="focus-ring-inset flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-container-top"
							onclick={() => app.navigate('events')}
						>
							<StatusGlyph state="warn" class="text-warning" />
							<span class="type-data-sm w-40 shrink-0 truncate text-text" title={event.object || undefined}>{event.object || EMPTY}</span>
							<span class="type-body-sm min-w-0 flex-1 truncate text-text-muted">
								{event.message ?? event.reason ?? EMPTY}
							</span>
							<span class="type-body-sm shrink-0 text-text-muted">{formatAge(event.last_timestamp)}</span>
						</button>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	<AlertsCard />

	<div class="grid grid-cols-1 gap-3 xl:grid-cols-2" data-testid="resource-grid">
		<ResourceSummaryCard
			title="Pods"
			icon={Box}
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
			rows={[
				{ label: 'Total', value: summary.deployments.total },
				{ label: 'Healthy', value: summary.deployments.healthy, tone: 'ok' },
				{ label: 'Degraded', value: summary.deployments.degraded, tone: 'warn' }
			]}
		/>
		<ResourceSummaryCard
			title="Services"
			icon={Network}
			forbidden={forbidden('services')}
			rows={[
				{ label: 'Total', value: summary.services?.total ?? null },
				{ label: 'ClusterIP', value: summary.services?.clusterIP ?? null },
				{ label: 'NodePort', value: summary.services?.nodePort ?? null, tone: 'warn' },
				{ label: 'LoadBalancer', value: summary.services?.loadBalancer ?? null }
			]}
		/>
		<ResourceSummaryCard
			title="Namespaces"
			icon={FolderTree}
			rows={[
				{ label: 'Total', value: summary.namespaces.total },
				{ label: 'Active', value: summary.namespaces.active, tone: 'ok' }
			]}
		/>
		<ResourceSummaryCard
			title="Secrets"
			icon={KeyRound}
			forbidden={forbidden('secrets')}
			rows={[
				{ label: 'Total', value: summary.secrets?.total ?? null },
				{ label: 'Opaque', value: summary.secrets?.opaque ?? null },
				{ label: 'TLS', value: summary.secrets?.tls ?? null },
				{ label: 'Docker', value: summary.secrets?.docker ?? null, tone: 'warn' }
			]}
		/>
		<ResourceSummaryCard
			title="ConfigMaps"
			icon={FileText}
			forbidden={forbidden('configmaps')}
			rows={[{ label: 'Total', value: summary.configmaps?.total ?? null }]}
		/>
		<ResourceSummaryCard
			title="Ingresses"
			icon={Globe}
			forbidden={forbidden('ingresses')}
			rows={[
				{ label: 'Total', value: summary.ingresses?.total ?? null },
				{ label: 'with TLS', value: summary.ingresses?.tls ?? null }
			]}
		/>
		<ResourceSummaryCard
			title="Helm Releases"
			icon={Package}
			forbidden={forbidden('helm')}
			rows={[
				{ label: 'Total', value: summary.helm?.total ?? null },
				{ label: 'deployed', value: summary.helm?.deployed ?? null, tone: 'ok' },
				{ label: 'failed', value: summary.helm?.failed ?? null, tone: 'err' }
			]}
		/>
	</div>
</div>
