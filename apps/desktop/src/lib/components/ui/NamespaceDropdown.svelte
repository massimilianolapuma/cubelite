<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';
	import { MENU_CONTENT, MENU_ITEM } from '#lib/ui-classes.ts';

	/** Radio value for "all namespaces"; `*` can never be a namespace name. */
	const ALL = '*';

	const podCounts = $derived(resources.podCountsByNamespace);

	async function select(ns: string | null) {
		app.namespace = ns;
		await resources.load();
		await resources.startWatching();
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger
		class="focus-ring forced-edge flex h-(--chip-h) max-w-[26%] min-w-0 shrink-0 @max-[44rem]:max-w-[34%] items-center gap-2 rounded-full bg-surface-container-high px-4 hover:brightness-110"
	>
		<span class="type-body-sm shrink-0 text-text-subtle @max-[44rem]:sr-only">Namespace</span>
		<span class="type-data truncate text-text">{app.namespace ?? 'all'}</span>
		<ChevronDown class="h-3.5 w-3.5 shrink-0 text-text-subtle" aria-hidden="true" />
	</DropdownMenu.Trigger>
	<DropdownMenu.Portal>
		<!-- A radio group, like the profile menu: the current namespace is checked and
		     carries a check mark; the highlight is only where the pointer or keyboard is. -->
		<DropdownMenu.Content align="start" sideOffset={6} class="{MENU_CONTENT} max-h-80 min-w-60 overflow-y-auto">
			<DropdownMenu.RadioGroup
				value={app.namespace ?? ALL}
				onValueChange={(value) => void select(value === ALL ? null : value)}
			>
				<DropdownMenu.RadioItem value={ALL} class={MENU_ITEM}>
					{#snippet children({ checked })}
						<span class="flex-1 {checked ? 'font-semibold text-text' : ''}">all namespaces</span>
						{#if checked}
							<span class="type-data-sm text-text-subtle">{resources.pods.length}</span>
						{/if}
						<Check class="h-4 w-4 shrink-0 text-primary {checked ? '' : 'invisible'}" aria-hidden="true" />
					{/snippet}
				</DropdownMenu.RadioItem>
				{#each resources.namespaces as ns (ns.name)}
					<DropdownMenu.RadioItem value={ns.name} class={MENU_ITEM}>
						{#snippet children({ checked })}
							<span class="type-data min-w-0 flex-1 truncate {checked ? 'font-semibold text-text' : ''}">{ns.name}</span>
							{#if podCounts[ns.name] !== undefined}
								<span class="type-data-sm text-text-subtle">{podCounts[ns.name]}</span>
							{/if}
							<Check class="h-4 w-4 shrink-0 text-primary {checked ? '' : 'invisible'}" aria-hidden="true" />
						{/snippet}
					</DropdownMenu.RadioItem>
				{/each}
			</DropdownMenu.RadioGroup>
		</DropdownMenu.Content>
	</DropdownMenu.Portal>
</DropdownMenu.Root>
