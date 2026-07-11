<script lang="ts">
	import FileText from '@lucide/svelte/icons/file-text';
	import RotateCw from '@lucide/svelte/icons/rotate-cw';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Drawer from '$lib/components/ui/Drawer.svelte';
	import MeterBar from '$lib/components/ui/MeterBar.svelte';
	import StatusPill from '$lib/components/ui/StatusPill.svelte';
	import { podStatusLabel, podTone } from '$lib/status';
	import { app } from '$lib/stores/app.svelte';
	import type { PodInfo } from '$lib/tauri';

	let { pod, onClose }: { pod: PodInfo; onClose: () => void } = $props();

	const disabledTitle = 'Requires backend support';
	// Fields the backend does not expose yet render as "—" (layout per spec).
	const meta = $derived<[string, string][]>([
		['Namespace', pod.namespace],
		['Node', '—'],
		['Age', '—'],
		['Restarts', String(pod.restarts)],
		['Pod IP', '—'],
		['QoS', '—']
	]);

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

		<div class="flex flex-col gap-2 rounded-lg border border-border-faint bg-surface-surface p-3">
			<MeterBar label="CPU" percent={null} />
			<MeterBar label="MEM" percent={null} />
			<p class="type-caption text-text-disabled">
				metrics unavailable — requires metrics-server integration
			</p>
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
			Restart
		</button>
		<button
			type="button"
			disabled
			title={disabledTitle}
			class="type-body flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md border text-status-err opacity-45"
			style="border-color: color-mix(in srgb, var(--color-status-err) 40%, transparent);"
		>
			<Trash2 class="h-3 w-3" />
			Delete
		</button>
	{/snippet}
</Drawer>
