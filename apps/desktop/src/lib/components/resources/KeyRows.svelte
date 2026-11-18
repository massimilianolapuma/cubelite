<script lang="ts" module>
	/** What one key's value area shows; the values themselves come only through `shown`. */
	export type KeyRowState =
		| { kind: 'hidden' }
		| { kind: 'reading' }
		| { kind: 'shown'; value: string }
		| { kind: 'error'; message: string };

	/** One key: its name and what its value is like, never the value. */
	export type KeyRowInfo = { key: string; size: number; binary: boolean };

	/** The longest text offered for Reveal, in bytes (64 KiB, as the backend). */
	export const MAX_SHOWN_BYTES = 64 * 1024;
</script>

<script lang="ts">
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import Button from '#lib/components/ui/Button.svelte';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';
	import { formatSize } from '#lib/units.ts';

	// The keys of an object whose values are read one at a time, on request
	// (#661 §3.1): a Secret's today, a ConfigMap's next (#668). It knows only
	// what its props tell it. One row per key, in the order given: name, size,
	// the value area, Reveal / Hide.
	let {
		keys,
		label,
		note = null,
		stateOf,
		onToggle,
		class: klass = ''
	}: {
		keys: readonly KeyRowInfo[];
		/** Accessible name of the block ("Keys of api-credentials"). */
		label: string;
		/** One line in place of the rows, with no action (a payload that is not values). */
		note?: string | null;
		stateOf: (key: string) => KeyRowState;
		/** Reveal a hidden key, hide a shown one. */
		onToggle: (key: string) => void;
		class?: string;
	} = $props();

	/** Why a key has no Reveal: its value is empty, not text, or too long to show. */
	function unoffered(info: KeyRowInfo): string | null {
		if (info.size === 0) return 'empty';
		if (info.binary) return 'binary';
		if (info.size > MAX_SHOWN_BYTES) return 'too large to show';
		return null;
	}

	// The data face, in the block's sunken surface (Tonal §7).
	const cell = 'type-data-sm';
</script>

<div
	class="card flex flex-col gap-1 rounded-md bg-surface-sunken px-3 py-2 {klass}"
	role="group"
	aria-label={label}
	data-key-rows
>
	{#if note}
		<p class="{cell} text-text-muted" data-key-note>{note}</p>
	{:else}
		{#each keys as info (info.key)}
			{@const reason = unoffered(info)}
			{@const shows = reason ? ({ kind: 'hidden' } as const) : stateOf(info.key)}
			<div class="flex min-h-(--control-inline-h) items-center gap-3" data-key-row={info.key}>
				<span class="{cell} w-44 shrink-0 truncate text-text-muted" title={info.key}>{info.key}</span>
				<span class="{cell} w-16 shrink-0 text-right text-text-muted">{formatSize(info.size)}</span>
				<span class="min-w-0 flex-1 py-1" data-key-value>
					{#if reason}
						<span class="{cell} text-text-muted">{reason}</span>
					{:else if shows.kind === 'shown'}
						<!-- Line breaks kept; past eight lines it scrolls inside the row. -->
						<span class="{cell} block max-h-[8lh] overflow-y-auto break-all whitespace-pre-wrap text-text select-text"
							>{shows.value}</span
						>
					{:else if shows.kind === 'error'}
						<span class="{cell} inline-flex items-center gap-1.5 text-error" data-key-error>
							<StatusGlyph state="err" />{shows.message}
						</span>
					{:else}
						<span class="{cell} text-text-subtle" aria-hidden="true">••••••••</span><span class="sr-only"
							>hidden</span
						>
					{/if}
				</span>
				{#if !reason}
					{@const shown = shows.kind === 'shown'}
					{@const reading = shows.kind === 'reading'}
					<!-- One button, Reveal then Hide: its name changes, the focus stays on it.
					     Its outline-strong edge identifies it on the sunken block (WCAG 1.4.11). -->
					<Button
						variant="text"
						size="inline"
						class="border border-outline-strong"
						pending={reading}
						aria-label="{reading ? 'Reading' : shown ? 'Hide' : 'Reveal'} {info.key}"
						onclick={() => onToggle(info.key)}
					>
						{#snippet icon()}
							{#if shown}
								<EyeOff class="h-3 w-3" aria-hidden="true" />
							{:else}
								<Eye class="h-3 w-3" aria-hidden="true" />
							{/if}
						{/snippet}
						{reading ? 'Reading…' : shown ? 'Hide' : 'Reveal'}
					</Button>
				{/if}
			</div>
		{/each}
	{/if}
</div>
