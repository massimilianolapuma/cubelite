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
	import Button from '#lib/components/ui/Button.svelte';
	import { FIELD_BASE } from '#lib/ui-classes.ts';

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

	// Icon-only buttons are discs (Tonal §7); a disabled one fades to 45 %. No
	// enlarged hit area: the rows touch, and a 28 px target would reach into the
	// row above and take its clicks. 24 px meets the WCAG 2.2 minimum.
	const iconButton =
		'focus-ring hover-layer flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-muted disabled:opacity-45';
</script>

<section data-testid="profiles-prefs" bind:this={root}>
	<div class="type-body mb-2 text-text">Profiles</div>
	<div class="flex flex-col gap-3 rounded-lg border border-outline px-4 py-3">
		<ul aria-label="Profiles" class="flex flex-col">
			{#each profiles.list as profile, i (profile.id)}
				<li class="flex flex-col">
					<div class="flex min-h-8 items-center gap-1">
						{#if renaming === profile.id}
							<input
								type="text"
								bind:value={draft}
								aria-label="New name for {profile.name}"
								maxlength={NAME_MAX}
								{@attach focusOnMount}
								class="{FIELD_BASE} flex-1"
								onkeydown={(e) => onRenameKeydown(e, profile.id)}
							/>
						{:else}
							<!-- The profile whose pins are shown: the tonal fill and a weight (Tonal §7). -->
							<button
								type="button"
								class="focus-ring type-body-sm h-8 min-w-0 flex-1 truncate rounded-full px-3 text-left {selected.id === profile.id
									? 'bg-primary-container font-semibold text-on-primary-container'
									: 'hover-layer text-text'}"
								data-profile={profile.id}
								aria-label="Show pins of {profile.name}"
								aria-pressed={selected.id === profile.id}
								onclick={() => (selectedId = profile.id)}
							>
								{profile.name}
							</button>
						{/if}
						{#if profiles.active.id === profile.id}
							<span class="type-label shrink-0 px-1 text-text">Active</span>
						{/if}
						{#if profile.builtIn}
							<span class="type-body-sm shrink-0 px-1 text-text-muted">Built-in</span>
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
						<p class="type-body-sm pt-1 pl-3 text-error" role="alert">{renameError}</p>
					{/if}
				</li>
			{/each}
		</ul>

		<div class="border-t border-outline pt-3">
			<div class="type-label mb-1 text-text-muted">Pins · {selected.name}</div>
			{#if selected.pins.length === 0}
				<p class="type-body-sm text-text-muted">No pins yet: pin a resource from its list header.</p>
			{:else}
				<ul aria-label="Pins of {selected.name}">
					{#each selected.pins as view, i (view)}
						<li class="flex items-center gap-1 pl-3">
							<span class="type-body-sm min-w-0 flex-1 truncate text-text">{labelOf(view)}</span>
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
			class="flex flex-col gap-2 border-t border-outline pt-3"
			onsubmit={(e) => {
				e.preventDefault();
				create();
			}}
		>
			<div class="type-label text-text-muted">New profile</div>
			<div class="flex flex-wrap items-center gap-2">
				<input
					type="text"
					bind:value={newName}
					aria-label="Profile name"
					placeholder="Name"
					maxlength={NAME_MAX}
					class="{FIELD_BASE} w-40"
				/>
				<SegmentedControl
					label="Start the new profile"
					outlined
					segments={[
						{ value: 'empty', label: 'Start empty' },
						{ value: 'active', label: `Copy ${profiles.active.name}` }
					]}
					bind:value={from}
				/>
				<Button type="submit" variant="tonal" size="inline">Create</Button>
			</div>
			{#if createError}
				<p class="type-body-sm text-error" role="alert">{createError}</p>
			{/if}
		</form>
	</div>
	<p class="type-body-sm mt-2 text-text-muted">
		The sidebar pins the active profile's resources; {isMac ? '⌥⌘1…9' : 'Ctrl+Alt+1…9'} switch to the first
		nine profiles.
	</p>
</section>
