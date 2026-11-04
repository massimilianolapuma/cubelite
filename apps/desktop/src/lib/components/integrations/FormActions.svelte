<script lang="ts">
	import { BUTTON_CLASS, type FormResult } from '#lib/integration-form.svelte.ts';

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
	<label class="type-caption flex items-center gap-2 text-text-secondary">
		<input type="checkbox" bind:checked={skipTlsVerify} /> Skip TLS verification (self-signed, no CA)
	</label>
{/if}
<div class="flex items-center gap-2">
	{#if active}
		<button type="button" class={BUTTON_CLASS} disabled={busy !== null || incomplete} onclick={onTest}>
			{busy === 'test' ? 'Testing…' : 'Test connection'}
		</button>
	{/if}
	<button type="button" class={BUTTON_CLASS} disabled={busy !== null || incomplete} onclick={onSave}>
		{busy === 'save' ? 'Saving…' : 'Save'}
	</button>
	{#if current}
		<span class="type-caption truncate text-text-tertiary" title={current}>current: {current}</span>
	{/if}
</div>
{#if result}
	<p class="type-caption {result.ok ? 'text-status-ok' : 'text-status-err'}" role={result.ok ? 'status' : 'alert'}>
		{result.text}
	</p>
{/if}
