<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import X from '@lucide/svelte/icons/x';
	import { logPanel } from '$lib/stores/logPanel.svelte';
	import type { SessionStatus } from '$lib/stores/logSession.svelte';

	function dot(status: SessionStatus): string {
		if (status === 'streaming') return 'var(--color-status-ok)';
		if (status === 'error') return 'var(--color-status-err)';
		return 'var(--color-status-warn)';
	}
</script>

<div
	class="flex h-[33px] shrink-0 items-center gap-1 overflow-x-auto border-b border-border-default px-1.5"
>
	{#each logPanel.sessions as session (session.key)}
		{@const active = session.key === logPanel.activeKey}
		<div
			class="group flex h-[26px] shrink-0 items-center gap-1.5 rounded-md px-2 {active
				? 'bg-surface-sunken'
				: 'hover:bg-surface-sunken/50'}"
		>
			<button
				type="button"
				class="flex items-center gap-1.5"
				onclick={() => logPanel.focus(session.key)}
			>
				<span
					class="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
					style="background: {dot(session.status)};"
				></span>
				<span class="type-caption font-mono {active ? 'text-text-primary' : 'text-text-secondary'}"
					>{session.pod}</span
				>
				<span class="type-caption font-mono text-text-tertiary">{session.container ?? ''}</span>
			</button>
			<button
				type="button"
				class="focus-ring rounded p-0.5 text-text-tertiary opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-text-secondary focus-visible:opacity-100"
				aria-label={`Close ${session.pod} logs`}
				onclick={() => void logPanel.closeSession(session.key)}
			>
				<X size={11} strokeWidth={1.5} />
			</button>
		</div>
	{/each}
	<span class="flex-1"></span>
	<button
		type="button"
		class="focus-ring flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-tertiary hover:text-text-secondary"
		aria-label={logPanel.collapsed ? 'Expand log panel' : 'Collapse log panel'}
		onclick={() => logPanel.toggleCollapsed()}
	>
		{#if logPanel.collapsed}<ChevronUp size={14} strokeWidth={1.5} />{:else}<ChevronDown
				size={14}
				strokeWidth={1.5}
			/>{/if}
	</button>
	<button
		type="button"
		class="focus-ring flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-tertiary hover:text-text-secondary"
		aria-label="Close active session"
		onclick={() => logPanel.active && void logPanel.closeSession(logPanel.active.key)}
	>
		<X size={14} strokeWidth={1.5} />
	</button>
</div>
