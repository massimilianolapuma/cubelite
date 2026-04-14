<script lang="ts">
	import type { PodInfo } from '$lib/tauri';

	type Props = {
		pods: PodInfo[];
	};

	let { pods }: Props = $props();

	function phaseColor(phase: string | null): string {
		switch (phase?.toLowerCase()) {
			case 'running':
				return 'hsl(142 71% 45%)';
			case 'pending':
				return 'hsl(38 92% 50%)';
			case 'failed':
			case 'error':
				return 'hsl(var(--destructive))';
			case 'succeeded':
				return 'hsl(var(--muted-foreground))';
			default:
				return 'hsl(var(--muted-foreground))';
		}
	}
</script>

<div class="overflow-x-auto">
	<table class="w-full text-xs">
		<thead>
			<tr class="border-b text-left" style="border-color: hsl(var(--border));">
				<th class="pb-2 pr-4 font-semibold" style="color: hsl(var(--muted-foreground));">Name</th>
				<th class="pb-2 pr-4 font-semibold" style="color: hsl(var(--muted-foreground));">Namespace</th>
				<th class="pb-2 pr-4 font-semibold" style="color: hsl(var(--muted-foreground));">Phase</th>
				<th class="pb-2 pr-4 font-semibold" style="color: hsl(var(--muted-foreground));">Ready</th>
				<th class="pb-2 font-semibold" style="color: hsl(var(--muted-foreground));">Restarts</th>
			</tr>
		</thead>
		<tbody>
			{#if pods.length === 0}
				<tr>
					<td colspan="5" class="py-6 text-center text-xs" style="color: hsl(var(--muted-foreground));">
						No pods found.
					</td>
				</tr>
			{:else}
				{#each pods as pod (pod.namespace + '/' + pod.name)}
					<tr class="border-b transition-colors hover:bg-[hsl(var(--accent))]" style="border-color: hsl(var(--border));">
						<td class="py-2 pr-4 font-medium" style="color: hsl(var(--foreground));">{pod.name}</td>
						<td class="py-2 pr-4" style="color: hsl(var(--muted-foreground));">{pod.namespace}</td>
						<td class="py-2 pr-4">
							<span class="font-medium" style="color: {phaseColor(pod.phase)};">
								{pod.phase ?? '—'}
							</span>
						</td>
						<td class="py-2 pr-4">
							<span
								class="font-medium"
								style={pod.ready ? 'color: hsl(142 71% 45%);' : 'color: hsl(var(--destructive));'}
							>
								{pod.ready ? 'Yes' : 'No'}
							</span>
						</td>
						<td class="py-2">
							<span
								class="font-medium"
								style={pod.restarts > 0 ? 'color: hsl(38 92% 50%);' : 'color: hsl(var(--muted-foreground));'}
							>
								{pod.restarts}
							</span>
						</td>
					</tr>
				{/each}
			{/if}
		</tbody>
	</table>
</div>
