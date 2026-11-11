<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import Button from '#lib/components/ui/Button.svelte';
	import Drawer from '#lib/components/ui/Drawer.svelte';
	import FactRows from '#lib/components/ui/FactRows.svelte';
	import { errorMessage } from '#lib/errors.ts';
	import type { KindView } from '#lib/resource-kinds.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { dynamic } from '#lib/stores/dynamic.svelte.ts';
	import { getDynamicResourceYaml } from '#lib/tauri.ts';
	import { PANEL_CARD, PANEL_SECTION } from '#lib/ui-classes.ts';

	// One object of a generic list (resource-kinds §5.1, Tonal §8.3): a Summary
	// of every column the server returned, then its read-only YAML. No Edit:
	// these kinds are not writable from CubeLite.
	let {
		view,
		kind,
		name,
		namespace,
		summary = [],
		onClose
	}: {
		view: KindView;
		/** What the object is, e.g. "daemon set". */
		kind?: string;
		name: string;
		namespace: string | null;
		/** Label and value of each column of the object's row. */
		summary?: readonly (readonly [string, string | null])[];
		onClose: () => void;
	} = $props();

	let yaml = $state<string | null>(null);
	let error = $state<string | null>(null);
	let copied = $state(false);

	$effect(() => {
		yaml = null;
		error = null;
		const kc = app.kubeconfigPath;
		const cluster = app.activeCluster;
		if (!kc || !cluster) return;
		let stale = false;
		getDynamicResourceYaml(kc, dynamic.refFor(view), namespace ?? undefined, name, cluster)
			.then((text) => {
				if (!stale) yaml = text;
			})
			.catch((e: unknown) => {
				if (!stale) error = errorMessage(e);
			});
		return () => (stale = true);
	});

	async function copy() {
		if (!yaml) return;
		try {
			await navigator.clipboard.writeText(yaml);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			// Clipboard may be unavailable; the selection still works.
		}
	}
</script>

<Drawer {kind} title={name} {onClose}>
	<div class="flex flex-col gap-4">
		{#if namespace === null}
			<p class="type-body-sm text-text-muted">cluster-scoped</p>
		{/if}

		{#if summary.length > 0}
			<div role="group" aria-label="Summary">
				<div class={PANEL_SECTION}>Summary</div>
				<FactRows facts={summary} />
			</div>
		{/if}

		<div>
			<div class="mb-2 flex items-center justify-between gap-2">
				<div class="type-label text-text-muted">YAML</div>
				<Button variant="text" size="inline" disabled={!yaml} onclick={() => void copy()}>
					{#snippet icon()}
						{#if copied}
							<Check class="h-3.5 w-3.5" aria-hidden="true" />
						{:else}
							<Copy class="h-3.5 w-3.5" aria-hidden="true" />
						{/if}
					{/snippet}
					{copied ? 'Copied' : 'Copy'}
				</Button>
			</div>
			{#if error}
				<p class="{PANEL_CARD} type-data-sm p-3 break-words text-text" role="alert">{error}</p>
			{:else if yaml === null}
				<p class="type-body-sm py-6 text-center text-text-muted" role="status">Loading…</p>
			{:else}
				<pre class="type-log overflow-auto rounded-md bg-surface-sunken p-3 text-text">{yaml}</pre>
			{/if}
		</div>
	</div>
</Drawer>
