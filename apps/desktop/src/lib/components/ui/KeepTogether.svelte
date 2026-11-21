<script lang="ts">
	import { keepTogether } from '#lib/keep-together.ts';

	// Text in which "read-only" never breaks after its hyphen (#662). Inline, no
	// wrapper of its own: it takes the type and colour of where it is put.
	let { text }: { text: string } = $props();
</script>

{#each keepTogether(text) as part, i (i)}{#if part.keep}<span class="whitespace-nowrap">{part.text}</span
		>{:else}{part.text}{/if}{/each}
