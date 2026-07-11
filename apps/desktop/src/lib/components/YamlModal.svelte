<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import Modal from '$lib/components/ui/Modal.svelte';
	import { errorMessage } from '$lib/errors';
	import { app } from '$lib/stores/app.svelte';
	import { getResourceYaml, type YamlResourceType } from '$lib/tauri';

	let {
		resourceType,
		namespace,
		name,
		onClose
	}: {
		resourceType: YamlResourceType;
		namespace: string;
		name: string;
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
		getResourceYaml(kc, resourceType, namespace, name, cluster)
			.then((text) => (yaml = text))
			.catch((e: unknown) => (error = errorMessage(e)));
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

<Modal title="{name}.yaml" width={720} {onClose}>
	<div class="flex flex-col gap-2">
		<div class="flex justify-end">
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
				class="type-log max-h-[60vh] overflow-auto rounded-lg border border-border-faint bg-surface-sunken p-3 text-text-log">{yaml}</pre>
		{/if}
	</div>
</Modal>
