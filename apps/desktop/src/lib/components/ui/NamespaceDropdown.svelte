<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';

	const podCounts = $derived(resources.podCountsByNamespace);

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
		<span class="type-data-sm text-text-primary">{app.namespace ?? 'all'}</span>
		<ChevronDown class="h-3 w-3 text-text-tertiary" />
	</DropdownMenu.Trigger>
	<DropdownMenu.Portal>
		<DropdownMenu.Content
			align="end"
			sideOffset={6}
			class="animate-popin z-50 max-h-80 min-w-56 overflow-y-auto rounded-xl border border-border-strong bg-surface-overlay p-1 shadow-overlay"
		>
			<DropdownMenu.Item
				class="flex cursor-default items-center gap-3 rounded-md px-2.5 py-1.5 type-body text-text-secondary data-highlighted:text-text-primary"
				style={app.namespace === null ? 'background: var(--alpha-active-nav-bg); color: var(--color-text-primary);' : ''}
				onSelect={() => void select(null)}
			>
				<span class="flex-1">all namespaces</span>
				{#if app.namespace === null}
					<span class="type-micro font-mono text-text-tertiary">{resources.pods.length}</span>
				{/if}
			</DropdownMenu.Item>
			{#each resources.namespaces as ns (ns.name)}
				<DropdownMenu.Item
					class="flex cursor-default items-center gap-3 rounded-md px-2.5 py-1.5 type-body text-text-secondary data-highlighted:text-text-primary"
					style={app.namespace === ns.name ? 'background: var(--alpha-active-nav-bg); color: var(--color-text-primary);' : ''}
					onSelect={() => void select(ns.name)}
				>
					<span class="type-data-sm flex-1">{ns.name}</span>
					{#if podCounts[ns.name] !== undefined}
						<span class="type-micro font-mono text-text-tertiary">{podCounts[ns.name]}</span>
					{/if}
				</DropdownMenu.Item>
			{/each}
		</DropdownMenu.Content>
	</DropdownMenu.Portal>
</DropdownMenu.Root>
