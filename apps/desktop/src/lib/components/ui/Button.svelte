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
		blockedReason = null,
		icon,
		children,
		onclick,
		class: klass = '',
		...rest
	}: {
		variant?: ButtonVariant;
		size?: ButtonSize;
		/**
		 * An operation is running: the button keeps its width and its keyboard focus
		 * (it is `aria-disabled`, not natively disabled), shows a spinner and ignores clicks.
		 */
		pending?: boolean;
		/** A disc with only an icon; `label` is then its accessible name. */
		iconOnly?: boolean;
		label?: string;
		disabled?: boolean;
		/**
		 * Why the action is off (a read-only cluster, #662). The button stays in
		 * place and in the tab order, drawn as disabled: `aria-disabled`, the reason
		 * as its tooltip and its accessible description, and a press does nothing.
		 * Use it rather than `disabled` whenever the user can do something about it.
		 */
		blockedReason?: string | null;
		/** Leading icon; replaced by the spinner while pending. */
		icon?: Snippet;
		children?: Snippet;
		onclick?: (event: MouseEvent) => void;
		class?: string;
	} & Omit<HTMLButtonAttributes, 'disabled' | 'children' | 'class' | 'onclick'> = $props();

	// A busy, blocked or disabled button does nothing, however the click reaches it.
	function click(event: MouseEvent) {
		if (pending || disabled || blocked) return;
		onclick?.(event);
	}

	const blocked = $derived(typeof blockedReason === 'string' && blockedReason !== '');
	const reasonId = $props.id();
	const describedBy = $derived(
		blocked
			? [rest['aria-describedby'], reasonId].filter((id) => typeof id === 'string' && id !== '').join(' ')
			: rest['aria-describedby']
	);

	const look: Record<ButtonVariant, string> = {
		primary: 'bg-primary text-on-primary',
		tonal: 'bg-primary-container text-on-primary-container',
		text: 'text-text',
		danger: 'text-error',
		'danger-solid': 'bg-error-solid text-on-error-solid'
	};
	// Filled buttons brighten; unfilled ones get a layer of their own colour, which
	// shows on any surface (a fixed surface tone vanishes on the overlay).
	const hover: Record<ButtonVariant, string> = {
		primary: 'enabled:hover:brightness-110',
		tonal: 'enabled:hover:brightness-110',
		text: 'hover-layer',
		danger: 'hover-layer',
		'danger-solid': 'enabled:hover:brightness-110'
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
	aria-label={iconOnly ? (label ?? rest['aria-label']) : rest['aria-label']}
	aria-busy={pending ? 'true' : rest['aria-busy']}
	aria-disabled={pending || blocked ? 'true' : rest['aria-disabled']}
	aria-describedby={describedBy}
	title={blocked ? blockedReason : rest.title}
	data-blocked={blocked ? 'true' : undefined}
	{disabled}
	onclick={click}
	class="focus-ring relative inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-semibold disabled:cursor-default disabled:opacity-45 {pending
		? 'cursor-progress'
		: blocked
			? 'cursor-default aria-disabled:opacity-45'
			: hover[variant]} {size === 'primary' ? 'type-title' : 'type-body'} {height[size]} {iconOnly
		? width[size]
		: padding[size]} {look[variant]} {klass}"
>
	{#if pending && icon}
		<LoaderCircle class="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
	{:else if icon}
		{@render icon()}
	{/if}
	<!-- With reduced motion a spinner stands still: a still circle in place of an
	     icon looks like an icon, and one over a hidden label would hide it. So every
	     pending label stays in view, faded like a disabled one (Tonal §9.1). -->
	{#if children}
		<span
			class="inline-flex items-center gap-2 {overlaySpinner
				? 'opacity-0 motion-reduce:opacity-45'
				: pending
					? 'motion-reduce:opacity-45'
					: ''}">{@render children()}</span
		>
	{/if}
	{#if overlaySpinner}
		<LoaderCircle class="absolute h-4 w-4 animate-spin motion-reduce:hidden" aria-hidden="true" />
	{/if}
</button>
{#if blocked}
	<!-- The reason as the button's description: hidden, read through aria-describedby
	     (outside the button, so it is not part of its name). -->
	<span id={reasonId} hidden>{blockedReason}</span>
{/if}
