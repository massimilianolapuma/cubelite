<script lang="ts" module>
	/** What one key's value area shows; the values themselves come only through `shown`. */
	export type KeyRowState =
		| { kind: 'hidden' }
		| { kind: 'reading' }
		| { kind: 'shown'; value: string }
		| { kind: 'error'; message: string };

	/** What one key's Copy button shows: at rest, copying, or "Copied" for a moment. */
	export type KeyCopyState = 'idle' | 'copying' | 'copied';

	/** One key: its name and what its value is like, never the value. */
	export type KeyRowInfo = { key: string; size: number; binary: boolean };

	/** The longest text offered for Reveal, in bytes (64 KiB, as the backend). */
	export const MAX_SHOWN_BYTES = 64 * 1024;
</script>

<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import Button from '#lib/components/ui/Button.svelte';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';
	import { formatSize } from '#lib/units.ts';

	// The keys of an object whose values are read one at a time, on request
	// (#661 §3.1): a Secret's today, a ConfigMap's next (#668). It knows only
	// what its props tell it. One row per key, in the order given: name, size,
	// the value area, Reveal / Hide, then Copy when the caller offers it.
	let {
		keys,
		label,
		note = null,
		stateOf,
		onToggle,
		copyStateOf = () => 'idle',
		onCopy,
		class: klass = ''
	}: {
		keys: readonly KeyRowInfo[];
		/** Accessible name of the block ("Keys of api-credentials"). */
		label: string;
		/** Said in every row's value area, with no action (a payload that is not values). */
		note?: string | null;
		stateOf: (key: string) => KeyRowState;
		/** Reveal a hidden key, hide a shown one. */
		onToggle: (key: string) => void;
		copyStateOf?: (key: string) => KeyCopyState;
		/**
		 * Copy a key's value; without it there is no Copy. A binary value is
		 * offered as base64, a text too long to show is still offered.
		 */
		onCopy?: (info: KeyRowInfo) => void;
		class?: string;
	} = $props();

	/** Why a key's value is not shown: it is empty, not text, or too long. */
	function unshown(info: KeyRowInfo): string | null {
		if (info.size === 0) return 'empty';
		if (info.binary) return 'binary';
		if (info.size > MAX_SHOWN_BYTES) return 'too large to show';
		return null;
	}

	// The data face, in the block's sunken surface (Tonal §7).
	const cell = 'type-data-sm';
	// Its outline-strong edge identifies a button on the sunken block (WCAG 1.4.11).
	const edge = 'border border-outline-strong';
</script>

<div
	class="card flex flex-col gap-1 rounded-md bg-surface-sunken px-3 py-2 {klass}"
	role="group"
	aria-label={label}
	data-key-rows
>
	{#each keys as info (info.key)}
		{@const reason = note ?? unshown(info)}
		<!-- No action at all for a note or an empty value; Copy for any other. -->
		{@const acts = note === null && info.size > 0}
		{@const shows = acts ? stateOf(info.key) : ({ kind: 'hidden' } as const)}
		{@const below = shows.kind === 'shown' || shows.kind === 'error'}
		<div class="flex flex-col" data-key-row={info.key}>
			<!-- One line: name, size, the value area (or the reason there is none), the
			     actions. A shown value or an error takes a line of its own under it, as
			     wide as the row: the actions never wrap, the value is not squeezed. -->
			<div class="flex min-h-(--control-inline-h) items-center gap-3">
				<!-- When the row is narrow the name gives way first (it truncates, its full
				     text in the title), then the value area, down to its eight dots. Every
				     row of the block has the same actions area, so they give way alike and
				     the columns line up. -->
				<span class="{cell} w-44 min-w-14 shrink truncate text-text-muted" title={info.key}>{info.key}</span>
				<span class="{cell} w-16 shrink-0 text-right text-text-muted" data-key-size>{formatSize(info.size)}</span>
				<span class="min-w-15 flex-1 py-1" data-key-value={below ? undefined : ''}>
					{#if reason}
						<span class="{cell} text-text-muted">{reason}</span>
					{:else if !below}
						<span class="{cell} text-text-subtle" aria-hidden="true">••••••••</span><span class="sr-only"
							>hidden</span
						>
					{/if}
				</span>
				{#if note === null}
					<!-- Wide enough for Reveal and Copy at rest; an empty value's row keeps it empty. -->
					<span class="flex {onCopy ? 'min-w-52' : 'min-w-24'} shrink-0 items-center justify-end gap-2" data-key-actions>
						{#if acts && !reason}
							{@const shown = shows.kind === 'shown'}
							{@const reading = shows.kind === 'reading'}
							<!-- One button, Reveal then Hide: its name changes, the focus stays on it. -->
							<Button
								variant="text"
								size="inline"
								class={edge}
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
						{#if acts && onCopy}
							{@const copy = copyStateOf(info.key)}
							{@const base64 = info.binary ? ' as base64' : ''}
							<!-- Never reveals. "Copied" for a moment, with the same focus; as wide as
							     "Copied", so the word changing moves nothing on the line. -->
							<Button
								variant="text"
								size="inline"
								class="{edge} min-w-25"
								pending={copy === 'copying'}
								aria-label="{copy === 'copied' ? 'Copied' : 'Copy'} {info.key}{base64}"
								data-key-copy
								onclick={() => onCopy(info)}
							>
								{#snippet icon()}
									{#if copy === 'copied'}
										<Check class="h-3 w-3" aria-hidden="true" />
									{:else}
										<Copy class="h-3 w-3" aria-hidden="true" />
									{/if}
								{/snippet}
								{copy === 'copied' ? 'Copied' : info.binary ? 'Copy base64' : 'Copy'}
							</Button>
						{/if}
					</span>
				{/if}
			</div>
			{#if shows.kind === 'shown'}
				<!-- Line breaks kept; past eight lines it scrolls inside the row. -->
				<div class="pb-1.5" data-key-value>
					<span
						class="{cell} block max-h-[8lh] overflow-y-auto break-all whitespace-pre-wrap text-text select-text"
						data-key-shown>{shows.value}</span
					>
				</div>
			{:else if shows.kind === 'error'}
				<div class="pb-1.5" data-key-value>
					<span class="{cell} inline-flex items-center gap-1.5 text-error" data-key-error>
						<StatusGlyph state="err" />{shows.message}
					</span>
				</div>
			{/if}
		</div>
	{/each}
</div>
