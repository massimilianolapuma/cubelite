<script lang="ts">
	import { EMPTY } from '#lib/empty.ts';
	import { formatAge } from '#lib/age.ts';
	import NodeMetricsSection from '#lib/components/metrics/NodeMetricsSection.svelte';
	import Drawer from '#lib/components/ui/Drawer.svelte';
	import FactRows from '#lib/components/ui/FactRows.svelte';
	import StatCard from '#lib/components/ui/StatCard.svelte';
	import StatusHero from '#lib/components/ui/StatusHero.svelte';
	import { nodeTone, toneGlyph } from '#lib/status.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';
	import type { NodeInfo } from '#lib/tauri.ts';
	import { percentOf } from '#lib/units.ts';

	// Node detail (#530): the inventory facts and the node's Metrics section.
	// `info` is null when the node is opened by name (an alert) before the
	// inventory has it.
	let { name, info, onClose }: { name: string; info: NodeInfo | null; onClose: () => void } = $props();

	const facts = $derived<[string, string | null][]>([
		['Roles', info?.roles.join(', ') || null],
		['Version', info?.version ?? null],
		['Age', info ? formatAge(info.creation_timestamp) : null]
	]);

	// Pods are loaded for the selected namespace: the tile says so, rather than
	// passing a part for the whole.
	const podsKnown = $derived(resources.mainLoaded && resources.listError('pods') === null);
	const podCount = $derived(resources.pods.filter((p) => p.node === name).length);
	const podLabel = $derived(app.namespace === null ? 'Pods' : `Pods in ${app.namespace}`);

	const capacity = $derived(resources.nodes.find((n) => n.name === name) ?? null);
	const cpu = $derived(capacity ? percentOf(capacity.cpu_used_millis, capacity.cpu_allocatable_millis) : null);
	// Same thresholds as the meters: attention from 60 %, failure from 75 %.
	const cpuTone = $derived(cpu === null ? undefined : Math.round(cpu) >= 75 ? 'err' : Math.round(cpu) >= 60 ? 'warn' : undefined);
</script>

<Drawer kind="Node" title={name} {onClose}>
	<div class="flex flex-col gap-4">
		{#if info}
			<StatusHero state={toneGlyph(nodeTone(info.status))} label={info.status} />
		{/if}
		<div class="grid grid-cols-2 gap-2">
			<!-- A count only once the pods answered: a zero would read as "no pods". -->
			<StatCard surface="top" label={podLabel} value={podsKnown ? podCount : EMPTY} />
			<StatCard surface="top" label="CPU" value={cpu === null ? EMPTY : `${Math.round(cpu)}%`} tone={cpuTone} />
		</div>
		<FactRows {facts} />
		<NodeMetricsSection node={name} />
	</div>
</Drawer>
