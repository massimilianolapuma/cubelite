<script lang="ts">
	import Modal from '$lib/components/ui/Modal.svelte';
	import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
	import { app } from '$lib/stores/app.svelte';
	import { resources } from '$lib/stores/resources.svelte';
	import { clusters } from '$lib/stores/clusters.svelte';
	import { settings, type RefreshInterval, type Theme } from '$lib/stores/settings.svelte';

	function close() {
		app.preferencesOpen = false;
	}

	const themeSegments: { value: Theme; label: string; disabled?: boolean; title?: string }[] = [
		{ value: 'light', label: 'Light', disabled: true, title: 'Coming soon — dark is final in v1' },
		{ value: 'dark', label: 'Dark' },
		{ value: 'system', label: 'System', disabled: true, title: 'Coming soon — dark is final in v1' }
	];

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
				<p class="type-caption mt-0.5 text-text-tertiary">Light and System arrive with the light theme.</p>
			</div>
			<SegmentedControl segments={themeSegments} bind:value={settings.theme.value} />
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

		<section>
			<div class="type-body mb-1.5 text-text-primary">Kubeconfig</div>
			<div class="rounded-md border border-border-faint bg-surface-window px-2.5 py-2">
				<div class="truncate font-mono text-[11px] text-text-secondary">{app.kubeconfigPath || '—'}</div>
				<div class="type-caption mt-0.5 text-text-tertiary">
					{clusters.contexts.length} context{clusters.contexts.length === 1 ? '' : 's'}
				</div>
			</div>
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
