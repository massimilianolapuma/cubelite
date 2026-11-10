<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import NavRow from './NavRow.svelte';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';
	import CustomResources from './CustomResources.svelte';
	import type { NavSection } from '#lib/navigation.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';
	import { sidebar, type OpenSection } from '#lib/stores/sidebar.svelte.ts';

	// All resources (resource-kinds §3): one disclosure per section, one open
	// at a time. ↑/↓ move between section rows, → opens, ← closes. Custom
	// Resources (§5.3) sits right before Observe.
	let { sections }: { sections: NavSection[] } = $props();

	let list = $state<HTMLElement | null>(null);

	function focusSibling(current: HTMLElement, delta: -1 | 1) {
		const toggles = [...(list?.querySelectorAll<HTMLElement>('[data-section-toggle]') ?? [])];
		toggles[toggles.indexOf(current) + delta]?.focus();
	}

	function onKeydown(event: KeyboardEvent, id: OpenSection) {
		const target = event.currentTarget as HTMLElement;
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			focusSibling(target, event.key === 'ArrowDown' ? 1 : -1);
		} else if (event.key === 'ArrowRight') {
			event.preventDefault();
			sidebar.open(id);
		} else if (event.key === 'ArrowLeft') {
			event.preventDefault();
			if (sidebar.openSection === id) sidebar.close();
		}
	}

	const podsNeedAttention = $derived(resources.issuePods.length > 0);
</script>

<!-- Section rows never scroll away; a short window scrolls only the open section's types. -->
<div bind:this={list} class="flex min-h-0 flex-1 flex-col">
	{#each sections as section (section.id)}
		{#if section.id === 'observe'}
			<CustomResources onkeydown={(e) => onKeydown(e, 'custom')} />
		{/if}
		{@const open = sidebar.openSection === section.id}
		{@const alert = !open && podsNeedAttention && section.items.some((i) => i.view === 'pods')}
		<button
			type="button"
			data-section-toggle
			class="focus-ring flex h-(--nav-h) shrink-0 items-center gap-2 rounded-full pr-3.5 pl-2.5 text-left hover:bg-surface-container {open
				? 'text-text'
				: 'text-text-muted'}"
			aria-expanded={open}
			aria-controls="sidebar-section-{section.id}"
			onclick={() => sidebar.toggle(section.id)}
			onkeydown={(e) => onKeydown(e, section.id)}
		>
			<ChevronRight
				class="h-3.5 w-3.5 shrink-0 text-text-subtle transition-transform {open ? 'rotate-90' : ''}"
				aria-hidden="true"
			/>
			<span class="type-body flex-1 truncate {open ? 'font-semibold' : ''}">{section.label}</span>
			{#if alert}
				<span class="shrink-0 text-error"><StatusGlyph state="err" size={8} /></span>
				<span class="sr-only">pods need attention</span>
			{/if}
			<span class="type-data-sm text-text-subtle">{section.items.length}</span>
		</button>
		{#if open}
			<ul id="sidebar-section-{section.id}" aria-label="{section.label} types" class="mb-0.5 min-h-0 overflow-y-auto pl-5">
				{#each section.items as item (item.view)}
					<li><NavRow view={item.view} label={item.label} /></li>
				{/each}
			</ul>
		{/if}
	{/each}
	{#if !sections.some((s) => s.id === 'observe')}
		<CustomResources onkeydown={(e) => onKeydown(e, 'custom')} />
	{/if}
</div>
