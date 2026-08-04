<script lang="ts">
	import type { KeyedLogLine } from '$lib/stores/logs.svelte';
	import type { LogLevel } from '$lib/tauri';

	let { line, timestamps, wrap }: { line: KeyedLogLine; timestamps: boolean; wrap: boolean } =
		$props();

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

<div class="flex items-baseline gap-2.5 px-2.5 py-px" style={rowStyle(line.level)}>
	{#if timestamps}
		<span class="w-[94px] shrink-0 font-mono text-[10.5px] text-text-disabled">{clock(line.time)}</span>
	{/if}
	<span
		class="w-[38px] shrink-0 font-mono text-[10px] font-semibold uppercase"
		style="color: {levelColor[line.level]};"
	>
		{line.level}
	</span>
	<span class="type-log text-text-log {wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre'}">{line.message}</span>
</div>
