<script lang="ts">
	import AuthFields from '#lib/components/integrations/AuthFields.svelte';
	import DetectedServices from '#lib/components/integrations/DetectedServices.svelte';
	import FormActions from '#lib/components/integrations/FormActions.svelte';
	import InClusterUi from '#lib/components/integrations/InClusterUi.svelte';
	import TargetFields from '#lib/components/integrations/TargetFields.svelte';
	import { errorMessage } from '#lib/errors.ts';
	import {
		INPUT_CLASS,
		SecretFields,
		TargetForm,
		describeTarget,
		saveCredentials,
		serviceRef,
		urlProblem,
		type FormResult
	} from '#lib/integration-form.svelte.ts';
	import { SUGGESTED_TEXT } from '#lib/integration-suggest.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { integrations } from '#lib/stores/integrations.svelte.ts';
	import { prometheus } from '#lib/stores/prometheus.svelte.ts';
	import { toasts } from '#lib/stores/toasts.svelte.ts';
	import {
		prometheusAuthMethod,
		prometheusDetect,
		prometheusDisconnect,
		prometheusSaveAuth,
		prometheusTest,
		type DetectedPrometheus,
		type GrafanaService,
		type PromAuth,
		type PromAuthMethod,
		type PromEndpoint
	} from '#lib/tauri.ts';

	// Preferences → Integrations → Prometheus for the active context (#510,
	// spec §5.3). In-cluster Prometheus is reached with the cluster
	// credentials; external endpoints take basic, bearer or an Azure CLI
	// token. Secrets go to the OS keychain and are never read back.

	const context = $derived(app.activeCluster);
	const saved = $derived(prometheus.endpointFor(context));

	const form = new TargetForm(9090, false);
	const auth = new SecretFields<PromAuthMethod>();
	let cluster = $state('');
	let grafanaUrl = $state('');
	let grafanaDatasource = $state('');
	/** In-cluster Grafana picked from Detect (#525). */
	let grafanaService = $state<GrafanaService | null>(null);

	let detected = $state<DetectedPrometheus[] | null>(null);
	let busy = $state<'detect' | 'test' | 'save' | null>(null);
	let result = $state<FormResult | null>(null);

	$effect(() => {
		const e = saved;
		void context;
		result = null;
		detected = null;
		// Nothing typed for the previous context may leak into this one.
		auth.reset();
		if (!e) {
			form.reset();
			cluster = '';
			grafanaUrl = '';
			grafanaDatasource = '';
			grafanaService = null;
			// Review in the integrations banner (#527): pre-filled, not saved.
			const suggested = context ? integrations.takePrometheus(context) : null;
			if (suggested) {
				form.load(suggested.target, false);
				grafanaService = suggested.grafanaService ?? null;
				result = { ok: true, text: SUGGESTED_TEXT };
			}
			return;
		}
		form.load(e.target, e.skipTlsVerify);
		cluster = e.cluster ?? '';
		grafanaUrl = e.grafanaUrl ?? '';
		grafanaDatasource = e.grafanaDatasource ?? '';
		grafanaService = e.grafanaService ?? null;
		void refreshStoredMethod(e);
	});


	async function refreshStoredMethod(e: PromEndpoint) {
		const ctx = context;
		if (!ctx) return;
		try {
			const method = await prometheusAuthMethod(ctx, e);
			if (ctx === app.activeCluster) auth.setStored(method);
		} catch {
			if (ctx === app.activeCluster) auth.stored = null;
		}
	}

	const grafanaError = $derived(form.mode === 'off' ? null : urlProblem(grafanaUrl));
	const azureHost = $derived.by(() => {
		try {
			const u = new URL(form.url.trim());
			return u.protocol === 'https:' && u.hostname.toLowerCase().endsWith('.prometheus.monitor.azure.com');
		} catch {
			return false;
		}
	});
	const azureError = $derived(
		auth.method === 'azure-cli' && form.mode === 'external' && !azureHost
			? 'Azure CLI sign-in works only with https://…prometheus.monitor.azure.com endpoints.'
			: null
	);
	const incomplete = $derived(form.incomplete || grafanaError !== null || azureError !== null);

	function draft(): PromEndpoint | null {
		const target = form.target();
		if (!target) return null;
		return {
			target,
			cluster: cluster.trim() || null,
			grafanaUrl: grafanaUrl.trim() || null,
			grafanaDatasource: grafanaDatasource.trim() || null,
			grafanaService: form.mode === 'in-cluster' ? grafanaService : null,
			skipTlsVerify: form.skipTlsVerify
		};
	}

	/** Auth typed in the form, or null to use the stored one. In-cluster
	 * endpoints always use the cluster credentials. */
	function typedAuth(): PromAuth | null {
		if (form.mode === 'in-cluster') return auth.stored === 'none' ? null : { method: 'none' };
		switch (auth.method) {
			case 'none':
				return auth.stored === 'none' ? null : { method: 'none' };
			case 'basic':
				return auth.username && auth.password
					? { method: 'basic', username: auth.username, password: auth.password }
					: null;
			case 'bearer':
				return auth.secret ? { method: 'bearer', token: auth.secret } : null;
			case 'azure-cli':
				return { method: 'azure-cli' };
		}
	}

	async function run(kind: NonNullable<typeof busy>, task: () => Promise<void>) {
		busy = kind;
		result = null;
		try {
			await task();
		} catch (e) {
			result = { ok: false, text: errorMessage(e) };
		} finally {
			busy = null;
		}
	}

	function detect() {
		const ctx = context;
		if (!ctx) return;
		void run('detect', async () => {
			detected = await prometheusDetect(app.kubeconfigPath, ctx);
		});
	}

	function test() {
		const endpoint = draft();
		const ctx = context;
		if (!ctx || !endpoint) return;
		void run('test', async () => {
			const info = await prometheusTest(app.kubeconfigPath, ctx, endpoint, typedAuth() ?? undefined);
			const parts = [`Prometheus ${info.version}`];
			parts.push(info.cadvisor ? 'cAdvisor ✓' : 'no cAdvisor series');
			parts.push(info.kubeStateMetrics ? 'kube-state-metrics ✓' : 'no kube-state-metrics series');
			if (info.clusters.length > 0) parts.push(`clusters: ${info.clusters.join(', ')}`);
			result = { ok: info.cadvisor, text: parts.join(' · ') };
		});
	}

	function save() {
		const ctx = context;
		if (!ctx) return;
		const endpoint = draft();
		void run('save', async () => {
			const refused = await saveCredentials({
				saved,
				endpoint,
				typed: typedAuth(),
				storedMethod: auth.stored,
				none: { method: 'none' } as PromAuth,
				save: (e, a) => prometheusSaveAuth(ctx, e, a)
			});
			if (refused) {
				result = refused;
				return;
			}
			auth.clearSecrets();
			prometheus.setEndpoint(ctx, endpoint);
			// A changed endpoint or Grafana service must not keep old forwards.
			await prometheusDisconnect(ctx);
			if (endpoint) await refreshStoredMethod(endpoint);
			toasts.push(endpoint ? `Prometheus saved for ${ctx}` : `Prometheus off for ${ctx}`, 'ok');
		});
	}

	const authOptions = [
		{ value: 'none', label: 'No authentication' },
		{ value: 'basic', label: 'User and password' },
		{ value: 'bearer', label: 'Bearer token' },
		{ value: 'azure-cli', label: 'Azure CLI (Azure Monitor)' }
	];
	const secretMethods = { bearer: { label: 'Bearer token', placeholder: 'token' } };
