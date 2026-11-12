<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import Button from '#lib/components/ui/Button.svelte';
	import IdentityAvatar from '#lib/components/ui/IdentityAvatar.svelte';
	import Kbd from '#lib/components/ui/Kbd.svelte';
	import { app } from '#lib/stores/app.svelte.ts';
	import { clusters } from '#lib/stores/clusters.svelte.ts';
	import { settings } from '#lib/stores/settings.svelte.ts';
	import { modLabel } from '#lib/platform.ts';

	const STEPS = 3;
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

<!-- Dimmed 88 % backdrop: heavier than a modal's, nothing behind it is in use yet. -->
<div class="animate-fadein fixed inset-0 z-40 bg-black/88" role="presentation"></div>
<!-- A dialog in the Modal look (Tonal §7, §8.6). Only the step's content scrolls,
     so the progress and the actions stay in a short window. -->
<div
	class="card animate-popin fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-2rem)] w-[480px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl bg-surface-overlay shadow-overlay"
	role="dialog"
	aria-modal="true"
	aria-label="Welcome to CubeLite"
	data-testid="onboarding"
>
	<div class="min-h-0 flex-1 overflow-y-auto px-6 pt-6 pb-2">
		{#if step === 0}
			<h2 class="type-headline mb-2">Welcome to CubeLite</h2>
			<p class="type-body mb-4 text-text-muted">
				A fast, keyboard-first Kubernetes client with one identity per cluster — so you always know
				where you are acting.
			</p>
			<div class="flex items-center gap-3 rounded-md bg-surface-sunken px-4 py-3">
				<span class="type-data-sm min-w-0 truncate text-text-muted" title={app.kubeconfigPath || '~/.kube/config'}>
					{app.kubeconfigPath || '~/.kube/config'}
				</span>
				<span class="flex-1"></span>
				<span class="type-body-sm flex shrink-0 items-center gap-1.5 font-semibold text-text">
					<Check class="h-3.5 w-3.5 text-success" aria-hidden="true" />
					{clusters.contexts.length} context{clusters.contexts.length === 1 ? '' : 's'} found
				</span>
			</div>
		{:else if step === 1}
			<h2 class="type-headline mb-1">Your clusters</h2>
			<p class="type-body-sm mb-4 text-text-muted">
				Each context gets a stable identity color, everywhere it appears.
			</p>
			<ul class="flex flex-col gap-1" aria-label="Clusters">
				{#each clusters.contexts.slice(0, 5) as ctx, i (ctx.name)}
					<!-- The avatar carries its own cluster's tint (Tonal §4.1). -->
					<li class="flex items-center gap-3 py-1">
						<IdentityAvatar name={ctx.name} color={clusters.identityFor(ctx.name)} size={32} surface="container" />
						<span class="type-body min-w-0 flex-1 truncate text-text" title={ctx.name}>{ctx.name}</span>
						<Kbd label="{modLabel}{i + 1}" />
					</li>
				{/each}
			</ul>
		{:else}
			<h2 class="type-headline mb-1">Keyboard first</h2>
			<p class="type-body-sm mb-4 text-text-muted">Everything is a few keys away.</p>
			<ul class="flex flex-col gap-2" aria-label="Shortcuts">
				{#each shortcuts as [combo, label] (combo)}
					<li class="flex items-center gap-3 py-1">
						<span class="flex w-16 shrink-0"><Kbd label={combo} /></span>
						<span class="type-body text-text">{label}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	<!-- The one primary action is 48 px (Tonal §7), as in the pod panel. -->
	<div class="flex shrink-0 flex-wrap items-center gap-2 px-6 pt-3 pb-5">
		<!-- Progress is a sentence; the dots repeat it, the current one longer (Tonal §9.3). -->
		<div class="flex items-center gap-1.5" aria-hidden="true">
			{#each Array.from({ length: STEPS }, (_, i) => i) as dot (dot)}
				<span
					data-current={dot === step}
					class="h-2 rounded-full {dot === step ? 'w-5 bg-primary' : 'w-2 bg-outline-strong'}"
				></span>
			{/each}
		</div>
		<span class="type-label ml-1 text-text-muted" data-testid="onboarding-progress">Step {step + 1} of {STEPS}</span>
		<span class="flex-1"></span>
		{#if step < STEPS - 1}
			<Button variant="text" onclick={finish}>Skip</Button>
			<Button variant="primary" size="primary" onclick={() => (step += 1)}>Continue</Button>
		{:else}
			<Button variant="primary" size="primary" onclick={finish}>Start using CubeLite</Button>
		{/if}
	</div>
</div>
