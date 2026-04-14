<script lang="ts">
	import type { DeploymentInfo } from '$lib/tauri';

	type Props = {
		deployments: DeploymentInfo[];
	};

	let { deployments }: Props = $props();
</script>

<div class="overflow-x-auto">
	<table class="w-full text-xs">
		<thead>
			<tr class="border-b text-left" style="border-color: hsl(var(--border));">
				<th class="pb-2 pr-4 font-semibold" style="color: hsl(var(--muted-foreground));">Name</th>
				<th class="pb-2 pr-4 font-semibold" style="color: hsl(var(--muted-foreground));">Namespace</th>
				<th class="pb-2 pr-4 font-semibold" style="color: hsl(var(--muted-foreground));">Ready</th>
				<th class="pb-2 font-semibold" style="color: hsl(var(--muted-foreground));">Replicas</th>
			</tr>
		</thead>
		<tbody>
			{#if deployments.length === 0}
				<tr>
					<td colspan="4" class="py-6 text-center text-xs" style="color: hsl(var(--muted-foreground));">
						No deployments found.
					</td>
				</tr>
			{:else}
				{#each deployments as dep (dep.namespace + '/' + dep.name)}
					<tr class="border-b transition-colors hover:bg-[hsl(var(--accent))]" style="border-color: hsl(var(--border));">
						<td class="py-2 pr-4 font-medium" style="color: hsl(var(--foreground));">{dep.name}</td>
						<td class="py-2 pr-4" style="color: hsl(var(--muted-foreground));">{dep.namespace}</td>
						<td class="py-2 pr-4">
							<span
								class="font-medium"
								style={dep.ready_replicas >= dep.replicas && dep.replicas > 0
									? 'color: hsl(142 71% 45%);'
									: 'color: hsl(38 92% 50%);'}
							>
								{dep.ready_replicas}/{dep.replicas}
							</span>
						</td>
						<td class="py-2" style="color: hsl(var(--foreground));">{dep.replicas}</td>
					</tr>
				{/each}
			{/if}
		</tbody>
	</table>
</div>
