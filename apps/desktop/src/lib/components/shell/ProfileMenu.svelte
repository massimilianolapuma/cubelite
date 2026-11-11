<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { isMac } from '#lib/platform.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { profiles } from '#lib/stores/profiles.svelte.ts';
	import { MENU_CONTENT, MENU_ITEM } from '#lib/ui-classes.ts';

	// Profile switch (resource-kinds §3): every profile, ⌥⌘1…9 for the first
	// nine, and the way to Preferences.
	const hint = (i: number) => (isMac ? `⌥⌘${i + 1}` : `Ctrl+Alt+${i + 1}`);

</script>

<DropdownMenu.Root>
	<!-- The pill shows the name only; "Profile:" stays in the accessible name and tooltip. -->
	<DropdownMenu.Trigger
		class="focus-ring flex h-(--control-h-compact) w-full items-center gap-2 rounded-full bg-surface-container-high px-4 text-left text-text hover:brightness-110"
		title="Profile: {profiles.active.name}"
	>
		<span class="sr-only">Profile:</span>
		<span class="type-body flex-1 truncate font-semibold">{profiles.active.name}</span>
		<ChevronDown class="h-3.5 w-3.5 shrink-0 text-text-subtle" />
	</DropdownMenu.Trigger>
	<DropdownMenu.Portal>
		<DropdownMenu.Content
			align="start"
			sideOffset={6}
			class="{MENU_CONTENT} min-w-56"
		>
			<DropdownMenu.RadioGroup value={profiles.active.id} onValueChange={(id) => profiles.activate(id)}>
				{#each profiles.list as profile, i (profile.id)}
					<DropdownMenu.RadioItem value={profile.id} class={MENU_ITEM}>
						{#snippet children({ checked })}
							<span class="flex-1 truncate {checked ? 'font-semibold text-text' : ''}">{profile.name}</span>
							{#if i < 9}
								<span class="type-micro font-mono text-text-subtle">{hint(i)}</span>
							{/if}
							<Check class="h-4 w-4 shrink-0 text-primary {checked ? '' : 'invisible'}" aria-hidden="true" />
						{/snippet}
					</DropdownMenu.RadioItem>
				{/each}
			</DropdownMenu.RadioGroup>
			<DropdownMenu.Separator class="mx-3 my-1.5 h-px bg-outline" />
			<DropdownMenu.Item class={MENU_ITEM} onSelect={() => app.openPreferences('navigation')}>
				Manage profiles…
			</DropdownMenu.Item>
		</DropdownMenu.Content>
	</DropdownMenu.Portal>
</DropdownMenu.Root>
