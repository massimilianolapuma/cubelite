<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import KeyRows, { type KeyCopyState, type KeyRowState } from '#lib/components/resources/KeyRows.svelte';
	import ResourceList from '#lib/components/ui/ResourceList.svelte';
	import SortHeader from '#lib/components/ui/SortHeader.svelte';
	import { formatAge } from '#lib/age.ts';
	import { CONFIGMAP_ERRORS, configMapErrorText } from '#lib/configmap-values.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';
	import {
		copyConfigMapValue,
		readConfigMapValue,
		type ConfigMapCommandError,
		type ConfigMapInfo
	} from '#lib/tauri.ts';
	import { LIST_PINNED } from '#lib/ui-classes.ts';
	import { ValueCopy } from '#lib/value-copy.svelte.ts';
	import { ValueReveal } from '#lib/value-reveal.svelte.ts';

	// The polite status region's message: a key's name and what happened, never a value.
	let announcement = $state('');

	// Emptied first, then set on the next microtask: the same words for another
	// ConfigMap's key of the same name are a change, and are announced again.
	function announce(message: string) {
		announcement = '';
		queueMicrotask(() => (announcement = message));
	}

	// Shown values live for this view only (#668 §3.2), as a Secret's without
	// the timer: each is read when its key is shown, and dropped on Hide, on
	// leaving the view, on a namespace or cluster change, and when a reload
	// shows its ConfigMap changed or the key gone.
	const reveal = new ValueReveal<ConfigMapCommandError>({
		read: (namespace, name, key) =>
			readConfigMapValue(app.kubeconfigPath, namespace, name, key, app.activeCluster ?? undefined),
		announce,
		reload: () => void resources.loadKind('configmaps'),
		errors: CONFIGMAP_ERRORS
	});
	// A copy goes through the backend, which writes the clipboard plain (#668
	// §6.2): no value here, nothing cleared.
	const copies = new ValueCopy<ConfigMapCommandError>({
		copy: (namespace, name, key) =>
			copyConfigMapValue(app.kubeconfigPath, namespace, name, key, app.activeCluster ?? undefined),
		announce,
		reload: () => void resources.loadKind('configmaps'),
		errors: CONFIGMAP_ERRORS
	});
	onDestroy(() => {
		reveal.destroy();
		copies.destroy();
	});

	$effect(() => {
		void [app.namespace, app.activeCluster];
		untrack(() => {
			reveal.reset();
			copies.reset();
		});
		void resources.loadKind('configmaps');
	});

	// Every reload of the list: drop what it shows changed or gone.
	$effect(() => {
		const list = resources.configmaps;
		untrack(() => reveal.reconcile(list));
	});

	function stateOf(cm: ConfigMapInfo, key: string): KeyRowState {
		const entry = reveal.entry(cm.namespace, cm.name, key);
		if (!entry) {
			// A failed copy says why in the row, as a failed read does.
			const copy = copies.entry(cm.namespace, cm.name, key);
			return copy?.status === 'error' ? { kind: 'error', message: configMapErrorText(copy.error) } : { kind: 'hidden' };
		}
		if (entry.status === 'reading') return { kind: 'reading' };
		if (entry.status === 'shown') return { kind: 'shown', value: entry.value };
		return { kind: 'error', message: configMapErrorText(entry.error) };
	}

	function copyStateOf(cm: ConfigMapInfo, key: string): KeyCopyState {
		const status = copies.entry(cm.namespace, cm.name, key)?.status;
		return status === 'copying' || status === 'copied' ? status : 'idle';
	}

	// One row error at a time: an action on a key drops the other's.
	function toggle(cm: ConfigMapInfo, key: string) {
		copies.dismiss(cm.namespace, cm.name, key);
		void reveal.toggle(cm.namespace, cm.name, key);
	}

	function copy(cm: ConfigMapInfo, key: string) {
		if (reveal.entry(cm.namespace, cm.name, key)?.status === 'error') {
			reveal.hide(cm.namespace, cm.name, key);
		}
		void copies.copy(cm.namespace, cm.name, key);
	}
</script>

<ResourceList
	list="configmaps"
	title="ConfigMaps"
	nouns={['config map', 'config maps']}
	rows={resources.configmaps}
	tracks={['3fr', '1fr', '0.6fr', '0.55fr']}
	accessors={{ name: (x) => x.name, namespace: (x) => x.namespace, created: (x) => x.creation_timestamp }}
	loaded={resources.kindLoaded('configmaps')}
	error={resources.kindError('configmaps')}
	busy={resources.extraLoading}
	onRetry={() => void resources.loadKind('configmaps')}
>
	{#snippet head()}
		<span class="truncate text-right">Data</span>
		<SortHeader list="configmaps" field="age" label="Age" />
	{/snippet}

	{#snippet cells(cm)}
		<span class="type-data-sm text-right text-text-muted">{cm.keys.length}</span>
		<span class="type-data-sm text-text-muted">{formatAge(cm.creation_timestamp)}</span>
	{/snippet}

	{#snippet below(cm)}
		{#if cm.keys.length > 0}
			<KeyRows
				class="{LIST_PINNED} mb-1"
				label="Keys of {cm.name}"
				keys={cm.keys}
				masked={false}
				stateOf={(key) => stateOf(cm, key)}
				onToggle={(key) => toggle(cm, key)}
				copyStateOf={(key) => copyStateOf(cm, key)}
				onCopy={(info) => copy(cm, info.key)}
			/>
		{/if}
	{/snippet}
</ResourceList>

<p class="sr-only" role="status" aria-live="polite" data-testid="configmap-status">{announcement}</p>
