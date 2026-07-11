<script lang="ts">
	import House from '@lucide/svelte/icons/house';
	import Settings from '@lucide/svelte/icons/settings';
	import IdentityAvatar from '$lib/components/ui/IdentityAvatar.svelte';
	import { app } from '$lib/stores/app.svelte';
	import { clusters } from '$lib/stores/clusters.svelte';

	function clickCluster(name: string) {
		if (name === app.activeCluster) {
			if (app.view === 'dashboard') app.navigate('overview');
			return;
		}
		void clusters.switchCluster(name);
	}
</script>

<nav
	class="flex w-[58px] shrink-0 flex-col items-center gap-2 border-r border-border-faint bg-surface-window py-2.5"
	aria-label="Clusters"
>
	<button
		type="button"
		title="All Clusters"
		aria-label="All Clusters"
		class="focus-ring flex h-[38px] w-[38px] items-center justify-center rounded-xl text-text-secondary hover:brightness-125"
		style={app.view === 'dashboard'
			? 'background: var(--alpha-active-nav-bg); color: var(--color-text-primary);'
			: 'background: var(--color-surface-raised);'}
		onclick={() => app.navigate('dashboard')}
	>
		<House class="h-4 w-4" />
	</button>

	<div class="my-0.5 h-px w-7 bg-border-faint"></div>

	{#each clusters.contexts as ctx (ctx.name)}
		{@const isActive = ctx.name === app.activeCluster}
		<button
			type="button"
			title={ctx.name}
			class="focus-ring rounded-xl hover:brightness-125"
			onclick={() => clickCluster(ctx.name)}
		>
			<IdentityAvatar
				name={ctx.name}
				color={clusters.identityFor(ctx.name)}
				active={isActive}
				health={isActive ? clusters.connectionState : 'unknown'}
			/>
		</button>
	{/each}

	<div class="mt-auto"></div>

	<button
		type="button"
		title="Preferences"
		aria-label="Preferences"
		class="focus-ring flex h-[38px] w-[38px] items-center justify-center rounded-xl text-text-tertiary hover:text-text-secondary hover:brightness-125"
		onclick={() => (app.preferencesOpen = true)}
	>
		<Settings class="h-4 w-4" />
	</button>
</nav>
