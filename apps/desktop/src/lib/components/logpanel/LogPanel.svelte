<script lang="ts">
	import LogBody from './LogBody.svelte';
	import LogTabStrip from './LogTabStrip.svelte';
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

		<!-- tab strip: one tab per session + collapse/close -->
		<LogTabStrip />

		{#if !logPanel.collapsed && logPanel.active}
			<LogToolbar session={logPanel.active} />
			<LogBody session={logPanel.active} />
		{/if}
	</section>
{/if}
