<script lang="ts">
	import { EMPTY } from '#lib/empty.ts';
	import FileCode from '@lucide/svelte/icons/file-code';
	import FileText from '@lucide/svelte/icons/file-text';
	import RotateCw from '@lucide/svelte/icons/rotate-cw';
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { formatAge } from '#lib/age.ts';
	import Button from '#lib/components/ui/Button.svelte';
	import Drawer from '#lib/components/ui/Drawer.svelte';
	import FactRows from '#lib/components/ui/FactRows.svelte';
	import ImageRef from '#lib/components/ui/ImageRef.svelte';
	import YamlModal from '#lib/components/YamlModal.svelte';
	import ShellModal from '#lib/components/pods/ShellModal.svelte';
	import MeterBar from '#lib/components/ui/MeterBar.svelte';
	import ContainerResourceRows from '#lib/components/resources/ContainerResourceRows.svelte';
	import { containerRows } from '#lib/container-usage.ts';
	import MetricsSection from '#lib/components/metrics/MetricsSection.svelte';
	import WorkloadLinks from '#lib/components/integrations/WorkloadLinks.svelte';
	import StatCard from '#lib/components/ui/StatCard.svelte';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';
	import StatusHero from '#lib/components/ui/StatusHero.svelte';
	import { podGlyph, podStatusLabel } from '#lib/status.ts';
	import { logPanel } from '#lib/stores/logPanel.svelte.ts';
	import { mutations } from '#lib/stores/mutations.svelte.ts';
	import { portforward } from '#lib/stores/portforward.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';
	import { parsePort, resolveLocalPort } from '#lib/ports.ts';
	import { formatBytes, formatCpu, percentOf } from '#lib/units.ts';
	import type { PodInfo } from '#lib/tauri.ts';
	import { FIELD, PANEL_CARD, PANEL_SECTION } from '#lib/ui-classes.ts';

	let {
		pod,
		onClose,
		onDelete
	}: { pod: PodInfo; onClose: () => void; onDelete?: (pod: PodInfo) => void } = $props();

	const restarting = $derived(mutations.isDeleting(pod.namespace, pod.name));
	let yamlOpen = $state(false);
	let shellOpen = $state(false);

	// Port-forward inputs. Empty local mirrors remote; "auto"/"0" lets the
	// OS assign a free port.
	let remotePortText = $state('80');
	let localPortText = $state('');
	let forwarding = $state(false);
	const remotePort = $derived(parsePort(remotePortText));
	const localPort = $derived(
		remotePort === null ? null : resolveLocalPort(localPortText, remotePort)
	);
	const forwardSessions = $derived(portforward.sessionsFor(pod.namespace, pod.name));

	async function forward() {
		if (remotePort === null || localPort === null || forwarding) return;
		forwarding = true;
		try {
			await portforward.start(pod.namespace, pod.name, localPort, remotePort);
		} finally {
			forwarding = false;
		}
	}

	async function restart() {
		// A pod "restart" is a delete; the owning controller recreates it.
		const ok = await mutations.deletePod(pod.namespace, pod.name);
		if (ok) onClose();
	}

	function openLogs() {
		void logPanel.openFor({ namespace: pod.namespace, name: pod.name });
	}

	// Not named `state`: that would shadow the `$state` rune.
	const glyph = $derived(restarting ? 'unknown' : podGlyph(pod));
	// What explains an attention or failure state, from what the list already knows.
	const reason = $derived.by(() => {
		if (glyph !== 'warn' && glyph !== 'err') return undefined;
		const ready = `${pod.ready_containers} of ${pod.total_containers} containers ready`;
		return pod.restarts > 0 ? `${ready}, ${pod.restarts} restart${pod.restarts === 1 ? '' : 's'}` : ready;
	});

	const usage = $derived(resources.metricsFor(pod.namespace, pod.name));
	// Requests, limits and this pod's usage per container (#652), by name.
	// Once metrics-server answered, a container without a sample says "no sample".
	const resourceRows = $derived(
		new Map(
			containerRows(pod.containers, [{ containers: pod.containers, metrics: usage }], {
				expectSample: resources.podMetricsAvailable
			}).map((c) => [c.name, c.rows])
		)
	);
	// Bars are relative to the allocatable capacity of the pod's node.
	const nodeCapacity = $derived(resources.nodes.find((n) => n.name === pod.node) ?? null);

	const facts = $derived<[string, string | null][]>([
		['Namespace', pod.namespace],
		['Node', pod.node],
		['Age', formatAge(pod.creation_timestamp)],
		['Ready', `${pod.ready_containers}/${pod.total_containers}`],
		['Pod IP', pod.pod_ip],
		['QoS', pod.qos_class]
	]);

	const labelEntries = $derived(
		Object.entries(pod.labels ?? {}).sort(([a], [b]) => a.localeCompare(b))
	);
</script>

