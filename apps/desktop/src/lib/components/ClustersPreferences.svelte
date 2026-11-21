<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Lock from '@lucide/svelte/icons/lock';
	import Timer from '@lucide/svelte/icons/timer';
	import AccessMenuItems from '#lib/components/shell/AccessMenuItems.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Switch from '#lib/components/ui/Switch.svelte';
	import { remainingText } from '#lib/access.ts';
	import {
		ENVIRONMENTS,
		ENVIRONMENT_LABEL,
		choiceOf,
		defaultVariants,
		environmentChoices,
		environmentLabel,
		settingOf,
		type EnvironmentChoice
	} from '#lib/environment.ts';
	import { ACCENT_LINK_CLASS } from '#lib/integration.ts';
	import { clusters } from '#lib/stores/clusters.svelte.ts';
	import { clusterSettings } from '#lib/stores/cluster-settings.svelte.ts';
	import { clock } from '#lib/stores/clock.svelte.ts';
	import type { Environment, EnvironmentVariants } from '#lib/tauri.ts';
	import { CHECKBOX, FIELD, FIELD_BASE, MENU_CONTENT } from '#lib/ui-classes.ts';

	// Preferences → Clusters (#662, spec §6): each context's environment and
	// access, the access preferences, and the words that name each environment.

	/** Production set by hand on a writable context: offer to lock it (spec §3.3). */
	function offersLock(name: string): boolean {
		const entry = clusterSettings.byName[name];
		return (
			entry?.source === 'manual' &&
			entry.environment === 'production' &&
			clusterSettings.accessOf(name) === 'writable'
		);
	}

	/** Toggle one environment of "Read-only from the start"; the box follows the saved list. */
	async function toggleStart(env: Environment, box: HTMLInputElement) {
		const current = clusterSettings.readOnlyFromStart;
		const next = ENVIRONMENTS.filter((e) => (e === env ? box.checked : current.includes(e)));
		const saved = await clusterSettings.setAccessPreferences({ readOnlyFromStart: next });
		if (!saved) box.checked = clusterSettings.readOnlyFromStart.includes(env);
	}

	/** The options of a row: as the menu's, the detected one read as "<Label> (detected)". */
	function options(name: string): { value: EnvironmentChoice; label: string }[] {
		const detected = clusterSettings.byName[name]?.detected ?? null;
		return environmentChoices(detected).map((c) =>
			c.value === 'detected' ? { ...c, label: `${environmentLabel(detected)} (detected)` } : c
		);
	}

	/** Set a context's environment; a choice the backend did not save goes back. */
	async function choose(name: string, select: HTMLSelectElement) {
		const saved = await clusterSettings.setEnvironment(
			name,
			settingOf(select.value as EnvironmentChoice)
		);
		if (!saved) select.value = choiceOf(clusterSettings.byName[name]);
	}

	let namesOpen = $state(false);

	const joined = (words: string[]) => words.join(', ');
	const blankDrafts = () =>
		Object.fromEntries(ENVIRONMENTS.map((e) => [e, ''])) as Record<Environment, string>;

	/** What each field shows: the saved words, or what the user typed while it is refused. */
	let drafts = $state(blankDrafts());
	/** The line under a field: a refusal (the text is kept) or the words left out. */
	let notes = $state<Partial<Record<Environment, { text: string; refused: boolean }>>>({});
	/** The field being typed in: a change from elsewhere does not overwrite it. */
	let editing = $state<Environment | null>(null);
	/** Fields whose save is on its way: their text stays until the answer. */
	let pending = $state<Partial<Record<Environment, boolean>>>({});

	// Follow the saved words, except where the user is typing, a save is on its
	// way, or the backend refused what was typed.
	$effect(() => {
		const saved = clusterSettings.variants;
		for (const env of ENVIRONMENTS) {
			if (env !== editing && !pending[env] && !notes[env]?.refused) {
				drafts[env] = joined(saved[env] ?? []);
			}
		}
	});

	/** Letters and digits, at least one letter: what detection can match. */
	const SINGLE_WORD = /^(?=.*[a-z])[a-z0-9]+$/;

	async function save(env: Environment) {
		pending[env] = true;
		if (editing === env) editing = null;
		try {
			await saveField(env);
		} finally {
			pending[env] = false;
		}
	}

	async function saveField(env: Environment) {
		const text = drafts[env];
		const words = text
			.split(',')
			.map((w) => w.trim().toLowerCase())
			.filter((w) => w !== '');
		const kept = [...new Set(words.filter((w) => SINGLE_WORD.test(w)))];
		const leftOut = [...new Set(words.filter((w) => !SINGLE_WORD.test(w)))];
		const saved = clusterSettings.variants;
		if (joined(kept) === joined(saved[env] ?? []) && leftOut.length === 0) {
			notes[env] = undefined;
			drafts[env] = joined(kept);
			return;
		}
		// A word that names another environment is refused here, naming that one; the
		// backend refuses it too, but cannot know which field was being edited.
		for (const word of kept) {
			const other = ENVIRONMENTS.find((e) => e !== env && (saved[e] ?? []).includes(word));
			if (other) {
				notes[env] = { text: `"${word}" is already in ${ENVIRONMENT_LABEL[other]}`, refused: true };
				return;
			}
		}
		const next: EnvironmentVariants = { ...saved, [env]: kept };
		const error = await clusterSettings.setVariants(next);
		if (error) {
			notes[env] = { text: error, refused: true };
			return;
		}
		drafts[env] = joined(clusterSettings.variants[env] ?? []);
		notes[env] =
			leftOut.length > 0
				? {
						text: `Left out ${leftOut.map((w) => `"${w}"`).join(', ')}: letters and digits only`,
						refused: false
					}
				: undefined;
	}

	async function resetNames() {
		const error = await clusterSettings.setVariants(defaultVariants());
		if (error) {
			for (const env of ENVIRONMENTS) notes[env] = { text: error, refused: true };
			return;
		}
		notes = {};
		for (const env of ENVIRONMENTS) drafts[env] = joined(clusterSettings.variants[env] ?? []);
	}

	const hint = 'type-body-sm mt-0.5 text-text-muted';
