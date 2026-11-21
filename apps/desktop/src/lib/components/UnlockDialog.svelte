<script lang="ts">
	import Button from '#lib/components/ui/Button.svelte';
	import KeepTogether from '#lib/components/ui/KeepTogether.svelte';
	import Modal from '#lib/components/ui/Modal.svelte';
	import { durationWords } from '#lib/access.ts';
	import { environmentLabel } from '#lib/environment.ts';
	import { clusterSettings } from '#lib/stores/cluster-settings.svelte.ts';
	import { CHECKBOX } from '#lib/ui-classes.ts';

	// The confirmation before a cluster is made writable (#662, spec §5.3). Mounted
	// once for the app; open while the store holds an unlock waiting for it. Making
	// a cluster read-only never asks.

	const pending = $derived(clusterSettings.pendingUnlock);
	let dontAskAgain = $state(false);

	// Each opening starts unchecked.
	$effect.pre(() => {
		if (clusterSettings.pendingUnlock) dontAskAgain = false;
	});

	const summary = $derived.by(() => {
		if (!pending) return '';
		const environment = clusterSettings.environmentOf(pending.name);
		const how = pending.duration === 'always' ? 'always' : `for ${durationWords(pending.duration)}`;
		if (environment) return `${environmentLabel(environment)} · ${how}`;
		return pending.duration === 'always' ? 'Always' : how;
	});

	const ending = $derived(
		!pending
			? ''
			: pending.duration === 'always'
				? 'It stays writable until you make it read-only.'
				: `It goes back to read-only after ${durationWords(pending.duration)} or when CubeLite quits.`
	);

	/** The dialog opens with the focus on Cancel: the safe answer is the default one. */
	function focusOnOpen(button: HTMLElement) {
		button.focus();
	}
</script>

{#if pending}
	<Modal title="Make {pending.name} writable?" width={440} onClose={() => clusterSettings.cancelPendingUnlock()}>
		<div class="type-body-sm flex flex-col gap-2 text-text-muted">
			<p class="font-semibold text-text">{summary}</p>
			<p>Actions in CubeLite will change this cluster: apply, delete, restart, scale, resources, shell.</p>
			<p><KeepTogether text={ending} /></p>
			<label class="mt-2 flex items-center gap-2 text-text">
				<input type="checkbox" class={CHECKBOX} bind:checked={dontAskAgain} />
				Don't ask again
			</label>
		</div>
		{#snippet footer()}
			<Button variant="text" onclick={() => clusterSettings.cancelPendingUnlock()} {@attach focusOnOpen}>
				Cancel
			</Button>
			<Button variant="tonal" onclick={() => void clusterSettings.confirmPendingUnlock(dontAskAgain)}>
				Make writable
			</Button>
		{/snippet}
	</Modal>
{/if}
