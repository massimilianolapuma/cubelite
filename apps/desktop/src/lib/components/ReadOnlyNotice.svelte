<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Lock from '@lucide/svelte/icons/lock';
	import AccessMenuItems from '#lib/components/shell/AccessMenuItems.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import KeepTogether from '#lib/components/ui/KeepTogether.svelte';
	import { clusterSettings } from '#lib/stores/cluster-settings.svelte.ts';
	import { MENU_CONTENT } from '#lib/ui-classes.ts';

	// One line above a drawer's actions on a read-only cluster (#662, spec §5.4):
	// it says once why the write actions under it are off, and offers the way
	// out, the durations of the cluster menu. Nothing on a writable cluster.
	let { name }: { name: string } = $props();

	const reason = $derived(clusterSettings.lockReason(name));
</script>

{#if reason !== null}
	<div class="flex w-full min-w-0 items-center gap-2" data-testid="read-only-notice">
		<Lock class="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
		<p class="type-body-sm min-w-0 flex-1 break-words text-text-muted"><KeepTogether text={reason} /></p>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="text" size="inline">
						Make writable
						<ChevronDown class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content align="end" sideOffset={6} class="{MENU_CONTENT} min-w-44">
					<AccessMenuItems {name} durations />
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	</div>
{/if}
