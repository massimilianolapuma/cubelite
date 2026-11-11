<script lang="ts" module>
	import type { StatusTone } from '#lib/status.ts';

	/** One metric row; a null value renders an en dash (kind not loaded yet). */
	export type SummaryRow = { label: string; value: number | null; tone?: StatusTone | 'accent' };
</script>

<script lang="ts">
	import type LucideIcon from '@lucide/svelte/icons/box';
	import StatusGlyph from './StatusGlyph.svelte';

	// One kind on the Overview (Tonal §8.4): neutral, no colour per resource.
	// A count that needs attention (pending, failed, degraded) is bold with its
	// shape when it is above zero; "0 failed" stays plain.
	let {
		title,
		icon: Icon,
		rows,
		forbidden = false
	}: {
		title: string;
		icon: typeof LucideIcon;
		rows: SummaryRow[];
		/** RBAC denied this kind: say so instead of showing zeros. */
		forbidden?: boolean;
	} = $props();

	const attention = (row: SummaryRow): 'warn' | 'err' | null =>
		row.value && (row.tone === 'warn' || row.tone === 'err') ? row.tone : null;
</script>

<section class="flex flex-col rounded-lg bg-surface-container-high p-4" aria-label={title}>
	<div class="flex items-center gap-2 pb-3">
		<Icon class="h-4 w-4 shrink-0 text-text-muted" strokeWidth={2} aria-hidden="true" />
		<h2 class="type-title">{title}</h2>
	</div>
	{#if forbidden}
		<div class="flex items-center gap-2 text-text-muted" data-testid="forbidden-badge">
			<StatusGlyph state="unknown" />
			<span class="type-body-sm">forbidden: RBAC does not let you list these</span>
		</div>
	{:else}
		<dl class="flex flex-col gap-1.5">
			{#each rows as row (row.label)}
				{@const flag = attention(row)}
				<div class="flex items-center justify-between gap-3">
					<dt class="type-body text-text-muted">{row.label}</dt>
					<dd
						class="type-data flex items-center gap-1.5 {flag
							? 'font-semibold text-text'
							: row.value === null
								? 'text-text-subtle'
								: 'text-text'}"
						data-attention={flag ?? 'none'}
					>
						{#if flag}
							<StatusGlyph state={flag} class={flag === 'err' ? 'text-error' : 'text-warning'} />
						{/if}
						{row.value ?? '–'}
					</dd>
				</div>
			{/each}
		</dl>
	{/if}
</section>
