<script lang="ts">
	import { app, type View } from '#lib/stores/app.svelte.ts';
	import { isExtraKind, resources } from '#lib/stores/resources.svelte.ts';

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
		{
			label: 'Cluster',
			dot: 'var(--color-accent)',
			items: [
				{ view: 'overview', label: 'Overview' },
				{ view: 'nodes', label: 'Nodes' }
			]
		},
		{
			label: 'Workloads',
			dot: 'var(--color-cluster-blue)',
			items: [
				{ view: 'pods', label: 'Pods' },
				{ view: 'deployments', label: 'Deployments' },
				{ view: 'statefulsets', label: 'StatefulSets' },
				{ view: 'jobs', label: 'Jobs' },
				{ view: 'cronjobs', label: 'CronJobs' },
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
				{ view: 'secrets', label: 'Secrets' },
				{ view: 'pvcs', label: 'PVCs' }
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

	interface Count {
		value: number;
		/** Items needing attention: the count turns red and gets a tooltip. */
		alert: string | null;
	}

	/** One right-aligned count per row; null when the kind is not loaded. */
	function countFor(view: View): Count | null {
		switch (view) {
			case 'pods':
				return {
					value: resources.pods.length,
					alert: issueCount > 0 ? `${issueCount} need attention` : null
				};
			case 'deployments':
				return { value: resources.deployments.length, alert: null };
			case 'events':
				return {
					value: resources.events.length,
					alert: warningCount > 0 ? `${warningCount} warnings` : null
				};
			default: {
				if (!isExtraKind(view)) return null;
				const value = resources.kindCount(view);
				return value === null ? null : { value, alert: null };
			}
		}
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
					{#if count}
						<span
							class="type-micro font-mono {count.alert ? 'text-status-err' : 'text-text-tertiary'}"
							title={count.alert ?? undefined}
						>
							{count.value}
						</span>
					{/if}
				</button>
			{/each}
		</div>
	{/each}
</aside>
