<script lang="ts">
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import SegmentedControl from '#lib/components/ui/SegmentedControl.svelte';
	import { PINNED_SECTION, PINNED_VIEW } from '#lib/navigation.ts';
	import { SORT_FIELDS, type SortDir, type SortField } from '#lib/list-sort.ts';
	import { navigation } from '#lib/stores/navigation.svelte.ts';
	import { lists } from '#lib/stores/lists.svelte.ts';

	// Sidebar order / visibility and the default list sort (#496).
	const arranged = $derived(navigation.arranged);

	const dirSegments: { value: SortDir; label: string }[] = [
		{ value: 'asc', label: 'Ascending' },
		{ value: 'desc', label: 'Descending' }
	];

	const iconButton =
		'focus-ring flex h-6 w-6 items-center justify-center rounded-sm text-text-tertiary hover:text-text-secondary disabled:opacity-30 disabled:hover:text-text-tertiary';
</script>

<section>
	<div class="mb-1.5 flex items-baseline justify-between gap-3">
		<div class="type-body text-text-primary">Navigation</div>
		<button
			type="button"
			class="focus-ring type-caption rounded-sm text-accent hover:brightness-110"
			onclick={() => navigation.reset()}
		>
			Reset to default
		</button>
	</div>
	<div
		class="flex flex-col gap-2 rounded-md border border-border-faint bg-surface-window px-2.5 py-2"
		data-testid="navigation-prefs"
	>
		{#each arranged as section, s (section.id)}
			<div>
				<div class="flex items-center gap-1">
					<span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background: {section.dot};"></span>
					<span class="type-section flex-1 pl-1 text-text-tertiary">{section.label}</span>
					{#if section.id !== PINNED_SECTION}
						<button
							type="button"
							class={iconButton}
							aria-label="Move {section.label} section up"
							disabled={s <= 1}
							onclick={() => navigation.moveSection(section.id, -1)}
						>
							<ChevronUp size={13} />
						</button>
						<button
							type="button"
							class={iconButton}
							aria-label="Move {section.label} section down"
							disabled={s === arranged.length - 1}
							onclick={() => navigation.moveSection(section.id, 1)}
						>
							<ChevronDown size={13} />
						</button>
					{/if}
				</div>
				<ul aria-label="{section.label} types">
					{#each section.items as item, i (item.view)}
						{@const hidden = navigation.isHidden(item.view)}
						{@const pinned = item.view === PINNED_VIEW}
						{@const firstMovable = section.items[0]?.view === PINNED_VIEW ? 1 : 0}
						<li class="flex items-center gap-1 pl-3.5" data-view={item.view}>
							<span class="type-caption flex-1 {hidden ? 'text-text-disabled' : 'text-text-secondary'}">
								{item.label}
							</span>
							{#if !pinned}
								<button
									type="button"
									class={iconButton}
									aria-label="Move {item.label} up"
									disabled={i <= firstMovable}
									onclick={() => navigation.moveItem(item.view, -1)}
								>
									<ChevronUp size={13} />
								</button>
								<button
									type="button"
									class={iconButton}
									aria-label="Move {item.label} down"
									disabled={i === section.items.length - 1}
									onclick={() => navigation.moveItem(item.view, 1)}
								>
									<ChevronDown size={13} />
								</button>
								<button
									type="button"
									class={iconButton}
									aria-label="{hidden ? 'Show' : 'Hide'} {item.label}"
									aria-pressed={hidden}
									disabled={!hidden && !navigation.canHide(item.view)}
									onclick={() => navigation.setHidden(item.view, !hidden)}
								>
									{#if hidden}<EyeOff size={13} />{:else}<Eye size={13} />{/if}
								</button>
							{:else}
								<span class="type-caption text-text-disabled">always shown</span>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/each}
	</div>
	<p class="type-caption mt-1 text-text-tertiary">
		Hidden types stay reachable from the command palette.
	</p>
</section>

<section class="flex items-center justify-between gap-4">
	<div>
		<div class="type-body text-text-primary">Default list sort</div>
		<p class="type-caption mt-0.5 text-text-tertiary">
			Click a column header to sort a list for this session.
		</p>
	</div>
	<div class="flex items-center gap-2">
		<select
			aria-label="Default sort field"
			class="focus-ring type-caption h-7 rounded-md border border-border-default bg-surface-window px-2 text-text-primary"
			value={lists.defaultSort.field}
			onchange={(e) =>
				(lists.defaultSort = {
					field: e.currentTarget.value as SortField,
					dir: lists.defaultSort.dir
				})}
		>
			{#each SORT_FIELDS as f (f.value)}
				<option value={f.value}>{f.label}</option>
			{/each}
		</select>
		{#if lists.defaultSort.field !== 'api'}
			<SegmentedControl
				segments={dirSegments}
				value={lists.defaultSort.dir}
				onChange={(dir) => (lists.defaultSort = { field: lists.defaultSort.field, dir })}
			/>
		{/if}
	</div>
</section>
