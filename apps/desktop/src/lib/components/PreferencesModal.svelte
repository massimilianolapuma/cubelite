<script lang="ts">
	import { setMode } from 'mode-watcher';
	import { applyAccent, applyDensity } from '$lib/appearance';
	import { IDENTITY_COLORS, identityVar } from '$lib/cluster-identity';
	import Modal from '$lib/components/ui/Modal.svelte';
	import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
	import { app } from '$lib/stores/app.svelte';
	import { resources } from '$lib/stores/resources.svelte';
	import { clusters } from '$lib/stores/clusters.svelte';
	import {
		settings,
		type Accent,
		type Density,
		type RefreshInterval,
		type Theme
	} from '$lib/stores/settings.svelte';
	import { updater } from '$lib/stores/updater.svelte';

	function close() {
		app.preferencesOpen = false;
	}

	let updateChecked = $state(false);

	async function checkForUpdates() {
		updateChecked = true;
		await updater.checkForUpdates(false);
	}

	const themeSegments: { value: Theme; label: string }[] = [
		{ value: 'light', label: 'Light' },
		{ value: 'dark', label: 'Dark' },
		{ value: 'system', label: 'System' }
	];

	const densitySegments: { value: Density; label: string }[] = [
		{ value: 'default', label: 'Default' },
		{ value: 'compact', label: 'Compact' }
	];

	const accents: { value: Accent; label: string; color: string }[] = [
		{ value: 'blue', label: 'Blue', color: 'var(--cl-color-cluster-blue)' },
		{ value: 'violet', label: 'Violet', color: 'var(--cl-color-accent-alt-violet)' },
		{ value: 'teal', label: 'Teal', color: 'var(--cl-color-accent-alt-teal)' }
	];

	function setAccent(value: Accent) {
		settings.accent.value = value;
		applyAccent(value);
	}

	const refreshSegments: { value: RefreshInterval; label: string }[] = [
		{ value: 10, label: '10s' },
		{ value: 30, label: '30s' },
		{ value: 60, label: '1m' },
		{ value: 0, label: 'off' }
	];
</script>

