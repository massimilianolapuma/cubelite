<script lang="ts">
	import { app, type View } from '$lib/stores/app.svelte';
	import { resources } from '$lib/stores/resources.svelte';

	interface NavItem {
		view: View;
		label: string;
	}
	interface Section {
		label: string;
		dot: string;
		items: NavItem[];
	}

	// Group dot colors per spec: workloads blue, network violet, config amber, observe teal.
	const sections: Section[] = [
		{ label: 'Cluster', dot: 'var(--color-accent)', items: [{ view: 'overview', label: 'Overview' }] },
		{
			label: 'Workloads',
			dot: 'var(--color-cluster-blue)',
			items: [
				{ view: 'pods', label: 'Pods' },
				{ view: 'deployments', label: 'Deployments' },
				{ view: 'helm', label: 'Helm Releases' }
			]
		},
		{
			label: 'Network',
			dot: 'var(--color-cluster-violet)',
			items: [
				{ view: 'services', label: 'Services' },
				{ view: 'ingresses', label: 'Ingresses' }
			]
		},
		{
			label: 'Config',
			dot: 'var(--color-status-warn)',
			items: [
				{ view: 'configmaps', label: 'ConfigMaps' },
				{ view: 'secrets', label: 'Secrets' }
			]
		},
		{
			label: 'Observe',
			dot: 'var(--color-cluster-teal)',
			items: [
				{ view: 'events', label: 'Events' },
				{ view: 'logs', label: 'Logs' }
			]
		}
	];

	const issueCount = $derived(resources.issuePods.length);
	const warningCount = $derived(resources.warningEvents.length);

	function countFor(view: View): number | null {
		if (view === 'pods') return resources.pods.length;
		if (view === 'deployments') return resources.deployments.length;
		return null;
	}
</script>

<aside class="flex w-[198px] shrink-0 flex-col gap-4 overflow-y-auto bg-surface-panel px-2 py-3">
	{#each sections as section (section.label)}
		<div>
			<div class="type-section mb-1 px-2.5 text-text-tertiary">{section.label}</div>
			{#each section.items as item (item.view)}
				{@const active = app.view === item.view}
				{@const count = countFor(item.view)}
				<button
					type="button"
					class="focus-ring flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-surface-row-hover"
					style={active ? 'background: var(--alpha-active-nav-bg);' : ''}
					onclick={() => app.navigate(item.view)}
				>
					<span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background: {section.dot};"></span>
					<span class="type-body flex-1 {active ? 'text-text-primary' : 'text-text-secondary'}">
						{item.label}
					</span>
					{#if item.view === 'pods' && issueCount > 0}
						<span class="font-mono text-[10.5px] text-status-err">{issueCount}</span>
					{/if}
					{#if item.view === 'events' && warningCount > 0}
						<span class="font-mono text-[10.5px] text-status-err">{warningCount}</span>
					{/if}
					{#if count !== null}
						<span class="font-mono text-[10.5px] text-text-tertiary">{count}</span>
					{/if}
				</button>
			{/each}
		</div>
	{/each}
</aside>
