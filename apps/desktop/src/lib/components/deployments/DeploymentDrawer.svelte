<script lang="ts">
	import FileText from '@lucide/svelte/icons/file-text';
	import RotateCw from '@lucide/svelte/icons/rotate-cw';
	import Drawer from '$lib/components/ui/Drawer.svelte';
	import StatusPill from '$lib/components/ui/StatusPill.svelte';
	import { deploymentStatus, podStatusLabel, podTone, toneColor } from '$lib/status';
	import { app } from '$lib/stores/app.svelte';
	import { resources } from '$lib/stores/resources.svelte';
	import type { DeploymentInfo } from '$lib/tauri';

	let { deployment, onClose }: { deployment: DeploymentInfo; onClose: () => void } = $props();

	const disabledTitle = 'Requires backend support';
	const status = $derived(deploymentStatus(deployment));
	const meta = $derived<[string, string][]>([
		['Namespace', deployment.namespace],
		['Replicas', `${deployment.ready_replicas}/${deployment.replicas}`],
		['Age', '—'],
		['Image', '—'],
		['Selector', '—'],
		['Strategy', '—']
	]);

	// Best-effort child pods: same namespace, ReplicaSet-style name prefix.
	const childPods = $derived(
		resources.pods.filter(
			(p) => p.namespace === deployment.namespace && p.name.startsWith(`${deployment.name}-`)
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
				app.navigate('logs');
			}}
		>
			<FileText class="h-3 w-3" />
			Logs
		</button>
		<button
			type="button"
			disabled
			title={disabledTitle}
			class="type-body flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md border border-border-default bg-surface-raised text-text-tertiary opacity-45"
		>
			<RotateCw class="h-3 w-3" />
			Rollout Restart
		</button>
	{/snippet}
</Drawer>
