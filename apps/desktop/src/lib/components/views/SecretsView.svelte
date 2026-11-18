<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import Download from '@lucide/svelte/icons/download';
	import { EMPTY } from '#lib/empty.ts';
	import KeyRows, { type KeyCopyState, type KeyRowState } from '#lib/components/resources/KeyRows.svelte';
	import SecretEnvDialog from '#lib/components/resources/SecretEnvDialog.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import ResourceList from '#lib/components/ui/ResourceList.svelte';
	import SortHeader from '#lib/components/ui/SortHeader.svelte';
	import { formatAge } from '#lib/age.ts';
	import { SecretCopy } from '#lib/secret-copy.svelte.ts';
	import { savedText } from '#lib/secret-env.ts';
	import { SecretReveal, errorText, secretCommandError } from '#lib/secret-reveal.svelte.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';
	import { settings } from '#lib/stores/settings.svelte.ts';
	import { toasts } from '#lib/stores/toasts.svelte.ts';
	import { copySecretValue, exportSecretEnv, revealSecretValue, type SecretInfo } from '#lib/tauri.ts';
	import { LIST_PINNED } from '#lib/ui-classes.ts';

	// Download as .env (#661 §3.3): the Secret whose confirmation is open, and
	// whether the backend is asking for a path or writing.
	let exporting = $state<SecretInfo | null>(null);
	let saving = $state(false);

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
	// A copy goes through the backend, which writes the clipboard and clears it
	// after the same time if it still holds the value (#661 §6.2): no value here.
	const copies = new SecretCopy({
		copy: (namespace, name, key, seconds) =>
			copySecretValue(app.kubeconfigPath, namespace, name, key, seconds, app.activeCluster ?? undefined),
		clearAfter: () => settings.secretHideAfter.value,
		announce,
		reload: () => void resources.loadKind('secrets')
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
			exporting = null;
		});
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
		if (!entry) {
			// A failed copy says why in the row, as a failed reveal does.
			const copy = copies.entry(secret.namespace, secret.name, key);
			return copy?.status === 'error' ? { kind: 'error', message: errorText(copy.error) } : { kind: 'hidden' };
		}
		if (entry.status === 'reading') return { kind: 'reading' };
		if (entry.status === 'shown') return { kind: 'shown', value: entry.value };
		return { kind: 'error', message: errorText(entry.error) };
	}

	function copyStateOf(secret: SecretInfo, key: string): KeyCopyState {
		const status = copies.entry(secret.namespace, secret.name, key)?.status;
		return status === 'copying' || status === 'copied' ? status : 'idle';
	}

	// One row error at a time: an action on a key drops the other's.
	function toggle(secret: SecretInfo, key: string) {
		copies.dismiss(secret.namespace, secret.name, key);
		void reveal.toggle(secret.namespace, secret.name, key);
	}

	function copy(secret: SecretInfo, key: string) {
		if (reveal.entry(secret.namespace, secret.name, key)?.status === 'error') {
			reveal.hide(secret.namespace, secret.name, key);
		}
		void copies.copy(secret.namespace, secret.name, key);
	}

	/** A Secret that can be offered as .env: not a Helm release, and with keys. */
	const exportable = (secret: SecretInfo) => !secret.helm_release && secret.keys.length > 0;
	const exportId = (secret: SecretInfo) => `${secret.namespace}/${secret.name}`;

	/** Close the confirmation; the focus goes back to the Secret's .env button. */
	async function closeExport() {
		const was = exporting;
		exporting = null;
		if (!was) return;
		await tick();
		document.querySelector<HTMLElement>(`[data-env-export="${CSS.escape(exportId(was))}"]`)?.focus();
	}

	async function saveEnv(secret: SecretInfo) {
		if (saving) return;
		saving = true;
		try {
			const answer = await exportSecretEnv(
				app.kubeconfigPath,
				secret.namespace,
				secret.name,
				app.activeCluster ?? undefined
			);
			// Cancelling the system's dialog writes nothing and says nothing.
			if (answer.saved && answer.path !== null) {
				toasts.push(savedText(secret.name, answer.written.length, answer.path), 'ok');
			}
		} catch (e) {
			toasts.push(`Could not save ${secret.name} as .env: ${errorText(secretCommandError(e))}`, 'err');
		} finally {
			saving = false;
			if (exporting === secret) await closeExport();
		}
	}
</script>

<ResourceList
	list="secrets"
	title="Secrets"
	nouns={['secret', 'secrets']}
	rows={resources.secrets}
	tracks={['2.2fr', '1fr', '1.3fr', '0.5fr', '0.55fr', '0.65fr']}
	accessors={{ name: (x) => x.name, namespace: (x) => x.namespace, created: (x) => x.creation_timestamp }}
	loaded={resources.kindLoaded('secrets')}
	error={resources.kindError('secrets')}
	busy={resources.extraLoading}
	onRetry={() => void resources.loadKind('secrets')}
>
	{#snippet tools()}
		<span class="type-body-sm rounded-full bg-warning-container px-3 py-1 text-on-warning-container">
			a value is read only when you reveal or copy it
		</span>
	{/snippet}

	{#snippet head()}
		<span class="truncate">Type</span>
		<span class="truncate text-right">Data</span>
		<SortHeader list="secrets" field="age" label="Age" />
		<span class="truncate">Export</span>
	{/snippet}

	{#snippet cells(secret)}
		<span class="type-data-sm truncate text-text-muted">{secret.secret_type ?? EMPTY}</span>
		<span class="type-data-sm text-right text-text-muted">{secret.keys.length}</span>
		<span class="type-data-sm text-text-muted">{formatAge(secret.creation_timestamp)}</span>
		<span class="flex min-w-0 items-center">
			{#if exportable(secret)}
				<!-- Before its key rows in the keyboard order: the row comes first. -->
				<Button
					variant="text"
					size="inline"
					class="border border-outline-strong"
					aria-label="Download {secret.name} as .env"
					data-env-export={exportId(secret)}
					onclick={() => (exporting = secret)}
				>
					{#snippet icon()}
						<Download class="h-3 w-3" aria-hidden="true" />
					{/snippet}
					.env
				</Button>
			{/if}
		</span>
	{/snippet}

	{#snippet below(secret)}
		{#if secret.keys.length > 0}
			<KeyRows
				class="{LIST_PINNED} mb-1"
				label="Keys of {secret.name}"
				keys={secret.keys}
				note={secret.helm_release ? 'Helm release payload, shown in Helm' : null}
				stateOf={(key) => stateOf(secret, key)}
				onToggle={(key) => toggle(secret, key)}
				copyStateOf={(key) => copyStateOf(secret, key)}
				onCopy={(info) => copy(secret, info.key)}
			/>
		{/if}
	{/snippet}
</ResourceList>

<svelte:window onfocus={recheck} />
<svelte:document onvisibilitychange={recheck} />

<p class="sr-only" role="status" aria-live="polite" data-testid="secret-status">{announcement}</p>

{#if exporting}
	{@const secret = exporting}
	<SecretEnvDialog
		name={secret.name}
		keys={secret.keys}
		{saving}
		onCancel={() => void closeExport()}
		onSave={() => void saveEnv(secret)}
	/>
{/if}
