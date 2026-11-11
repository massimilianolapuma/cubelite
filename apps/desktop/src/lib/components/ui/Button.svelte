<script lang="ts" module>
	/** Weight of an action (Tonal §7). `danger` is destructive text; `danger-solid` only confirms a destructive dialog. */
	export type ButtonVariant = 'primary' | 'tonal' | 'text' | 'danger' | 'danger-solid';
	/** `inline` sits inside a list row; `primary` is the one tall action of a panel or dialog. */
	export type ButtonSize = 'default' | 'inline' | 'primary';
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';

	let {
		variant = 'tonal',
		size = 'default',
		pending = false,
		iconOnly = false,
		label,
		disabled = false,
		icon,
		children,
		onclick,
		class: klass = '',
		...rest
	}: {
		variant?: ButtonVariant;
		size?: ButtonSize;
		/** An operation is running: the button keeps its width, shows a spinner and ignores clicks. */
		pending?: boolean;
		/** A disc with only an icon; `label` is then its accessible name. */
		iconOnly?: boolean;
		label?: string;
		disabled?: boolean;
		/** Leading icon; replaced by the spinner while pending. */
		icon?: Snippet;
		children?: Snippet;
		onclick?: (event: MouseEvent) => void;
		class?: string;
	} & Omit<HTMLButtonAttributes, 'disabled' | 'children' | 'class' | 'onclick'> = $props();

	// A busy or disabled button does nothing, however the click reaches it.
	function click(event: MouseEvent) {
		if (pending || disabled) return;
		onclick?.(event);
	}

	const look: Record<ButtonVariant, string> = {
		primary: 'bg-primary text-on-primary',
		tonal: 'bg-primary-container text-on-primary-container',
		text: 'text-text hover:bg-surface-container-high',
		danger: 'text-error hover:bg-surface-container-high',
		'danger-solid': 'bg-error-solid text-on-error-solid'
	};
	const height: Record<ButtonSize, string> = {
		default: 'h-(--control-h)',
		inline: 'h-(--control-inline-h)',
		primary: 'h-(--control-primary-h)'
	};
	const width: Record<ButtonSize, string> = {
		default: 'w-(--control-h)',
		inline: 'w-(--control-inline-h)',
		primary: 'w-(--control-primary-h)'
	};
	const padding: Record<ButtonSize, string> = { default: 'px-5', inline: 'px-3.5', primary: 'px-6' };
	// With no icon to swap, the spinner sits over the label so the width holds.
	const overlaySpinner = $derived(pending && !icon);
</script>

<button
	type="button"
	{...rest}
	data-variant={variant}
	data-icon-only={iconOnly ? 'true' : undefined}
	aria-label={iconOnly ? label : rest['aria-label']}
	aria-busy={pending ? 'true' : undefined}
	disabled={disabled || pending}
	onclick={click}
	class="focus-ring relative inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-semibold hover:brightness-110 disabled:pointer-events-none {pending
		? ''
		: 'disabled:opacity-45'} {size === 'primary' ? 'type-title' : 'type-body'} {height[size]} {iconOnly
		? width[size]
		: padding[size]} {look[variant]} {klass}"
>
	{#if pending && icon}
		<LoaderCircle class="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
	{:else if icon}
		{@render icon()}
	{/if}
	{#if children}
		<span class="inline-flex items-center gap-2 {overlaySpinner ? 'opacity-0' : ''}">{@render children()}</span>
	{/if}
	{#if overlaySpinner}
		<LoaderCircle class="absolute h-4 w-4 animate-spin" aria-hidden="true" />
	{/if}
</button>
