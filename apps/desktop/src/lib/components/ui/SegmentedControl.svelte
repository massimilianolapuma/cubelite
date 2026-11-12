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
		dense = false,
		outlined = false
	}: {
		segments: Segment<T>[];
		value: T;
		onChange?: (value: T) => void;
		/** Accessible name of the group. */
		label?: string;
		/** Narrower segments, for toolbars that must stay on one row. */
		dense?: boolean;
		/**
		 * An `outline-strong` border instead of the filled track, for forms and
		 * dialogs: on `surface-overlay` the filled track is one step away and has
		 * no visible edge.
		 */
		outlined?: boolean;
	} = $props();
</script>

<!-- One pill group; the selected segment is the tonal fill (Tonal §7). -->
<div
	class="inline-flex shrink-0 gap-0.5 rounded-full p-0.5 {outlined
		? 'border border-outline-strong'
		: 'bg-surface-container-high'}"
	role="radiogroup"
	aria-label={label}
	data-outlined={outlined}
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
					: 'text-text-muted ' + (outlined ? 'hover-layer' : 'hover:bg-surface-container-top')}"
			onclick={() => {
				value = segment.value;
				onChange?.(segment.value);
			}}
		>
			{segment.label}
		</button>
	{/each}
</div>
