<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import IdentityAvatar from '$lib/components/ui/IdentityAvatar.svelte';
	import Kbd from '$lib/components/ui/Kbd.svelte';
	import { app } from '$lib/stores/app.svelte';
	import { clusters } from '$lib/stores/clusters.svelte';
	import { settings } from '$lib/stores/settings.svelte';
	import { modLabel } from '$lib/platform';

	let step = $state(0);

	function finish() {
		settings.onboardingSeen.value = true;
		app.onboardingOpen = false;
	}

	const shortcuts: [string, string][] = [
		[`${modLabel}K`, 'Search & switch anything'],
		[`${modLabel}1–5`, 'Switch cluster instantly'],
		['esc', 'Close the topmost overlay']
	];
</script>

<!-- Dimmed 88% backdrop per spec (heavier than modals). -->
<div
	class="animate-fadein fixed inset-0 z-40"
	style="background: color-mix(in srgb, black 88%, transparent);"
	role="presentation"
></div>
<div
	class="animate-popin fixed top-1/2 left-1/2 z-50 w-[480px] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border-strong bg-surface-overlay p-6 shadow-overlay"
	role="dialog"
	aria-modal="true"
	aria-label="Welcome to CubeLite"
>
	{#if step === 0}
		<h1 class="type-display mb-2">Welcome to CubeLite</h1>
		<p class="type-body mb-4 text-text-secondary">
			A fast, keyboard-first Kubernetes client with one identity per cluster — so you always know
			where you are acting.
		</p>
		<div class="flex items-center gap-2.5 rounded-lg border border-border-faint bg-surface-window px-3 py-2.5">
			<span class="truncate font-mono text-[11px] text-text-secondary">
				{app.kubeconfigPath || '~/.kube/config'}
			</span>
			<span class="flex-1"></span>
			<span class="flex items-center gap-1 text-[11px] text-status-ok">
				<Check class="h-3 w-3" />
				{clusters.contexts.length} context{clusters.contexts.length === 1 ? '' : 's'} found
			</span>
		</div>
	{:else if step === 1}
		<h2 class="type-title mb-1">Your clusters</h2>
		<p class="type-caption mb-3 text-text-tertiary">
			Each context gets a stable identity color, everywhere it appears.
		</p>
		<div class="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
			{#each clusters.contexts.slice(0, 5) as ctx, i (ctx.name)}
				<div class="flex items-center gap-2.5 rounded-lg border border-border-faint bg-surface-window px-3 py-2">
					<IdentityAvatar name={ctx.name} color={clusters.identityFor(ctx.name)} size={26} />
					<span class="type-body flex-1 truncate text-text-primary">{ctx.name}</span>
					<Kbd label="{modLabel}{i + 1}" />
				</div>
			{/each}
		</div>
	{:else}
		<h2 class="type-title mb-1">Keyboard first</h2>
		<p class="type-caption mb-3 text-text-tertiary">Everything is a few keys away.</p>
		<div class="flex flex-col gap-1.5">
			{#each shortcuts as [combo, label] (combo)}
				<div class="flex items-center gap-3 rounded-lg border border-border-faint bg-surface-window px-3 py-2">
					<Kbd label={combo} />
					<span class="type-body text-text-secondary">{label}</span>
				</div>
			{/each}
		</div>
	{/if}

	<div class="mt-5 flex items-center gap-1.5">
		{#each [0, 1, 2] as dot (dot)}
			<span
				class="h-1.5 w-1.5 rounded-full"
				style="background: {dot === step ? 'var(--color-accent)' : 'var(--color-border-strong)'};"
			></span>
		{/each}
		<span class="flex-1"></span>
		{#if step < 2}
			<button
				type="button"
				class="focus-ring type-body flex h-7 items-center rounded-md px-3 text-text-tertiary hover:text-text-secondary"
				onclick={finish}
			>
				Skip
			</button>
			<button
				type="button"
				class="focus-ring type-body flex h-7 items-center rounded-md bg-accent px-3 text-surface-window hover:brightness-110"
				onclick={() => (step += 1)}
			>
				Continue
			</button>
		{:else}
			<button
				type="button"
				class="focus-ring type-body flex h-7 items-center rounded-md bg-accent px-3 text-surface-window hover:brightness-110"
				onclick={finish}
			>
				Start using CubeLite
			</button>
		{/if}
	</div>
</div>
