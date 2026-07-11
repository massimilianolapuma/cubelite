<script lang="ts">
	import Minus from '@lucide/svelte/icons/minus';
	import Plus from '@lucide/svelte/icons/plus';
	import RotateCw from '@lucide/svelte/icons/rotate-cw';
	import type { DeploymentInfo } from '$lib/tauri';
	import { deploymentStatus, toneColor } from '$lib/status';

	let {
		deployments,
		selected = null,
		onRowClick
	}: {
		deployments: DeploymentInfo[];
		selected?: DeploymentInfo | null;
		onRowClick?: (dep: DeploymentInfo) => void;
	} = $props();

	// NAME / READY / STATUS / AGE / REPLICAS · ACTIONS
	const grid = 'grid-template-columns: 2.2fr 0.6fr 0.9fr 0.55fr 1.4fr;';
	const disabledTitle = 'Requires backend support';
</script>

<div class="overflow-hidden rounded-lg border border-border-default">
	<div class="grid gap-x-3 border-b border-border-default bg-surface-surface px-3 py-2" style={grid}>
		<span class="type-colhead">Name</span>
		<span class="type-colhead">Ready</span>
		<span class="type-colhead">Status</span>
		<span class="type-colhead">Age</span>
		<span class="type-colhead">Replicas · Actions</span>
	</div>
	<div class="bg-surface-panel">
		{#if deployments.length === 0}
			<p class="py-8 text-center text-xs text-text-disabled">No deployments found.</p>
		{:else}
			{#each deployments as dep (dep.namespace + '/' + dep.name)}
				{@const status = deploymentStatus(dep)}
				{@const isSelected = selected?.name === dep.name && selected?.namespace === dep.namespace}
				<div
					role="button"
					tabindex="0"
					class="grid w-full cursor-default items-center gap-x-3 border-b border-border-faint px-3 text-left last:border-b-0 hover:bg-surface-row-hover"
					style="{grid} padding-top: var(--row-pad-default); padding-bottom: var(--row-pad-default); {isSelected
						? 'background: var(--alpha-selection-bg);'
						: ''}"
					onclick={() => onRowClick?.(dep)}
					onkeydown={(e) => {
						if (e.key === 'Enter') onRowClick?.(dep);
					}}
				>
					<span class="type-data truncate text-text-data-bright">{dep.name}</span>
					<span class="type-data-sm text-text-secondary">{dep.ready_replicas}/{dep.replicas}</span>
					<span class="flex items-center gap-1.5">
						<span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background: {toneColor[status.tone]};"></span>
						<span class="text-[11.5px]" style="color: {toneColor[status.tone]};">{status.label}</span>
					</span>
					<span class="type-data-sm text-text-disabled">—</span>
					<span class="flex items-center gap-1.5">
						<!-- Replica stepper + restart: rendered per spec, disabled until mutation commands exist. -->
						<span class="flex items-center overflow-hidden rounded-md border border-border-default">
							<button
								type="button"
								disabled
								title={disabledTitle}
								class="flex h-6 w-6 items-center justify-center bg-surface-raised text-text-tertiary opacity-45"
								onclick={(e) => e.stopPropagation()}
							>
								<Minus class="h-3 w-3" />
							</button>
							<span class="type-data-sm border-x border-border-default bg-surface-window px-2 text-text-secondary">
								{dep.replicas}
							</span>
							<button
								type="button"
								disabled
								title={disabledTitle}
								class="flex h-6 w-6 items-center justify-center bg-surface-raised text-text-tertiary opacity-45"
								onclick={(e) => e.stopPropagation()}
							>
								<Plus class="h-3 w-3" />
							</button>
						</span>
						<button
							type="button"
							disabled
							title={disabledTitle}
							class="type-caption flex h-6 items-center gap-1 rounded-md border border-border-default bg-surface-raised px-2 text-text-tertiary opacity-45"
							onclick={(e) => e.stopPropagation()}
						>
							<RotateCw class="h-3 w-3" />
							Restart
						</button>
					</span>
				</div>
			{/each}
		{/if}
	</div>
</div>
