<script lang="ts">
	import Button from '#lib/components/ui/Button.svelte';
	import IdentityAvatar from '#lib/components/ui/IdentityAvatar.svelte';
	import MeterBar from '#lib/components/ui/MeterBar.svelte';
	import StatCard from '#lib/components/ui/StatCard.svelte';
	import StatusBadge from '#lib/components/ui/StatusBadge.svelte';
	import StatusGlyph, { type GlyphState } from '#lib/components/ui/StatusGlyph.svelte';
	import { tintStyle } from '#lib/appearance.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { clusters } from '#lib/stores/clusters.svelte.ts';
	import { health } from '#lib/stores/health.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';
	import { formatAge } from '#lib/age.ts';
	import { percentOf } from '#lib/units.ts';
	import { buildSnapshot, dashboardTotals, type LiveCluster } from '#lib/all-clusters.ts';

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

	function badgeFor(state: string): { label: string; state: GlyphState } {
		if (state === 'connected') return { label: 'Healthy', state: 'ok' };
		if (state === 'unreachable') return { label: 'Unreachable', state: 'err' };
		return { label: 'Unknown', state: 'unknown' };
	}
</script>

<div class="flex flex-col gap-4 p-4">
	<div class="flex min-h-(--chip-h) flex-wrap items-baseline gap-3">
		<h1 class="type-display">All Clusters</h1>
		{#if clusters.contexts.length > 0}
			<p class="type-body-sm text-text-muted">
				{totals.watched} context{totals.watched === 1 ? '' : 's'} · {totals.pods} pods
			</p>
		{/if}
	</div>

	{#if clusters.contexts.length === 0}
		<!-- No context at all (Tonal §8.4): say where they come from and how to add one. -->
		<div class="flex flex-col items-center gap-3 px-4 py-16 text-center" data-testid="no-clusters">
			<h2 class="type-headline">No clusters yet</h2>
			<p class="type-body-sm max-w-md text-text-muted">
				CubeLite reads the contexts of your kubeconfig: the files in the KUBECONFIG variable, or
				~/.kube/config. Add a context there, or pick another file in Preferences.
			</p>
			<Button variant="tonal" onclick={() => app.openPreferences()}>Open Preferences</Button>
		</div>
	{:else}
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
				{@const badge = badgeFor(snap.state)}
				{@const identity = clusters.identityFor(ctx.name)}
				<!-- Each card carries its own cluster's tint (Tonal §4.1), whatever the window shows. -->
				<button
					type="button"
					class="focus-ring flex flex-col gap-3 rounded-lg bg-surface-container-high p-4 text-left hover:brightness-110"
					data-tint
					data-identity={identity}
					data-state={snap.state}
					style={tintStyle(identity)}
					onclick={() => clickCluster(ctx.name)}
				>
					<div class="flex items-center gap-3">
						<IdentityAvatar name={ctx.name} color={identity} active={ctx.name === app.activeCluster} size={32} />
						<div class="min-w-0 flex-1">
							<div class="type-title truncate" title={ctx.name}>{ctx.name}</div>
							{#if ctx.cluster_server}
								<div class="type-data-sm truncate text-text-muted" title={ctx.cluster_server}>
									{ctx.cluster_server}
								</div>
							{/if}
						</div>
						<StatusBadge state={badge.state} label={badge.label} />
					</div>

					<dl class="grid grid-cols-4 gap-2">
						{#each [['Nodes', snap.nodes], ['Pods', snap.pods], ['Version', snap.version], ['Warnings', snap.warnings]] as const as [label, value] (label)}
							{@const flagged = label === 'Warnings' && typeof value === 'number' && value > 0}
							<div class="min-w-0">
								<dt class="type-label mb-0.5 text-text-muted">{label}</dt>
								<!-- Warnings above zero: bold with the triangle, not a colour. -->
								<dd
									class="type-data flex items-center gap-1 truncate {value === null
										? 'text-text-subtle'
										: flagged
											? 'font-semibold text-text'
											: 'text-text'}"
									data-attention={flagged}
								>
									{#if flagged}<StatusGlyph state="warn" class="text-warning" />{/if}
									{value ?? '–'}
								</dd>
							</div>
						{/each}
					</dl>

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
							<p class="type-body-sm text-text-muted">metrics unavailable</p>
						{/if}
					{/if}

					{#if snap.state === 'unreachable'}
						{@const h = health.for(ctx.name)}
						<!-- The badge carries the failure; this line says since when and why. -->
						<p class="type-body-sm text-text-muted" data-testid="unreachable-detail">
							{h.lastSeen ? `Last seen ${formatAge(h.lastSeen)} ago · ` : ''}{(ctx.name ===
								app.activeCluster && clusters.unreachableReason) ||
								h.reason ||
								'connection failed'}
						</p>
					{/if}
				</button>
			{/each}
		</div>
	{/if}
</div>
