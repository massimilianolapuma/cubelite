<script lang="ts">
	import GroupedRows from '#lib/components/ui/GroupedRows.svelte';
	import ListTitle from '#lib/components/ui/ListTitle.svelte';
	import SortHeader from '#lib/components/ui/SortHeader.svelte';
	import ObjectYamlDrawer from '#lib/components/dynamic/ObjectYamlDrawer.svelte';
	import { formatAge } from '#lib/age.ts';
	import { isCustomView, type KindView } from '#lib/resource-kinds.ts';
	import { cellText, gridTemplate, planColumns } from '#lib/table-columns.ts';
	import type { TableRow } from '#lib/tauri.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { dynamic } from '#lib/stores/dynamic.svelte.ts';

	// Any ★ kind of the resource-kinds design (§5.1): the columns `kubectl get`
	// prints, from the API server's Table; Name, Namespace and Age are ours.
	let { view }: { view: KindView } = $props();

	const meta = $derived(dynamic.meta(view));
	const namespaced = $derived(meta.namespaced);
	const grouped = $derived(namespaced && app.groupedLists);

	let filter = $state('');
	// The registry reuses this component for every ★ kind: a new kind starts unfiltered.
	$effect.pre(() => {
		void view;
		filter = '';
	});

	$effect(() => {
		void [app.namespace, app.activeCluster];
		void dynamic.load(view);
	});

	const table = $derived(dynamic.tables[view]);
	const plan = $derived(planColumns(table?.columns ?? [], namespaced && !grouped));
	const grid = $derived(gridTemplate(plan));
	const rows = $derived.by(() => {
		const all = table?.rows ?? [];
		const text = filter.trim().toLowerCase();
		return text ? all.filter((r) => r.name.toLowerCase().includes(text)) : all;
	});

	const accessors = {
		name: (r: TableRow) => r.name,
		namespace: (r: TableRow) => r.namespace ?? '',
		created: (r: TableRow) => r.creation_timestamp
	};

	const selected = $derived(app.selectedObject);
</script>

<div class="flex flex-col gap-3 p-4">
	<ListTitle title={meta.label} groupable={namespaced}>
		{#if isCustomView(view)}
			<span class="type-caption text-text-tertiary">{meta.group}</span>
		{/if}
		{#if !namespaced}
			<span class="type-caption text-text-tertiary">cluster-scoped</span>
		{/if}
		<input
			type="text"
			placeholder="Filter {meta.nouns[1]}…"
			aria-label="Filter {meta.label}"
			bind:value={filter}
			class="focus-ring h-7 w-52 rounded-md border border-border-default bg-surface-window px-2.5 type-caption text-text-primary placeholder:text-text-disabled"
		/>
	</ListTitle>

	{#if dynamic.isUnavailable(view)}
		<p class="py-8 text-center text-xs text-text-disabled">Not available on this cluster</p>
	{:else if dynamic.errors[view]}
		<p class="py-8 text-center text-xs text-status-err">{dynamic.errors[view]}</p>
	{:else if !table}
		<p class="py-8 text-center text-xs text-text-disabled">Loading…</p>
	{:else}
		<div class="overflow-hidden rounded-lg border border-border-default">
			<div class="grid gap-x-3 border-b border-border-default bg-surface-surface px-3 py-2" style={grid}>
				{#each plan as column, i (i)}
					{#if column.kind === 'name'}
						<SortHeader list={view} field="name" label="Name" />
					{:else if column.kind === 'namespace'}
						<SortHeader list={view} field="namespace" label="Namespace" />
					{:else if column.kind === 'age'}
						<SortHeader list={view} field="age" label={column.label} />
					{:else}
						<span class="type-colhead truncate" title={table.columns[column.index]?.description}>{column.label}</span>
					{/if}
				{/each}
			</div>
			<div class="bg-surface-panel">
				{#if rows.length === 0}
					<p class="py-8 text-center text-xs text-text-disabled">No {meta.nouns[1]} found.</p>
				{:else}
					<GroupedRows list={view} {rows} {accessors} nouns={meta.nouns} {filter} groupable={namespaced}>
						{#snippet row(r, inGroup)}
							{@const active = selected?.name === r.name && selected?.namespace === r.namespace}
							<button
								type="button"
								class="focus-ring grid w-full items-center gap-x-3 border-b border-border-faint px-3 text-left last:border-b-0 hover:bg-surface-row-hover"
								style="{grid} padding-top: var(--row-pad-default); padding-bottom: var(--row-pad-default);{active
									? ' background: var(--alpha-selection-bg);'
									: ''}"
								onclick={() => (app.selectedObject = { name: r.name, namespace: r.namespace })}
							>
								{#each plan as column, i (i)}
									{#if column.kind === 'name'}
										<span class="type-data truncate text-text-data-bright {inGroup ? 'pl-4.5' : ''}">{r.name}</span>
									{:else if column.kind === 'namespace'}
										<span class="type-data-sm truncate text-text-secondary">{r.namespace ?? ''}</span>
									{:else if column.kind === 'age'}
										<span class="type-data-sm text-text-secondary">{formatAge(r.creation_timestamp)}</span>
									{:else}
										<span class="type-data-sm truncate text-text-secondary">{cellText(r.cells[column.index], column.date)}</span>
									{/if}
								{/each}
							</button>
						{/snippet}
					</GroupedRows>
				{/if}
			</div>
		</div>
	{/if}
</div>

{#if selected}
	<ObjectYamlDrawer {view} name={selected.name} namespace={selected.namespace} onClose={() => (app.selectedObject = null)} />
{/if}
