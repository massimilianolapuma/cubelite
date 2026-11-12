<script lang="ts">
	import type { Snippet } from 'svelte';
	import { INPUT_CLASS, type SecretFields } from '#lib/integration-form.svelte.ts';
	import { FIELD_BASE } from '#lib/ui-classes.ts';

	// Authentication method and the secret fields it needs. `secretMethods`
	// maps single-secret methods (API key, bearer) to their label and hint;
	// `extra` renders method-specific controls (ECK, Azure CLI).
	let {
		fields,
		options,
		secretMethods,
		extra
	}: {
		fields: SecretFields<string>;
		options: { value: string; label: string }[];
		secretMethods: Record<string, { label: string; placeholder: string }>;
		extra?: Snippet;
	} = $props();

	const single = $derived(secretMethods[fields.method]);
</script>

<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
	<!-- As wide as its longest option ("Azure CLI (Azure Monitor)"), never wider than the form. -->
	<select class="{FIELD_BASE} w-auto max-w-full" aria-label="Authentication" bind:value={fields.method}>
		{#each options as option (option.value)}
			<option value={option.value}>{option.label}</option>
		{/each}
	</select>
	{#if fields.stored && fields.stored !== 'none'}
		<span class="type-body-sm text-text-muted">saved in the keychain: {fields.stored}</span>
	{/if}
</div>
{#if fields.method === 'basic'}
	<div class="grid grid-cols-2 gap-2">
		<input class={INPUT_CLASS} aria-label="Username" placeholder="username" autocomplete="off" bind:value={fields.username} />
		<input
			class={INPUT_CLASS}
			aria-label="Password"
			type="password"
			placeholder={fields.stored === 'basic' ? '•••••• (saved)' : 'password'}
			autocomplete="off"
			bind:value={fields.password}
		/>
	</div>
{:else if single}
	<input
		class={INPUT_CLASS}
		aria-label={single.label}
		type="password"
		autocomplete="off"
		placeholder={fields.stored === fields.method ? '•••••• (saved)' : single.placeholder}
		bind:value={fields.secret}
	/>
{/if}
{@render extra?.()}
