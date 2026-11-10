<script lang="ts">
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import X from '@lucide/svelte/icons/x';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import { tick } from 'svelte';
	import SegmentedControl from '#lib/components/ui/SegmentedControl.svelte';
	import { NAME_MAX, type BuiltInId } from '#lib/profiles.ts';
	import type { View } from '#lib/stores/app.svelte.ts';
	import { navigation } from '#lib/stores/navigation.svelte.ts';
	import { profiles } from '#lib/stores/profiles.svelte.ts';
	import { isMac } from '#lib/platform.ts';

	// Preferences › Navigation › Profiles (resource-kinds §7): the menu's
	// profiles in order, their pins, and a form for a new one.
	let selectedId = $state<string | null>(null);
	const selected = $derived(profiles.list.find((p) => p.id === selectedId) ?? profiles.active);

	const labels = $derived(new Map(navigation.arranged.flatMap((s) => s.items.map((i) => [i.view, i.label] as const))));
	const labelOf = (view: View) => labels.get(view) ?? view;

	let newName = $state('');
	let from = $state<'empty' | 'active'>('empty');
	let createError = $state<string | null>(null);

	function create() {
		createError = profiles.create(newName, from);
		if (createError) return;
		newName = '';
		selectedId = profiles.active.id;
	}

	// A removed button would leave focus on <body>: move it to a neighbour.
	let root = $state<HTMLElement | null>(null);
	function focusMarked(attr: string, value: string | undefined) {
		void tick().then(() => {
			const marked = root?.querySelectorAll<HTMLElement>(`[data-${attr}]`) ?? [];
			[...marked].find((el) => el.getAttribute(`data-${attr}`) === value)?.focus();
		});
	}
	const focusProfile = (id: string | undefined) => focusMarked('profile', id);

	function remove(id: string) {
		const at = profiles.list.findIndex((p) => p.id === id);
		profiles.remove(id);
		const list = profiles.list;
		focusProfile(list[Math.min(at, list.length - 1)]?.id);
	}

	function unpin(view: View) {
		const owner = selected.id;
		const at = selected.pins.indexOf(view);
		profiles.unpin(view, owner);
		const pins = profiles.list.find((p) => p.id === owner)?.pins ?? [];
		if (pins.length === 0) focusProfile(owner);
		else focusMarked('unpin', pins[Math.min(at, pins.length - 1)]);
	}

	const focusOnMount = (node: HTMLElement) => node.focus();

	let renaming = $state<string | null>(null);
	let draft = $state('');
	let renameError = $state<string | null>(null);

	function startRename(id: string, name: string) {
		renaming = id;
		draft = name;
		renameError = null;
	}

	function onRenameKeydown(event: KeyboardEvent, id: string) {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			renaming = null;
			renameError = null;
			focusMarked('rename', id);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			renameError = profiles.rename(id, draft);
			if (renameError) return;
			renaming = null;
			focusMarked('rename', id);
		}
	}

	const iconButton =
		'focus-ring flex h-6 w-6 items-center justify-center rounded-sm text-text-tertiary hover:text-text-secondary disabled:opacity-30 disabled:hover:text-text-tertiary';
</script>

