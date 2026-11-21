<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { UNLOCK_CHOICES } from '#lib/access.ts';
	import { clusterSettings } from '#lib/stores/cluster-settings.svelte.ts';
	import { MENU_CONTENT, MENU_ITEM } from '#lib/ui-classes.ts';

	// The access items of a cluster's menu (#662, spec §5.2), inside the parent's
	// DropdownMenu.Content. Read-only or writable for a while: "Make writable for ▸"
	// with the durations (choosing one again restarts the time); writable for a
	// while also "Make read-only" under it; writable: "Make read-only" only.
	// `durations` renders just the four durations, for a "Make writable ▾" button
	// whose own label already says what they do.
	let { name, durations = false }: { name: string; durations?: boolean } = $props();

	const access = $derived(clusterSettings.accessOf(name));
</script>

{#snippet choices()}
	{#each UNLOCK_CHOICES as choice (choice.value)}
		<DropdownMenu.Item class={MENU_ITEM} onSelect={() => void clusterSettings.requestUnlock(name, choice.value)}>
			{choice.label}
		</DropdownMenu.Item>
	{/each}
{/snippet}

{#if durations}
	{@render choices()}
{:else}
	{#if access !== 'writable'}
		<DropdownMenu.Sub>
			<DropdownMenu.SubTrigger class={MENU_ITEM}>
				<span class="flex-1">Make writable for</span>
				<ChevronRight class="h-4 w-4 shrink-0 text-text-subtle" aria-hidden="true" />
			</DropdownMenu.SubTrigger>
			<DropdownMenu.SubContent sideOffset={6} class="{MENU_CONTENT} min-w-44">
				{@render choices()}
			</DropdownMenu.SubContent>
		</DropdownMenu.Sub>
	{/if}
	{#if access !== 'read_only'}
		<DropdownMenu.Item class={MENU_ITEM} onSelect={() => void clusterSettings.makeReadOnly(name)}>
			Make read-only
		</DropdownMenu.Item>
	{/if}
{/if}
