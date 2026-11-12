<script lang="ts">
	import LogBody from './LogBody.svelte';
	import LogTabStrip from './LogTabStrip.svelte';
	import LogToolbar from './LogToolbar.svelte';
	import { logPanel, PANEL_COLLAPSED, PANEL_MAX, PANEL_MIN } from '#lib/stores/logPanel.svelte.ts';
	import { layout } from '#lib/stores/layout.svelte.ts';

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
	<!-- A card under the list and the detail panel (Tonal §5): tabs and toolbar on
	     surface-container, the lines on surface-sunken (§8.5). It never gets shorter
	     than its tab strip, its toolbar as wrapped and four lines (min-content), so a
	     saved height of 160 cannot squeeze the lines out of the card. While
	     the detail panel lies over the list (overlay mode) the card is lifted above it
	     (z-30) so the toolbar's upward menus stay clickable, below modals (z-40).
	     Docked, nothing covers it. -->
	<section
		class="relative flex min-h-min shrink-0 flex-col rounded-xl bg-surface-container data-[lifted=true]:z-[35]"
		style="height: {logPanel.collapsed ? PANEL_COLLAPSED : logPanel.height}px;"
		aria-label="Pod logs panel"
		data-lifted={layout.docked ? undefined : 'true'}
	>
		<!-- resize handle: the card's top edge -->
		{#if !logPanel.collapsed}
			<div
				role="separator"
				aria-orientation="horizontal"
				aria-label="Resize log panel"
				class="group absolute inset-x-0 top-0 z-10 flex h-2 cursor-row-resize justify-center"
				onpointerdown={startDrag}
			>
				<span
					class="mt-0.5 h-1 w-10 rounded-full {dragging
						? 'bg-outline-strong'
						: 'bg-transparent group-hover:bg-outline-strong'}"
				></span>
			</div>
		{/if}

		<!-- tab strip: one tab per session + collapse/close -->
		<LogTabStrip />

		{#if !logPanel.collapsed && logPanel.active}
			<LogToolbar session={logPanel.active} />
			<LogBody session={logPanel.active} />
		{/if}
	</section>
{/if}
