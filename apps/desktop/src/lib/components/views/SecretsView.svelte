<script lang="ts">
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import { formatAge } from '$lib/age';
	import { app } from '$lib/stores/app.svelte';
	import { resources } from '$lib/stores/resources.svelte';

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

	const grid = 'grid-template-columns: 2.2fr 1.3fr 0.5fr 0.55fr 0.7fr;';
</script>

<div class="flex flex-col gap-3 p-4">
	<div class="flex items-center gap-3">
		<h1 class="type-title flex-1">Secrets</h1>
		<span
			class="rounded-full px-2.5 py-1 text-[10.5px] font-medium"
			style="background: var(--alpha-pill-warn); color: var(--color-status-warn);"
		>
			values decoded locally — never leave this machine
		</span>
	</div>

	{#if resources.extraError}
		<p class="py-8 text-center text-xs text-status-err">{resources.extraError}</p>
	{:else}
		<div class="overflow-hidden rounded-lg border border-border-default">
			<div class="grid gap-x-3 border-b border-border-default bg-surface-surface px-3 py-2" style={grid}>
				<span class="type-colhead">Name</span>
				<span class="type-colhead">Type</span>
				<span class="type-colhead">Data</span>
				<span class="type-colhead">Age</span>
				<span class="type-colhead">Reveal</span>
			</div>
			<div class="bg-surface-panel">
				{#if resources.secrets.length === 0}
					<p class="py-8 text-center text-xs text-text-disabled">No secrets found.</p>
				{:else}
					{#each resources.secrets as secret (secret.namespace + '/' + secret.name)}
						{@const isRevealed = revealed[keyOf(secret.namespace, secret.name)] ?? false}
						<div class="border-b border-border-faint last:border-b-0">
							<div
								class="grid items-center gap-x-3 px-3 hover:bg-surface-row-hover"
								style="{grid} padding-top: var(--row-pad-default); padding-bottom: var(--row-pad-default);"
							>
								<span class="type-data truncate text-text-data-bright">{secret.name}</span>
								<span class="type-data-sm truncate text-text-secondary">{secret.secret_type ?? '—'}</span>
								<span class="type-data-sm text-text-secondary">{Object.keys(secret.data).length}</span>
								<span class="type-data-sm text-text-secondary">{formatAge(secret.creation_timestamp)}</span>
								<button
									type="button"
									class="focus-ring type-caption flex h-6 w-fit items-center gap-1 rounded-md border border-border-default bg-surface-raised px-2 text-text-secondary hover:brightness-110"
									onclick={() => toggle(secret.namespace, secret.name)}
								>
									{#if isRevealed}
										<EyeOff class="h-3 w-3" />
										Hide
									{:else}
										<Eye class="h-3 w-3" />
										Reveal
									{/if}
								</button>
							</div>
							{#if Object.keys(secret.data).length > 0}
								<div class="flex flex-col gap-1 bg-surface-sunken px-3 py-2">
									{#each Object.entries(secret.data) as [key, value] (key)}
										<div class="flex items-baseline gap-3">
											<span class="type-data-sm w-44 shrink-0 truncate text-text-tertiary">{key}</span>
											<span
												class="type-data-sm break-all {isRevealed ? 'text-text-log' : 'text-text-disabled'}"
											>
												{isRevealed ? value : '••••••••'}
											</span>
										</div>
									{/each}
								</div>
							{/if}
						</div>
					{/each}
				{/if}
			</div>
		</div>
	{/if}
</div>
