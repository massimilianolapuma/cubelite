<script lang="ts">
	import { EMPTY } from '#lib/empty.ts';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import PrometheusHint from '#lib/components/metrics/PrometheusHint.svelte';
	import {
		CLUSTER_HINT,
		alertSubject,
		alertTarget,
		alertTone,
		firingSince,
		isInformational,
		type AlertTarget
	} from '#lib/host-metrics.ts';
	import { canOpenGrafana, openGrafanaQueries, showsIntegrationHint } from '#lib/integration-links.ts';
	import Button from '#lib/components/ui/Button.svelte';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';
	import { toneGlyph, type StatusTone } from '#lib/status.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { prometheus } from '#lib/stores/prometheus.svelte.ts';
	import { promOverview } from '#lib/stores/promOverview.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';
	import { settings } from '#lib/stores/settings.svelte.ts';
	import { prometheusAlertExpr, type Alert, type PromEndpoint } from '#lib/tauri.ts';

	// Firing alerts from Prometheus in the Overview (#530): severity, name,
	// what it is about (a link to the pod or node when it is loaded),
	// summary, firing since, and Open in Grafana on the alert's rule
	// expression (asked for on click). Informational alerts (severity
	// "none": Watchdog) come last, muted, and are not counted.
	const endpoint = $derived(prometheus.active);
	const hint = $derived(showsIntegrationHint(endpoint, settings.integrationHints.value));
	const alerts = $derived(promOverview.alerts);
	const actionable = $derived((alerts ?? []).filter((a) => !isInformational(a)));
	const informational = $derived((alerts ?? []).filter(isInformational));
	const nodes = $derived([...resources.nodeInventory.map((n) => n.name), ...resources.nodes.map((n) => n.name)]);
	const SHOWN = 8;
	// Expanded for one context only: switching context collapses it (#568).
	let expandedFor = $state<string | null>(null);
	const expanded = $derived(expandedFor !== null && expandedFor === app.activeCluster);
	const ordered = $derived([...actionable, ...informational]);
	const shown = $derived(expanded ? ordered : ordered.slice(0, SHOWN));

	function open(target: AlertTarget) {
		if (target.kind === 'pod') {
			app.navigate('pods');
			app.selectedPod = target.pod;
		} else {
			app.navigate('nodes');
			app.selectedNode = target.name;
		}
	}

	async function grafana(ep: PromEndpoint, alert: Alert) {
		const context = app.activeCluster;
		// The rule's expression, else the alert's own series.
		const expr = context
			? await prometheusAlertExpr(app.kubeconfigPath, context, ep, alert).catch(() => alert.expr)
			: alert.expr;
		await openGrafanaQueries(ep, [expr], '1h');
	}

	const GLYPH_TONE: Record<StatusTone, string> = { ok: 'text-success', warn: 'text-warning', err: 'text-error', neutral: 'text-text-subtle' };
</script>

{#if endpoint}
	<section
		id="overview-alerts"
		tabindex="-1"
		aria-labelledby="overview-alerts-title"
		class="card focus-ring scroll-mt-4 rounded-lg bg-surface-container-high p-4"
		data-testid="alerts-card"
	>
		<div class="mb-2 flex items-center gap-2">
			<h2 id="overview-alerts-title" class="type-label text-text-muted">Alerts</h2>
			{#if alerts}
				<span class="type-data-sm rounded-full bg-surface-container-top px-2 font-semibold text-text" data-testid="alerts-count">
					{actionable.length}<span class="sr-only"> firing alerts</span>
				</span>
				{#if informational.length > 0}
					<span class="type-body-sm text-text-muted" data-testid="alerts-informational">
						{informational.length} informational
					</span>
				{/if}
			{/if}
		</div>
		{#if promOverview.alertsError}
			<p class="type-body-sm flex items-start gap-1.5 text-text" role="alert">
				<StatusGlyph state="err" class="mt-1 text-error" />
				{promOverview.alertsError}
			</p>
		{:else if alerts === null}
			<p class="type-body-sm text-text-muted" role="status">loading alerts…</p>
		{:else if alerts.length === 0}
			<p class="type-body-sm text-text-muted">No firing alerts.</p>
		{:else}
			<div class="flex flex-col gap-0.5" id="overview-alerts-list">
				{#each shown as alert, i (i)}
					{@const target = alertTarget(alert, resources.pods, nodes)}
					{@const subject = alertSubject(alert)}
					{@const muted = isInformational(alert)}
					{@const tone = muted ? 'neutral' : alertTone(alert.severity)}
					<!-- Severity is a shape and a word: square critical, triangle warning, dashed ring otherwise. -->
					<div class="flex flex-col rounded-md px-2 py-1.5 hover:bg-surface-container-top" data-testid="alert-row" data-tone={tone}>
						<div class="flex items-center gap-2">
							<StatusGlyph state={toneGlyph(tone)} class={GLYPH_TONE[tone]} />
							<span class="type-data-sm min-w-0 truncate {muted ? 'text-text-muted' : 'font-semibold text-text'}" title={alert.name}>
								{alert.name}
							</span>
							<span class="type-body-sm shrink-0 text-text-muted">{alert.severity ?? EMPTY}</span>
							{#if subject && target}
								<button
									type="button"
									class="focus-ring type-data-sm min-w-0 truncate rounded-xs text-primary underline-offset-2 hover:underline"
									title="Open {subject}"
									onclick={() => open(target)}
								>
									{subject}
								</button>
							{:else if subject}
								<span class="type-data-sm min-w-0 truncate text-text-muted">{subject}</span>
							{/if}
							<span class="ml-auto"></span>
							<span class="type-body-sm shrink-0 text-text-muted">{firingSince(alert.activeAt)}</span>
							{#if canOpenGrafana(endpoint)}
								{@const ep = endpoint}
								<button
									type="button"
									class="focus-ring forced-edge rounded-xs text-text-muted hover:text-text"
									aria-label="Open {alert.name} in Grafana"
									title="Open in Grafana"
									onclick={() => void grafana(ep, alert)}
								>
									<ExternalLink class="h-3 w-3" aria-hidden="true" />
								</button>
							{/if}
						</div>
						{#if alert.summary}
							<p class="type-body-sm truncate pl-4 text-text-muted" title={alert.summary}>
								{alert.summary}
							</p>
						{/if}
					</div>
				{/each}
				{#if ordered.length > SHOWN}
					<Button
						variant="text"
						size="inline"
						class="mt-1 self-start"
						aria-expanded={expanded}
						aria-controls="overview-alerts-list"
						data-testid="alerts-toggle"
						onclick={() => (expandedFor = expanded ? null : app.activeCluster)}
					>
						{expanded ? 'Show fewer' : `Show ${ordered.length - SHOWN} more`}
					</Button>
				{/if}
			</div>
		{/if}
	</section>
{:else if hint}
	<PrometheusHint title="Alerts" text={CLUSTER_HINT} testid="overview-prometheus-hint" />
{/if}
