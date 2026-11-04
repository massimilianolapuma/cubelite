<script lang="ts">
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
	import { toneColor } from '#lib/status.ts';
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
	const shown = $derived([...actionable, ...informational].slice(0, SHOWN));

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
</script>

{#if endpoint}
	<div class="rounded-xl border border-border-default bg-surface-surface p-4" data-testid="alerts-card">
		<div class="mb-2 flex items-center gap-2">
			<div class="type-colhead">Alerts</div>
			{#if alerts}
				<span
					class="type-micro rounded-full border border-border-default px-1.5 font-mono text-text-secondary"
					data-testid="alerts-count"
					aria-label="{actionable.length} firing alerts"
				>
					{actionable.length}
				</span>
				{#if informational.length > 0}
					<span class="type-caption text-text-disabled" data-testid="alerts-informational">
						{informational.length} informational
					</span>
				{/if}
			{/if}
		</div>
		{#if promOverview.alertsError}
			<p class="type-caption text-status-err" role="alert">{promOverview.alertsError}</p>
		{:else if alerts === null}
			<p class="type-caption text-text-disabled">loading alerts…</p>
		{:else if alerts.length === 0}
			<p class="type-caption text-text-disabled">No firing alerts.</p>
		{:else}
			<div class="flex flex-col">
				{#each shown as alert, i (i)}
					{@const target = alertTarget(alert, resources.pods, nodes)}
					{@const subject = alertSubject(alert)}
					{@const muted = isInformational(alert)}
					{@const color = muted ? 'var(--color-text-disabled)' : toneColor[alertTone(alert.severity)]}
					<div class="flex flex-col rounded-md px-1.5 py-1 hover:bg-surface-row-hover" data-testid="alert-row">
						<div class="flex items-center gap-2">
							<span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background: {color};"></span>
							<span class="type-data-sm shrink-0 {muted ? 'text-text-tertiary' : 'text-text-data-bright'}">
								{alert.name}
							</span>
							<span class="type-caption shrink-0" style="color: {color};">{alert.severity ?? '—'}</span>
							{#if subject && target}
								<button
									type="button"
									class="focus-ring type-data-sm min-w-0 truncate rounded-sm text-accent hover:underline"
									title="Open {subject}"
									onclick={() => open(target)}
								>
									{subject}
								</button>
							{:else if subject}
								<span class="type-data-sm min-w-0 truncate text-text-secondary">{subject}</span>
							{/if}
							<span class="ml-auto"></span>
							<span class="type-caption shrink-0 text-text-tertiary">{firingSince(alert.activeAt)}</span>
							{#if canOpenGrafana(endpoint)}
								{@const ep = endpoint}
								<button
									type="button"
									class="focus-ring rounded-sm text-text-tertiary hover:text-text-secondary"
									aria-label="Open {alert.name} in Grafana"
									title="Open in Grafana"
									onclick={() => void grafana(ep, alert)}
								>
									<ExternalLink class="h-3 w-3" />
								</button>
							{/if}
						</div>
						{#if alert.summary}
							<p class="type-caption truncate pl-3.5 {muted ? 'text-text-disabled' : 'text-text-tertiary'}" title={alert.summary}>
								{alert.summary}
							</p>
						{/if}
					</div>
				{/each}
				{#if alerts.length > SHOWN}
					<p class="type-caption px-1.5 pt-1 text-text-disabled">and {alerts.length - SHOWN} more</p>
				{/if}
			</div>
		{/if}
	</div>
{:else if hint}
	<PrometheusHint title="Alerts" text={CLUSTER_HINT} testid="overview-prometheus-hint" />
{/if}
