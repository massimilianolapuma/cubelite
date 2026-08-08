<script lang="ts">
	import type { KeyedLogLine } from '$lib/stores/logs.svelte';
	import type { LogLevel } from '$lib/tauri';

	let {
		line,
		timestamps,
		wrap,
		search = null,
		source = null
	}: {
		line: KeyedLogLine;
		timestamps: boolean;
		wrap: boolean;
		search?: { query: string; active: boolean } | null;
		source?: { name: string; color: string } | null;
	} = $props();

	const segments = $derived.by(() => {
		if (!search || !search.query) return [{ text: line.message, hit: false }];
		const q = search.query.toLowerCase();
		const src = line.message;
		const out: { text: string; hit: boolean }[] = [];
		let i = 0;
		for (;;) {
			const at = src.toLowerCase().indexOf(q, i);
			if (at === -1) {
				out.push({ text: src.slice(i), hit: false });
				return out;
			}
			if (at > i) out.push({ text: src.slice(i, at), hit: false });
			out.push({ text: src.slice(at, at + q.length), hit: true });
			i = at + q.length;
		}
	});

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
	{#if source}
		<span
			class="w-[52px] shrink-0 truncate font-mono text-[9.5px] font-semibold"
			style="color: {source.color};">{source.name}</span
		>
	{/if}
	<span
		class="w-[38px] shrink-0 font-mono text-[10px] font-semibold uppercase"
		style="color: {levelColor[line.level]};"
	>
		{line.level}
	</span>
	<span class="type-log text-text-log {wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre'}">
		{#each segments as seg, i (i)}
			{#if seg.hit}<mark
					style={search?.active
						? 'background: var(--color-status-warn); color: var(--color-surface-window);'
						: 'background: var(--alpha-pill-warn); color: inherit;'}>{seg.text}</mark>
			{:else}{seg.text}{/if}
		{/each}
	</span>
</div>
