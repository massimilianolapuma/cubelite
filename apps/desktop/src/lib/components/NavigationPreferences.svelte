<script lang="ts">
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import SegmentedControl from '#lib/components/ui/SegmentedControl.svelte';
	import Switch from '#lib/components/ui/Switch.svelte';
	import ProfilesPreferences from '#lib/components/ProfilesPreferences.svelte';
	import { PINNED_SECTION, PINNED_VIEW } from '#lib/navigation.ts';
	import { SORT_FIELDS, type SortDir, type SortField } from '#lib/list-sort.ts';
	import { navigation } from '#lib/stores/navigation.svelte.ts';
	import { lists } from '#lib/stores/lists.svelte.ts';
	import { ACCENT_LINK_CLASS } from '#lib/integration.ts';
	import { FIELD_BASE } from '#lib/ui-classes.ts';

	// Sidebar order / visibility, the default list sort (#496) and grouping (#547).
	const arranged = $derived(navigation.arranged);

	const dirSegments: { value: SortDir; label: string }[] = [
		{ value: 'asc', label: 'Ascending' },
		{ value: 'desc', label: 'Descending' }
	];

	// Icon-only buttons are discs (Tonal §7); a disabled one fades to 45 %. No
	// enlarged hit area: the rows touch, and a 28 px target would reach into the
	// row above and take its clicks. 24 px meets the WCAG 2.2 minimum.
	const iconButton =
		'focus-ring hover-layer flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-muted disabled:opacity-45';
</script>

<ProfilesPreferences />

<section>
	<div class="mb-2 flex items-baseline justify-between gap-3">
		<div class="type-body text-text">Sidebar order</div>
		<button type="button" class={ACCENT_LINK_CLASS} onclick={() => navigation.reset()}>
			Reset to default
		</button>
	</div>
	<!-- No section dots (Tonal §3 #6): sections are named, types indented under them. -->
	<div class="flex flex-col gap-3 rounded-lg border border-outline px-4 py-3" data-testid="navigation-prefs">
		{#each arranged as section, s (section.id)}
			<div>
				<div class="flex items-center gap-1">
					<span class="type-label flex-1 text-text-muted">{section.label}</span>
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
						<li class="flex items-center gap-1 pl-4" data-view={item.view}>
							<span class="type-body-sm flex-1 {hidden ? 'text-text-subtle' : 'text-text'}">
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
								<span class="type-body-sm text-text-muted">always shown</span>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/each}
	</div>
	<p class="type-body-sm mt-2 text-text-muted">
		Hidden types stay reachable from the command palette.
	</p>
</section>

<section class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
	<div>
		<div class="type-body text-text">Default list sort</div>
		<p class="type-body-sm mt-0.5 text-text-muted">
			Click a column header to sort a list for this session.
		</p>
	</div>
	<div class="flex flex-wrap items-center gap-2">
		<select
			aria-label="Default sort field"
			class="{FIELD_BASE} w-auto pr-2"
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
				label="Sort direction"
				outlined
				segments={dirSegments}
				value={lists.defaultSort.dir}
				onChange={(dir) => (lists.defaultSort = { field: lists.defaultSort.field, dir })}
			/>
		{/if}
	</div>
</section>

<section class="flex items-center justify-between gap-4">
	<div>
		<div class="type-body text-text">Group by namespace</div>
		<p class="type-body-sm mt-0.5 text-text-muted">
			With all namespaces shown, lists get one collapsible group per namespace.
		</p>
	</div>
	<Switch
		checked={lists.groupByNamespace}
		label="Group by namespace"
		onChange={(on) => (lists.groupByNamespace = on)}
	/>
</section>
