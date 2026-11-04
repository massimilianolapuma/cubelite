<script lang="ts">
	import { untrack } from 'svelte';
	import AuthFields from '#lib/components/integrations/AuthFields.svelte';
	import ClusterLabelField from '#lib/components/integrations/ClusterLabelField.svelte';
	import DetectedServices from '#lib/components/integrations/DetectedServices.svelte';
	import EndpointScopeBar from '#lib/components/integrations/EndpointScopeBar.svelte';
	import FormActions from '#lib/components/integrations/FormActions.svelte';
	import InClusterUi from '#lib/components/integrations/InClusterUi.svelte';
	import TargetFields from '#lib/components/integrations/TargetFields.svelte';
	import { DEFAULT_MODE_SEGMENTS, matchClusterLabel } from '#lib/endpoint-scope.ts';
	import { errorMessage } from '#lib/errors.ts';
	import {
		INPUT_CLASS,
		MODE_SEGMENTS,
		SecretFields,
		TargetForm,
		describeTarget,
		saveCredentials,
		serviceRef,
		urlProblem,
		type FormResult
	} from '#lib/integration-form.svelte.ts';
	import { EndpointScope } from '#lib/integration-scope.svelte.ts';
	import { SUGGESTED_TEXT } from '#lib/integration-suggest.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { clusters } from '#lib/stores/clusters.svelte.ts';
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
	// spec §5.3), or the default endpoint shared by every context (#528).
	// In-cluster Prometheus is reached with the cluster credentials; external
	// endpoints take basic, bearer or an Azure CLI token. Secrets go to the
	// OS keychain and are never read back.

	const NONE: PromAuth = { method: 'none' };

	const context = $derived(app.activeCluster);
	const scope = new EndpointScope({
		store: prometheus,
		name: 'Prometheus',
		kind: 'prometheus',
		removeSecret: (ctx, own) => prometheusSaveAuth(ctx, own, NONE),
		disconnect: (ctx) => prometheusDisconnect(ctx)
	});
	const view = $derived(scope.view(context));
	const saved = $derived(scope.saved(view, context));
	const fallback = $derived(prometheus.defaultEndpoint);

	const form = new TargetForm(9090, false);
	const auth = new SecretFields<PromAuthMethod>();
	let cluster = $state('');
	let grafanaUrl = $state('');
	let grafanaDatasource = $state('');
	/** In-cluster Grafana picked from Detect (#525). */
	let grafanaService = $state<GrafanaService | null>(null);
	/** `cluster` values found by the last Test connection (#528). */
	let found = $state<string[] | null>(null);

	let detected = $state<DetectedPrometheus[] | null>(null);
	let busy = $state<'detect' | 'test' | 'save' | 'scope' | null>(null);
	let result = $state<FormResult | null>(null);

	// Another context starts on its own endpoint, not an Override in progress.
	$effect(() => {
		void context;
		scope.overriding = false;
	});

	$effect(() => {
		const e = saved;
		const v = view;
		const ctx = context;
		result = null;
		detected = null;
		found = null;
		// Nothing typed for the previous context may leak into this one.
		auth.reset();
		if (v === 'inherited') {
			cluster = untrack(() => (ctx && prometheus.contextSettings(ctx)?.cluster) || '');
			return;
		}
		if (e) {
			loadFields(e);
			void refreshStoredMethod(scope.forBackend(v, e));
			return;
		}
		form.reset();
		cluster = '';
		grafanaUrl = '';
		grafanaDatasource = '';
		grafanaService = null;
		// Override starts from the default's values.
		const prefill = v === 'own' && untrack(() => scope.overriding) ? untrack(() => fallback) : null;
		if (prefill) {
			loadFields(prefill);
			return;
		}
		// Review in the integrations banner (#527): pre-filled, not saved.
		const suggested = v === 'own' && ctx ? integrations.takePrometheus(ctx) : null;
		if (suggested) {
			form.load(suggested.endpoint.target, false);
			grafanaService = suggested.endpoint.grafanaService ?? null;
			// Every candidate, so another one can be picked.
			detected = suggested.candidates;
			result = { ok: true, text: SUGGESTED_TEXT };
		}
	});

	function loadFields(e: PromEndpoint) {
		form.load(e.target, e.skipTlsVerify);
		cluster = e.cluster ?? '';
		grafanaUrl = e.grafanaUrl ?? '';
		grafanaDatasource = e.grafanaDatasource ?? '';
		grafanaService = e.grafanaService ?? null;
	}

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
	const usedBy = $derived(prometheus.usersOfDefault(clusters.contexts.map((c) => c.name)));

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

	/** The endpoint Test connection reaches: the default with this context's label, or the form's. */
	function tested(): PromEndpoint | null {
		if (view === 'inherited') return prometheus.defaultFor({ cluster: cluster.trim() || null });
		const endpoint = draft();
		return endpoint && scope.forBackend(view, endpoint);
	}

	/** Auth typed in the form, or null to use the stored one. In-cluster
	 * endpoints always use the cluster credentials. */
	function typedAuth(): PromAuth | null {
		if (view === 'inherited') return null;
		if (form.mode === 'in-cluster') return auth.stored === 'none' ? null : NONE;
		switch (auth.method) {
			case 'none':
				return auth.stored === 'none' ? null : NONE;
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
		const endpoint = tested();
		const ctx = context;
		if (!ctx || !endpoint) return;
		void run('test', async () => {
			const info = await prometheusTest(app.kubeconfigPath, ctx, endpoint, typedAuth() ?? undefined);
			const parts = [`Prometheus ${info.version}`];
			parts.push(info.cadvisor ? 'cAdvisor ✓' : 'no cAdvisor series');
			parts.push(info.kubeStateMetrics ? 'kube-state-metrics ✓' : 'no kube-state-metrics series');
			if (info.clusters.length > 0) parts.push(`clusters: ${info.clusters.join(', ')}`);
			found = info.clusters;
			// Preselect this context's cluster in a shared workspace (#528).
			if (view !== 'default' && !cluster.trim()) cluster = matchClusterLabel(info.clusters, ctx) ?? '';
			result = { ok: info.cadvisor, text: parts.join(' · ') };
		});
	}

	function save() {
		const ctx = context;
		if (!ctx) return;
		if (view === 'inherited') {
			prometheus.setContextSettings(ctx, cluster.trim() ? { cluster: cluster.trim() } : null);
			toasts.push(`Prometheus cluster label saved for ${ctx}`, 'ok');
			return;
		}
		const v = view;
		const endpoint = draft();
		void run('save', async () => {
			const refused = await saveCredentials({
				saved: saved && scope.forBackend(v, saved),
				endpoint: endpoint && scope.forBackend(v, endpoint),
				typed: typedAuth(),
				storedMethod: auth.stored,
				none: NONE,
				save: (e, a) => prometheusSaveAuth(ctx, e, a)
			});
			if (refused) {
				result = refused;
				return;
			}
			auth.clearSecrets();
			if (v === 'default') {
				prometheus.setDefault(endpoint);
				scope.savedDefault(endpoint);
			} else {
				prometheus.setEndpoint(ctx, endpoint);
				scope.savedOwn(ctx, endpoint);
				// Turned off on purpose: the detection banner must not offer it again.
				if (!endpoint) integrations.dismissKind(ctx, 'prometheus');
				toasts.push(endpoint ? `Prometheus saved for ${ctx}` : `Prometheus off for ${ctx}`, 'ok');
			}
			// A changed endpoint or Grafana service must not keep old forwards.
			await prometheusDisconnect(ctx);
			if (endpoint) await refreshStoredMethod(scope.forBackend(v, endpoint));
		});
	}

	function scoped(action: (ctx: string) => Promise<void>) {
		const ctx = context;
		if (ctx) void run('scope', () => action(ctx));
	}

	const authOptions = [
		{ value: 'none', label: 'No authentication' },
		{ value: 'basic', label: 'User and password' },
		{ value: 'bearer', label: 'Bearer token' },
		{ value: 'azure-cli', label: 'Azure CLI (Azure Monitor)' }
	];
	const secretMethods = { bearer: { label: 'Bearer token', placeholder: 'token' } };

	/** Placeholder of a context's label on the default: the default's own value. */
	function clusterHint(fallback: string | null | undefined): string {
		return fallback ? `cluster label value (default: ${fallback})` : 'cluster label value for this context';
	}
</script>

<section data-testid="prometheus-prefs">
	<div class="mb-1.5 flex items-baseline justify-between gap-3">
		<div class="type-body text-text-primary">Prometheus</div>
		<div class="type-caption truncate text-text-tertiary">
			{view === 'default' ? 'for every context' : context ? `for ${context}` : 'no cluster selected'}
		</div>
	</div>
	{#if context}
		<div class="flex flex-col gap-2 rounded-md border border-border-faint bg-surface-window px-2.5 py-2">
			<EndpointScopeBar
				bind:scope={scope.scope}
				{view}
				defaultTarget={fallback ? describeTarget(fallback.target) : null}
				{usedBy}
				hasOwn={prometheus.ownEndpoint(context) !== null || scope.overriding}
				disabled={busy !== null}
				onOverride={() => (scope.overriding = true)}
				onTurnOff={() => scoped((ctx) => scope.turnOff(ctx))}
				onUseDefault={() => scoped((ctx) => scope.useDefault(ctx))}
			/>

			{#if view === 'inherited'}
				<ClusterLabelField bind:value={cluster} {found} placeholder={clusterHint(fallback?.cluster)} />
				<FormActions
					active={true}
					tls={false}
					{busy}
					incomplete={false}
					skipTlsVerify={false}
					current={null}
					{result}
					onTest={test}
					onSave={save}
				/>
			{:else if view !== 'off'}
				<TargetFields
					{form}
					segments={view === 'default' ? DEFAULT_MODE_SEGMENTS : MODE_SEGMENTS}
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
					<ClusterLabelField
						bind:value={cluster}
						{found}
						placeholder={view === 'default'
							? 'cluster label value (fallback for contexts without their own)'
							: 'cluster label value (optional, for shared workspaces)'}
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
			{/if}
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
