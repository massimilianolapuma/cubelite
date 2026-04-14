<script lang="ts">
	import { homeDir } from '@tauri-apps/api/path';
	import KubeContextSidebar from '$lib/components/KubeContextSidebar.svelte';
	import MainView from '$lib/components/MainView.svelte';
	import type { ContextInfo } from '$lib/tauri';

	let kubeconfigPath: string = $state('');
	let selectedContext: string = $state('');

	$effect(() => {
		homeDir().then((dir) => {
			kubeconfigPath = `${dir}/.kube/config`;
		});
	});

	function handleContextSelect(ctx: ContextInfo) {
		selectedContext = ctx.name;
	}
</script>

<div class="flex h-screen overflow-hidden" style="background-color: hsl(var(--background));">
	<KubeContextSidebar onContextSelect={handleContextSelect} />
	<MainView {kubeconfigPath} context={selectedContext} />
</div>


