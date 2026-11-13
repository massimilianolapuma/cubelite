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
		outlined = false,
		arrowKeys = false
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
		/**
		 * The radio group pattern: one Tab stop (the selected segment), the arrow
		 * keys (and Home, End) move the selection and the focus, skipping disabled
		 * segments. Off by default: every segment is its own Tab stop.
		 */
		arrowKeys?: boolean;
	} = $props();

	let group = $state<HTMLElement | null>(null);

	// Without a selected enabled segment, the first enabled one takes the Tab stop.
	const stop = $derived(
		segments.find((s) => s.value === value && !s.disabled)?.value ?? segments.find((s) => !s.disabled)?.value
	);

	function choose(next: T) {
		value = next;
		onChange?.(next);
	}

	function key(e: KeyboardEvent, index: number) {
		if (!arrowKeys) return;
		const enabled = segments.map((s, i) => ({ s, i })).filter(({ s }) => !s.disabled);
		if (enabled.length === 0) return;
		const at = enabled.findIndex(({ i }) => i === index);
		let to: number;
		switch (e.key) {
			case 'ArrowRight':
			case 'ArrowDown':
				to = (at + 1) % enabled.length;
				break;
			case 'ArrowLeft':
			case 'ArrowUp':
				to = (at - 1 + enabled.length) % enabled.length;
				break;
			case 'Home':
				to = 0;
				break;
			case 'End':
				to = enabled.length - 1;
				break;
			default:
				return;
		}
		e.preventDefault();
		const target = enabled[to];
		choose(target.s.value);
		group?.querySelectorAll<HTMLElement>('[role="radio"]')[target.i]?.focus();
	}
</script>

<!-- One pill group; the selected segment is the tonal fill (Tonal §7) inside a
     1.5 px primary ring: the fill alone is 1.3–1.6:1 from its surface, and the
     ring, drawn inside, reaches 3:1 without changing the segment's size. -->
<div
	class="inline-flex shrink-0 gap-0.5 rounded-full p-0.5 {outlined
		? 'border border-outline-strong'
		: 'bg-surface-container-high'}"
	role="radiogroup"
	aria-label={label}
	data-outlined={outlined}
	bind:this={group}
>
	{#each segments as segment, index (segment.value)}
		{@const active = value === segment.value}
		<button
			type="button"
			role="radio"
			aria-checked={active}
			tabindex={arrowKeys ? (segment.value === stop ? 0 : -1) : undefined}
			onkeydown={(e) => key(e, index)}
			disabled={segment.disabled}
			title={segment.title}
			data-selected={active}
			class="focus-ring type-body-sm h-(--control-inline-h) rounded-full {dense ? 'px-2' : 'px-3.5'} {segment.disabled
				? 'text-text-subtle opacity-45'
				: active
					? 'bg-primary-container font-semibold text-on-primary-container inset-ring-[1.5px] inset-ring-primary'
					: 'text-text-muted ' + (outlined ? 'hover-layer' : 'hover:bg-surface-container-top')}"
			onclick={() => choose(segment.value)}
		>
			{segment.label}
		</button>
	{/each}
</div>
