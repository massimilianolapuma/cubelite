<script lang="ts">
	import LayoutGrid from '@lucide/svelte/icons/layout-grid';
	import Settings from '@lucide/svelte/icons/settings';
	import IdentityAvatar from '#lib/components/ui/IdentityAvatar.svelte';
	import { app } from '#lib/stores/app.svelte.ts';
	import { clusters } from '#lib/stores/clusters.svelte.ts';
	import { health } from '#lib/stores/health.svelte.ts';

	// With several kubeconfig files, the tooltip also names the defining file.
	const multiFile = $derived(app.kubeconfigSources.length > 1);

	function clickCluster(name: string) {
		if (name === app.activeCluster) {
			if (app.view === 'dashboard') app.navigate('overview');
			return;
		}
		void clusters.switchCluster(name);
	}

	const healthWord = { connected: 'connected', unreachable: 'unreachable', unknown: 'not connected' } as const;

	const disc =
		'focus-ring forced-edge flex h-(--control-h) w-(--control-h) shrink-0 items-center justify-center rounded-full';
</script>

<!-- All Clusters and Preferences stay put; with many contexts only the avatars scroll. -->
<nav class="flex min-h-0 w-[68px] flex-1 flex-col items-center gap-2 pt-1 pb-3" aria-label="Clusters">
	<button
		type="button"
		title="All Clusters"
		aria-label="All Clusters"
		aria-current={app.view === 'dashboard' ? 'page' : undefined}
		class="{disc} {app.view === 'dashboard'
			? 'bg-primary-container text-on-primary-container'
			: 'text-text-muted hover:bg-surface-container'}"
		onclick={() => app.navigate('dashboard')}
	>
		<LayoutGrid class="h-4 w-4" />
	</button>

	<ul
		aria-label="Contexts"
		class="flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
	>
		{#each clusters.contexts as ctx (ctx.name)}
			{@const isActive = ctx.name === app.activeCluster}
			{@const state = isActive ? clusters.connectionState : health.for(ctx.name).state}
			<li class="shrink-0">
				<!-- The name is the context and its health: initials alone are ambiguous
				     and the health glyph is decorative. -->
				<button
					type="button"
					aria-label="{ctx.name}, {healthWord[state]}"
					title={multiFile && ctx.source ? `${ctx.name} (${ctx.source})` : ctx.name}
					aria-current={isActive ? 'true' : undefined}
					class="focus-ring block rounded-md hover:brightness-110"
					onclick={() => clickCluster(ctx.name)}
				>
					<IdentityAvatar
						name={ctx.name}
						color={clusters.identityFor(ctx.name)}
						active={isActive}
						health={state}
					/>
				</button>
			</li>
		{/each}
	</ul>

	<button
		type="button"
		title="Preferences"
		aria-label="Preferences"
		class="{disc} text-text-subtle hover:bg-surface-container hover:text-text-muted"
		onclick={() => (app.preferencesOpen = true)}
	>
		<Settings class="h-4 w-4" />
	</button>
</nav>