</script>

<section data-testid="prometheus-prefs">
	<div class="mb-1.5 flex items-baseline justify-between gap-3">
		<div class="type-body text-text-primary">Prometheus</div>
		<div class="type-caption truncate text-text-tertiary">
			{context ? `for ${context}` : 'no cluster selected'}
		</div>
	</div>
	{#if context}
		<div class="flex flex-col gap-2 rounded-md border border-border-faint bg-surface-window px-2.5 py-2">
			<TargetFields
				{form}
				sourceLabel="Metrics history source"
				urlLabel="Prometheus URL"
				urlPlaceholder="https://<workspace>.<region>.prometheus.monitor.azure.com"
				httpsLabel="HTTPS"
				detectHint="Finds Prometheus servers and Grafana in the cluster."
				detecting={busy === 'detect'}
				disabled={busy !== null}
				onDetect={detect}
			>
				{#snippet detected()}
					{@render detectedList()}
				{/snippet}
			</TargetFields>

			{#if form.mode !== 'off'}
				<input
					class={INPUT_CLASS}
					aria-label="Cluster label"
					placeholder="cluster label value (optional, for shared workspaces)"
					bind:value={cluster}
				/>
				<div class="grid grid-cols-[1fr_10rem] gap-2">
					<input class={INPUT_CLASS} aria-label="Grafana URL" placeholder="Grafana URL (optional)" bind:value={grafanaUrl} />
					<input class={INPUT_CLASS} aria-label="Grafana datasource" placeholder="datasource UID" bind:value={grafanaDatasource} />
				</div>
				{#if grafanaError}<p class="type-caption text-status-err">{grafanaError}</p>{/if}
				{#if form.mode === 'in-cluster' && grafanaService}
					<InClusterUi
						name="Grafana"
						service={grafanaService}
						urlSet={grafanaUrl.trim() !== ''}
						testid="grafana-service"
						onClear={() => (grafanaService = null)}
					/>
				{/if}

				{#if form.mode === 'in-cluster'}
					<p class="type-caption text-text-tertiary">Reached through the API server with your cluster credentials.</p>
				{:else}
					<AuthFields fields={auth} options={authOptions} {secretMethods}>
						{#snippet extra()}
							{#if auth.method === 'azure-cli'}
								<p class="type-caption {azureError ? 'text-status-err' : 'text-text-tertiary'}">
									{azureError ?? 'Uses the account `az` is logged in with; the token is kept in memory only.'}
								</p>
							{/if}
						{/snippet}
					</AuthFields>
				{/if}
			{/if}

			<FormActions
				active={form.mode !== 'off'}
				{busy}
				{incomplete}
				bind:skipTlsVerify={form.skipTlsVerify}
				current={saved ? describeTarget(saved.target) : null}
				{result}
				onTest={test}
				onSave={save}
			/>
		</div>
	{/if}
</section>

{#snippet detectedList()}
	<DetectedServices
		services={detected}
		empty="No Prometheus service found."
		onUse={(svc) => (svc.kind === 'grafana' ? (grafanaService = serviceRef(svc)) : form.pick(svc))}
	/>
{/snippet}
