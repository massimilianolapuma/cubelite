<script lang="ts">
	import IdentityAvatar from '$lib/components/ui/IdentityAvatar.svelte';
	import MeterBar from '$lib/components/ui/MeterBar.svelte';
	import StatCard from '$lib/components/ui/StatCard.svelte';
	import StatusPill from '$lib/components/ui/StatusPill.svelte';
	import { app } from '$lib/stores/app.svelte';
	import { clusters } from '$lib/stores/clusters.svelte';
	import { health } from '$lib/stores/health.svelte';
	import { resources } from '$lib/stores/resources.svelte';
	import { formatAge } from '$lib/age';
	import { percentOf } from '$lib/units';
	import { buildSnapshot, dashboardTotals, type LiveCluster } from '$lib/all-clusters';

	/** Live store data for the active cluster (fresher than the 60s probe). */
	const live = $derived<LiveCluster>({
		state: clusters.connectionState,
		pods: resources.pods.length,
		warnings: resources.issuePods.length,
		nodes: resources.metricsAvailable ? resources.nodes.length : null,
		capacity: resources.capacityTotals
			? {
					cpu_used_millis: resources.capacityTotals.cpuUsed,
					cpu_allocatable_millis: resources.capacityTotals.cpuAllocatable,
					memory_used_bytes: resources.capacityTotals.memUsed,
					memory_allocatable_bytes: resources.capacityTotals.memAllocatable
				}
			: null
	});

	const snapshots = $derived(
		clusters.contexts.map((ctx) =>
			buildSnapshot(
				ctx.name,
				health.for(ctx.name),
				ctx.name === app.activeCluster ? live : null
			)
		)
	);
	const totals = $derived(dashboardTotals(snapshots));

	function clickCluster(name: string) {
		if (name === app.activeCluster) {
			app.navigate('overview');
			return;
		}
		void clusters.switchCluster(name);
	}

	function pillFor(state: string): { label: string; tone: 'ok' | 'err' | 'neutral' } {
		if (state === 'connected') return { label: 'Healthy', tone: 'ok' };
		if (state === 'unreachable') return { label: 'Unreachable', tone: 'err' };
		return { label: 'Unknown', tone: 'neutral' };
	}

	function show(value: number | string | null): string {
		return value === null ? '—' : String(value);
	}
</script>

<div class="flex flex-col gap-4 p-5">
	<div>
		<h1 class="type-title">All Clusters</h1>
		<p class="type-caption mt-0.5 text-text-tertiary">
			{totals.watched} context{totals.watched === 1 ? '' : 's'} · {totals.pods} pods
		</p>
	</div>

	<div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
		<StatCard
			label="Clusters online"
			value={totals.online}
			tone={totals.online < totals.watched ? 'warn' : 'ok'}
		/>
		<StatCard label="Total pods" value={totals.pods} />
		<StatCard label="Warnings" value={totals.warnings} tone={totals.warnings > 0 ? 'warn' : 'ok'} />
		<StatCard label="Contexts watched" value={totals.watched} />
	</div>

	<div class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax(330px, 1fr));">
		{#each clusters.contexts as ctx, i (ctx.name)}
			{@const snap = snapshots[i]}
			{@const pill = pillFor(snap.state)}
			<button
				type="button"
				class="focus-ring flex flex-col gap-3 rounded-xl border border-border-default bg-surface-surface p-4 text-left hover:border-border-strong"
				onclick={() => clickCluster(ctx.name)}
			>
				<div class="flex items-center gap-2.5">
					<IdentityAvatar
						name={ctx.name}
						color={clusters.identityFor(ctx.name)}
						active={ctx.name === app.activeCluster}
						size={30}
					/>
					<div class="min-w-0 flex-1">
						<div class="type-subtitle truncate">{ctx.name}</div>
						{#if ctx.cluster_server}
							<div class="truncate type-micro font-mono text-text-tertiary">
								{ctx.cluster_server}
							</div>
						{/if}
					</div>
					<StatusPill label={pill.label} tone={pill.tone} />
				</div>

				<div class="grid grid-cols-4 gap-2">
					{#each [['Nodes', show(snap.nodes)], ['Pods', show(snap.pods)], ['Version', show(snap.version)], ['Warnings', show(snap.warnings)]] as [label, value] (label)}
						<div>
							<div class="type-colhead mb-0.5">{label}</div>
							<div
								class="type-data {value === '—'
									? 'text-text-disabled'
									: label === 'Warnings' && value !== '0'
										? 'text-status-warn'
										: 'text-text-data-bright'}"
							>
								{value}
							</div>
						</div>
					{/each}
				</div>

				{#if snap.state === 'connected'}
					{#if snap.capacity}
						<div class="flex flex-col gap-1.5">
							<MeterBar
								label="CPU"
								percent={percentOf(snap.capacity.cpu_used_millis, snap.capacity.cpu_allocatable_millis)}
							/>
							<MeterBar
								label="MEM"
								percent={percentOf(
									snap.capacity.memory_used_bytes,
									snap.capacity.memory_allocatable_bytes
								)}
							/>
						</div>
					{:else}
						<p class="type-caption text-text-disabled">metrics unavailable</p>
					{/if}
				{/if}

				{#if snap.state === 'unreachable'}
					{@const h = health.for(ctx.name)}
					<p class="type-caption text-status-err">
						{h.lastSeen ? `Last seen ${formatAge(h.lastSeen)} ago — ` : ''}{(ctx.name ===
							app.activeCluster && clusters.unreachableReason) ||
							h.reason ||
							'connection failed'}
					</p>
				{/if}
			</button>
		{/each}
	</div>
</div>
