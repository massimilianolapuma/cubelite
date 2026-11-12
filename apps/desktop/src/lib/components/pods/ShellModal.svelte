<script lang="ts">
	import { onMount } from 'svelte';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import Modal from '#lib/components/ui/Modal.svelte';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';
	import { errorMessage } from '#lib/errors.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { execSend, startExec, stopExec, type ExecLine } from '#lib/tauri.ts';

	/**
	 * Line-based shell in a pod (#488):
	 * `/bin/sh` without a TTY, one command line at a time on stdin, stdout and
	 * stderr streamed back into a capped scrollback.
	 */
	let {
		namespace,
		pod,
		onClose
	}: {
		namespace: string;
		pod: string;
		onClose: () => void;
	} = $props();

	const SCROLLBACK_CAP = 1000;

	type Kind = 'input' | ExecLine['channel'];
	type Row = { id: number; kind: Kind; text: string };

	// On the sunken code area (Tonal §8.5). stderr is told apart by weight too,
	// not by colour alone; input lines start with "$ ".
	const KIND_CLASS: Record<Kind, string> = {
		input: 'text-primary',
		stdout: 'text-text',
		stderr: 'font-semibold text-error',
		status: 'text-text-muted'
	};

	const sessionId = crypto.randomUUID();
	let rows = $state<Row[]>([]);
	let nextId = 0;
	let command = $state('');
	let sessionError = $state<string | null>(null);
	let ended = $state(false);
	let scroller = $state<HTMLDivElement | null>(null);
	let input = $state<HTMLInputElement | null>(null);

	function append(kind: Kind, text: string) {
		rows.push({ id: nextId++, kind, text });
		if (rows.length > SCROLLBACK_CAP) rows.splice(0, rows.length - SCROLLBACK_CAP);
	}

	// Keep the newest line in view.
	$effect(() => {
		void rows.length;
		if (scroller) scroller.scrollTop = scroller.scrollHeight;
	});

	onMount(() => {
		let disposed = false;
		const unlisteners: UnlistenFn[] = [];
		const keep = (unlisten: UnlistenFn) => {
			if (disposed) unlisten();
			else unlisteners.push(unlisten);
		};

		void (async () => {
			const kc = app.kubeconfigPath;
			const cluster = app.activeCluster;
			if (!kc || !cluster) {
				sessionError = 'No active cluster.';
				return;
			}
			try {
				keep(
					await listen<ExecLine>(`exec-output:${sessionId}`, (event) =>
						append(event.payload.channel, event.payload.text)
					)
				);
				keep(
					await listen(`exec-end:${sessionId}`, () => {
						append('status', 'session closed');
						ended = true;
					})
				);
				if (disposed) return;
				await startExec(kc, sessionId, namespace, pod, cluster);
				append('status', 'connected: line-based shell (/bin/sh, no TTY)');
				input?.focus();
			} catch (e: unknown) {
				sessionError = errorMessage(e);
			}
		})();

		return () => {
			disposed = true;
			for (const unlisten of unlisteners) unlisten();
			void stopExec(sessionId).catch(() => {});
		};
	});

	function send() {
		const line = command;
		if (!line || ended || sessionError) return;
		command = '';
		append('input', `$ ${line}`);
		execSend(sessionId, `${line}\n`).catch((e: unknown) => {
			append('status', errorMessage(e));
			ended = true;
		});
	}
</script>

<Modal title="{pod} shell" width={720} {onClose}>
	<div class="flex flex-col gap-3">
		{#if sessionError}
			<p class="type-body-sm flex items-center justify-center gap-2 py-8 text-text" role="alert">
				<StatusGlyph state="err" class="text-error" />{sessionError}
			</p>
		{:else}
			<div
				bind:this={scroller}
				class="type-log h-[50vh] overflow-auto rounded-md bg-surface-sunken p-3"
				data-testid="shell-scrollback"
			>
				{#each rows as row (row.id)}
					<div class="break-all whitespace-pre-wrap {KIND_CLASS[row.kind]}" data-kind={row.kind}>
						{row.text}
					</div>
				{/each}
			</div>
		{/if}
		<form
			class="flex items-center gap-2"
			onsubmit={(event) => {
				event.preventDefault();
				send();
			}}
		>
			<span class="type-log font-semibold text-primary" aria-hidden="true">$</span>
			<input
				bind:this={input}
				bind:value={command}
				aria-label="Shell command"
				placeholder={ended ? 'session closed' : 'command'}
				autocomplete="off"
				spellcheck="false"
				disabled={ended || sessionError !== null}
				class="focus-ring type-log h-(--control-h-compact) min-w-0 flex-1 rounded-md border border-outline-strong bg-surface-sunken px-3 text-text placeholder:text-text-muted disabled:opacity-45"
			/>
		</form>
	</div>
</Modal>