<Drawer kind="Pod" title={pod.name} {onClose} onPrimary={openLogs}>
	<div class="flex flex-col gap-4">
		<StatusHero state={glyph} label={restarting ? 'Terminating…' : podStatusLabel(pod)} {reason} />

		<WorkloadLinks namespace={pod.namespace} workload={{ kind: 'pod', name: pod.name }} />

		<div class="grid grid-cols-2 gap-2">
			<!-- A completed pod's restarts are history (Tonal §3 #7): no warning. -->
			<StatCard
				surface="top"
				label="Restarts"
				value={pod.restarts}
				tone={pod.phase !== 'Succeeded' && pod.restarts > 3 ? 'warn' : undefined}
			/>
			<StatCard surface="top" label="Memory" value={usage ? formatBytes(usage.memory_bytes) : EMPTY} />
		</div>

		<FactRows {facts} />

		{#if pod.containers.length > 0}
			<div>
				<div class={PANEL_SECTION}>Containers</div>
				<div class="flex flex-col gap-0.5">
					{#each pod.containers as container (container.name)}
						<!-- Two lines: a long name and a long image each get the row's width; the image's tag never gives way. -->
						<div class="{PANEL_CARD} flex flex-col gap-0.5 px-3 py-2" data-container={container.name}>
							<div class="flex min-w-0 items-center gap-2">
								<StatusGlyph state={container.ready ? 'ok' : 'warn'} class={container.ready ? 'text-success' : 'text-warning'} />
								<span class="type-data-sm min-w-0 flex-1 truncate text-text" title={container.name}>{container.name}</span>
								<span class="type-body-sm shrink-0 {container.ready ? 'text-text-muted' : 'font-semibold text-text'}">
									{container.ready ? 'ready' : 'not ready'}
								</span>
							</div>
							{#if container.image}
								<ImageRef image={container.image} />
							{/if}
							{#if resourceRows.has(container.name)}
								<div class="mt-1.5">
									<ContainerResourceRows rows={resourceRows.get(container.name) ?? []} />
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<div class="{PANEL_CARD} flex flex-col gap-2 p-3">
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
				<p class="type-body-sm text-text-muted">
					{formatCpu(usage.cpu_millis)} CPU · {formatBytes(usage.memory_bytes)}: share of node allocatable
				</p>
			{:else}
				<p class="type-body-sm text-text-muted">
					Metrics unavailable: metrics-server did not answer for this pod.
				</p>
			{/if}
		</div>

		<MetricsSection namespace={pod.namespace} workload={{ kind: 'pod', name: pod.name }} />

		{#if labelEntries.length > 0}
			<div>
				<div class={PANEL_SECTION}>Labels</div>
				<div class="flex flex-wrap gap-1.5">
					{#each labelEntries as [key, value] (key)}
						<span
							class="type-data-sm max-w-full rounded-md bg-surface-container-top px-2.5 py-0.5 break-all text-text-muted"
							title="{key}={value}"
						>
							{key}={value}
						</span>
					{/each}
				</div>
			</div>
		{/if}

		<div>
			<div class={PANEL_SECTION}>Port forward</div>
			<div class="flex items-center gap-2">
				<input type="text" aria-label="Remote port" bind:value={remotePortText} class="{FIELD} w-20! text-center font-mono" />
				<span class="type-body-sm text-text-muted" aria-hidden="true">→</span>
				<input
					type="text"
					aria-label="Local port"
					placeholder="auto"
					bind:value={localPortText}
					class="{FIELD} w-20! text-center font-mono"
				/>
				<Button
					variant="tonal"
					size="inline"
					pending={forwarding}
					disabled={remotePort === null || localPort === null}
					onclick={() => void forward()}
				>
					Forward
				</Button>
			</div>
			{#if remotePort === null || localPort === null}
				<p class="type-body-sm mt-1.5 flex items-start gap-1.5 text-text" role="alert">
					<StatusGlyph state="err" class="mt-1 text-error" />
					Ports must be numbers between 1 and 65535 (local: empty = remote, "auto" = free port)
				</p>
			{/if}
			{#each forwardSessions as session (session.id)}
				<div class="mt-2 flex items-center gap-2">
					<StatusGlyph state="ok" class="text-success" />
					<span class="type-data-sm flex-1 text-text">
						localhost:{session.localPort} → {session.remotePort}
					</span>
					<Button variant="text" size="inline" onclick={() => void portforward.stop(session.id)}>Stop</Button>
				</div>
			{/each}
		</div>
	</div>

	{#snippet footer()}
		<Button variant="primary" size="primary" title="Open pod logs panel" onclick={openLogs}>
			{#snippet icon()}<FileText class="h-4 w-4" aria-hidden="true" />{/snippet}
			Open logs
		</Button>
		<Button variant="tonal" iconOnly label="Shell" title="Open a shell in this pod" onclick={() => (shellOpen = true)}>
			{#snippet icon()}<SquareTerminal class="h-4 w-4" aria-hidden="true" />{/snippet}
		</Button>
		<Button variant="tonal" iconOnly label="YAML" title="View YAML" onclick={() => (yamlOpen = true)}>
			{#snippet icon()}<FileCode class="h-4 w-4" aria-hidden="true" />{/snippet}
		</Button>
		<Button variant="tonal" pending={restarting} onclick={() => void restart()}>
			{#snippet icon()}<RotateCw class="h-4 w-4" aria-hidden="true" />{/snippet}
			Restart
		</Button>
		<Button variant="danger" onclick={() => onDelete?.(pod)}>
			{#snippet icon()}<Trash2 class="h-4 w-4" aria-hidden="true" />{/snippet}
			Delete
		</Button>
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

{#if shellOpen}
	<ShellModal namespace={pod.namespace} pod={pod.name} onClose={() => (shellOpen = false)} />
{/if}
