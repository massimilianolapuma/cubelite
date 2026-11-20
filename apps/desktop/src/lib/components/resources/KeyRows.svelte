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
	import { untrack } from 'svelte';
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import Button from '#lib/components/ui/Button.svelte';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';
	import { formatSize } from '#lib/units.ts';

	// The keys of an object whose values are read one at a time, on request
	// (#661 §3.1): a Secret's, masked, and a ConfigMap's (#668), not. It knows
	// only what its props tell it. One row per key, in the order given: name,
	// size, the value area, Reveal / Hide (Show / Hide), then Copy when the
	// caller offers it.
	let {
		keys,
		label,
		masked = true,
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
		/**
		 * A value not shown is hidden (a Secret's): dots, "hidden" for screen
		 * readers, Reveal / Hide. Without it (a ConfigMap's) nothing is hidden,
		 * only not read yet: an empty value area, Show / Hide.
		 */
		masked?: boolean;
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

	// Keys whose reason does not fit their value area: it goes on a line of its
	// own under the key, as wide as the row, rather than not being drawn.
	let cramped = $state<Record<string, boolean>>({});

	/** Watch a key's value area: whether its reason, on one line, fits in it. */
	function fit(key: string) {
		return (area: HTMLElement) => {
			const check = () =>
				untrack(() => {
					const words = area.querySelector<HTMLElement>('[data-key-reason-inline]');
					const narrow = words !== null && words.getBoundingClientRect().width > area.clientWidth + 0.5;
					if ((cramped[key] ?? false) !== narrow) cramped[key] = narrow;
				});
			check();
			if (typeof ResizeObserver === 'undefined') return;
			const observer = new ResizeObserver(check);
			observer.observe(area);
			const words = area.querySelector('[data-key-reason-inline]');
			if (words) observer.observe(words);
			return () => observer.disconnect();
		};
	}

	// The data face, in the block's sunken surface (Tonal §7).
	const cell = 'type-data-sm';
	// Its outline-strong edge identifies a button on the sunken block (WCAG 1.4.11).
	const edge = 'border border-outline-strong';
</script>

<!-- One grid for the block, shared by its rows (subgrid), so the columns line up:
     the name as wide as the longest (at most 11rem; longer ones truncate, their full
     text in the title), the size, as wide as the longest and never wrapped, the
     value area, which takes what is left and gives way first, and the actions,
     which never wrap. -->
<div
	class="card grid grid-cols-[minmax(0,max-content)_minmax(4rem,max-content)_minmax(0,1fr)_auto] gap-x-2 gap-y-1 rounded-md bg-surface-sunken px-3 py-2 {klass}"
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
		<!-- One line: name, size, the value area (or the reason there is none), the
		     actions. A shown value or an error takes a line of its own under it, as
		     wide as the row: the actions never wrap, the value is not squeezed. -->
		<div class="col-span-full grid grid-cols-subgrid items-center" data-key-row={info.key}>
			<span class="{cell} max-w-44 truncate text-text-muted" title={info.key} data-key-name>{info.key}</span>
			<span class="{cell} flex min-h-(--control-inline-h) items-center justify-end whitespace-nowrap text-text-muted" data-key-size
				>{formatSize(info.size)}</span
			>
			<!-- A container: in a row too narrow for them, the dots are not drawn at all
			     rather than cut mid-glyph. A reason that does not fit is kept here, unseen,
			     to be measured, and said on a line of its own under the key. -->
			<span
				class="@container min-w-0 overflow-hidden py-1"
				data-key-value={below ? undefined : ''}
				{@attach fit(info.key)}
			>
				{#if reason}
					{@const away = cramped[info.key] ?? false}
					<span
						class="{cell} whitespace-nowrap text-text-muted {away ? 'invisible' : ''}"
						aria-hidden={away ? 'true' : undefined}
						data-key-reason-inline>{reason}</span
					>
				{:else if !below && masked}
					<span class="{cell} whitespace-nowrap text-text-subtle @max-[3.75rem]:hidden" aria-hidden="true"
						>••••••••</span
					><span
						class="sr-only">hidden</span
					>
				{/if}
			</span>
			{#if note === null}
				<span class="flex items-center justify-end gap-1.5" data-key-actions>
					{#if acts && !reason}
						{@const shown = shows.kind === 'shown'}
						{@const reading = shows.kind === 'reading'}
						{@const show = masked ? 'Reveal' : 'Show'}
						<!-- One button, Reveal (Show) then Hide: its name changes, the focus stays on it. -->
						<Button
							variant="text"
							size="inline"
							class={edge}
							pending={reading}
							aria-label="{reading ? 'Reading' : shown ? 'Hide' : show} {info.key}"
							onclick={() => onToggle(info.key)}
						>
							{#snippet icon()}
								{#if shown}
									<EyeOff class="h-3 w-3" aria-hidden="true" />
								{:else}
									<Eye class="h-3 w-3" aria-hidden="true" />
								{/if}
							{/snippet}
							{reading ? 'Reading…' : shown ? 'Hide' : show}
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
			{#if reason && cramped[info.key]}
				<div class="col-span-full pb-1.5">
					<span class="{cell} text-text-muted [overflow-wrap:anywhere]" data-key-reason>{reason}</span>
				</div>
			{/if}
			{#if shows.kind === 'shown'}
				<!-- Line breaks kept; past eight lines it scrolls inside the row. -->
				<div class="col-span-full pb-1.5" data-key-value>
					<span
						class="{cell} block max-h-[8lh] overflow-y-auto break-all whitespace-pre-wrap text-text select-text"
						data-key-shown>{shows.value}</span
					>
				</div>
			{:else if shows.kind === 'error'}
				<div class="col-span-full pb-1.5" data-key-value>
					<span class="{cell} inline-flex items-center gap-1.5 text-error" data-key-error>
						<StatusGlyph state="err" />{shows.message}
					</span>
				</div>
			{/if}
		</div>
	{/each}
</div>
