<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { isMac } from '#lib/platform.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { profiles } from '#lib/stores/profiles.svelte.ts';

	// Profile switch (resource-kinds §3): every profile, ⌥⌘1…9 for the first
	// nine, and the way to Preferences.
	const hint = (i: number) => (isMac ? `⌥⌘${i + 1}` : `Ctrl+Alt+${i + 1}`);

	const item =
		'flex cursor-default items-center gap-3 rounded-md px-2.5 py-1.5 type-body text-text-secondary data-highlighted:text-text-primary';
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
			class="animate-popin z-50 min-w-52 rounded-xl border border-border-strong bg-surface-overlay p-1 shadow-overlay"
		>
			<DropdownMenu.RadioGroup value={profiles.active.id} onValueChange={(id) => profiles.activate(id)}>
				{#each profiles.list as profile, i (profile.id)}
					<DropdownMenu.RadioItem value={profile.id} class={item}>
						{#snippet children({ checked })}
							<span class="flex-1 truncate {checked ? 'text-text-primary' : ''}">{profile.name}</span>
							{#if i < 9}
								<span class="type-micro font-mono text-text-disabled">{hint(i)}</span>
							{/if}
						{/snippet}
					</DropdownMenu.RadioItem>
				{/each}
			</DropdownMenu.RadioGroup>
			<DropdownMenu.Separator class="my-1 h-px bg-border-faint" />
			<DropdownMenu.Item class={item} onSelect={() => app.openPreferences('navigation')}>
				Manage profiles…
			</DropdownMenu.Item>
		</DropdownMenu.Content>
	</DropdownMenu.Portal>
</DropdownMenu.Root>
