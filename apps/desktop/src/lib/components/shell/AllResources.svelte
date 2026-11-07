<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import NavRow from './NavRow.svelte';
	import type { NavSection } from '#lib/navigation.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';
	import { sidebar } from '#lib/stores/sidebar.svelte.ts';

	// All resources (resource-kinds §3): one disclosure per section, one open
	// at a time. ↑/↓ move between section rows, → opens, ← closes.
	let { sections }: { sections: NavSection[] } = $props();

	let list = $state<HTMLElement | null>(null);

	function focusSibling(current: HTMLElement, delta: -1 | 1) {
		const toggles = [...(list?.querySelectorAll<HTMLElement>('[data-section-toggle]') ?? [])];
		toggles[toggles.indexOf(current) + delta]?.focus();
	}

	function onKeydown(event: KeyboardEvent, section: NavSection) {
		const target = event.currentTarget as HTMLElement;
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			focusSibling(target, event.key === 'ArrowDown' ? 1 : -1);
		} else if (event.key === 'ArrowRight') {
			event.preventDefault();
			sidebar.open(section.id);
		} else if (event.key === 'ArrowLeft') {
			event.preventDefault();
			if (sidebar.openSection === section.id) sidebar.close();
		}
	}

	const podsNeedAttention = $derived(resources.issuePods.length > 0);
</script>

<div bind:this={list} class="flex flex-col">
	{#each sections as section (section.id)}
		{@const open = sidebar.openSection === section.id}
		{@const alert = !open && podsNeedAttention && section.items.some((i) => i.view === 'pods')}
		<button
			type="button"
			data-section-toggle
			class="focus-ring flex items-center gap-2 rounded-md py-1.5 pr-2 pl-2.5 text-left hover:bg-surface-row-hover"
			aria-expanded={open}
			aria-controls="sidebar-section-{section.id}"
			onclick={() => sidebar.toggle(section.id)}
			onkeydown={(e) => onKeydown(e, section)}
		>
			<span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background: {section.dot};"></span>
			<span class="type-body flex-1 truncate {open ? 'text-text-primary' : 'text-text-secondary'}">
				{section.label}
			</span>
			{#if alert}
				<span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background: var(--color-status-err);" aria-hidden="true"
				></span>
				<span class="sr-only">pods need attention</span>
			{/if}
			<span class="type-micro font-mono text-text-tertiary">{section.items.length}</span>
			<ChevronRight
				class="h-3 w-3 shrink-0 text-text-tertiary transition-transform {open ? 'rotate-90' : ''}"
				aria-hidden="true"
			/>
		</button>
		{#if open}
			<ul id="sidebar-section-{section.id}" aria-label="{section.label} types" class="mb-1 pl-2">
				{#each section.items as item (item.view)}
					<li><NavRow view={item.view} label={item.label} dot={section.dot} compact /></li>
				{/each}
			</ul>
		{/if}
	{/each}
</div>
