<script lang="ts">
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import Button from '#lib/components/ui/Button.svelte';
	import ResourceList from '#lib/components/ui/ResourceList.svelte';
	import SortHeader from '#lib/components/ui/SortHeader.svelte';
	import { formatAge } from '#lib/age.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';
	import { LIST_PINNED } from '#lib/ui-classes.ts';

	$effect(() => {
		void [app.namespace, app.activeCluster];
		void resources.loadKind('secrets');
	});

	// Per-visit reveal state; cleared when the view unmounts.
	let revealed = $state<Record<string, boolean>>({});

	function keyOf(ns: string, name: string): string {
		return `${ns}/${name}`;
	}

	function toggle(ns: string, name: string) {
		const key = keyOf(ns, name);
		revealed = { ...revealed, [key]: !revealed[key] };
	}
</script>

<ResourceList
	list="secrets"
	title="Secrets"
	nouns={['secret', 'secrets']}
	rows={resources.secrets}
	tracks={['2.2fr', '1fr', '1.3fr', '0.5fr', '0.55fr', '0.9fr']}
	accessors={{ name: (x) => x.name, namespace: (x) => x.namespace, created: (x) => x.creation_timestamp }}
	loaded={resources.kindLoaded('secrets')}
	error={resources.kindError('secrets')}
	busy={resources.extraLoading}
	onRetry={() => void resources.loadKind('secrets')}
>
	{#snippet tools()}
		<span class="type-body-sm rounded-full bg-warning-container px-3 py-1 text-on-warning-container">
			values decoded locally — never leave this machine
		</span>
	{/snippet}

	{#snippet head()}
		<span class="truncate">Type</span>
		<span class="truncate text-right">Data</span>
		<SortHeader list="secrets" field="age" label="Age" />
		<span class="truncate">Reveal</span>
	{/snippet}

	{#snippet cells(secret)}
		{@const isRevealed = revealed[keyOf(secret.namespace, secret.name)] ?? false}
		<span class="type-data-sm truncate text-text-muted">{secret.secret_type ?? '–'}</span>
		<span class="type-data-sm text-right text-text-muted">{Object.keys(secret.data).length}</span>
		<span class="type-data-sm text-text-muted">{formatAge(secret.creation_timestamp)}</span>
		<span class="flex min-w-0 items-center">
			<Button variant="text" size="inline" onclick={() => toggle(secret.namespace, secret.name)}>
				{#snippet icon()}
					{#if isRevealed}
						<EyeOff class="h-3 w-3" aria-hidden="true" />
					{:else}
						<Eye class="h-3 w-3" aria-hidden="true" />
					{/if}
				{/snippet}
				{isRevealed ? 'Hide' : 'Reveal'}
			</Button>
		</span>
	{/snippet}

	{#snippet below(secret)}
		{@const isRevealed = revealed[keyOf(secret.namespace, secret.name)] ?? false}
		{#if Object.keys(secret.data).length > 0}
			<div class="{LIST_PINNED} mb-1 flex flex-col gap-1 rounded-md bg-surface-sunken px-3 py-2" data-testid="secret-data">
				{#each Object.entries(secret.data) as [key, value] (key)}
					<div class="flex items-baseline gap-3">
						<span class="type-data-sm w-44 shrink-0 truncate text-text-muted">{key}</span>
						<span class="type-data-sm break-all {isRevealed ? 'text-text' : 'text-text-subtle'}">
							{isRevealed ? value : '••••••••'}
						</span>
					</div>
				{/each}
			</div>
		{/if}
	{/snippet}
</ResourceList>
