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
		onChange
	}: {
		segments: Segment<T>[];
		value: T;
		onChange?: (value: T) => void;
	} = $props();
</script>

<div
	class="inline-flex overflow-hidden rounded-md border border-border-default bg-surface-window"
	role="radiogroup"
>
	{#each segments as segment (segment.value)}
		{@const active = value === segment.value}
		<button
			type="button"
			role="radio"
			aria-checked={active}
			disabled={segment.disabled}
			title={segment.title}
			class="type-caption h-7 border-r border-border-default px-3 last:border-r-0 {segment.disabled
				? 'text-text-disabled opacity-45'
				: active
					? 'text-text-primary'
					: 'text-text-secondary hover:bg-surface-row-hover'}"
			style={active ? 'background: var(--alpha-active-nav-bg);' : ''}
			onclick={() => {
				value = segment.value;
				onChange?.(segment.value);
			}}
		>
			{segment.label}
		</button>
	{/each}
</div>
