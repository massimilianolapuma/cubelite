<script lang="ts">
	import { logs, type LevelFilter } from '$lib/stores/logs.svelte';
	import { resources } from '$lib/stores/resources.svelte';
	import { app } from '$lib/stores/app.svelte';
	import type { LogLevel } from '$lib/tauri';

	let container = $state<HTMLDivElement | null>(null);

	// (Re)start the aggregated stream when cluster/namespace change.
	$effect(() => {
		void [app.activeCluster, app.namespace];
		const pods = resources.pods.map((p) => ({ namespace: p.namespace, name: p.name }));
		void logs.start(pods);
		return () => void logs.stop();
	});

	// Auto-scroll to bottom while following.
	$effect(() => {
		void logs.filtered.length;
		if (logs.following && container) {
			container.scrollTop = container.scrollHeight;
		}
	});

	const chips: { value: LevelFilter; label: string; color: string | null }[] = [
		{ value: 'all', label: 'ALL', color: null },
		{ value: 'info', label: 'INFO', color: 'var(--color-status-info)' },
		{ value: 'warn', label: 'WARN', color: 'var(--color-status-warn)' },
		{ value: 'error', label: 'ERROR', color: 'var(--color-status-err)' }
	];

	const levelColor: Record<LogLevel, string> = {
		debug: 'var(--color-text-tertiary)',
		info: 'var(--color-status-info)',
		warn: 'var(--color-status-warn)',
		error: 'var(--color-status-err)'
	};

	function rowStyle(level: LogLevel): string {
		if (level === 'error')
			return 'border-left: 2px solid var(--color-status-err); background: var(--alpha-log-error-row);';
		if (level === 'warn')
			return 'border-left: 2px solid color-mix(in srgb, var(--color-status-warn) 50%, transparent); background: var(--alpha-log-warn-row);';
		return 'border-left: 2px solid transparent;';
	}

	function clock(iso: string | null): string {
		if (!iso) return '—';
		const d = new Date(iso);
		return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString([], { hour12: false });
	}
</script>

<div class="flex min-h-0 flex-1 flex-col gap-3 p-4">
	<div class="flex items-center gap-2">
		<h1 class="type-title flex-1">Logs</h1>

		<div class="flex overflow-hidden rounded-md border border-border-default">
			{#each chips as chip (chip.value)}
				{@const active = logs.level === chip.value}
				<button
					type="button"
					class="type-section h-7 border-r border-border-default px-2.5 last:border-r-0"
					style={active
						? chip.color
							? `background: ${chip.color}; color: var(--color-surface-window);`
							: 'background: var(--color-text-secondary); color: var(--color-surface-window);'
						: 'color: var(--color-text-tertiary);'}
					onclick={() => (logs.level = chip.value)}
				>
					{chip.label}
				</button>
			{/each}
		</div>

		<input
			type="text"
			placeholder="Filter…"
			bind:value={logs.textFilter}
			class="focus-ring h-7 w-44 rounded-md border border-border-default bg-surface-window px-2.5 text-[11.5px] text-text-primary placeholder:text-text-disabled"
		/>

		<button
			type="button"
			class="type-caption flex h-7 items-center gap-1.5 rounded-md px-2.5 font-medium"
			style={logs.following
				? 'background: var(--color-status-ok); color: var(--color-surface-window);'
				: 'background: var(--alpha-pill-warn); color: var(--color-status-warn);'}
			onclick={() => logs.toggleFollow()}
		>
			{logs.following ? '● Following' : '⏸ Paused'}
		</button>

		<button
			type="button"
			class="focus-ring type-caption flex h-7 items-center rounded-md border border-border-default bg-surface-raised px-2.5 text-text-secondary hover:brightness-110"
			onclick={() => logs.clear()}
		>
			Clear
		</button>
	</div>

	<div class="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border-default bg-surface-sunken">
		{#if !logs.following && logs.bufferedWhilePaused > 0}
			<div class="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
				<span
					class="type-caption animate-pulse rounded-full px-2.5 py-1"
					style="background: var(--alpha-pill-warn); color: var(--color-status-warn);"
				>
					paused — new lines buffered
				</span>
			</div>
		{/if}

		<div bind:this={container} class="h-full overflow-y-auto py-1">
			{#if logs.filtered.length === 0}
				<p class="py-8 text-center text-xs text-text-disabled">
					{logs.lines.length === 0 ? 'Waiting for log lines…' : 'No lines match the filter.'}
				</p>
			{:else}
				{#each logs.filtered as line (line.id)}
					<div class="flex items-baseline gap-2.5 px-2.5 py-px" style={rowStyle(line.level)}>
						<span class="shrink-0 font-mono text-[10.5px] text-text-disabled">{clock(line.time)}</span>
						<span
							class="w-[38px] shrink-0 font-mono text-[10px] font-semibold uppercase"
							style="color: {levelColor[line.level]};"
						>
							{line.level}
						</span>
						<span class="shrink-0 font-mono text-[10.5px] text-text-secondary">{line.pod}</span>
						<span class="type-log break-all text-text-log">{line.message}</span>
					</div>
				{/each}
			{/if}
		</div>
	</div>
</div>
