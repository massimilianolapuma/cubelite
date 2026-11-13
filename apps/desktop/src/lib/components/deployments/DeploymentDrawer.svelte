<script lang="ts">
	import { EMPTY } from '#lib/empty.ts';
	import FileCode from '@lucide/svelte/icons/file-code';
	import FileText from '@lucide/svelte/icons/file-text';
	import RotateCw from '@lucide/svelte/icons/rotate-cw';
	import { formatAge } from '#lib/age.ts';
	import { matchesSelector } from '#lib/k8s-match.ts';
	import ReplicaStepper from '#lib/components/deployments/ReplicaStepper.svelte';
	import ContainerResourceRows from '#lib/components/resources/ContainerResourceRows.svelte';
	import { containerRows } from '#lib/container-usage.ts';
	import Button from '#lib/components/ui/Button.svelte';
	import Drawer from '#lib/components/ui/Drawer.svelte';
	import FactRows from '#lib/components/ui/FactRows.svelte';
	import ImageRef from '#lib/components/ui/ImageRef.svelte';
	import YamlModal from '#lib/components/YamlModal.svelte';
	import StatCard from '#lib/components/ui/StatCard.svelte';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';
	import StatusHero from '#lib/components/ui/StatusHero.svelte';
	import MetricsSection from '#lib/components/metrics/MetricsSection.svelte';
	import WorkloadLinks from '#lib/components/integrations/WorkloadLinks.svelte';
	import { deploymentStatus, podGlyph, podStatusLabel, toneGlyph } from '#lib/status.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { logs } from '#lib/stores/logs.svelte.ts';
	import { mutations } from '#lib/stores/mutations.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';
	import type { DeploymentInfo } from '#lib/tauri.ts';
	import type { Snippet } from 'svelte';
	import { PANEL_CARD, PANEL_SECTION } from '#lib/ui-classes.ts';

	let { deployment, onClose }: { deployment: DeploymentInfo; onClose: () => void } = $props();

	const status = $derived(deploymentStatus(deployment));
	const restarting = $derived(mutations.isRestarting(deployment.namespace, deployment.name));
	let yamlOpen = $state(false);
	const selectorLabel = $derived(
		Object.entries(deployment.selector)
			.map(([k, v]) => `${k}=${v}`)
			.join(', ')
	);
	const facts = $derived<[string, string | Snippet | null][]>([
		['Namespace', deployment.namespace],
		['Age', formatAge(deployment.creation_timestamp)],
		[deployment.images.length > 1 ? 'Images' : 'Image', deployment.images.length > 0 ? imageLines : null],
		['Selector', selectorLabel || null],
		['Strategy', deployment.strategy]
	]);

	// Child pods matched via the deployment's label selector.
	const childPods = $derived(
		resources.pods.filter(
			(p) => p.namespace === deployment.namespace && matchesSelector(p.labels, deployment.selector)
		)
	);

	const podsKnown = $derived(resources.mainLoaded && resources.listError('pods') === null);

	// Requests, limits and usage per template container (#652). Usage is the
	// highest among the deployment's pods that run the template's limits: the
	// one closest to its limit.
	const resourceRows = $derived(
		containerRows(
			deployment.containers ?? [],
			childPods.map((p) => ({ containers: p.containers, metrics: resources.metricsFor(p.namespace, p.name) }))
		)
	);
	// Only once metrics-server was asked: before that, it has not failed to answer.
	const usageUnavailable = $derived(resources.metricsKnown && !resources.metricsAvailable);

	const glyphTone = { ok: 'text-success', warn: 'text-warning', err: 'text-error', done: '', unknown: '' } as const;

	function openPod(podName: string) {
		const pod = childPods.find((p) => p.name === podName);
		if (!pod) return;
		onClose();
		app.navigate('pods');
		app.selectedPod = pod;
	}

	function openLogs() {
		// The deployment's pods, live and in history (#529); set before
		// closing, which drops the panel's deployment.
		logs.scope = {
			namespace: deployment.namespace,
			workload: { kind: 'deployment', name: deployment.name }
		};
		onClose();
		app.navigate('logs');
	}
</script>

