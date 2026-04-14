<script lang="ts">
	import { listen } from '@tauri-apps/api/event';
	import { listPods, listDeployments } from '$lib/tauri';
	import type { PodInfo, DeploymentInfo } from '$lib/tauri';
	import NamespaceSelector from './NamespaceSelector.svelte';
	import PodTable from './PodTable.svelte';
	import DeploymentTable from './DeploymentTable.svelte';

	type Props = {
		kubeconfigPath: string;
		context: string;
	};

	let { kubeconfigPath, context }: Props = $props();

	let namespace: string | null = $state(null);
	let pods: PodInfo[] = $state([]);
	let deployments: DeploymentInfo[] = $state([]);
	let loadingPods = $state(false);
	let loadingDeployments = $state(false);
	let podError: string | null = $state(null);
	let deploymentError: string | null = $state(null);

	async function loadResources(kc: string, ctx: string, ns: string | null) {
		loadingPods = true;
		loadingDeployments = true;
		podError = null;
		deploymentError = null;

		const podPromise = listPods(kc, ns ?? undefined, ctx)
			.then((p) => {
				pods = p;
			})
			.catch((e: unknown) => {
				podError = e instanceof Error ? e.message : String(e);
			})
			.finally(() => {
				loadingPods = false;
			});

		const depPromise = ns
			? listDeployments(kc, ns, ctx)
					.then((d) => {
						deployments = d;
					})
					.catch((e: unknown) => {
						deploymentError = e instanceof Error ? e.message : String(e);
					})
					.finally(() => {
						loadingDeployments = false;
					})
			: Promise.resolve().then(() => {
					deployments = [];
					loadingDeployments = false;
				});

		await Promise.all([podPromise, depPromise]);
	}

	function handleNamespaceSelect(ns: string | null) {
		namespace = ns;
	}

	// Watch integration: listen for resource-updated / resource-deleted events
	$effect(() => {
		if (!kubeconfigPath || !context) return;

		pods = [];
		deployments = [];
		namespace = null;

		const unlistenUpdated = listen<unknown>('resource-updated', () => {
			loadResources(kubeconfigPath, context, namespace);
		});
		const unlistenDeleted = listen<unknown>('resource-deleted', () => {
			loadResources(kubeconfigPath, context, namespace);
		});

		return () => {
			unlistenUpdated.then((fn) => fn());
			unlistenDeleted.then((fn) => fn());
		};
	});

	// Reload when namespace changes
	$effect(() => {
		if (kubeconfigPath && context) {
			loadResources(kubeconfigPath, context, namespace);
		}
	});
</script>

<main class="flex flex-1 flex-col overflow-hidden" style="background-color: hsl(var(--background));">
	{#if !context}
		<div class="flex flex-1 items-center justify-center">
			<p class="text-sm" style="color: hsl(var(--muted-foreground));">Select a context to get started.</p>
		</div>
	{:else}
		<!-- Toolbar -->
		<div class="flex items-center gap-4 border-b px-6 py-3" style="border-color: hsl(var(--border)); background-color: hsl(var(--card));">
			<span class="text-xs font-semibold" style="color: hsl(var(--foreground));">{context}</span>
			<div class="ml-auto">
				<NamespaceSelector
					{kubeconfigPath}
					{context}
					onSelect={handleNamespaceSelect}
				/>
			</div>
		</div>

		<!-- Content -->
		<div class="flex-1 overflow-y-auto p-6">
			<!-- Pods section -->
			<section class="mb-8">
				<h2 class="mb-3 text-xs font-semibold uppercase tracking-wider" style="color: hsl(var(--muted-foreground));">
					Pods {#if loadingPods}<span class="normal-case font-normal">— loading…</span>{/if}
				</h2>
				{#if podError}
					<p class="text-xs" style="color: hsl(var(--destructive));">{podError}</p>
				{:else}
					<div class="rounded-lg border" style="border-color: hsl(var(--border)); background-color: hsl(var(--card));">
						<div class="p-4">
							<PodTable {pods} />
						</div>
					</div>
				{/if}
			</section>

			<!-- Deployments section -->
			<section>
				<h2 class="mb-3 text-xs font-semibold uppercase tracking-wider" style="color: hsl(var(--muted-foreground));">
					Deployments {#if loadingDeployments}<span class="normal-case font-normal">— loading…</span>{/if}
				</h2>
				{#if !namespace}
					<p class="text-xs" style="color: hsl(var(--muted-foreground));">Select a namespace to list deployments.</p>
				{:else if deploymentError}
					<p class="text-xs" style="color: hsl(var(--destructive));">{deploymentError}</p>
				{:else}
					<div class="rounded-lg border" style="border-color: hsl(var(--border)); background-color: hsl(var(--card));">
						<div class="p-4">
							<DeploymentTable {deployments} />
						</div>
					</div>
				{/if}
			</section>
		</div>
	{/if}
</main>

