<script lang="ts">
	import GroupedRows from '#lib/components/ui/GroupedRows.svelte';
	import ListCard from '#lib/components/ui/ListCard.svelte';
	import SortHeader from '#lib/components/ui/SortHeader.svelte';
	import ObjectYamlDrawer from '#lib/components/dynamic/ObjectYamlDrawer.svelte';
	import { formatAge } from '#lib/age.ts';
	import { listState } from '#lib/list-state.ts';
	import { isCustomView, type KindView } from '#lib/resource-kinds.ts';
	import { cellText, planColumns, planTracks } from '#lib/table-columns.ts';
	import type { TableRow } from '#lib/tauri.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { dynamic } from '#lib/stores/dynamic.svelte.ts';
	import { layout } from '#lib/stores/layout.svelte.ts';
	import { LIST_ROW_ACTION, LIST_STICKY, SEARCH_FIELD } from '#lib/ui-classes.ts';

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

	const selected = $derived(app.selectedObject);
	// Beside the docked panel the list keeps its first five columns; the panel's
	// Summary has them all (Tonal §3 #2, §8.3).
	const narrow = $derived(layout.docked && selected !== null);

	const table = $derived(dynamic.tables[view]);
	const withNamespace = $derived(namespaced && !grouped && (!narrow || app.namespace === null));
	const fullPlan = $derived(planColumns(table?.columns ?? [], withNamespace));
	const plan = $derived(narrow ? fullPlan.slice(0, 5) : fullPlan);
	const all = $derived(table?.rows ?? []);
	const rows = $derived.by(() => {
		const text = filter.trim().toLowerCase();
		return text ? all.filter((r) => r.name.toLowerCase().includes(text)) : all;
	});

	// Not named `state`: that would shadow the `$state` rune.
	const shows = $derived(
		listState({
			nouns: meta.nouns,
			namespace: app.namespace,
			namespaced,
			loaded: table !== undefined,
			error: dynamic.errors[view] ?? null,
			unavailable: dynamic.isUnavailable(view),
			total: all.length,
			shown: rows.length,
			filter
		})
	);

	const accessors = {
		name: (r: TableRow) => r.name,
		namespace: (r: TableRow) => r.namespace ?? '',
		created: (r: TableRow) => r.creation_timestamp
	};

	// Every column the server returned for the open object, as the panel's
	// Summary: nothing is lost when the list is narrowed. The name is the
	// panel's title.
	const summary = $derived.by((): [string, string | null][] => {
		const row = selected && all.find((r) => r.name === selected.name && r.namespace === selected.namespace);
		if (!row || !table) return [];
		const nameIndex = table.columns.findIndex((c) => c.format === 'name');
		const facts: [string, string | null][] = namespaced ? [['Namespace', row.namespace]] : [];
		table.columns.forEach((column, i) => {
			if (i === nameIndex || (nameIndex < 0 && column.name === 'Name')) return;
			facts.push([column.name, cellText(row.cells[i], column.column_type === 'date') || null]);
		});
		return facts;
	});

	// The first column stays in view while the others scroll sideways.
	const sticky = (i: number) => (i === 0 ? LIST_STICKY : '');
</script>

<ListCard
	title={meta.label}
	list={view}
	nouns={meta.nouns}
	columns={planTracks(plan)}
	state={shows}
	shown={rows.length}
	total={all.length}
	groupable={namespaced}
	busy={dynamic.loading[view] ?? false}
	onRetry={() => void dynamic.load(view)}
	onClear={() => (filter = '')}
>
	{#snippet tools()}
		{#if isCustomView(view)}
			<span class="type-body-sm text-text-muted">{meta.group}</span>
		{/if}
		{#if !namespaced}
			<span class="type-body-sm text-text-muted">cluster-scoped</span>
		{/if}
		<input
			type="text"
			placeholder="Filter {meta.nouns[1]}…"
			aria-label="Filter {meta.label}"
			bind:value={filter}
			class={SEARCH_FIELD}
		/>
	{/snippet}

	{#snippet head()}
		{#each plan as column, i (i)}
			{#if column.kind === 'name'}
				<span class="{sticky(i)} flex min-w-0"><SortHeader list={view} field="name" label="Name" /></span>
			{:else if column.kind === 'namespace'}
				<SortHeader list={view} field="namespace" label="Namespace" />
			{:else if column.kind === 'age'}
				<SortHeader list={view} field="age" label={column.label} />
			{:else}
				<span class="truncate {sticky(i)}" title={table?.columns[column.index]?.description}>{column.label}</span>
			{/if}
		{/each}
	{/snippet}

	<GroupedRows list={view} {rows} {accessors} nouns={meta.nouns} {filter} groupable={namespaced}>
		{#snippet row(r, inGroup)}
			{@const active = selected?.name === r.name && selected?.namespace === r.namespace}
			<button
				type="button"
				class={LIST_ROW_ACTION}
				data-selected={active}
				aria-current={active ? 'true' : undefined}
				onclick={() => (app.selectedObject = { name: r.name, namespace: r.namespace })}
			>
				{#each plan as column, i (i)}
					{#if column.kind === 'name'}
						<span class="flex min-w-0 items-center self-stretch {sticky(i)} {inGroup ? 'pl-4.5' : ''}">
							<span class="type-data truncate text-text" title={r.name}>{r.name}</span>
						</span>
					{:else if column.kind === 'namespace'}
						<span class="type-data-sm truncate text-text-muted">{r.namespace ?? ''}</span>
					{:else if column.kind === 'age'}
						<span class="type-data-sm truncate text-text-muted">{formatAge(r.creation_timestamp)}</span>
					{:else}
						{@const text = cellText(r.cells[column.index], column.date)}
						<span class="flex min-w-0 items-center self-stretch {sticky(i)}">
							<span class="type-data-sm truncate text-text-muted" title={text}>{text}</span>
						</span>
					{/if}
				{/each}
			</button>
		{/snippet}
	</GroupedRows>
</ListCard>

{#if selected}
	<ObjectYamlDrawer
		{view}
		kind={meta.nouns[0]}
		name={selected.name}
		namespace={selected.namespace}
		{summary}
		onClose={() => (app.selectedObject = null)}
	/>
{/if}