<section data-testid="profiles-prefs" bind:this={root}>
	<div class="type-body mb-1.5 text-text-primary">Profiles</div>
	<div class="flex flex-col gap-2 rounded-md border border-border-faint bg-surface-window px-2.5 py-2">
		<ul aria-label="Profiles" class="flex flex-col">
			{#each profiles.list as profile, i (profile.id)}
				<li class="flex flex-col">
					<div class="flex items-center gap-1">
						{#if renaming === profile.id}
							<input
								type="text"
								bind:value={draft}
								aria-label="New name for {profile.name}"
								maxlength={NAME_MAX}
								{@attach focusOnMount}
								class="focus-ring type-caption h-6 flex-1 rounded-sm border border-border-default bg-surface-panel px-1.5 text-text-primary"
								onkeydown={(e) => onRenameKeydown(e, profile.id)}
							/>
						{:else}
							<button
								type="button"
								class="focus-ring type-caption flex-1 truncate rounded-sm px-1 py-0.5 text-left {selected.id === profile.id
									? 'text-text-primary'
									: 'text-text-secondary'}"
								style={selected.id === profile.id ? 'background: var(--alpha-active-nav-bg);' : undefined}
								data-profile={profile.id}
								aria-label="Show pins of {profile.name}"
								aria-pressed={selected.id === profile.id}
								onclick={() => (selectedId = profile.id)}
							>
								{profile.name}
							</button>
						{/if}
						{#if profiles.active.id === profile.id}
							<span class="type-micro text-accent">active</span>
						{/if}
						{#if profile.builtIn}
							<span class="type-micro text-text-disabled">Built-in</span>
						{/if}
						<button
							type="button"
							class={iconButton}
							aria-label="Move {profile.name} up"
							disabled={i === 0}
							onclick={() => profiles.move(profile.id, -1)}
						>
							<ChevronUp size={13} />
						</button>
						<button
							type="button"
							class={iconButton}
							aria-label="Move {profile.name} down"
							disabled={i === profiles.list.length - 1}
							onclick={() => profiles.move(profile.id, 1)}
						>
							<ChevronDown size={13} />
						</button>
						{#if profile.builtIn}
							<button
								type="button"
								class={iconButton}
								aria-label="Reset {profile.name} to default pins"
								title="Reset to default pins"
								onclick={() => profiles.resetPins(profile.id as BuiltInId)}
							>
								<RotateCcw size={13} />
							</button>
						{:else}
							<button
								type="button"
								class={iconButton}
								data-rename={profile.id}
								aria-label="Rename {profile.name}"
								onclick={() => startRename(profile.id, profile.name)}
							>
								<Pencil size={13} />
							</button>
							<button
								type="button"
								class={iconButton}
								aria-label="Delete {profile.name}"
								onclick={() => remove(profile.id)}
							>
								<Trash2 size={13} />
							</button>
						{/if}
					</div>
					{#if renaming === profile.id && renameError}
						<p class="type-caption pl-1 text-status-err" role="alert">{renameError}</p>
					{/if}
				</li>
			{/each}
		</ul>

		<div class="border-t border-border-faint pt-2">
			<div class="type-section mb-1 text-text-tertiary">Pins · {selected.name}</div>
			{#if selected.pins.length === 0}
				<p class="type-caption text-text-tertiary">No pins yet: pin a resource from its list header.</p>
			{:else}
				<ul aria-label="Pins of {selected.name}">
					{#each selected.pins as view, i (view)}
						<li class="flex items-center gap-1 pl-1">
							<span class="type-caption flex-1 text-text-secondary">{labelOf(view)}</span>
							<button
								type="button"
								class={iconButton}
								aria-label="Move {labelOf(view)} up in {selected.name}"
								disabled={i === 0}
								onclick={() => profiles.movePin(selected.id, view, -1)}
							>
								<ChevronUp size={13} />
							</button>
							<button
								type="button"
								class={iconButton}
								aria-label="Move {labelOf(view)} down in {selected.name}"
								disabled={i === selected.pins.length - 1}
								onclick={() => profiles.movePin(selected.id, view, 1)}
							>
								<ChevronDown size={13} />
							</button>
							<button
								type="button"
								class={iconButton}
								data-unpin={view}
								aria-label="Unpin {labelOf(view)} from {selected.name}"
								onclick={() => unpin(view)}
							>
								<X size={13} />
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		<form
			class="flex flex-col gap-1.5 border-t border-border-faint pt-2"
			onsubmit={(e) => {
				e.preventDefault();
				create();
			}}
		>
			<div class="type-section text-text-tertiary">New profile</div>
			<div class="flex flex-wrap items-center gap-2">
				<input
					type="text"
					bind:value={newName}
					aria-label="Profile name"
					placeholder="Name"
					maxlength={NAME_MAX}
					class="focus-ring type-caption h-7 w-40 rounded-md border border-border-default bg-surface-panel px-2 text-text-primary placeholder:text-text-disabled"
				/>
				<SegmentedControl
					label="Start the new profile"
					segments={[
						{ value: 'empty', label: 'Start empty' },
						{ value: 'active', label: `Copy ${profiles.active.name}` }
					]}
					bind:value={from}
				/>
				<button
					type="submit"
					class="focus-ring type-caption h-7 rounded-md bg-accent px-2.5 font-medium text-surface-window hover:brightness-110"
				>
					Create
				</button>
			</div>
			{#if createError}
				<p class="type-caption text-status-err" role="alert">{createError}</p>
			{/if}
		</form>
	</div>
	<p class="type-caption mt-1 text-text-tertiary">
		The sidebar pins the active profile's resources; {isMac ? '⌥⌘1…9' : 'Ctrl+Alt+1…9'} switch to the first
		nine profiles.
	</p>
</section>
