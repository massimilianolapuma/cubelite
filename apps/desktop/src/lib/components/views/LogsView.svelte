<script lang="ts">
	import PinToggle from '#lib/components/ui/PinToggle.svelte';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import { onDestroy, untrack } from 'svelte';
	import { listDaemonSets, type WorkloadRef } from '#lib/tauri.ts';
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
	import Button from '#lib/components/ui/Button.svelte';
	import FollowChip from '#lib/components/logpanel/FollowChip.svelte';
	import { TOOLBAR_FIELD, TOOLBAR_SELECT } from '#lib/ui-classes.ts';
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
	// demand, once per namespace; DaemonSets (listed nowhere else) each time.
	let daemonsets = $state<WorkloadRef[]>([]);
	$effect(() => {
		const cluster = app.activeCluster;
		const ns = app.namespace ?? null;
		void untrack(async () => {
			for (const kind of ['statefulsets', 'jobs'] as const) {
				if (resources.loadedKinds[kind] !== ns) await resources.loadKind(kind);
			}
		});
		daemonsets = [];
		if (!cluster) return;
		let current = true;
		listDaemonSets(app.kubeconfigPath, ns ?? undefined, cluster).then(
			(list) => current && (daemonsets = list),
			() => {} // RBAC or an old cluster: no DaemonSets to pick.
		);
		return () => (current = false);
	});
	// The view's history holds a point in time: release it on the way out.
	onDestroy(() => logs.closeHistory());

	const workloads = $derived<LogScope[]>([
		...resources.deployments.map((d) => ({
			namespace: d.namespace,
			workload: { kind: 'deployment' as const, name: d.name }
		})),
		...resources.statefulsets.map((s) => ({
			namespace: s.namespace,
			workload: { kind: 'stateful-set' as const, name: s.name }
		})),
		...daemonsets.map((d) => ({
			namespace: d.namespace,
			workload: { kind: 'daemon-set' as const, name: d.name }
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

	// Level filter: one choice of four, as words (Tonal §8.5: no level colour here).
	const LEVELS: { value: LevelFilter; label: string }[] = [
		{ value: 'all', label: 'All' },
		{ value: 'info', label: 'INFO' },
		{ value: 'warn', label: 'WARN' },
		{ value: 'error', label: 'ERROR' }
	];

	const VIEW_MODES: { value: LogViewMode; label: string }[] = [
		{ value: 'raw', label: 'Raw' },
		{ value: 'json', label: 'JSON' },
		{ value: 'ecs', label: 'ECS' }
	];
</script>

<div class="flex min-h-0 flex-1 flex-col gap-3 p-4">
	<header class="flex max-w-full min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
		<h1 class="type-display">Logs</h1>
		<span class="type-body-sm text-text-muted">
			streaming {Math.min(streamedPods.length, MAX_STREAMED_PODS)}{streamedPods.length >
			MAX_STREAMED_PODS
				? ` of ${streamedPods.length}`
				: ''} pods
		</span>
		<span class="flex-1"></span>
		<span class="self-center"><PinToggle /></span>
	</header>

	<!-- Toolbar of chips and pill fields on the card (Tonal §8.5) -->
	<div class="flex flex-wrap items-center gap-2" data-testid="log-toolbar">
		<!-- one workload's pods, live and in history (#529) -->
		<select
			aria-label="Workload"
			class="{TOOLBAR_SELECT} w-52"
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
			aria-label="Label selector"
			bind:value={labelSelector}
			class={TOOLBAR_FIELD}
		/>

		<LogSourceSwitch
			value={logs.source}
			onChange={(v) => logs.setSource(v)}
			blocked={mapping.reason}
			testid="logs-source"
			hintTestid="logs-history-hint"
			dense
		/>

		{#if history}
			<HistoryControls {history} />
		{/if}

		<SegmentedControl segments={LEVELS} bind:value={logs.level} label="Level" dense />

		<input
			type="text"
			placeholder="Filter…"
			aria-label="Filter lines"
			bind:value={logs.textFilter}
			class={TOOLBAR_FIELD}
		/>

		<!-- view mode: own preference, independent of the log panel's (#461, #492) -->
		<span data-testid="logs-view-mode" title="Log view: raw text, humanised JSON or Elastic Common Schema">
			<SegmentedControl segments={VIEW_MODES} bind:value={logs.viewMode} label="Log view" dense />
		</span>

		{#if history}
			{#if canOpenKibana(endpoint)}
				<button type="button" class={UI_LINK_CLASS} onclick={openKibana}>
					<ExternalLink class="h-3 w-3" /> Open in Kibana
				</button>
			{/if}
		{:else}
			<FollowChip following={logs.following} onToggle={() => logs.toggleFollow()} />
			<Button variant="text" size="inline" onclick={() => logs.clear()}>Clear</Button>
		{/if}
	</div>

	<!-- Never shorter than four lines: with the log panel open in a small window the
	     card scrolls instead. -->
	<div class="relative flex min-h-18 flex-1 flex-col overflow-hidden rounded-lg bg-surface-sunken" data-testid="logs-lines">
		{#if history}
			<HistoryStrip {history} />
		{:else if !logs.following && logs.bufferedWhilePaused > 0}
			<div class="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
				<span
					class="type-body-sm rounded-full bg-warning-container px-3 py-1 font-semibold text-on-warning-container shadow-overlay motion-safe:animate-pulse"
				>
					paused — new lines buffered
				</span>
			</div>
		{/if}

		<div bind:this={container} class="min-h-0 flex-1 overflow-y-auto py-1">
			{#if logs.filtered.length === 0}
				<p class="type-body-sm py-8 text-center text-text-muted">
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
						source={{ name: line.pod, index: null, wide: true }}
						mode={logs.viewMode}
						expanded={logs.expanded.has(line.id)}
						ontoggle={() => logs.toggleExpanded(line.id)}
					/>
				{/each}
			{/if}
		</div>
	</div>
</div>
