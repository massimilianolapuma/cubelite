<script lang="ts">
	import FileCode from '@lucide/svelte/icons/file-code';
	import FileText from '@lucide/svelte/icons/file-text';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import RotateCw from '@lucide/svelte/icons/rotate-cw';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { formatAge } from '$lib/age';
	import Drawer from '$lib/components/ui/Drawer.svelte';
	import YamlModal from '$lib/components/YamlModal.svelte';
	import MeterBar from '$lib/components/ui/MeterBar.svelte';
	import StatusPill from '$lib/components/ui/StatusPill.svelte';
	import { podStatusLabel, podTone } from '$lib/status';
	import { app } from '$lib/stores/app.svelte';
	import { logs } from '$lib/stores/logs.svelte';
	import { mutations } from '$lib/stores/mutations.svelte';
	import { resources } from '$lib/stores/resources.svelte';
	import { formatBytes, formatCpu, percentOf } from '$lib/units';
	import type { PodInfo } from '$lib/tauri';

	let {
		pod,
		onClose,
		onDelete
	}: { pod: PodInfo; onClose: () => void; onDelete?: (pod: PodInfo) => void } = $props();

	const restarting = $derived(mutations.isDeleting(pod.namespace, pod.name));
	let yamlOpen = $state(false);

	async function restart() {
		// A pod "restart" is a delete; the owning controller recreates it.
		const ok = await mutations.deletePod(pod.namespace, pod.name);
		if (ok) onClose();
	}
	const meta = $derived<[string, string][]>([
		['Namespace', pod.namespace],
		['Node', pod.node ?? '—'],
		['Age', formatAge(pod.creation_timestamp)],
		['Restarts', String(pod.restarts)],
		['Pod IP', pod.pod_ip ?? '—'],
		['QoS', pod.qos_class ?? '—']
	]);

	const usage = $derived(resources.metricsFor(pod.namespace, pod.name));
	// Bars are relative to the allocatable capacity of the pod's node.
	const nodeCapacity = $derived(resources.nodes.find((n) => n.name === pod.node) ?? null);

	const pillTone = $derived.by(() => {
		const tone = podTone(pod);
		return tone === 'neutral' ? 'neutral' : tone;
	});
</script>

<Drawer title={pod.name} {onClose}>
	<div class="flex flex-col gap-4">
		<div>
			<StatusPill label={podStatusLabel(pod)} tone={pillTone} />
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

		{#if pod.containers.length > 0}
			<div>
				<div class="type-section mb-1.5 text-text-tertiary">Containers</div>
				<div class="overflow-hidden rounded-lg border border-border-faint">
					{#each pod.containers as container (container.name)}
						<div class="flex items-center gap-2 border-b border-border-faint bg-surface-surface px-2.5 py-1.5 last:border-b-0">
							<span
								class="h-1.5 w-1.5 shrink-0 rounded-full"
								style="background: {container.ready
									? 'var(--color-status-ok)'
									: 'var(--color-status-warn)'};"
							></span>
							<span class="type-data-sm shrink-0 text-text-secondary">{container.name}</span>
							<span class="type-caption min-w-0 flex-1 truncate text-right text-text-tertiary">
								{container.image ?? ''}
							</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<div class="flex flex-col gap-2 rounded-lg border border-border-faint bg-surface-surface p-3">
			<MeterBar
				label="CPU"
				percent={usage && nodeCapacity
					? percentOf(usage.cpu_millis, nodeCapacity.cpu_allocatable_millis)
					: null}
			/>
			<MeterBar
				label="MEM"
				percent={usage && nodeCapacity
					? percentOf(usage.memory_bytes, nodeCapacity.memory_allocatable_bytes)
					: null}
			/>
			{#if usage}
				<p class="type-caption text-text-tertiary">
					{formatCpu(usage.cpu_millis)} CPU · {formatBytes(usage.memory_bytes)} — share of node allocatable
				</p>
			{:else}
				<p class="type-caption text-text-disabled">
					metrics unavailable — metrics-server not detected in this cluster
				</p>
			{/if}
		</div>
	</div>

	{#snippet footer()}
		<button
			type="button"
			class="focus-ring type-body flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md bg-accent text-surface-window hover:brightness-110"
			onclick={() => {
				onClose();
				logs.textFilter = pod.name;
				app.navigate('logs');
			}}
		>
			<FileText class="h-3 w-3" />
			Logs
		</button>
		<button
			type="button"
			aria-label="YAML"
			title="View YAML"
			class="focus-ring type-body flex h-7 items-center justify-center gap-1.5 rounded-md border border-border-default bg-surface-raised px-2.5 text-text-secondary hover:brightness-110"
			onclick={() => (yamlOpen = true)}
		>
			<FileCode class="h-3 w-3" />
		</button>
		<button
			type="button"
			disabled={restarting}
			class="focus-ring type-body flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md border border-border-default bg-surface-raised text-text-secondary hover:brightness-110 disabled:opacity-45"
			onclick={() => void restart()}
		>
			{#if restarting}
				<LoaderCircle class="h-3 w-3 animate-spin" />
			{:else}
				<RotateCw class="h-3 w-3" />
			{/if}
			Restart
		</button>
		<button
			type="button"
			class="focus-ring type-body flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md border text-status-err hover:brightness-110"
			style="border-color: color-mix(in srgb, var(--color-status-err) 40%, transparent);"
			onclick={() => onDelete?.(pod)}
		>
			<Trash2 class="h-3 w-3" />
			Delete
		</button>
	{/snippet}
</Drawer>

{#if yamlOpen}
	<YamlModal
		resourceType="pod"
		namespace={pod.namespace}
		name={pod.name}
		onClose={() => (yamlOpen = false)}
	/>
{/if}
