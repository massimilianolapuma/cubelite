<script lang="ts">
	import { EMPTY } from '#lib/empty.ts';
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

	// Online is a warning only when a cluster is known to be down: one that has
	// not been probed yet is unknown, not offline.
	const anyUnreachable = $derived(snapshots.some((s) => s.state === 'unreachable'));

	/** What a screen reader hears for a card: the cluster, its health, what needs attention. */
	function cardName(name: string, health: string, attention: number | null): string {
		const parts = [name, health];
		if (attention) parts.push(`${attention} ${attention === 1 ? 'pod needs' : 'pods need'} attention`);
		return parts.join(', ');
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

	{#if !clusters.loaded}
		<!-- The kubeconfig has not been read yet: not "no clusters". -->
		<div class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(330px,1fr))]" role="status" aria-label="Loading clusters" aria-busy="true">
			{#each [0, 1] as i (i)}
				<div class="h-40 rounded-lg bg-surface-container-high motion-safe:animate-pulse"></div>
			{/each}
		</div>
	{:else if clusters.contexts.length === 0 && clusters.error}
		<div class="card flex flex-col items-start gap-3 rounded-lg bg-error-container p-4 text-on-error-container" role="alert">
			<h2 class="type-title flex items-center gap-2">
				<StatusGlyph state="err" />
				Could not read the kubeconfig
			</h2>
			<p class="type-data max-w-full [overflow-wrap:anywhere]">{clusters.error}</p>
			<Button variant="tonal" onclick={() => app.openPreferences('kubeconfig')}>Open Preferences</Button>
		</div>
	{:else if clusters.contexts.length === 0}
		<!-- No context at all (Tonal §8.4): say where they come from and how to add one. -->
		<div class="flex flex-col items-center gap-3 px-4 py-16 text-center" data-testid="no-clusters">
			<h2 class="type-headline">No clusters yet</h2>
			<p class="type-body-sm max-w-md text-text-muted">
				CubeLite reads the contexts of your kubeconfig: the files in the KUBECONFIG variable, or
				~/.kube/config. Add a context there, or pick another file in Preferences.
			</p>
			<Button variant="tonal" onclick={() => app.openPreferences('kubeconfig')}>Open Preferences</Button>
		</div>
	{:else}
		<div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
			<StatCard
				label="Clusters online"
				value={totals.online}
				tone={anyUnreachable ? 'warn' : 'ok'}
			/>
			<StatCard label="Total pods" value={totals.pods} />
			<!-- Pods that are not ready or restart hard: not the warning events the top bar counts. -->
			<StatCard label="Pods needing attention" value={totals.warnings} tone={totals.warnings > 0 ? 'warn' : 'ok'} />
			<StatCard label="Contexts watched" value={totals.watched} />
		</div>

		<div class="grid grid-cols-[repeat(auto-fill,minmax(330px,1fr))] gap-3">
			{#each clusters.contexts as ctx, i (ctx.name)}
				{@const snap = snapshots[i]}
				{@const badge = badgeFor(snap.state)}
				{@const identity = clusters.identityFor(ctx.name)}
				<!-- Each card carries its own cluster's tint (Tonal §4.1), whatever the window shows. -->
				<button
					type="button"
					class="card focus-ring flex flex-col gap-3 rounded-lg bg-surface-container-high p-4 text-left hover:bg-surface-container-top"
					aria-label={cardName(ctx.name, badge.label, snap.warnings)}
					data-tint
					data-identity={identity}
					data-state={snap.state}
					style={tintStyle(identity)}
					onclick={() => clickCluster(ctx.name)}
				>
					<div class="flex items-center gap-3">
						<IdentityAvatar name={ctx.name} color={identity} active={ctx.name === app.activeCluster} size={32} surface="container" />
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
						{#each [['Nodes', snap.nodes], ['Pods', snap.pods], ['Version', snap.version], ['Attention', snap.warnings]] as const as [label, value] (label)}
							{@const flagged = label === 'Attention' && typeof value === 'number' && value > 0}
							<div class="min-w-0">
								<dt class="type-label mb-0.5 text-text-muted">{label}</dt>
								<!-- Pods needing attention above zero: bold with the triangle, not a colour. -->
								<dd
									class="type-data flex min-w-0 items-center gap-1 {value === null
										? 'text-text-subtle'
										: flagged
											? 'font-semibold text-text'
											: 'text-text'}"
									data-attention={flagged}
								>
									{#if flagged}<StatusGlyph state="warn" class="text-warning" />{/if}
									<span class="truncate" title={value === null ? undefined : String(value)}>{value ?? EMPTY}</span>
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
						<p class="type-body-sm text-text-muted [overflow-wrap:anywhere]" data-testid="unreachable-detail">
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
