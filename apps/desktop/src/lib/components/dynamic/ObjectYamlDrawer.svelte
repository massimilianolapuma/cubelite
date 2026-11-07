<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import Drawer from '#lib/components/ui/Drawer.svelte';
	import { errorMessage } from '#lib/errors.ts';
	import type { KindView } from '#lib/resource-kinds.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { dynamic } from '#lib/stores/dynamic.svelte.ts';
	import { getDynamicResourceYaml } from '#lib/tauri.ts';

	// Read-only YAML of one object of a generic list (resource-kinds §5.1):
	// no Edit, the new kinds are not writable from CubeLite.
	let {
		view,
		name,
		namespace,
		onClose
	}: { view: KindView; name: string; namespace: string | null; onClose: () => void } = $props();

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

<Drawer title={name} {onClose}>
	<div class="flex flex-col gap-2">
		<div class="flex items-center justify-between gap-2">
			<span class="type-caption text-text-tertiary">{namespace ?? 'cluster-scoped'}</span>
			<button
				type="button"
				disabled={!yaml}
				class="focus-ring type-caption flex h-7 items-center gap-1.5 rounded-md border border-border-default bg-surface-raised px-2.5 text-text-secondary hover:brightness-110 disabled:opacity-45"
				onclick={() => void copy()}
			>
				{#if copied}
					<Check class="h-3 w-3 text-status-ok" />
					Copied
				{:else}
					<Copy class="h-3 w-3" />
					Copy
				{/if}
			</button>
		</div>
		{#if error}
			<p class="py-8 text-center text-xs text-status-err">{error}</p>
		{:else if yaml === null}
			<p class="py-8 text-center text-xs text-text-disabled">Loading…</p>
		{:else}
			<pre
				class="type-log overflow-auto rounded-lg border border-border-faint bg-surface-sunken p-3 text-text-log">{yaml}</pre>
		{/if}
	</div>
</Drawer>
