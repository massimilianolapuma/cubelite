<script lang="ts">
	// Services found by Detect, each with a Use button (shared by the
	// integration preferences).
	import { ACCENT_LINK_CLASS } from '#lib/integration.ts';

	type Found = { kind: string; namespace: string; name: string; port: number; https: boolean };
	let {
		services,
		empty,
		onUse
	}: {
		/** null before the first Detect. */
		services: readonly Found[] | null;
		/** Shown when Detect found nothing. */
		empty: string;
		onUse: (found: Found) => void;
	} = $props();
</script>

{#if services}
	{#if services.length === 0}
		<p class="type-body-sm text-text-muted">{empty}</p>
	{:else}
		<ul class="flex flex-col gap-1" aria-label="Detected services">
			{#each services as svc (svc.kind + ':' + svc.namespace + '/' + svc.name)}
				<li class="flex items-center gap-3">
					<span class="type-data-sm min-w-0 flex-1 truncate text-text" title="{svc.kind} · {svc.namespace}/{svc.name}:{svc.port}">
						{svc.kind} · {svc.namespace}/{svc.name}:{svc.port}{svc.https ? ' (https)' : ''}
					</span>
					<button
						type="button"
						class="{ACCENT_LINK_CLASS} shrink-0 px-2"
						aria-label="Use {svc.kind} {svc.namespace}/{svc.name}"
						onclick={() => onUse(svc)}>Use</button
					>
				</li>
			{/each}
		</ul>
	{/if}
{/if}
