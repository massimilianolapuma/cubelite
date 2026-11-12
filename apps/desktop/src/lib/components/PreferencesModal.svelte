<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { setMode } from 'mode-watcher';
	import { open } from '@tauri-apps/plugin-dialog';
	import {
		addPaths,
		originLabel,
		redefinedEntries,
		removePath,
		seedIfEmpty
	} from '#lib/kubeconfig-list.ts';
	import Check from '@lucide/svelte/icons/check';
	import Download from '@lucide/svelte/icons/download';
	import { applyDensity, tintStyle } from '#lib/appearance.ts';
	import { IDENTITY_COLORS } from '#lib/cluster-identity.ts';
	import Button from '#lib/components/ui/Button.svelte';
	import Modal from '#lib/components/ui/Modal.svelte';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';
	import SegmentedControl from '#lib/components/ui/SegmentedControl.svelte';
	import NavigationPreferences from '#lib/components/NavigationPreferences.svelte';
	import ElasticPreferences from '#lib/components/ElasticPreferences.svelte';
	import PrometheusPreferences from '#lib/components/PrometheusPreferences.svelte';
	import { errorMessage } from '#lib/errors.ts';
	import { ACCENT_LINK_CLASS } from '#lib/integration.ts';
	import { integrations } from '#lib/stores/integrations.svelte.ts';
	import { toasts } from '#lib/stores/toasts.svelte.ts';
	import Switch from '#lib/components/ui/Switch.svelte';
	import { app, type PreferencesSection } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';
	import { clusters } from '#lib/stores/clusters.svelte.ts';
	import {
		settings,
		type Density,
		type RefreshInterval,
		type Theme
	} from '#lib/stores/settings.svelte.ts';
	import { updater } from '#lib/stores/updater.svelte.ts';

	function close() {
		app.preferencesOpen = false;
	}

	// "Set up" in a panel opens Preferences on an integration (#526).
	const sections = $state<Record<PreferencesSection, HTMLElement | null>>({
		kubeconfig: null,
		navigation: null,
		integrations: null,
		elasticsearch: null,
		prometheus: null
	});
	let content = $state<HTMLElement | null>(null);
	/** How long the scroll follows content that loads above the section. */
	const FOLLOW_MS = 1000;
	$effect(() => {
		// Read once (the modal mounts per opening) so clearing it does not re-run this.
		const wanted = untrack(() => app.preferencesSection);
		const el = wanted ? sections[wanted] : null;
		if (!el || !content) return;
		untrack(() => (app.preferencesSection = null));
		const scroll = () => el.scrollIntoView?.({ block: 'start' });
		void tick().then(scroll);
		// Sections above (kubeconfig list, detected services) fill in
		// asynchronously and push the target down: follow them briefly.
		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(scroll);
		observer.observe(content);
		const stop = setTimeout(() => observer.disconnect(), FOLLOW_MS);
		return () => {
			clearTimeout(stop);
			observer.disconnect();
		};
	});

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

	const refreshSegments: { value: RefreshInterval; label: string }[] = [
		{ value: 10, label: '10s' },
		{ value: 30, label: '30s' },
		{ value: 60, label: '1m' },
		{ value: 0, label: 'off' }
	];

	// One row per kubeconfig file; before sources load, show the spec path.
	const kubeconfigRows = $derived(
		app.kubeconfigSources.length > 0
			? app.kubeconfigSources
			: [
					{
						path: app.kubeconfigPath || '—',
						exists: true,
						contexts: clusters.contexts.length,
						shadowed: [] as string[]
					}
				]
	);

	const resolvedPaths = $derived(app.kubeconfigSources.map((s) => s.path));

	async function applyKubeconfigList(next: string[]) {
		const prev = settings.kubeconfigPaths.value;
		settings.kubeconfigPaths.value = next;
		try {
			// The reload itself toasts a load failure.
			const ok = await clusters.reloadKubeconfig('preferences');
			if (!ok) settings.kubeconfigPaths.value = prev;
		} catch (e) {
			settings.kubeconfigPaths.value = prev;
			toasts.push(`Failed to update kubeconfig list: ${errorMessage(e)}`, 'err');
		}
	}

	async function addKubeconfigFiles() {
		let picked: string | string[] | null;
		try {
			picked = await open({ multiple: true, directory: false, title: 'Select kubeconfig files' });
		} catch (e) {
			toasts.push(`Could not open the file picker: ${errorMessage(e)}`, 'err');
			return;
		}
		const files = Array.isArray(picked) ? picked : picked ? [picked] : [];
		if (files.length === 0) return;
		const seeded = seedIfEmpty(settings.kubeconfigPaths.value, resolvedPaths);
		await applyKubeconfigList(addPaths(seeded, files));
	}

	async function removeKubeconfigFile(path: string) {
		const seeded = seedIfEmpty(settings.kubeconfigPaths.value, resolvedPaths);
		await applyKubeconfigList(removePath(seeded, path));
	}

	async function useDefaultKubeconfig() {
		await applyKubeconfigList([]);
	}

	// One look for every setting (Tonal §7): a group heading in `title`, the
	// setting's name in `body`, its explanation in `body-sm`. Controls sit on the
	// dialog's own surface, so they carry outlines rather than fills.
	const group = 'flex flex-col gap-5 border-t border-outline pt-6 first:border-t-0 first:pt-0';
	const groupHeading = 'type-title text-text';
	const row = 'flex items-center justify-between gap-4';
	const name = 'type-body text-text';
	const hint = 'type-body-sm mt-0.5 text-text-muted';
