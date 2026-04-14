<script lang="ts">
	import { listContexts, setContext } from '$lib/tauri';
	import type { ContextInfo } from '$lib/tauri';

	type Props = {
		onContextSelect?: (context: ContextInfo) => void;
	};

	let { onContextSelect }: Props = $props();

	let contexts: ContextInfo[] = $state([]);
	let loading = $state(true);
	let error: string | null = $state(null);

	async function loadContexts() {
		loading = true;
		error = null;
		try {
			contexts = await listContexts();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	async function handleSelect(ctx: ContextInfo) {
		if (ctx.is_active) return;
		try {
			await setContext(ctx.name);
			await loadContexts();
			onContextSelect?.(ctx);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	$effect(() => {
		loadContexts();
	});
</script>

<aside class="flex w-64 flex-shrink-0 flex-col overflow-hidden border-r" style="border-color: hsl(var(--border)); background-color: hsl(var(--card));">
	<header class="flex items-center justify-between border-b px-4 py-3" style="border-color: hsl(var(--border));">
		<span class="text-xs font-semibold uppercase tracking-wider" style="color: hsl(var(--muted-foreground));">Contexts</span>
		<button
			onclick={loadContexts}
			class="rounded p-1 transition-colors hover:bg-[hsl(var(--accent))]"
			title="Refresh contexts"
		>
			<svg class="h-3.5 w-3.5" style="color: hsl(var(--muted-foreground));" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
			</svg>
		</button>
	</header>

	<div class="flex-1 overflow-y-auto">
		{#if loading}
			<div class="flex items-center justify-center p-6">
				<span class="text-xs" style="color: hsl(var(--muted-foreground));">Loading…</span>
			</div>
		{:else if error}
			<div class="p-4">
				<p class="text-xs" style="color: hsl(var(--destructive));">{error}</p>
			</div>
		{:else if contexts.length === 0}
			<div class="p-4">
				<p class="text-xs" style="color: hsl(var(--muted-foreground));">No contexts found.</p>
			</div>
		{:else}
			<ul class="py-1">
				{#each contexts as ctx (ctx.name)}
					<li>
						<button
							class="w-full cursor-pointer px-3 py-2 text-left transition-colors hover:bg-[hsl(var(--accent))] {ctx.is_active ? 'border-l-2' : 'border-l-2 border-transparent'}"
							style={ctx.is_active ? 'border-left-color: hsl(var(--primary));' : ''}
							onclick={() => handleSelect(ctx)}
						>
							<div class="flex items-center gap-2">
								{#if ctx.is_active}
									<span class="h-1.5 w-1.5 flex-shrink-0 rounded-full" style="background-color: hsl(var(--primary));"></span>
								{:else}
									<span class="h-1.5 w-1.5 flex-shrink-0 rounded-full" style="background-color: hsl(var(--muted-foreground));"></span>
								{/if}
								<span
									class="truncate text-xs font-medium"
									style={ctx.is_active ? 'color: hsl(var(--foreground));' : 'color: hsl(var(--muted-foreground));'}
								>
									{ctx.name}
								</span>
							</div>
							{#if ctx.cluster_server}
								<p class="mt-0.5 truncate pl-3.5 text-xs" style="color: hsl(var(--muted-foreground));">
									{ctx.cluster_server.replace(/^https?:\/\//, '')}
								</p>
							{/if}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</aside>

