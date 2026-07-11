<script lang="ts">
	export type PillTone = 'ok' | 'warn' | 'err' | 'neutral';

	let { label, tone = 'neutral' }: { label: string; tone?: PillTone } = $props();

	const toneStyle: Record<PillTone, string> = {
		ok: 'background: var(--alpha-pill-ok); color: var(--color-status-ok);',
		warn: 'background: var(--alpha-pill-warn); color: var(--color-status-warn);',
		err: 'background: var(--alpha-pill-err); color: var(--color-status-err);',
		neutral: 'background: var(--color-surface-raised); color: var(--color-text-secondary);'
	};
</script>

<span
	class="inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium"
	style={toneStyle[tone]}
>
	{label}
</span>
