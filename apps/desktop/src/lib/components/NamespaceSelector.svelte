<script lang="ts">
	import { listNamespaces } from '$lib/tauri';
	import type { NamespaceInfo } from '$lib/tauri';

	type Props = {
		kubeconfigPath: string;
		context: string;
		onSelect?: (namespace: string | null) => void;
	};

	let { kubeconfigPath, context, onSelect }: Props = $props();

	let namespaces: NamespaceInfo[] = $state([]);
	let selected: string = $state('');
	let loading = $state(false);
	let error: string | null = $state(null);

	async function loadNamespaces(kc: string, ctx: string) {
		loading = true;
		error = null;
		namespaces = [];
		selected = '';
		try {
			namespaces = await listNamespaces(kc, ctx);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	function handleChange(e: Event) {
		const target = e.currentTarget as HTMLSelectElement;
		selected = target.value;
		onSelect?.(selected || null);
	}

	$effect(() => {
		if (kubeconfigPath && context) {
			loadNamespaces(kubeconfigPath, context);
		}
	});
</script>

<div class="flex items-center gap-2">
	<label
		for="namespace-select"
		class="text-xs font-medium"
		style="color: hsl(var(--muted-foreground));"
	>
		Namespace
	</label>
	{#if loading}
		<span class="text-xs" style="color: hsl(var(--muted-foreground));">Loading…</span>
	{:else if error}
		<span class="text-xs" style="color: hsl(var(--destructive));">{error}</span>
	{:else}
		<select
			id="namespace-select"
			value={selected}
			onchange={handleChange}
			class="rounded border px-2 py-1 text-xs focus:outline-none focus:ring-1"
			style="border-color: hsl(var(--border)); background-color: hsl(var(--card)); color: hsl(var(--foreground)); focus-ring-color: hsl(var(--ring));"
		>
			<option value="">All namespaces</option>
			{#each namespaces as ns (ns.name)}
				<option value={ns.name}>{ns.name}</option>
			{/each}
		</select>
	{/if}
</div>
