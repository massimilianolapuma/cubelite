<script lang="ts">
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';
	import { BUTTON_CLASS, CHECKBOX_CLASS, type FormResult } from '#lib/integration-form.svelte.ts';

	// Skip-TLS opt-in, Test connection, Save, the saved endpoint and the
	// last result (shared by the integration preferences).
	let {
		active,
		tls = true,
		busy,
		incomplete,
		skipTlsVerify = $bindable(),
		current,
		result,
		onTest,
		onSave
	}: {
		/** The integration is on (Test and skip-TLS only apply then). */
		active: boolean;
		/** Shows the skip-TLS opt-in (not for a context using the default, #528). */
		tls?: boolean;
		busy: string | null;
		incomplete: boolean;
		skipTlsVerify: boolean;
		current: string | null;
		result: FormResult | null;
		onTest: () => void;
		onSave: () => void;
	} = $props();
</script>

{#if active && tls}
	<label class="type-body-sm flex items-center gap-2 text-text-muted">
		<input type="checkbox" class={CHECKBOX_CLASS} bind:checked={skipTlsVerify} /> Skip TLS verification (self-signed, no CA)
	</label>
{/if}
<div class="flex min-w-0 items-center gap-2">
	{#if active}
		<button type="button" class={BUTTON_CLASS} disabled={busy !== null || incomplete} onclick={onTest}>
			{busy === 'test' ? 'Testing…' : 'Test connection'}
		</button>
	{/if}
	<button type="button" class={BUTTON_CLASS} disabled={busy !== null || incomplete} onclick={onSave}>
		{busy === 'save' ? 'Saving…' : 'Save'}
	</button>
	{#if current}
		<span class="type-body-sm min-w-0 truncate text-text-muted" title={current}>current: {current}</span>
	{/if}
</div>
{#if result}
	<!-- Passed or failed is a shape as well as a colour (Tonal §9.3): circle or square. -->
	<p
		class="type-body-sm flex items-baseline gap-2 [overflow-wrap:anywhere] {result.ok ? 'text-text' : 'text-error'}"
		role={result.ok ? 'status' : 'alert'}
		data-state={result.ok ? 'ok' : 'err'}
	>
		<StatusGlyph state={result.ok ? 'ok' : 'err'} class="relative top-px {result.ok ? 'text-success' : ''}" />
		<span>{result.text}</span>
	</p>
{/if}
