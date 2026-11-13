<script lang="ts">
	import { parseImageRef } from '#lib/image-ref.ts';

	// A container image reference in a detail panel (#648): what the reader
	// looks for is which image (its name) and which version. The version is
	// the primary part (full text colour, semibold); the name is secondary
	// (muted, regular) but stays whole; the registry and path in front of it
	// (the prefix, same muted style) are what gives way. The full reference,
	// digest included, stays in the tooltip.
	let { image, align = 'start' }: { image: string; align?: 'start' | 'end' } = $props();

	const ref = $derived(parseImageRef(image));
</script>

<!--
	Three parts on one flex line that wraps. The prefix starts at no width and
	grows up to its own length, truncating with an ellipsis when it has less, so
	it gives way first, down to nothing. Name and version keep their length:
	when both no longer fit, the version goes to a line of its own under the
	name. A name or a version longer than the row wraps inside it: nothing
	the reader looks for is cut.
	No whitespace between the parts: the reference reads and copies as one string.
-->
<span
	class="flex max-w-full min-w-0 flex-wrap items-baseline type-data-sm {align === 'end' ? 'justify-end' : ''}"
	title={image}
	data-image
>{#if ref.prefix}<span
			class="max-w-max min-w-0 grow basis-0 truncate font-normal text-text-muted"
			data-image-prefix>{ref.prefix}</span
		>{/if}<span class="max-w-full shrink-0 break-all font-normal text-text-muted" data-image-name
		>{ref.name}</span
	>{#if ref.version !== null}<span class="max-w-full shrink-0 break-all"
			><span class="font-normal text-text-muted">{ref.separator}</span><span
				class="font-semibold text-text"
				data-image-tag>{ref.version}</span
			></span
		>{/if}</span
>
