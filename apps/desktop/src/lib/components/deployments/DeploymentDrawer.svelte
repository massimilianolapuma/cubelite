<script lang="ts">
	import FileText from '@lucide/svelte/icons/file-text';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import RotateCw from '@lucide/svelte/icons/rotate-cw';
	import { formatAge } from '$lib/age';
	import { matchesSelector } from '$lib/k8s-match';
	import Drawer from '$lib/components/ui/Drawer.svelte';
	import StatusPill from '$lib/components/ui/StatusPill.svelte';
	import { deploymentStatus, podStatusLabel, podTone, toneColor } from '$lib/status';
	import { app } from '$lib/stores/app.svelte';
	import { logs } from '$lib/stores/logs.svelte';
	import { mutations } from '$lib/stores/mutations.svelte';
	import { resources } from '$lib/stores/resources.svelte';
	import type { DeploymentInfo } from '$lib/tauri';

	let { deployment, onClose }: { deployment: DeploymentInfo; onClose: () => void } = $props();

	const status = $derived(deploymentStatus(deployment));
	const restarting = $derived(mutations.isRestarting(deployment.namespace, deployment.name));
	const selectorLabel = $derived(
		Object.entries(deployment.selector)
			.map(([k, v]) => `${k}=${v}`)
			.join(', ')
	);
	const meta = $derived<[string, string][]>([
		['Namespace', deployment.namespace],
		['Replicas', `${deployment.ready_replicas}/${deployment.replicas}`],
		['Age', formatAge(deployment.creation_timestamp)],
		['Image', deployment.images.join(', ') || '—'],
		['Selector', selectorLabel || '—'],
		['Strategy', deployment.strategy ?? '—']
	]);

	// Child pods matched via the deployment's label selector.
	const childPods = $derived(
		resources.pods.filter(
			(p) => p.namespace === deployment.namespace && matchesSelector(p.labels, deployment.selector)
		)
	);

	function openPod(podName: string) {
		const pod = childPods.find((p) => p.name === podName);
		if (!pod) return;
		onClose();
		app.navigate('pods');
		app.selectedPod = pod;
	}
</script>

<Drawer title={deployment.name} {onClose}>
	<div class="flex flex-col gap-4">
		<div>
			<StatusPill label={status.label} tone={status.tone} />
		</div>

		<div class="grid grid-cols-2 gap-x-4 gap-y-2.5">
			{#each meta as [label, value] (label)}
				<div>
					<div class="type-colhead mb-0.5">{label}</div>
					<div class="type-data-sm {value === '—' ? 'text-text-disabled' : 'text-text-secondary'}">
						{value}
					</div>
				</div>
			{/each}
		</div>

		{#if deployment.conditions.length > 0}
			<div>
				<div class="type-section mb-1.5 text-text-tertiary">Conditions</div>
				<div class="flex flex-col gap-1.5">
					{#each deployment.conditions as condition (condition.condition_type)}
						<div class="rounded-lg border border-border-faint bg-surface-surface px-2.5 py-1.5">
							<div class="flex items-center gap-2">
								<span class="type-body flex-1 text-text-primary">{condition.condition_type}</span>
								<span
									class="type-data-sm"
									style="color: {condition.status === 'True'
										? 'var(--color-status-ok)'
										: condition.status === 'False'
											? 'var(--color-status-err)'
											: 'var(--color-text-tertiary)'};"
								>
									{condition.status}
								</span>
							</div>
							{#if condition.reason}
								<div class="type-caption mt-0.5 text-text-tertiary">{condition.reason}</div>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<div>
			<div class="type-section mb-1.5 text-text-tertiary">Pods</div>
			{#if childPods.length === 0}
				<p class="type-caption text-text-disabled">No pods matched to this deployment.</p>
			{:else}
				<div class="overflow-hidden rounded-lg border border-border-faint">
					{#each childPods as pod (pod.name)}
						<button
							type="button"
							class="flex w-full items-center gap-2 border-b border-border-faint bg-surface-surface px-2.5 py-1.5 text-left last:border-b-0 hover:bg-surface-row-hover"
							onclick={() => openPod(pod.name)}
						>
							<span
								class="h-1.5 w-1.5 shrink-0 rounded-full"
								style="background: {toneColor[podTone(pod)]};"
							></span>
							<span class="type-data-sm flex-1 truncate text-text-secondary">{pod.name}</span>
							<span class="type-caption text-text-tertiary">{podStatusLabel(pod)}</span>
						</button>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	{#snippet footer()}
		<button
			type="button"
			class="focus-ring type-body flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md bg-accent text-surface-window hover:brightness-110"
			onclick={() => {
				onClose();
				logs.textFilter = deployment.name;
				app.navigate('logs');
			}}
		>
			<FileText class="h-3 w-3" />
			Logs
		</button>
		<button
			type="button"
			disabled={restarting}
			class="focus-ring type-body flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md border border-border-default bg-surface-raised text-text-secondary hover:brightness-110 disabled:opacity-45"
			onclick={() => void mutations.restartDeployment(deployment.namespace, deployment.name)}
		>
			{#if restarting}
				<LoaderCircle class="h-3 w-3 animate-spin" />
			{:else}
				<RotateCw class="h-3 w-3" />
			{/if}
			Rollout Restart
		</button>
	{/snippet}
</Drawer>
