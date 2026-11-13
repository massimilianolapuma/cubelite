<script lang="ts">
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import Button from '#lib/components/ui/Button.svelte';
	import SegmentedControl from '#lib/components/ui/SegmentedControl.svelte';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';
	import { EMPTY } from '#lib/empty.ts';
	import {
		fieldFinding,
		requestHint,
		type EditableContainer,
		type FieldKey
	} from '#lib/resource-editor.ts';
	import { resourceEditor } from '#lib/stores/resourceEditor.svelte.ts';
	import type { ResourceFacts, ResourceField, ResourceName } from '#lib/tauri.ts';
	import { PANEL_CARD, FIELD_BASE } from '#lib/ui-classes.ts';
	import { formatBytes, formatCpu } from '#lib/units.ts';

	// One container of the editor (spec #650 §3.2 step 1): its four fields, what it
	// uses now, the quick steps and reset. Fields are plain text: what is typed goes
	// to the core as it is, and everything said about a value comes from its check.
	let { container, facts }: { container: EditableContainer; facts: ResourceFacts } = $props();

	const uid = $props.id();
	const ROWS: readonly { resource: ResourceName; label: string; name: string }[] = [
		{ resource: 'cpu', label: 'CPU', name: 'CPU' },
		{ resource: 'memory', label: 'Memory', name: 'memory' }
	];
	const COLUMNS: readonly ResourceField[] = ['request', 'limit'];
	const STEPS: readonly { factor: 1.25 | 1.5 | 2; text: string; verb: (f: string) => string }[] = [
		{ factor: 1.25, text: '+25%', verb: (f) => `Raise ${f} of ${container.name} by 25%` },
		{ factor: 1.5, text: '+50%', verb: (f) => `Raise ${f} of ${container.name} by 50%` },
		{ factor: 2, text: '×2', verb: (f) => `Double ${f} of ${container.name}` }
	];

	/**
	 * The field the quick steps act on (plan, call 2): chosen in the control
	 * before the steps, and moved to a field that takes focus; the memory limit
	 * until then.
	 */
	let stepField = $state<FieldKey>('memory.limit');
	const TARGETS: { value: FieldKey; label: string }[] = [
		{ value: 'cpu.request', label: 'CPU request' },
		{ value: 'cpu.limit', label: 'CPU limit' },
		{ value: 'memory.request', label: 'Memory request' },
		{ value: 'memory.limit', label: 'Memory limit' }
	];
	const stepParts = $derived(stepField.split('.') as [ResourceName, ResourceField]);
	const stepLabel = $derived(`${stepParts[0] === 'cpu' ? 'CPU' : 'memory'} ${stepParts[1]}`);
	// A step is worked out from the cluster's value; without one there is nothing to raise.
	const stepDisabled = $derived(container.resources[stepParts[0]][stepParts[1]]?.amount == null);

	const draft = $derived(resourceEditor.drafts[container.name]);
	const editable = $derived(resourceEditor.step === 'edit' && !resourceEditor.applying);

	function clusterText(resource: ResourceName, field: ResourceField): string {
		return container.resources[resource][field]?.text ?? '';
	}
	function isChanged(resource: ResourceName, field: ResourceField): boolean {
		return (draft?.[`${resource}.${field}`] ?? '').trim() !== clusterText(resource, field);
	}
	const anyChanged = $derived(
		ROWS.some((r) => COLUMNS.some((f) => isChanged(r.resource, f)))
	);

	// What the container uses now: the highest of the workload's pods (the one
	// closest to its limit); an empty value without a sample.
	const now = $derived.by(() => {
		let cpu: number | null = null;
		let memory: number | null = null;
		for (const pod of facts.pods) {
			for (const u of pod.usage) {
				if (u.name !== container.name) continue;
				cpu = Math.max(cpu ?? 0, u.cpu_millis);
				memory = Math.max(memory ?? 0, u.memory_bytes);
			}
		}
		return {
			cpu: cpu === null ? EMPTY : formatCpu(cpu),
			memory: memory === null ? EMPTY : formatBytes(memory)
		};
	});

	const blocked = $derived(
		ROWS.flatMap((r) =>
			COLUMNS.map((f) => {
				const key: FieldKey = `${r.resource}.${f}`;
				return { key, finding: fieldFinding(resourceEditor.evaluation, container.name, key) };
			})
		).filter((b) => b.finding !== null)
	);

	const messageId = (key: FieldKey) => `${uid}-${key.replace('.', '-')}-message`;
	const wasId = (key: FieldKey) => `${uid}-${key.replace('.', '-')}-was`;
	const nameId = `${uid}-name`;
</script>

