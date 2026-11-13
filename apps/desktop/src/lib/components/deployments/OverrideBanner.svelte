<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';
	import { EMPTY } from '#lib/empty.ts';
	import { overrideChanges, overrideDate } from '#lib/resource-editor.ts';
	import { resourceEditor } from '#lib/stores/resourceEditor.svelte.ts';
	import type { DeploymentInfo, OverrideInfo } from '#lib/tauri.ts';
	import { PANEL_CARD } from '#lib/ui-classes.ts';

	// An override made from CubeLite, while it is active (spec #650 §6.2): when,
	// what it changed, and the two ways out. Restore opens the editor on the
	// original values; "Keep these values" removes the mark alone, after asking once.
	let { deployment, override }: { deployment: DeploymentInfo; override: OverrideInfo } = $props();

	const changes = $derived(overrideChanges(override));
	const when = $derived(overrideDate(override.at));

	let asking = $state(false);
	let removing = $state(false);
	let keepButton = $state<HTMLElement | null>(null);
	let cancelButton = $state<HTMLElement | null>(null);

	async function ask(value: boolean) {
		asking = value;
		// The button that was pressed is gone: focus goes to the one that takes its place.
		await tick();
		(value ? cancelButton : keepButton)?.querySelector('button')?.focus();
	}

	async function removeMark() {
		if (removing) return;
		removing = true;
		try {
			const ok = await resourceEditor.keepValues(deployment);
			if (!ok) asking = false;
		} finally {
			removing = false;
		}
	}

	// When the banner goes with the focus in it (the mark removed, the values
	// restored), the focus goes to the Resources section's Adjust, not to the page.
	let root = $state<HTMLElement | null>(null);
	let holdsFocus = false;
	onDestroy(() => {
		if (!holdsFocus) return;
		queueMicrotask(() => {
			const active = document.activeElement;
			if (active === null || active === document.body) {
				document.querySelector<HTMLElement>('[data-resource-adjust]')?.focus();
			}
		});
	});
</script>

<div
	bind:this={root}
	class="{PANEL_CARD} flex flex-col gap-2 px-3 py-2.5"
	data-override-banner
	role="group"
	aria-label="Resources override"
	onfocusin={() => (holdsFocus = true)}
	onfocusout={(e) => {
		// A focus that leaves for another element leaves the banner; one that goes nowhere
		// (the element removed under it) still belongs to it.
		if (e.relatedTarget !== null && !root?.contains(e.relatedTarget as Node)) holdsFocus = false;
	}}
>
	<p class="type-body-sm flex items-center gap-2 font-semibold text-text">
		<StatusGlyph state="warn" class="text-warning" />
		<span>Resources overridden from CubeLite · {when}</span>
	</p>
	<ul role="list" aria-label="Overridden values" class="flex flex-col gap-0.5 pl-[17px]">
		{#each changes as change, i (i)}
			<li class="grid grid-cols-[minmax(0,1fr)_7rem_auto] items-baseline gap-x-3">
				<span class="type-data-sm min-w-0 truncate text-text" title={change.container}>{change.container}</span>
				<span class="type-body-sm text-text-muted">{change.label}</span>
				<span class="type-data-sm text-right whitespace-nowrap text-text">
					{change.before ?? EMPTY} → {change.after ?? EMPTY}
				</span>
			</li>
		{/each}
	</ul>
	{#if asking}
		<div class="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
			<p class="type-body-sm mr-auto text-text">Remove the override mark? The values stay as they are.</p>
			<span bind:this={cancelButton} class="contents">
				<Button variant="text" size="inline" disabled={removing} onclick={() => void ask(false)}>Cancel</Button>
			</span>
			<Button variant="tonal" size="inline" pending={removing} onclick={() => void removeMark()}>Remove mark</Button>
		</div>
	{:else}
		<div class="flex flex-wrap items-center justify-end gap-2">
			<span bind:this={keepButton} class="contents">
				<Button variant="text" size="inline" onclick={() => void ask(true)}>Keep these values</Button>
			</span>
			<Button
				variant="tonal"
				size="inline"
				disabled={resourceEditor.isApplying(deployment.namespace, deployment.name)}
				onclick={() => void resourceEditor.open(deployment, 'restore')}
			>
				Restore
			</Button>
		</div>
	{/if}
</div>
