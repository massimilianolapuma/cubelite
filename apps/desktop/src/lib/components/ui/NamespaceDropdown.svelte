<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { app } from '$lib/stores/app.svelte';
	import { resources } from '$lib/stores/resources.svelte';

	const counts = $derived(resources.podCountByNamespace);

	async function select(ns: string | null) {
		app.namespace = ns;
		await resources.load();
		await resources.startWatching();
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger
		class="focus-ring flex h-7 items-center gap-1.5 rounded-md border border-border-default bg-surface-raised px-2.5 text-text-secondary hover:brightness-110"
	>
		<span class="type-caption">namespace:</span>
		<span class="font-mono text-[11.5px] text-text-primary">{app.namespace ?? 'all'}</span>
		<ChevronDown class="h-3 w-3 text-text-tertiary" />
	</DropdownMenu.Trigger>
	<DropdownMenu.Portal>
		<DropdownMenu.Content
			align="end"
			sideOffset={6}
			class="animate-popin z-50 max-h-80 min-w-56 overflow-y-auto rounded-xl border border-border-strong bg-surface-overlay p-1 shadow-overlay"
		>
			<DropdownMenu.Item
				class="flex cursor-default items-center justify-between rounded-md px-2.5 py-1.5 type-body text-text-secondary data-highlighted:text-text-primary"
				style={app.namespace === null ? 'background: var(--alpha-active-nav-bg); color: var(--color-text-primary);' : ''}
				onSelect={() => void select(null)}
			>
				<span>all namespaces</span>
				<span class="font-mono text-[10.5px] text-text-tertiary">{resources.pods.length}</span>
			</DropdownMenu.Item>
			{#each resources.namespaces as ns (ns.name)}
				<DropdownMenu.Item
					class="flex cursor-default items-center justify-between gap-4 rounded-md px-2.5 py-1.5 type-body text-text-secondary data-highlighted:text-text-primary"
					style={app.namespace === ns.name ? 'background: var(--alpha-active-nav-bg); color: var(--color-text-primary);' : ''}
					onSelect={() => void select(ns.name)}
				>
					<span class="font-mono text-[11.5px]">{ns.name}</span>
					<span class="font-mono text-[10.5px] text-text-tertiary">{counts.get(ns.name) ?? 0}</span>
				</DropdownMenu.Item>
			{/each}
		</DropdownMenu.Content>
	</DropdownMenu.Portal>
</DropdownMenu.Root>