<Modal title="Preferences" onClose={close}>
	<div class="flex flex-col gap-5">
		<section class="flex items-center justify-between gap-4">
			<div>
				<div class="type-body text-text-primary">Appearance</div>
				<p class="type-caption mt-0.5 text-text-tertiary">System follows the OS preference.</p>
			</div>
			<SegmentedControl
				segments={themeSegments}
				bind:value={settings.theme.value}
				onChange={(value) => setMode(value)}
			/>
		</section>

		<section class="flex items-center justify-between gap-4">
			<div>
				<div class="type-body text-text-primary">Density</div>
				<p class="type-caption mt-0.5 text-text-tertiary">Compact tightens table rows.</p>
			</div>
			<SegmentedControl
				segments={densitySegments}
				bind:value={settings.density.value}
				onChange={(value) => applyDensity(value)}
			/>
		</section>

		<section class="flex items-center justify-between gap-4">
			<div>
				<div class="type-body text-text-primary">Accent</div>
				<p class="type-caption mt-0.5 text-text-tertiary">Selection, focus and primary buttons.</p>
			</div>
			<div class="flex items-center gap-2" role="radiogroup" aria-label="Accent color">
				{#each accents as accent (accent.value)}
					{@const active = settings.accent.value === accent.value}
					<button
						type="button"
						role="radio"
						aria-checked={active}
						aria-label={accent.label}
						class="focus-ring hit-target h-5 w-5 rounded-full"
						style="background: {accent.color}; box-shadow: {active
							? `0 0 0 2px var(--color-surface-overlay), 0 0 0 4px ${accent.color}`
							: 'none'};"
						onclick={() => setAccent(accent.value)}
					></button>
				{/each}
			</div>
		</section>

		<section class="flex items-center justify-between gap-4">
			<div>
				<div class="type-body text-text-primary">Auto-refresh</div>
				<p class="type-caption mt-0.5 text-text-tertiary">Re-list resources on an interval, on top of live watches.</p>
			</div>
			<SegmentedControl
				segments={refreshSegments}
				bind:value={settings.refreshInterval.value}
				onChange={() => resources.applyRefreshInterval()}
			/>
		</section>

		<section class="flex items-center justify-between gap-4">
			<div>
				<div class="type-body text-text-primary">Skip TLS verification</div>
				<p class="type-caption mt-0.5 text-text-tertiary">Stored only — not yet enforced by the backend.</p>
			</div>
			<button
				type="button"
				role="switch"
				aria-checked={settings.skipTls.value}
				aria-label="Skip TLS verification"
				class="focus-ring relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors"
				style="background: {settings.skipTls.value ? 'var(--color-status-ok)' : 'var(--color-surface-raised)'};"
				onclick={() => (settings.skipTls.value = !settings.skipTls.value)}
			>
				<span
					class="absolute top-[3px] h-4 w-4 rounded-full bg-text-primary transition-[left]"
					style="left: {settings.skipTls.value ? '18px' : '3px'};"
				></span>
			</button>
		</section>

		{#if clusters.contexts.length > 0}
			<section>
				<div class="type-body mb-1.5 text-text-primary">Cluster colors</div>
				<div class="flex flex-col gap-1.5 rounded-md border border-border-faint bg-surface-window px-2.5 py-2">
					{#each clusters.contexts as ctx (ctx.name)}
						{@const current = clusters.identityFor(ctx.name)}
						<div class="flex items-center gap-3">
							<span class="min-w-0 flex-1 truncate type-data-sm text-text-secondary">{ctx.name}</span>
							<div class="flex items-center gap-1.5" role="radiogroup" aria-label="Color for {ctx.name}">
								{#each IDENTITY_COLORS as color (color)}
									<button
										type="button"
										role="radio"
										aria-checked={current === color}
										aria-label={color}
										class="focus-ring hit-target h-3.5 w-3.5 rounded-full"
										style="background: {identityVar(color)}; box-shadow: {current === color
											? `0 0 0 2px var(--color-surface-window), 0 0 0 3.5px ${identityVar(color)}`
											: 'none'};"
										onclick={() => clusters.setIdentityColor(ctx.name, color)}
									></button>
								{/each}
							</div>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		<section>
			<div class="type-body mb-1.5 text-text-primary">Kubeconfig</div>
			<div class="rounded-md border border-border-faint bg-surface-window px-2.5 py-2">
				<div class="truncate type-data-sm text-text-secondary">{app.kubeconfigPath || '—'}</div>
				<div class="type-caption mt-0.5 text-text-tertiary">
					{clusters.contexts.length} context{clusters.contexts.length === 1 ? '' : 's'}
				</div>
			</div>
		</section>

		<section class="flex items-center justify-between gap-4">
			<div>
				<div class="type-body text-text-primary">Updates</div>
				<p class="type-caption mt-0.5 text-text-tertiary">
					{#if updater.status === 'checking'}
						Checking…
					{:else if updater.status === 'available' || updater.status === 'downloading'}
						Update {updater.version} available
					{:else if updater.status === 'ready'}
						Update {updater.version} ready to install
					{:else if updater.status === 'error'}
						{updater.error}
					{:else if updateChecked}
						Up to date
					{/if}
				</p>
			</div>
			{#if updater.status === 'available' || updater.status === 'downloading' || updater.status === 'ready'}
				<button
					type="button"
					class="focus-ring type-caption rounded-md border border-border-default bg-surface-raised px-2.5 py-1 text-text-secondary hover:brightness-110"
					disabled={updater.status === 'downloading'}
					onclick={() => updater.installAndRestart()}
				>
					{updater.status === 'downloading' ? 'Downloading…' : 'Install update'}
				</button>
			{:else}
				<button
					type="button"
					class="focus-ring type-caption rounded-md border border-border-default bg-surface-raised px-2.5 py-1 text-text-secondary hover:brightness-110"
					disabled={updater.status === 'checking'}
					onclick={checkForUpdates}
				>
					Check for updates
				</button>
			{/if}
		</section>

		<button
			type="button"
			class="focus-ring type-caption self-start rounded-sm text-accent hover:brightness-110"
			onclick={() => {
				close();
				app.onboardingOpen = true;
			}}
		>
			Show first-launch onboarding again
		</button>
	</div>
</Modal>