<div class="{PANEL_CARD} flex flex-col gap-2 px-3 pt-2.5 pb-1" role="group" aria-labelledby={nameId} data-editor-container={container.name}>
	<!-- A long name wraps whole; "(unchanged)" keeps its room, so the name never reflows when it goes. -->
	<div class="flex items-baseline gap-2">
		<h3 class="min-w-0 flex-1 break-words">
			<span id={nameId} class="type-data-sm text-text">{container.name}</span>
			{#if container.sidecar}
				<span class="type-body-sm ml-1.5 whitespace-nowrap text-text-muted">sidecar</span>
			{/if}
		</h3>
		<span class="type-body-sm shrink-0 text-text-muted {anyChanged ? 'invisible' : ''}">(unchanged)</span>
	</div>

	<!-- Four fields and what is used now. Every track has a fixed or shared width, so a
	     changed mark, "was …" or an invalid field never moves a field. -->
	<div class="grid grid-cols-[3.75rem_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5">
		<span aria-hidden="true"></span>
		<span class="type-label text-text-muted">Request</span>
		<span class="type-label text-text-muted">Limit</span>
		<span class="type-label text-right whitespace-nowrap text-text-muted">Now (highest pod)</span>

		{#each ROWS as row (row.resource)}
			<span class="type-label text-text-muted">{row.label}</span>
			{#each COLUMNS as column (column)}
				{@const key = `${row.resource}.${column}` as FieldKey}
				{@const changed = isChanged(row.resource, column)}
				{@const invalid = blocked.some((b) => b.key === key)}
				{@const before = clusterText(row.resource, column)}
				<div class="flex min-w-0 items-center gap-1.5" data-field={key} data-changed={changed}>
					<input
						type="text"
						spellcheck="false"
						autocomplete="off"
						aria-label="{container.name} {row.name} {column}"
						aria-invalid={invalid ? 'true' : undefined}
						aria-describedby={[changed ? wasId(key) : null, invalid ? messageId(key) : null]
							.filter((id) => id !== null)
							.join(' ') || undefined}
						placeholder={column === 'request'
							? requestHint(facts, resourceEditor.drafts, container.name, row.resource) || EMPTY
							: EMPTY}
						value={draft?.[key] ?? ''}
						disabled={!editable}
						oninput={(e) => resourceEditor.setField(container.name, key, e.currentTarget.value)}
						onfocus={() => (stepField = key)}
						class="{FIELD_BASE} w-26 shrink-0 font-mono aria-invalid:border-error {changed ? 'font-semibold' : ''}"
					/>
					<!-- The mark: a square for a value the check refuses, a triangle for a changed one. -->
					<span class="type-body-sm flex min-w-0 items-center gap-1 text-text-muted">
						{#if invalid}
							<StatusGlyph state="err" size={8} class="text-error" />
						{:else if changed}
							<StatusGlyph state="warn" size={8} class="text-warning" />
						{/if}
						{#if changed}
							<span id={wasId(key)} class="truncate" title="was {before || EMPTY}">was {before || EMPTY}</span>
						{/if}
					</span>
				</div>
			{/each}
			<span
				class="type-data-sm text-right text-text-muted"
				data-testid="now-{row.resource}"
				title="{row.label} used now, highest pod"
			>
				<span class="sr-only">now </span>{now[row.resource]}
			</span>
		{/each}
	</div>

	<!-- The choice on its own line (one Tab stop, arrows move it), then the steps
	     that act on it and reset: the two never share a line, so neither breaks up
	     at any width. Without a value on the cluster the steps say why they are off. -->
	<div class="flex flex-col items-start gap-2">
		<SegmentedControl
			segments={TARGETS.map((t) => ({ ...t, disabled: !editable }))}
			bind:value={stepField}
			label="Field the steps raise, {container.name}"
			dense
			outlined
			arrowKeys
		/>
		<div class="flex w-full flex-wrap items-center gap-1.5">
			{#each STEPS as step (step.factor)}
				<Button
					variant="tonal"
					size="inline"
					aria-label={step.verb(stepLabel)}
					disabled={!editable || stepDisabled}
					onclick={() => resourceEditor.quickStep(container.name, stepField, step.factor)}
				>
					{step.text}
				</Button>
			{/each}
			{#if stepDisabled}
				<span class="type-body-sm ml-1 min-w-0 text-text-muted">no value on the cluster to step from</span>
			{/if}
			<Button
				variant="text"
				size="inline"
				class="ml-auto"
				aria-label="Reset {container.name} to the cluster's values"
				disabled={!editable || !anyChanged}
				onclick={() => resourceEditor.reset(container.name)}
			>
				{#snippet icon()}<RotateCcw class="h-3.5 w-3.5" aria-hidden="true" />{/snippet}
				reset
			</Button>
		</div>
	</div>

	<!-- What the check refuses about a field of this container. One line is always
	     kept, so a message arriving with the check moves nothing above it. -->
	<div class="flex min-h-5 flex-col gap-1">
		{#each blocked as b (b.key)}
			<p id={messageId(b.key)} class="type-body-sm flex items-start gap-2 text-text">
				<StatusGlyph state="err" class="mt-1 text-error" />
				<span class="min-w-0 break-words"><span class="sr-only">Blocked:</span>{` ${b.finding?.message ?? ''}`}</span>
			</p>
		{/each}
	</div>
</div>
