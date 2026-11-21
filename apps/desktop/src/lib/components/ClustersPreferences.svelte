<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
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
	import type { Environment, EnvironmentVariants } from '#lib/tauri.ts';
	import { FIELD, FIELD_BASE } from '#lib/ui-classes.ts';

	// Preferences → Clusters (#662, spec §6): each context's environment, and the
	// words that name each environment. The access column comes with read-only.

	/** The options of a row: as the menu's, the detected one read as "<Label> (detected)". */
	function options(name: string): { value: EnvironmentChoice; label: string }[] {
		const detected = clusterSettings.byName[name]?.detected ?? null;
		return environmentChoices(detected).map((c) =>
			c.value === 'detected' ? { ...c, label: `${environmentLabel(detected)} (detected)` } : c
		);
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

	// Follow the saved words, except where the user is typing or was refused.
	$effect(() => {
		const saved = clusterSettings.variants;
		for (const env of ENVIRONMENTS) {
			if (env !== editing && !notes[env]?.refused) drafts[env] = joined(saved[env] ?? []);
		}
	});

	/** Letters and digits, at least one letter: what detection can match. */
	const SINGLE_WORD = /^(?=.*[a-z])[a-z0-9]+$/;

	async function save(env: Environment) {
		editing = null;
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
				<th scope="col" class="type-label pb-2 text-left text-text-muted">Context</th>
				<th scope="col" class="type-label pb-2 text-left text-text-muted">Environment</th>
			</tr>
		</thead>
		<tbody>
			{#each clusters.contexts as ctx (ctx.name)}
				<tr class="border-b border-outline last:border-b-0">
					<td class="type-data-sm max-w-0 truncate py-2 pr-4 text-text" title={ctx.name}>{ctx.name}</td>
					<td class="w-1 py-2 whitespace-nowrap">
						<select
							aria-label="Environment of {ctx.name}"
							class="{FIELD_BASE} w-56 max-w-full pr-2"
							value={choiceOf(clusterSettings.byName[ctx.name])}
							onchange={(e) =>
								void clusterSettings.setEnvironment(
									ctx.name,
									settingOf(e.currentTarget.value as EnvironmentChoice)
								)}
						>
							{#each options(ctx.name) as option (option.value)}
								<option value={option.value}>{option.label}</option>
							{/each}
						</select>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}

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