</script>

{#if clusters.contexts.length === 0}
	<p class={hint}>No contexts in the loaded kubeconfig.</p>
{:else}
	<table class="w-full border-collapse" aria-label="Cluster environments">
		<thead>
			<tr class="border-b border-outline">
				<th scope="col" class="type-label pr-4 pb-2 text-left text-text-muted">Context</th>
				<th scope="col" class="type-label pb-2 text-left text-text-muted">Environment</th>
				<th scope="col" class="type-label pb-2 pl-3 text-left text-text-muted">Access</th>
			</tr>
		</thead>
		<tbody>
			{#each clusters.contexts as ctx (ctx.name)}
				{@const access = clusterSettings.accessOf(ctx.name)}
				{@const until = clusterSettings.writableUntil(ctx.name)}
				{@const offer = offersLock(ctx.name)}
				<tr class="border-outline {offer ? '' : 'border-b last:border-b-0'}">
					<td class="type-data-sm max-w-0 truncate py-2 pr-4 text-text" title={ctx.name}>{ctx.name}</td>
					<td class="w-1 py-2 whitespace-nowrap">
						<select
							aria-label="Environment of {ctx.name}"
							class="{FIELD_BASE} w-48 max-w-full pr-2"
							value={choiceOf(clusterSettings.byName[ctx.name])}
							onchange={(e) => void choose(ctx.name, e.currentTarget)}
						>
							{#each options(ctx.name) as option (option.value)}
								<option value={option.value}>{option.label}</option>
							{/each}
						</select>
					</td>
					<td class="w-1 py-2 pl-3 whitespace-nowrap">
						<div class="flex items-center justify-end gap-2">
							<!-- The state as the top bar chip says it, then the way to change it. -->
							<span class="mr-auto flex items-center" data-testid="access-state" data-access={access}>
								{#if access === 'read_only'}
									<span class="type-body-sm flex items-center gap-1 text-text-muted">
										<Lock class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />Read-only
									</span>
								{:else if access === 'timed' && until !== null}
									<span
										class="type-micro flex items-center gap-1 rounded-xs bg-warning-container px-1.5 py-px font-semibold text-on-warning-container"
										data-badge
									>
										<Timer class="h-3 w-3 shrink-0" aria-hidden="true" />Writable · {remainingText(until - clock.now)}
									</span>
								{:else}
									<span class="type-body-sm text-text-muted">Writable</span>
								{/if}
							</span>
							<!-- One button per row: two do not fit beside the state. Writable for a
							     while offers the way back; restarting its time is in the top bar menu. -->
							{#if access === 'read_only'}
								<DropdownMenu.Root>
									<DropdownMenu.Trigger>
										{#snippet child({ props })}
											<Button {...props} variant="text" size="inline" aria-label="Make writable: {ctx.name}">
												Make writable
												<ChevronDown class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
											</Button>
										{/snippet}
									</DropdownMenu.Trigger>
									<DropdownMenu.Portal>
										<DropdownMenu.Content align="end" sideOffset={6} class="{MENU_CONTENT} min-w-44">
											<AccessMenuItems name={ctx.name} durations />
										</DropdownMenu.Content>
									</DropdownMenu.Portal>
								</DropdownMenu.Root>
							{/if}
							{#if access !== 'read_only'}
								<Button
									variant="text"
									size="inline"
									aria-label="Make read-only: {ctx.name}"
									onclick={() => void clusterSettings.makeReadOnly(ctx.name)}
								>
									Make read-only
								</Button>
							{/if}
						</div>
					</td>
				</tr>
				{#if offer}
					<tr class="border-b border-outline last:border-b-0">
						<td colspan="3" class="pb-2">
							<p class="type-body-sm flex items-center gap-1.5 text-text-muted">
								<span>Production clusters are usually read-only</span>
								<span aria-hidden="true">·</span>
								<button
									type="button"
									class={ACCENT_LINK_CLASS}
									aria-label="Make read-only: {ctx.name}"
									onclick={() => void clusterSettings.makeReadOnly(ctx.name)}
								>
									Make read-only
								</button>
							</p>
						</td>
					</tr>
				{/if}
			{/each}
		</tbody>
	</table>
{/if}

<div class="flex items-center justify-between gap-4">
	<div class="min-w-0 flex-1">
		<div class="type-body text-text">Ask before making a cluster writable</div>
		<p class={hint}>A confirmation names the cluster and how long it stays writable.</p>
	</div>
	<Switch
		checked={clusterSettings.confirmUnlock}
		label="Ask before making a cluster writable"
		onChange={(v) => void clusterSettings.setAccessPreferences({ confirmUnlock: v })}
	/>
</div>

<fieldset class="min-w-0">
	<legend class="type-body text-text">Read-only from the start</legend>
	<p class={hint}>A cluster with one of these environments is read-only the first time CubeLite sees it.</p>
	<div class="mt-2 flex flex-wrap gap-x-5 gap-y-2">
		{#each ENVIRONMENTS as env (env)}
			<label class="type-body-sm flex items-center gap-2 text-text">
				<input
					type="checkbox"
					class={CHECKBOX}
					checked={clusterSettings.readOnlyFromStart.includes(env)}
					onchange={(e) => void toggleStart(env, e.currentTarget)}
				/>
				{ENVIRONMENT_LABEL[env]}
			</label>
		{/each}
	</div>
</fieldset>

<div>
	<div class="flex items-center justify-between gap-3">
		<button
			type="button"
			class="focus-ring flex items-center gap-2 rounded-full py-1 pr-3 text-left text-text"
			aria-expanded={namesOpen}
			aria-controls="prefs-environment-names"
			onclick={() => (namesOpen = !namesOpen)}
		>
			<ChevronRight
				class="h-3.5 w-3.5 shrink-0 text-text-subtle transition-transform {namesOpen ? 'rotate-90' : ''}"
				aria-hidden="true"
			/>
			<span class="type-body">Environment names</span>
		</button>
	</div>
	<p class={hint}>The words in a context's name that tell its environment, separated by commas.</p>
	{#if namesOpen}
		<div id="prefs-environment-names" class="mt-3 flex flex-col gap-3">
			{#each ENVIRONMENTS as env (env)}
				{@const note = notes[env]}
				<div class="grid grid-cols-[7rem_1fr] items-start gap-x-3">
					<label for="prefs-variants-{env}" class="type-body-sm pt-2 text-text">{ENVIRONMENT_LABEL[env]}</label>
					<div class="min-w-0">
						<input
							id="prefs-variants-{env}"
							type="text"
							class={FIELD}
							spellcheck="false"
							autocomplete="off"
							bind:value={drafts[env]}
							aria-invalid={note?.refused ? 'true' : undefined}
							aria-describedby={note ? `prefs-variants-${env}-note` : undefined}
							onfocus={() => (editing = env)}
							onblur={() => void save(env)}
						/>
						{#if note}
							<p
								id="prefs-variants-{env}-note"
								class="type-body-sm mt-1 {note.refused ? 'font-semibold text-error' : 'text-text-muted'}"
							>
								{note.text}
							</p>
						{/if}
					</div>
				</div>
			{/each}
			<button type="button" class="{ACCENT_LINK_CLASS} self-end" onclick={() => void resetNames()}>
				Reset to defaults
			</button>
		</div>
	{/if}
</div>
