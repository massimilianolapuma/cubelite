<script lang="ts">
	import LayoutGrid from '@lucide/svelte/icons/layout-grid';
	import Lock from '@lucide/svelte/icons/lock';
	import Settings from '@lucide/svelte/icons/settings';
	import Timer from '@lucide/svelte/icons/timer';
	import IdentityAvatar from '#lib/components/ui/IdentityAvatar.svelte';
	import { app } from '#lib/stores/app.svelte.ts';
	import { clusters } from '#lib/stores/clusters.svelte.ts';
	import { clusterSettings } from '#lib/stores/cluster-settings.svelte.ts';
	import { clock } from '#lib/stores/clock.svelte.ts';
	import { remainingText } from '#lib/access.ts';
	import { environmentLabel } from '#lib/environment.ts';
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

	/** "Read-only", "Writable for 12 min", or null for a writable cluster (#662). */
	function accessWords(name: string): string | null {
		const until = clusterSettings.writableUntil(name);
		if (until !== null) return `Writable for ${remainingText(until - clock.now)}`;
		return clusterSettings.accessOf(name) === 'read_only' ? 'Read-only' : null;
	}

	/** "<name> · <Environment> · <access>" with what is set (#662), then the defining file. */
	function tooltip(name: string, source: string | null | undefined): string {
		const environment = clusterSettings.environmentOf(name);
		const access = accessWords(name);
		const label = [name, environment ? environmentLabel(environment) : null, access]
			.filter((part) => part !== null)
			.join(' · ');
		return multiFile && source ? `${label} (${source})` : label;
	}

	/** The button's name: the context, its health and, when not plain writable, its access. */
	function buttonName(name: string, health: keyof typeof healthWord): string {
		const access = accessWords(name);
		return [name, healthWord[health], access?.toLowerCase()].filter(Boolean).join(', ');
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
			{@const access = clusterSettings.accessOf(ctx.name)}
			<li class="shrink-0">
				<!-- The name is the context, its health and its access: initials alone are
				     ambiguous and the glyphs are decorative. -->
				<button
					type="button"
					aria-label={buttonName(ctx.name, state)}
					title={tooltip(ctx.name, ctx.source)}
					aria-current={isActive ? 'true' : undefined}
					class="focus-ring relative block rounded-md hover:brightness-110"
					onclick={() => clickCluster(ctx.name)}
				>
					<IdentityAvatar
						name={ctx.name}
						color={clusters.identityFor(ctx.name)}
						active={isActive}
						health={state}
					/>
					<!-- Access (#662): top right, the health badge holds the bottom right. A
					     lock when read-only, a timer while writable for a while, nothing
					     when writable. -->
					{#if access !== 'writable'}
						<span
							data-testid="access-badge"
							data-access={access}
							data-badge
							class="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-surface-container-top {access ===
							'timed'
								? 'text-warning'
								: 'text-text-muted'}"
						>
							{#if access === 'timed'}
								<Timer class="h-2.5 w-2.5" strokeWidth={2.5} aria-hidden="true" />
							{:else}
								<Lock class="h-2.5 w-2.5" strokeWidth={2.5} aria-hidden="true" />
							{/if}
						</span>
					{/if}
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
