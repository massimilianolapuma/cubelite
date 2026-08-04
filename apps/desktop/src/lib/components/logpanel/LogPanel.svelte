<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import X from '@lucide/svelte/icons/x';
	import LogBody from './LogBody.svelte';
	import LogToolbar from './LogToolbar.svelte';
	import { logPanel, PANEL_COLLAPSED, PANEL_MAX, PANEL_MIN } from '$lib/stores/logPanel.svelte';

	let dragging = $state(false);

	function startDrag(event: PointerEvent) {
		dragging = true;
		const startY = event.clientY;
		const startHeight = logPanel.height;
		const onMove = (e: PointerEvent) => {
			logPanel.height = Math.min(PANEL_MAX, Math.max(PANEL_MIN, startHeight + (startY - e.clientY)));
		};
		const onUp = () => {
			dragging = false;
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}
</script>

{#if logPanel.open}
	<section
		class="flex shrink-0 flex-col border-t border-border-default bg-surface-window"
		style="height: {logPanel.collapsed ? PANEL_COLLAPSED : logPanel.height}px;"
		aria-label="Pod logs panel"
	>
		<!-- resize handle -->
		{#if !logPanel.collapsed}
			<div
				role="separator"
				aria-orientation="horizontal"
				class="h-1 shrink-0 cursor-row-resize {dragging ? 'bg-border-default' : 'hover:bg-border-default'}"
				onpointerdown={startDrag}
			></div>
		{/if}

		<!-- header strip: session title + collapse/close -->
		<div class="flex h-[33px] shrink-0 items-center gap-2 border-b border-border-default px-2.5">
			{#if logPanel.active}
				<span
					class="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
					style="background: {logPanel.active.status === 'streaming'
						? 'var(--color-status-ok)'
						: logPanel.active.status === 'error'
							? 'var(--color-status-err)'
							: 'var(--color-status-warn)'};"
				></span>
				<span class="type-caption font-mono text-text-primary">{logPanel.active.pod}</span>
				<span class="type-caption font-mono text-text-tertiary">{logPanel.active.container ?? ''}</span>
			{/if}
			<span class="flex-1"></span>
			<button
				type="button"
				class="focus-ring flex h-6 w-6 items-center justify-center rounded text-text-tertiary hover:text-text-secondary"
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
				class="focus-ring flex h-6 w-6 items-center justify-center rounded text-text-tertiary hover:text-text-secondary"
				aria-label="Close log panel"
				onclick={() => logPanel.active && void logPanel.closeSession(logPanel.active.key)}
			>
				<X size={14} strokeWidth={1.5} />
			</button>
		</div>

		{#if !logPanel.collapsed && logPanel.active}
			<LogToolbar session={logPanel.active} />
			<LogBody session={logPanel.active} />
		{/if}
	</section>
{/if}
