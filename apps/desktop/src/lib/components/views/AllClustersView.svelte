<script lang="ts">
	import IdentityAvatar from '$lib/components/ui/IdentityAvatar.svelte';
	import StatCard from '$lib/components/ui/StatCard.svelte';
	import StatusPill from '$lib/components/ui/StatusPill.svelte';
	import { app } from '$lib/stores/app.svelte';
	import { clusters } from '$lib/stores/clusters.svelte';
	import { resources } from '$lib/stores/resources.svelte';

	const issues = $derived(resources.issuePods.length);

	function clickCluster(name: string) {
		if (name === app.activeCluster) {
			app.navigate('overview');
			return;
		}
		void clusters.switchCluster(name);
	}

	function pillFor(name: string): { label: string; tone: 'ok' | 'err' | 'neutral' } {
		if (name !== app.activeCluster) return { label: 'Unknown', tone: 'neutral' };
		if (clusters.connectionState === 'connected') return { label: 'Healthy', tone: 'ok' };
		if (clusters.connectionState === 'unreachable') return { label: 'Unreachable', tone: 'err' };
		return { label: 'Unknown', tone: 'neutral' };
	}

	// Backend has no probe for inactive clusters; only the active one has data.
	function statsFor(name: string): [string, string][] {
		const active = name === app.activeCluster && clusters.connectionState === 'connected';
		return [
			['Nodes', '—'],
			['Pods', active ? String(resources.pods.length) : '—'],
			['Version', '—'],
			['Warnings', active ? String(issues) : '—']
		];
	}
</script>

<div class="flex flex-col gap-4 p-5">
	<div>
		<h1 class="type-title">All Clusters</h1>
		<p class="type-caption mt-0.5 text-text-tertiary">
			{clusters.contexts.length} context{clusters.contexts.length === 1 ? '' : 's'}
			· {resources.pods.length} pods (active cluster)
		</p>
	</div>

	<div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
		<StatCard label="Contexts" value={clusters.contexts.length} />
		<StatCard label="Pods (active)" value={resources.pods.length} />
		<StatCard label="Warnings" value={issues} tone={issues > 0 ? 'warn' : 'ok'} />
		<StatCard label="Watched" value={app.activeCluster ? 1 : 0} />
	</div>

	<div class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax(330px, 1fr));">
		{#each clusters.contexts as ctx (ctx.name)}
			{@const pill = pillFor(ctx.name)}
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
							<div class="truncate font-mono text-[10.5px] text-text-tertiary">
								{ctx.cluster_server}
							</div>
						{/if}
					</div>
					<StatusPill label={pill.label} tone={pill.tone} />
				</div>

				<div class="grid grid-cols-4 gap-2">
					{#each statsFor(ctx.name) as [label, value] (label)}
						<div>
							<div class="type-colhead mb-0.5">{label}</div>
							<div
								class="font-mono text-[12px] font-medium {value === '—'
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

				{#if ctx.name === app.activeCluster && clusters.connectionState === 'unreachable'}
					<p class="type-caption text-status-err">
						{clusters.unreachableReason ?? 'connection failed'}
					</p>
				{/if}
			</button>
		{/each}
	</div>
</div>
