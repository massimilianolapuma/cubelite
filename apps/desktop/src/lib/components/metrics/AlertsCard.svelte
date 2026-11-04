<script lang="ts">
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import PrometheusHint from '#lib/components/metrics/PrometheusHint.svelte';
	import {
		CLUSTER_HINT,
		alertSubject,
		alertTarget,
		alertTone,
		firingSince,
		type AlertTarget
	} from '#lib/host-metrics.ts';
	import { canOpenGrafana, openGrafanaQueries, showsIntegrationHint } from '#lib/integration-links.ts';
	import { toneColor } from '#lib/status.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { prometheus } from '#lib/stores/prometheus.svelte.ts';
	import { promOverview } from '#lib/stores/promOverview.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';
	import { settings } from '#lib/stores/settings.svelte.ts';
	import type { Alert } from '#lib/tauri.ts';

	// Firing alerts from Prometheus in the Overview (#530): severity, name,
	// what it is about (a link to the pod or node when it can be resolved),
	// summary, firing since, and Open in Grafana on the alert's expression.
	const endpoint = $derived(prometheus.active);
	const hint = $derived(showsIntegrationHint(endpoint, settings.integrationHints.value));
	const alerts = $derived(promOverview.alerts);
	const SHOWN = 8;

	function open(target: AlertTarget) {
		if (target.kind === 'pod') {
			app.navigate('pods');
			app.selectedPod = target.pod;
		} else {
			app.navigate('nodes');
			app.selectedNode = target.name;
		}
	}

	function grafana(alert: Alert) {
		const ep = endpoint;
		if (canOpenGrafana(ep)) void openGrafanaQueries(ep, [alert.expr], '1h');
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
					aria-label="{alerts.length} firing alerts"
				>
					{alerts.length}
				</span>
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
				{#each alerts.slice(0, SHOWN) as alert, i (i)}
					{@const target = alertTarget(alert, resources.pods)}
					{@const subject = alertSubject(alert)}
					<div class="flex flex-col rounded-md px-1.5 py-1 hover:bg-surface-row-hover" data-testid="alert-row">
						<div class="flex items-center gap-2">
							<span
								class="h-1.5 w-1.5 shrink-0 rounded-full"
								style="background: {toneColor[alertTone(alert.severity)]};"
							></span>
							<span class="type-data-sm shrink-0 text-text-data-bright">{alert.name}</span>
							<span class="type-caption shrink-0" style="color: {toneColor[alertTone(alert.severity)]};">
								{alert.severity ?? '—'}
							</span>
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
								<button
									type="button"
									class="focus-ring rounded-sm text-text-tertiary hover:text-text-secondary"
									aria-label="Open {alert.name} in Grafana"
									title="Open in Grafana"
									onclick={() => grafana(alert)}
								>
									<ExternalLink class="h-3 w-3" />
								</button>
							{/if}
						</div>
						{#if alert.summary}
							<p class="type-caption truncate pl-3.5 text-text-tertiary" title={alert.summary}>{alert.summary}</p>
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
