<script lang="ts" generics="T extends string | number">
	interface Segment<V> {
		value: V;
		label: string;
		disabled?: boolean;
		title?: string;
	}

	let {
		segments,
		value = $bindable(),
		onChange,
		label,
		dense = false
	}: {
		segments: Segment<T>[];
		value: T;
		onChange?: (value: T) => void;
		/** Accessible name of the group. */
		label?: string;
		/** Narrower segments, for toolbars that must stay on one row. */
		dense?: boolean;
	} = $props();
</script>

<!-- One pill group; the selected segment is the tonal fill (Tonal §7). -->
<div class="inline-flex shrink-0 gap-0.5 rounded-full bg-surface-container-high p-0.5" role="radiogroup"
	aria-label={label}
>
	{#each segments as segment (segment.value)}
		{@const active = value === segment.value}
		<button
			type="button"
			role="radio"
			aria-checked={active}
			disabled={segment.disabled}
			title={segment.title}
			data-selected={active}
			class="focus-ring type-body-sm h-(--control-inline-h) rounded-full {dense ? 'px-2' : 'px-3.5'} {segment.disabled
				? 'text-text-subtle opacity-45'
				: active
					? 'bg-primary-container font-semibold text-on-primary-container'
					: 'text-text-muted hover:bg-surface-container-top'}"
			onclick={() => {
				value = segment.value;
				onChange?.(segment.value);
			}}
		>
			{segment.label}
		</button>
	{/each}
</div>
