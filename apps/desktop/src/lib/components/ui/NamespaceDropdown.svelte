<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';
	import { MENU_CONTENT, MENU_ITEM } from '#lib/ui-classes.ts';

	const podCounts = $derived(resources.podCountsByNamespace);

	async function select(ns: string | null) {
		app.namespace = ns;
		await resources.load();
		await resources.startWatching();
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger
		class="focus-ring flex h-(--chip-h) min-w-0 items-center gap-2 rounded-full bg-surface-container-high px-4 hover:brightness-110"
	>
		<span class="type-body-sm shrink-0 text-text-subtle">Namespace</span>
		<span class="type-data truncate text-text">{app.namespace ?? 'all'}</span>
		<ChevronDown class="h-3.5 w-3.5 shrink-0 text-text-subtle" aria-hidden="true" />
	</DropdownMenu.Trigger>
	<DropdownMenu.Portal>
		<!-- The current namespace carries a check; the highlight is only where the keyboard is. -->
		<DropdownMenu.Content align="start" sideOffset={6} class="{MENU_CONTENT} max-h-80 min-w-60 overflow-y-auto">
			<DropdownMenu.Item class={MENU_ITEM} onSelect={() => void select(null)}>
				<span class="flex-1 {app.namespace === null ? 'font-semibold text-text' : ''}">all namespaces</span>
				{#if app.namespace === null}
					<span class="type-data-sm text-text-subtle">{resources.pods.length}</span>
					<Check class="h-4 w-4 shrink-0 text-primary" aria-label="current" />
				{/if}
			</DropdownMenu.Item>
			{#each resources.namespaces as ns (ns.name)}
				{@const current = app.namespace === ns.name}
				<DropdownMenu.Item class={MENU_ITEM} onSelect={() => void select(ns.name)}>
					<span class="type-data min-w-0 flex-1 truncate {current ? 'font-semibold text-text' : ''}">{ns.name}</span>
					{#if podCounts[ns.name] !== undefined}
						<span class="type-data-sm text-text-subtle">{podCounts[ns.name]}</span>
					{/if}
					{#if current}
						<Check class="h-4 w-4 shrink-0 text-primary" aria-label="current" />
					{/if}
				</DropdownMenu.Item>
			{/each}
		</DropdownMenu.Content>
	</DropdownMenu.Portal>
</DropdownMenu.Root>
