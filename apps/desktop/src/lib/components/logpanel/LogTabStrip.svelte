<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import X from '@lucide/svelte/icons/x';
	import { logPanel } from '#lib/stores/logPanel.svelte.ts';
	import { TOOLBAR_ICON } from '#lib/ui-classes.ts';
	import StreamState from './StreamState.svelte';
</script>

<!-- One pill per session; its stream state is a shape and a word (Tonal §9.3). -->
<div class="flex h-11 shrink-0 items-center gap-1 overflow-x-auto px-2 pt-1" data-testid="log-tabs">
	{#each logPanel.sessions as session (session.key)}
		{@const active = session.key === logPanel.activeKey}
		<div
			class="group flex h-(--control-inline-h) shrink-0 items-center gap-1 rounded-full pr-1 pl-3 {active
				? 'bg-surface-container-high text-text'
				: 'text-text-muted hover-layer'}"
		>
			<button
				type="button"
				class="focus-ring flex items-center gap-2 rounded-full"
				aria-current={active ? 'true' : undefined}
				onclick={() => logPanel.focus(session.key)}
			>
				<StreamState status={session.status} />
				<span class="type-data-sm {active ? 'font-semibold' : ''}">{session.pod}</span>
				<span class="type-data-sm text-text-muted">{session.container ?? ''}</span>
			</button>
			<button
				type="button"
				class="focus-ring hover-layer flex h-6 w-6 items-center justify-center rounded-full text-text-muted opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
				aria-label={`Close ${session.pod} logs`}
				onclick={() => void logPanel.closeSession(session.key)}
			>
				<X class="h-3.5 w-3.5" aria-hidden="true" />
			</button>
		</div>
	{/each}
	<span class="flex-1"></span>
	<button
		type="button"
		class={TOOLBAR_ICON}
		aria-label={logPanel.collapsed ? 'Expand log panel' : 'Collapse log panel'}
		onclick={() => logPanel.toggleCollapsed()}
	>
		{#if logPanel.collapsed}<ChevronUp class="h-4 w-4" aria-hidden="true" />{:else}<ChevronDown
				class="h-4 w-4"
				aria-hidden="true"
			/>{/if}
	</button>
	<button
		type="button"
		class={TOOLBAR_ICON}
		aria-label="Close active session"
		onclick={() => logPanel.active && void logPanel.closeSession(logPanel.active.key)}
	>
		<X class="h-4 w-4" aria-hidden="true" />
	</button>
</div>
