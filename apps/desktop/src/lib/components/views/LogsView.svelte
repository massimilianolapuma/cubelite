<script lang="ts">
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import { untrack } from 'svelte';
	import { logs, type LevelFilter } from '#lib/stores/logs.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { elastic } from '#lib/stores/elastic.svelte.ts';
	import { matchesSelector, parseLabelSelector } from '#lib/k8s-match.ts';
	import { UI_LINK_CLASS } from '#lib/integration.ts';
	import { canOpenKibana, openKibanaFor, toastErrors } from '#lib/integration-links.ts';
	import {
		kindLabel,
		logsHistoryMapping,
		scopeKey,
		scopeMatcher,
		type LogScope
	} from '#lib/log-scope.ts';
	import type { LogViewMode } from '#lib/log-ecs.ts';
	import SegmentedControl from '#lib/components/ui/SegmentedControl.svelte';
	import LogLineRow from '#lib/components/logpanel/LogLineRow.svelte';
	import HistoryControls from '#lib/components/logpanel/HistoryControls.svelte';
	import HistoryStrip from '#lib/components/logpanel/HistoryStrip.svelte';
	import LogSourceSwitch from '#lib/components/logpanel/LogSourceSwitch.svelte';

	/** Backend streams at most this many pods (MAX_LOG_PODS in Rust). */
	const MAX_STREAMED_PODS = 20;

	let container = $state<HTMLDivElement | null>(null);
	let labelSelector = $state('');
	let debouncedSelector = $state('');
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;

	// Debounce selector edits so each keystroke doesn't restart the stream.
	$effect(() => {
		const value = labelSelector;
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => (debouncedSelector = value), 300);
		return () => clearTimeout(debounceTimer);
	});

	// Workloads to narrow to (#529): StatefulSets and Jobs are loaded on
	// demand, once per namespace.
	$effect(() => {
		void app.activeCluster;
		const ns = app.namespace ?? null;
		void untrack(async () => {
			for (const kind of ['statefulsets', 'jobs'] as const) {
				if (resources.loadedKinds[kind] !== ns) await resources.loadKind(kind);
			}
		});
	});

	const workloads = $derived<LogScope[]>([
		...resources.deployments.map((d) => ({
			namespace: d.namespace,
			workload: { kind: 'deployment' as const, name: d.name }
		})),
		...resources.statefulsets.map((s) => ({
			namespace: s.namespace,
			workload: { kind: 'stateful-set' as const, name: s.name }
		})),
		...resources.jobs.map((j) => ({ namespace: j.namespace, workload: { kind: 'job' as const, name: j.name } }))
	]);
	// The current scope stays selectable while its lists load.
	const scopeOptions = $derived.by(() => {
		const scope = logs.scope;
		if (!scope) return workloads;
		const key = scopeKey(scope);
		return workloads.some((w) => scopeKey(w) === key) ? workloads : [scope, ...workloads];
	});

	// A scope belongs to its cluster and namespace: drop it when they change.
	let scopeCluster = app.activeCluster;
	$effect(() => {
		const cluster = app.activeCluster;
		const ns = app.namespace;
		untrack(() => {
			const scope = logs.scope;
			if (scope && (cluster !== scopeCluster || (ns !== null && ns !== scope.namespace))) logs.scope = null;
			scopeCluster = cluster;
		});
	});

	function pickScope(key: string) {
		logs.scope = scopeOptions.find((w) => scopeKey(w) === key) ?? null;
	}

	const streamedPods = $derived.by(() => {
		const selector = parseLabelSelector(debouncedSelector);
		const bySelector = Object.keys(selector).length > 0;
		const inScope = logs.scope ? scopeMatcher(logs.scope) : () => true;
		return resources.pods
			.filter((p) => inScope(p) && (!bySelector || matchesSelector(p.labels, selector)))
			.map((p) => ({ namespace: p.namespace, name: p.name }));
	});

	// (Re)start the aggregated stream when cluster/namespace/selector change.
	$effect(() => {
		void [app.activeCluster, app.namespace];
		const pods = streamedPods;
		void logs.start(pods);
		return () => void logs.stop();
	});

	// Elasticsearch history of the same filter (#529).
	const endpoint = $derived(elastic.endpointFor(app.activeCluster));
	const mapping = $derived(logsHistoryMapping(app.namespace, logs.scope, debouncedSelector));
	$effect(() => {
		const m = mapping;
		const cluster = endpoint ? app.activeCluster : null;
		untrack(() => logs.setHistory(m, cluster));
	});
	const history = $derived(logs.source === 'history' ? logs.history : null);

	function openKibana() {
		const ep = endpoint;
		const m = mapping;
		if (!ep || m.namespace === null) return;
		void toastErrors(() => openKibanaFor(ep, m.namespace, m.target, history?.range ?? 'now-1h'));
	}

	// Auto-scroll to bottom while following.
	$effect(() => {
		void logs.filtered.length;
		if (logs.source === 'live' && logs.following && container) {
			container.scrollTop = container.scrollHeight;
		}
	});

	// History: show the newest lines after each (re)load, once.
	$effect(() => {
		void history?.loads;
		if (history && container) container.scrollTop = container.scrollHeight;
	});

	const chips: { value: LevelFilter; label: string; color: string | null }[] = [
		{ value: 'all', label: 'ALL', color: null },
		{ value: 'info', label: 'INFO', color: 'var(--color-status-info)' },
		{ value: 'warn', label: 'WARN', color: 'var(--color-status-warn)' },
		{ value: 'error', label: 'ERROR', color: 'var(--color-status-err)' }
	];


	const VIEW_MODES: { value: LogViewMode; label: string }[] = [
		{ value: 'raw', label: 'Raw' },
		{ value: 'json', label: 'JSON' },
		{ value: 'ecs', label: 'ECS' }
	];
