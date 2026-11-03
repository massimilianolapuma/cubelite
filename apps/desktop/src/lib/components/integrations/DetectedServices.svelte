<script lang="ts">
	// Services found by Detect, each with a Use button (shared by the
	// integration preferences).
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
		<p class="type-caption text-text-tertiary">{empty}</p>
	{:else}
		<ul class="flex flex-col gap-0.5" aria-label="Detected services">
			{#each services as svc (svc.kind + ':' + svc.namespace + '/' + svc.name)}
				<li class="flex items-center gap-2">
					<span class="type-data-sm flex-1 truncate text-text-secondary">
						{svc.kind} · {svc.namespace}/{svc.name}:{svc.port}{svc.https ? ' (https)' : ''}
					</span>
					<button
						type="button"
						class="focus-ring type-caption rounded-sm text-accent hover:brightness-110"
						aria-label="Use {svc.kind} {svc.namespace}/{svc.name}"
						onclick={() => onUse(svc)}>Use</button
					>
				</li>
			{/each}
		</ul>
	{/if}
{/if}