<!-- One image per line, each with its tag apart from its repository (#648). -->
{#snippet imageLines()}
	<span class="flex flex-col items-end gap-0.5">
		{#each deployment.images as image, i (i)}
			<ImageRef {image} align="end" />
		{/each}
	</span>
{/snippet}

<Drawer kind="Deployment" title={deployment.name} {onClose} onPrimary={openLogs}>
	<div class="flex flex-col gap-4">
		<StatusHero
			state={toneGlyph(status.tone)}
			label={status.label}
			reason={status.tone === 'ok'
				? undefined
				: `${deployment.ready_replicas} of ${deployment.replicas} replicas ready`}
		/>

		<WorkloadLinks
			namespace={deployment.namespace}
			workload={{ kind: 'deployment', name: deployment.name }}
		/>

		<div class="grid grid-cols-2 gap-2">
			<StatCard
				surface="top"
				label="Ready"
				value="{deployment.ready_replicas}/{deployment.replicas}"
				tone={status.tone === 'ok' ? undefined : 'warn'}
			/>
			<!-- A count only once the pods answered: a zero would read as "no pods". -->
			<StatCard surface="top" label="Pods" value={podsKnown ? childPods.length : EMPTY} />
		</div>

		<div>
			<div class={PANEL_SECTION}>Replicas</div>
			<ReplicaStepper {deployment} />
		</div>

		{#if resourceRows.length > 0}
			<div data-section="resources">
				<div class={PANEL_SECTION}>Resources</div>
				<div class="flex flex-col gap-0.5">
					{#each resourceRows as container (container.name)}
						<div class="{PANEL_CARD} flex flex-col gap-2 px-3 py-2" data-container={container.name}>
							<div class="flex min-w-0 items-baseline gap-2">
								<span class="type-data-sm min-w-0 truncate text-text" title={container.name}>{container.name}</span>
								{#if container.sidecar}
									<span class="type-body-sm shrink-0 text-text-muted">sidecar</span>
								{/if}
							</div>
							<ContainerResourceRows rows={container.rows} />
						</div>
					{/each}
				</div>
				{#if usageUnavailable}
					<p class="type-body-sm mt-2 text-text-muted">Usage unavailable: metrics-server did not answer.</p>
				{/if}
			</div>
		{/if}

		<FactRows {facts} />

		{#if deployment.conditions.length > 0}
			<div>
				<div class={PANEL_SECTION}>Conditions</div>
				<div class="flex flex-col gap-0.5">
					{#each deployment.conditions as condition (condition.condition_type)}
						<!-- True is not always good news (ReplicaFailure): the status is a word,
						     and anything but True stands out by weight, not by a colour. -->
						<div class="{PANEL_CARD} px-3 py-2" data-condition={condition.status}>
							<div class="flex items-center gap-2">
								<span class="type-body flex-1 text-text">{condition.condition_type}</span>
								<span class="type-data-sm {condition.status === 'True' ? 'text-text-muted' : 'font-semibold text-text'}">
									{condition.status}
								</span>
							</div>
							{#if condition.reason}
								<div class="type-body-sm mt-0.5 text-text-muted">{condition.reason}</div>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<MetricsSection namespace={deployment.namespace} workload={{ kind: 'deployment', name: deployment.name }} />

		<div>
			<div class={PANEL_SECTION}>Pods</div>
			{#if childPods.length === 0}
				<p class="type-body-sm text-text-muted">No pods matched to this deployment.</p>
			{:else}
				<div class="flex flex-col gap-0.5">
					{#each childPods as pod (pod.name)}
						{@const glyph = podGlyph(pod)}
						<button
							type="button"
							class="focus-ring-inset {PANEL_CARD} flex w-full items-center gap-2 px-3 py-2 text-left hover:brightness-110"
							onclick={() => openPod(pod.name)}
						>
							<StatusGlyph state={glyph} class={glyphTone[glyph]} />
							<span class="type-data-sm min-w-0 flex-1 truncate text-text" title={pod.name}>{pod.name}</span>
							<span class="type-body-sm shrink-0 text-text-muted">{podStatusLabel(pod)}</span>
						</button>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	{#snippet footer()}
		<Button variant="primary" size="primary" onclick={openLogs}>
			{#snippet icon()}<FileText class="h-4 w-4" aria-hidden="true" />{/snippet}
			Logs
		</Button>
		<Button variant="tonal" iconOnly label="YAML" title="View YAML" onclick={() => (yamlOpen = true)}>
			{#snippet icon()}<FileCode class="h-4 w-4" aria-hidden="true" />{/snippet}
		</Button>
		<Button
			variant="tonal"
			pending={restarting}
			onclick={() => void mutations.restartDeployment(deployment.namespace, deployment.name)}
		>
			{#snippet icon()}<RotateCw class="h-4 w-4" aria-hidden="true" />{/snippet}
			Rollout Restart
		</Button>
	{/snippet}
</Drawer>

{#if yamlOpen}
	<YamlModal
		resourceType="deployment"
		namespace={deployment.namespace}
		name={deployment.name}
		onClose={() => (yamlOpen = false)}
	/>
{/if}