</script>

<Modal title="Preferences" onClose={close}>
	<div bind:this={content} class="flex flex-col gap-6">
		<section class={group} aria-labelledby="prefs-appearance">
			<h3 id="prefs-appearance" class={groupHeading}>Appearance</h3>
			<div class={row}>
				<div class="min-w-0 flex-1">
					<div class={name}>Theme</div>
					<p class={hint}>System follows the OS preference.</p>
				</div>
				<SegmentedControl
					label="Theme"
					outlined
					segments={themeSegments}
					bind:value={settings.theme.value}
					onChange={(value) => setMode(value)}
				/>
			</div>

			<div class={row}>
				<div class="min-w-0 flex-1">
					<div class={name}>Density</div>
					<p class={hint}>Compact tightens table rows.</p>
				</div>
				<SegmentedControl
					label="Density"
					outlined
					segments={densitySegments}
					bind:value={settings.density.value}
					onChange={(value) => applyDensity(value)}
				/>
			</div>

			{#if clusters.contexts.length > 0}
				<div>
					<div class={name}>Cluster colors</div>
					<p class={hint}>A cluster's color tints the whole window while you are on it.</p>
					<ul class="mt-3 flex flex-col gap-2" aria-label="Cluster colors">
						{#each clusters.contexts as ctx (ctx.name)}
							{@const current = clusters.identityFor(ctx.name)}
							<li class="flex items-center gap-3">
								<span class="type-data-sm min-w-0 flex-1 truncate text-text" title={ctx.name}>{ctx.name}</span>
								<div class="flex items-center gap-2" role="radiogroup" aria-label="Color for {ctx.name}">
									<!-- Each swatch carries its colour as a tint (Tonal §4.1); the chosen one
									     also holds a check, so it is not told by colour alone. -->
									{#each IDENTITY_COLORS as color (color)}
										<button
											type="button"
											role="radio"
											aria-checked={current === color}
											aria-label={color}
											data-tint
											data-swatch
											style={tintStyle(color)}
											class="focus-ring flex h-6 w-6 items-center justify-center rounded-full bg-primary text-on-primary"
											onclick={() => clusters.setIdentityColor(ctx.name, color)}
										>
											{#if current === color}
												<Check class="h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" data-swatch-mark />
											{/if}
										</button>
									{/each}
								</div>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</section>

		<section class={group} aria-labelledby="prefs-connection">
			<h3 id="prefs-connection" class={groupHeading}>Connection</h3>
			<div class={row}>
				<div class="min-w-0 flex-1">
					<div class={name}>Auto-refresh</div>
					<p class={hint}>Re-list resources on an interval, on top of live watches.</p>
				</div>
				<SegmentedControl
					label="Auto-refresh"
					outlined
					segments={refreshSegments}
					bind:value={settings.refreshInterval.value}
					onChange={() => resources.applyRefreshInterval()}
				/>
			</div>

			<div class={row}>
				<div class="min-w-0 flex-1">
					<div class={name}>Skip TLS verification</div>
					<p class={hint}>Stored only — not yet enforced by the backend.</p>
				</div>
				<Switch
					checked={settings.skipTls.value}
					label="Skip TLS verification"
					onChange={(v) => (settings.skipTls.value = v)}
				/>
			</div>
		</section>

		<section bind:this={sections.navigation} class={group} aria-labelledby="prefs-navigation">
			<h3 id="prefs-navigation" class={groupHeading}>Navigation</h3>
			<NavigationPreferences />
		</section>

		<section
			bind:this={sections.integrations}
			class={group}
			data-testid="integrations-prefs"
			aria-labelledby="prefs-integrations"
		>
			<h3 id="prefs-integrations" class={groupHeading}>Integrations</h3>
			<div class={row}>
				<div class="min-w-0 flex-1">
					<div class={name}>Integration hints</div>
					<p class={hint}>Show integration hints in panels</p>
					{#if app.activeCluster && integrations.dismissed(app.activeCluster).length > 0}
						<button
							type="button"
							class="{ACCENT_LINK_CLASS} mt-1"
							onclick={() => app.activeCluster && integrations.resetDismissals(app.activeCluster)}
						>
							Suggest detected integrations again
						</button>
					{/if}
				</div>
				<Switch
					checked={settings.integrationHints.value}
					label="Show integration hints in panels"
					onChange={(v) => (settings.integrationHints.value = v)}
				/>
			</div>

			<div bind:this={sections.elasticsearch}>
				<ElasticPreferences />
			</div>

			<div bind:this={sections.prometheus}>
				<PrometheusPreferences />
			</div>
		</section>

		<section bind:this={sections.kubeconfig} class={group} aria-labelledby="prefs-kubeconfig">
			<div class="flex flex-wrap items-baseline justify-between gap-x-3">
				<h3 id="prefs-kubeconfig" class={groupHeading}>Kubeconfig files</h3>
				<div class="type-body-sm text-text-muted">{originLabel(app.kubeconfigOrigin)}</div>
			</div>
			<div>
				<ul class="rounded-lg border border-outline" aria-label="Kubeconfig files">
					{#each kubeconfigRows as row (row.path)}
						{@const redefined = redefinedEntries(row)}
						<li class="flex items-center gap-3 border-b border-outline px-4 py-2.5 last:border-b-0">
							<div class="min-w-0 flex-1">
								<div
									class="type-data-sm truncate {row.exists ? 'text-text' : 'text-text-subtle'}"
									title={row.path}
								>
									{row.path}
								</div>
								<div class="type-body-sm mt-0.5 flex flex-wrap items-center gap-x-1.5 text-text-muted">
									{#if !row.exists}
										not found — skipped
									{:else}
										<span>{row.contexts} context{row.contexts === 1 ? '' : 's'}</span>
										<!-- Attention is the triangle and a weight, not a colour alone (Tonal §6). -->
										{#if row.shadowed.length > 0}
											<span
												class="inline-flex items-center gap-1 font-semibold text-text"
												data-note="merged"
												title="Also defined in an earlier file, which wins: {row.shadowed.join(', ')}"
											>
												· <StatusGlyph state="warn" class="text-warning" />
												{row.shadowed.length} merged
											</span>
										{/if}
										{#if redefined.length > 0}
											<span
												class="inline-flex items-center gap-1 font-semibold text-text"
												data-note="redefined"
												title="Also defined differently in an earlier file: {redefined.join(
													', '
												)}. Contexts in this file use this file's definition."
											>
												· <StatusGlyph state="warn" class="text-warning" />
												{redefined.length} redefined
											</span>
										{/if}
									{/if}
								</div>
							</div>
							{#if app.kubeconfigSources.length > 0 && !(app.kubeconfigOrigin !== 'custom' && kubeconfigRows.length === 1)}
								<Button
									variant="danger"
									size="inline"
									aria-label="Remove {row.path}"
									onclick={() => void removeKubeconfigFile(row.path)}
								>
									Remove
								</Button>
							{/if}
						</li>
					{/each}
				</ul>
				<div class="mt-3 flex flex-wrap items-center gap-3">
					<Button variant="tonal" size="inline" onclick={() => void addKubeconfigFiles()}>Add file…</Button>
					{#if app.kubeconfigOrigin === 'custom'}
						<button type="button" class={ACCENT_LINK_CLASS} onclick={() => void useDefaultKubeconfig()}>
							Use defaults
						</button>
					{/if}
				</div>
				{#if app.kubeconfigOrigin === 'custom'}
					<p class="{hint} mt-2">Custom list replaces KUBECONFIG; remove every file to go back to defaults.</p>
				{:else if kubeconfigRows.length > 1}
					<p class="{hint} mt-2">Files come from KUBECONFIG; on a name clash the first file wins.</p>
				{/if}
			</div>
		</section>

		<section class={group} aria-labelledby="prefs-updates">
			<h3 id="prefs-updates" class={groupHeading}>Updates</h3>
			<!-- The action first, its outcome beside it: the row reads left to right. -->
			<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
				{#if updater.status === 'available' || updater.status === 'downloading' || updater.status === 'ready'}
					<Button
						variant="tonal"
						size="inline"
						pending={updater.status === 'downloading'}
						onclick={() => updater.installAndRestart()}
					>
						<!-- While it downloads the icon turns into the spinner; the label and the
						     width stay, and the line beside it says what is happening (§7, §9.3). -->
						{#snippet icon()}<Download class="h-4 w-4" aria-hidden="true" />{/snippet}
						Install update
					</Button>
				{:else}
					<Button variant="tonal" size="inline" pending={updater.status === 'checking'} onclick={checkForUpdates}>
						Check for updates
					</Button>
				{/if}
				<p class="type-body-sm min-w-0 text-text-muted" aria-live="polite">
					{#if updater.status === 'checking'}
						Checking…
					{:else if updater.status === 'downloading'}
						Downloading update {updater.version}…
					{:else if updater.status === 'available'}
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

			<button
				type="button"
				class="{ACCENT_LINK_CLASS} self-start"
				onclick={() => {
					close();
					app.onboardingOpen = true;
				}}
			>
				Show first-launch onboarding again
			</button>
		</section>
	</div>
</Modal>
