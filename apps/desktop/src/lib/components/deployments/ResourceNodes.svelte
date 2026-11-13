<script lang="ts">
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Button from '#lib/components/ui/Button.svelte';
	import MeterBar from '#lib/components/ui/MeterBar.svelte';
	import { EMPTY } from '#lib/empty.ts';
	import type { NodeRow, NodeRows } from '#lib/resource-editor.ts';

	// The nodes the pods run on, before and after the change (spec #650 §3.2): one
	// measure for every node, the one the worst finding is about. The nodes that
	// host none of the pods are behind a disclosure.
	let { rows }: { rows: NodeRows } = $props();

	const uid = $props.id();
	let othersOpen = $state(false);

	const pods = (n: number) => (n <= 0 ? EMPTY : n === 1 ? '1 pod here' : `${n} pods here`);
</script>

{#snippet row(node: NodeRow)}
	<!-- Fixed tracks: the after bar keeps its room when it is not drawn, so a bar
	     appearing while the user types moves nothing. -->
	<div
		class="grid grid-cols-[minmax(0,1fr)_5.5rem_minmax(0,1fr)_0.875rem_minmax(0,1fr)] items-center gap-x-2.5"
		role="listitem"
		data-testid="node-{node.name}"
	>
		<span class="min-w-0">
			<span class="type-data-sm block truncate text-text" title={node.name}>{node.name}</span>
			{#if !node.schedulable}
				<span class="type-body-sm block text-text-muted">not schedulable</span>
			{/if}
		</span>
		<span class="type-body-sm whitespace-nowrap text-text-muted">{pods(node.ownPods)}</span>
		<div class="min-w-0">
			<span class="sr-only">now</span>
			<MeterBar percent={node.before} />
		</div>
		{#if node.after !== null}
			<ArrowRight class="h-3.5 w-3.5 text-text-muted" aria-hidden="true" />
			<div class="min-w-0" data-after>
				<span class="sr-only">after the change</span>
				<MeterBar percent={node.after} />
			</div>
		{/if}
	</div>
{/snippet}

<section class="flex flex-col gap-2" aria-labelledby="{uid}-title" data-editor-nodes>
	<div class="flex items-baseline gap-3">
		<h3 id="{uid}-title" class="type-label shrink-0 text-text-muted">Nodes these pods run on</h3>
		<span class="type-body-sm ml-auto min-w-0 truncate text-text-muted" title={rows.caption}>{rows.caption}</span>
	</div>
	{#if rows.hosting.length > 0}
		<div class="flex flex-col gap-1.5" role="list" aria-label="Nodes hosting the pods">
			{#each rows.hosting as node (node.name)}
				{@render row(node)}
			{/each}
		</div>
	{/if}
	{#if rows.others.length > 0}
		<Button
			variant="text"
			size="inline"
			class="-ml-3.5 self-start"
			aria-expanded={othersOpen}
			aria-controls="{uid}-others"
			onclick={() => (othersOpen = !othersOpen)}
		>
			{#snippet icon()}
				<ChevronDown
					class="h-3.5 w-3.5 transition-transform motion-reduce:transition-none {othersOpen ? '' : '-rotate-90'}"
					aria-hidden="true"
				/>
			{/snippet}
			{rows.others.length === 1 ? '1 other node' : `${rows.others.length} other nodes`}
		</Button>
		<div id="{uid}-others" class="flex flex-col gap-1.5" role="list" aria-label="Other nodes" hidden={!othersOpen}>
			{#if othersOpen}
				{#each rows.others as node (node.name)}
					{@render row(node)}
				{/each}
			{/if}
		</div>
	{/if}
	<p class="type-body-sm text-text-muted">
		Estimate from capacity. Node selectors, taints and affinity are not considered.
	</p>
</section>
