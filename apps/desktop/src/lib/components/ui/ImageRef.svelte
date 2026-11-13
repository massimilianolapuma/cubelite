<script lang="ts">
	import { parseImageRef } from '#lib/image-ref.ts';

	// A container image reference in a detail panel (#648): the version is
	// what the reader looks for, so it is the primary part (full text colour,
	// semibold) and never gives way; the repository is secondary (muted,
	// regular weight) and is the part that truncates when the row is narrow.
	// The full reference, digest included, stays in the tooltip.
	let { image, align = 'start' }: { image: string; align?: 'start' | 'end' } = $props();

	const ref = $derived(parseImageRef(image));
</script>

<!--
	One line while the version and at least 10 characters of the repository fit;
	otherwise the version goes to a line of its own under the repository, and
	wraps there only if it is longer than the row. The repository grows up to
	its own length and truncates when it has less.
	No whitespace between the parts: the reference reads and copies as one string.
-->
<span
	class="flex max-w-full min-w-0 flex-wrap items-baseline type-data-sm {align === 'end' ? 'justify-end' : ''}"
	title={image}
	data-image
><span class="max-w-max min-w-0 grow basis-[10ch] truncate font-normal text-text-muted" data-image-repository
		>{ref.repository}</span
	>{#if ref.version !== null}<span class="max-w-full shrink-0 break-all"
			><span class="font-normal text-text-muted">{ref.separator}</span><span
				class="font-semibold text-text"
				data-image-tag>{ref.version}</span
			></span
		>{/if}</span
>
