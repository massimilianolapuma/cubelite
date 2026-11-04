<script lang="ts">
	import { formatAge } from '#lib/age.ts';
	import NodeMetricsSection from '#lib/components/metrics/NodeMetricsSection.svelte';
	import Drawer from '#lib/components/ui/Drawer.svelte';
	import StatusPill from '#lib/components/ui/StatusPill.svelte';
	import { nodeTone } from '#lib/status.ts';
	import type { NodeInfo } from '#lib/tauri.ts';

	// Node detail (#530): the inventory facts and the node's Metrics section.
	// `info` is null when the node is opened by name (an alert) before the
	// inventory has it.
	let { name, info, onClose }: { name: string; info: NodeInfo | null; onClose: () => void } = $props();

	const meta = $derived<[string, string][]>([
		['Roles', info?.roles.join(', ') || '—'],
		['Version', info?.version ?? '—'],
		['Age', formatAge(info?.creation_timestamp ?? null)]
	]);
</script>

<Drawer title={name} {onClose}>
	<div class="flex flex-col gap-4">
		{#if info}
			<div><StatusPill label={info.status} tone={nodeTone(info.status)} /></div>
		{/if}
		<div class="grid grid-cols-2 gap-x-4 gap-y-2.5">
			{#each meta as [label, value] (label)}
				<div>
					<div class="type-colhead mb-0.5">{label}</div>
					<div class="type-data-sm {value === '—' ? 'text-text-disabled' : 'text-text-secondary'}">{value}</div>
				</div>
			{/each}
		</div>
		<NodeMetricsSection node={name} />
	</div>
</Drawer>