</script>

<div class="flex min-h-0 flex-1 flex-col gap-3 p-4">
	<div class="flex flex-wrap items-center gap-2">
		<h1 class="type-title">Logs</h1>
		<span class="type-caption flex-1 text-text-tertiary">
			streaming {Math.min(streamedPods.length, MAX_STREAMED_PODS)}{streamedPods.length >
			MAX_STREAMED_PODS
				? ` of ${streamedPods.length}`
				: ''} pods
		</span>

		<!-- one workload's pods, live and in history (#529) -->
		<select
			aria-label="Workload"
			class="focus-ring type-caption h-7 max-w-52 rounded-md border border-border-default bg-surface-window px-2 text-text-primary"
			value={logs.scope ? scopeKey(logs.scope) : ''}
			onchange={(e) => pickScope(e.currentTarget.value)}
		>
			<option value="">All pods</option>
			{#each scopeOptions as option (scopeKey(option))}
				<option value={scopeKey(option)}>
					{kindLabel(option.workload.kind)} {app.namespace ? '' : `${option.namespace}/`}{option.workload.name}
				</option>
			{/each}
		</select>

		<input
			type="text"
			placeholder="label=value,…"
			bind:value={labelSelector}
			class="focus-ring h-7 w-44 rounded-md border border-border-default bg-surface-window px-2.5 type-data-sm text-text-primary placeholder:text-text-disabled"
		/>

		<LogSourceSwitch
			value={logs.source}
			onChange={(v) => logs.setSource(v)}
			blocked={mapping.reason}
			testid="logs-source"
			hintTestid="logs-history-hint"
		/>

		{#if history}
			<HistoryControls {history} />
		{/if}

		<div class="flex overflow-hidden rounded-md border border-border-default">
			{#each chips as chip (chip.value)}
				{@const active = logs.level === chip.value}
				<button
					type="button"
					class="focus-ring type-section h-7 border-r border-border-default px-2.5 last:border-r-0"
					style={active
						? chip.color
							? `background: ${chip.color}; color: var(--color-surface-window);`
							: 'background: var(--color-text-secondary); color: var(--color-surface-window);'
						: 'color: var(--color-text-tertiary);'}
					onclick={() => (logs.level = chip.value)}
				>
					{chip.label}
				</button>
			{/each}
		</div>

		<input
			type="text"
			placeholder="Filter…"
			bind:value={logs.textFilter}
			class="focus-ring h-7 w-44 rounded-md border border-border-default bg-surface-window px-2.5 type-caption text-text-primary placeholder:text-text-disabled"
		/>

		<!-- view mode: own preference, independent of the log panel's (#461, #492) -->
		<span data-testid="logs-view-mode" title="Log view: raw text, humanised JSON or Elastic Common Schema">
			<SegmentedControl segments={VIEW_MODES} bind:value={logs.viewMode} />
		</span>

		{#if history}
			{#if canOpenKibana(endpoint)}
				<button type="button" class={UI_LINK_CLASS} onclick={openKibana}>
					<ExternalLink class="h-3 w-3" /> Open in Kibana
				</button>
			{/if}
		{:else}
			<button
				type="button"
				class="focus-ring type-caption flex h-7 items-center gap-1.5 rounded-md px-2.5 font-medium"
				style={logs.following
					? 'background: var(--color-status-ok); color: var(--color-surface-window);'
					: 'background: var(--alpha-pill-warn); color: var(--color-status-warn);'}
				onclick={() => logs.toggleFollow()}
			>
				{logs.following ? '● Following' : '⏸ Paused'}
			</button>

			<button
				type="button"
				class="focus-ring type-caption flex h-7 items-center rounded-md border border-border-default bg-surface-raised px-2.5 text-text-secondary hover:brightness-110"
				onclick={() => logs.clear()}
			>
				Clear
			</button>
		{/if}
	</div>

	<div
		class="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border-default bg-surface-sunken"
	>
		{#if history}
			<HistoryStrip {history} />
		{:else if !logs.following && logs.bufferedWhilePaused > 0}
			<div class="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
				<span
					class="type-caption animate-pulse rounded-full px-2.5 py-1"
					style="background: var(--alpha-pill-warn); color: var(--color-status-warn);"
				>
					paused — new lines buffered
				</span>
			</div>
		{/if}

		<div bind:this={container} class="min-h-0 flex-1 overflow-y-auto py-1">
			{#if logs.filtered.length === 0}
				<p class="py-8 text-center text-xs text-text-disabled">
					{#if history}
						{history.loading || history.error
							? ''
							: logs.sourceLines.length === 0
								? 'No lines in Elasticsearch for this filter and range.'
								: 'No lines match the filter.'}
					{:else}
						{logs.lines.length === 0 ? 'Waiting for log lines…' : 'No lines match the filter.'}
					{/if}
				</p>
			{:else}
				{#each logs.filtered as line (line.id)}
					<LogLineRow
						{line}
						timestamps={true}
						wrap={true}
						source={{ name: line.pod, color: 'var(--color-text-secondary)', wide: true }}
						mode={logs.viewMode}
						expanded={logs.expanded.has(line.id)}
						ontoggle={() => logs.toggleExpanded(line.id)}
					/>
				{/each}
			{/if}
		</div>
	</div>
</div>
