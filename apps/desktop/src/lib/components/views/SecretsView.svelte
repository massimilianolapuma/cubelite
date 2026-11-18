<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { EMPTY } from '#lib/empty.ts';
	import KeyRows, { type KeyRowState } from '#lib/components/resources/KeyRows.svelte';
	import ResourceList from '#lib/components/ui/ResourceList.svelte';
	import SortHeader from '#lib/components/ui/SortHeader.svelte';
	import { formatAge } from '#lib/age.ts';
	import { SecretReveal, errorText } from '#lib/secret-reveal.svelte.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';
	import { settings } from '#lib/stores/settings.svelte.ts';
	import { revealSecretValue, type SecretInfo } from '#lib/tauri.ts';
	import { LIST_PINNED } from '#lib/ui-classes.ts';

	// The polite status region's message: a key's name and what happened, never a value.
	let announcement = $state('');

	// Emptied first, then set on the next microtask: the same words for another
	// Secret's key of the same name are a change, and are announced again.
	function announce(message: string) {
		announcement = '';
		queueMicrotask(() => (announcement = message));
	}

	// Shown values live for this view only (#661 §3.2): each is read when its key
	// is revealed, and dropped on its timer, on Hide, on leaving the view, on a
	// namespace or cluster change, and when a reload shows its Secret changed.
	const reveal = new SecretReveal({
		read: (namespace, name, key) =>
			revealSecretValue(app.kubeconfigPath, namespace, name, key, app.activeCluster ?? undefined),
		hideAfter: () => settings.secretHideAfter.value,
		announce,
		reload: () => void resources.loadKind('secrets')
	});
	onDestroy(() => reveal.destroy());

	$effect(() => {
		void [app.namespace, app.activeCluster];
		untrack(() => reveal.reset());
		void resources.loadKind('secrets');
	});

	// A new time in Preferences applies to the values already shown.
	$effect(() => {
		void settings.secretHideAfter.value;
		untrack(() => reveal.recheck());
	});

	// A sleep stops timers, not the clock: check again when the window is back.
	function recheck() {
		if (document.visibilityState !== 'hidden') reveal.recheck();
	}

	// Every reload of the list: drop what it shows changed or gone.
	$effect(() => {
		const list = resources.secrets;
		untrack(() => reveal.reconcile(list));
	});

	function stateOf(secret: SecretInfo, key: string): KeyRowState {
		const entry = reveal.entry(secret.namespace, secret.name, key);
		if (!entry) return { kind: 'hidden' };
		if (entry.status === 'reading') return { kind: 'reading' };
		if (entry.status === 'shown') return { kind: 'shown', value: entry.value };
		return { kind: 'error', message: errorText(entry.error) };
	}
</script>

<ResourceList
	list="secrets"
	title="Secrets"
	nouns={['secret', 'secrets']}
	rows={resources.secrets}
	tracks={['2.2fr', '1fr', '1.3fr', '0.5fr', '0.55fr']}
	accessors={{ name: (x) => x.name, namespace: (x) => x.namespace, created: (x) => x.creation_timestamp }}
	loaded={resources.kindLoaded('secrets')}
	error={resources.kindError('secrets')}
	busy={resources.extraLoading}
	onRetry={() => void resources.loadKind('secrets')}
>
	{#snippet tools()}
		<span class="type-body-sm rounded-full bg-warning-container px-3 py-1 text-on-warning-container">
			a value is read only when you reveal it
		</span>
	{/snippet}

	{#snippet head()}
		<span class="truncate">Type</span>
		<span class="truncate text-right">Data</span>
		<SortHeader list="secrets" field="age" label="Age" />
	{/snippet}

	{#snippet cells(secret)}
		<span class="type-data-sm truncate text-text-muted">{secret.secret_type ?? EMPTY}</span>
		<span class="type-data-sm text-right text-text-muted">{secret.keys.length}</span>
		<span class="type-data-sm text-text-muted">{formatAge(secret.creation_timestamp)}</span>
	{/snippet}

	{#snippet below(secret)}
		{#if secret.keys.length > 0}
			<KeyRows
				class="{LIST_PINNED} mb-1"
				label="Keys of {secret.name}"
				keys={secret.keys}
				note={secret.helm_release ? 'Helm release payload, shown in Helm' : null}
				stateOf={(key) => stateOf(secret, key)}
				onToggle={(key) => void reveal.toggle(secret.namespace, secret.name, key)}
			/>
		{/if}
	{/snippet}
</ResourceList>

<svelte:window onfocus={recheck} />
<svelte:document onvisibilitychange={recheck} />

<p class="sr-only" role="status" aria-live="polite" data-testid="secret-status">{announcement}</p>
