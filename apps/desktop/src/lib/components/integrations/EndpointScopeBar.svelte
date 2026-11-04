<script lang="ts">
	import SegmentedControl from '#lib/components/ui/SegmentedControl.svelte';
	import { SCOPE_SEGMENTS, SCOPE_TEXT, usedByText, type EndpointScopeKind, type ScopeView } from '#lib/endpoint-scope.ts';
	import { ACCENT_LINK_CLASS, BUTTON_CLASS } from '#lib/integration-form.svelte.ts';

	// Top of an integration's preferences (#528): edit this context's
	// endpoint or the default shared by every context, and what the default
	// means for this context (used, overridden, off).
	let {
		scope,
		pending,
		view,
		defaultTarget,
		usedBy,
		hasOwn,
		disabled,
		onScope,
		onConfirm,
		onCancel,
		onOverride,
		onTurnOff,
		onUseDefault
	}: {
		scope: EndpointScopeKind;
		/** A switch waiting for "Discard changes" (unsaved edits). */
		pending: EndpointScopeKind | null;
		view: ScopeView;
		/** The default endpoint's URL; null when there is none. */
		defaultTarget: string | null;
		/** Contexts using the default (shown while editing it). */
		usedBy: string[];
		/** The context has an endpoint of its own (or the user is overriding). */
		hasOwn: boolean;
		disabled: boolean;
		onScope: (kind: EndpointScopeKind) => void;
		onConfirm: () => void;
		onCancel: () => void;
		onOverride: () => void;
		onTurnOff: () => void;
		onUseDefault: () => void;
	} = $props();
</script>

<div class="flex items-center justify-between gap-3">
	<span class="type-caption text-text-secondary">Endpoint for</span>
	<SegmentedControl segments={SCOPE_SEGMENTS} bind:value={() => scope, onScope} label="Endpoint scope" />
</div>

{#if pending}
	<div class="flex flex-wrap items-center gap-2" role="alert" data-testid="scope-unsaved">
		<span class="type-caption text-status-warn">{SCOPE_TEXT.unsaved}</span>
		<button type="button" class={BUTTON_CLASS} onclick={onConfirm}>{SCOPE_TEXT.discard}</button>
		<button type="button" class={BUTTON_CLASS} onclick={onCancel}>{SCOPE_TEXT.keepEditing}</button>
	</div>
{/if}

{#if view === 'default'}
	<p class="type-caption text-text-tertiary" data-testid="default-used-by">{usedByText(usedBy)}</p>
	<p class="type-caption text-text-tertiary">{SCOPE_TEXT.defaultHint}</p>
{:else if view === 'inherited'}
	<div class="flex flex-wrap items-center gap-2" data-testid="default-in-use">
		<span class="type-caption min-w-0 truncate text-text-secondary" title={defaultTarget ?? undefined}>
			{SCOPE_TEXT.usingDefault} · <span class="text-text-tertiary">{defaultTarget}</span>
		</span>
		<button type="button" class={BUTTON_CLASS} {disabled} onclick={onOverride}>{SCOPE_TEXT.override}</button>
		<button type="button" class={BUTTON_CLASS} {disabled} onclick={onTurnOff}>{SCOPE_TEXT.turnOff}</button>
	</div>
{:else if defaultTarget !== null && (view === 'off' || hasOwn)}
	<div class="flex flex-wrap items-center gap-2" data-testid="default-not-used">
		<span class="type-caption text-text-tertiary">
			{view === 'off' ? SCOPE_TEXT.offForContext : SCOPE_TEXT.overridesDefault}
		</span>
		<button type="button" class={ACCENT_LINK_CLASS} {disabled} onclick={onUseDefault}>{SCOPE_TEXT.useDefault}</button>
	</div>
{/if}
