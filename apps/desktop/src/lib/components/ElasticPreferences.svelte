<script lang="ts">
	import { untrack } from 'svelte';
	import AuthFields from '#lib/components/integrations/AuthFields.svelte';
	import ClusterFilterFields from '#lib/components/integrations/ClusterFilterFields.svelte';
	import DetectedServices from '#lib/components/integrations/DetectedServices.svelte';
	import EndpointScopeBar from '#lib/components/integrations/EndpointScopeBar.svelte';
	import FormActions from '#lib/components/integrations/FormActions.svelte';
	import InClusterUi from '#lib/components/integrations/InClusterUi.svelte';
	import TargetFields from '#lib/components/integrations/TargetFields.svelte';
	import { DEFAULT_INDEX_PATTERN, clusterFieldHint, clusterFilterOf, newEndpoint } from '#lib/elastic.ts';
	import { DEFAULT_MODE_SEGMENTS } from '#lib/endpoint-scope.ts';
	import { errorMessage } from '#lib/errors.ts';
	import {
		BUTTON_CLASS,
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
	import { elastic } from '#lib/stores/elastic.svelte.ts';
	import { integrations } from '#lib/stores/integrations.svelte.ts';
	import { toasts } from '#lib/stores/toasts.svelte.ts';
	import {
		elasticAuthMethod,
		elasticDetect,
		elasticDisconnect,
		elasticSaveAuth,
		elasticTest,
		elasticUseEckCredentials,
		type DetectedService,
		type EsAuth,
		type EsAuthMethod,
		type EsEndpoint,
		type FieldPreset,
		type KibanaService
	} from '#lib/tauri.ts';

	// Preferences → Integrations → Elasticsearch for the active context
	// (#501, spec §5.2), or the default endpoint shared by every context
	// (#528). Secrets go straight to the OS keychain and are never read
	// back; the form only knows which method is stored.

	const NONE: EsAuth = { method: 'none' };

	const context = $derived(app.activeCluster);
	const scope = new EndpointScope({
		store: elastic,
		name: 'Elasticsearch',
		kind: 'elasticsearch',
		removeSecret: (ctx, own) => elasticSaveAuth(ctx, own, NONE),
		disconnect: (ctx) => elasticDisconnect(ctx)
	});
	const view = $derived(scope.view(context));
	const saved = $derived(scope.saved(view, context));
	const fallback = $derived(elastic.defaultEndpoint);

	const form = new TargetForm(9200, true);
	const auth = new SecretFields<EsAuthMethod>();
	let indexPattern = $state(DEFAULT_INDEX_PATTERN);
	let preset = $state<FieldPreset>('ecs');
	let kibanaUrl = $state('');
	/** In-cluster Kibana picked from Detect (#505). */
	let kibanaService = $state<KibanaService | null>(null);
	/** Cluster filter (#528). */
	let clusterField = $state('');
	let clusterValue = $state('');

	let detected = $state<DetectedService[] | null>(null);
	let busy = $state<'detect' | 'test' | 'save' | 'eck' | 'scope' | null>(null);
	let result = $state<FormResult | null>(null);

	// Another context starts on its own endpoint, not an Override in progress.
	$effect(() => {
		void context;
		scope.overriding = false;
	});

	// Load the saved endpoint whenever the context or the edited scope changes.
	$effect(() => {
		const e = saved;
		const v = view;
		const ctx = context;
		result = null;
		detected = null;
		// Nothing typed for the previous context may leak into this one.
		auth.reset();
		if (v === 'inherited') {
			const own = untrack(() => (ctx ? elastic.contextSettings(ctx)?.clusterFilter : null));
			clusterField = own?.field ?? '';
			clusterValue = own?.value ?? '';
			return;
		}
		if (e) {
			loadFields(e);
			void refreshStoredMethod(scope.forBackend(v, e));
			return;
		}
		form.reset();
		indexPattern = DEFAULT_INDEX_PATTERN;
		preset = 'ecs';
		kibanaUrl = '';
		kibanaService = null;
		clusterField = '';
		clusterValue = '';
		// Override starts from the default's values.
		const prefill = v === 'own' && untrack(() => scope.overriding) ? untrack(() => fallback) : null;
		if (prefill) {
			loadFields(prefill);
			return;
		}
		// Review in the integrations banner (#527): pre-filled, not saved.
		const suggested = v === 'own' && ctx ? integrations.takeElastic(ctx) : null;
		if (suggested) {
			form.load(suggested.endpoint.target, false);
			kibanaService = suggested.endpoint.kibanaService ?? null;
			if (suggested.eck) auth.method = 'eck-user';
			// Every candidate, so another one can be picked.
			detected = suggested.candidates;
			result = { ok: true, text: SUGGESTED_TEXT };
		}
	});

	function loadFields(e: EsEndpoint) {
		form.load(e.target, e.skipTlsVerify);
		indexPattern = e.indexPattern;
		preset = e.preset;
		kibanaUrl = e.kibanaUrl ?? '';
		kibanaService = e.kibanaService ?? null;
		clusterField = e.clusterFilter?.field ?? '';
		clusterValue = e.clusterFilter?.value ?? '';
	}

	async function refreshStoredMethod(e: EsEndpoint) {
		const ctx = context;
		if (!ctx) return;
		try {
			const method = await elasticAuthMethod(ctx, e);
			// A late answer for another context must not land here.
			if (ctx === app.activeCluster) auth.setStored(method);
		} catch {
			if (ctx === app.activeCluster) auth.stored = null;
		}
	}

	const kibanaError = $derived(form.mode === 'off' ? null : urlProblem(kibanaUrl));
	const incomplete = $derived(form.incomplete || kibanaError !== null);
	const usedBy = $derived(elastic.usersOfDefault(clusters.contexts.map((c) => c.name)));
	const fieldHint = $derived(
		view === 'inherited'
			? clusterFieldHint(fallback?.preset ?? 'ecs', fallback?.clusterFilter?.field)
			: clusterFieldHint(preset, null)
	);

	function draft(): EsEndpoint | null {
		const target = form.target();
		if (!target) return null;
		const clusterFilter = clusterFilterOf(clusterField, clusterValue);
		return {
			...newEndpoint(target),
			indexPattern: indexPattern.trim() || DEFAULT_INDEX_PATTERN,
			preset,
			kibanaUrl: kibanaUrl.trim() || null,
			kibanaService: form.mode === 'in-cluster' ? kibanaService : null,
			skipTlsVerify: form.skipTlsVerify,
			...(clusterFilter ? { clusterFilter } : {})
		};
	}

	/** Auth typed in the form, or null to use the stored one. */
	function typedAuth(): EsAuth | null {
		if (view === 'inherited') return null;
		switch (auth.method) {
			case 'none':
				return auth.stored === 'none' ? null : NONE;
			case 'basic':
				return auth.username && auth.password
					? { method: 'basic', username: auth.username, password: auth.password }
					: null;
			case 'api-key':
				return auth.secret ? { method: 'api-key', key: auth.secret } : null;
			case 'bearer':
				return auth.secret ? { method: 'bearer', token: auth.secret } : null;
			case 'eck-user':
				return null;
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
			detected = await elasticDetect(app.kubeconfigPath, ctx);
		});
	}

	function test() {
		const ctx = context;
		const draftEndpoint = view === 'inherited' ? null : draft();
		const endpoint =
			view === 'inherited'
				? elastic.defaultFor({ clusterFilter: clusterFilterOf(clusterField, clusterValue) })
				: draftEndpoint && scope.forBackend(view, draftEndpoint);
		if (!ctx || !endpoint) return;
		void run('test', async () => {
			const info = await elasticTest(app.kubeconfigPath, ctx, endpoint, typedAuth() ?? undefined);
			const parts = [`Elasticsearch ${info.version}`, info.clusterName];
			if (info.health) parts.push(`health ${info.health}`);
			if (info.indices !== null) parts.push(`${info.indices} matching indices or data streams`);
			result = { ok: true, text: parts.filter(Boolean).join(' · ') };
		});
	}

	function save() {
		const ctx = context;
		if (!ctx) return;
		if (view === 'inherited') {
			const clusterFilter = clusterFilterOf(clusterField, clusterValue);
			elastic.setContextSettings(ctx, clusterFilter ? { clusterFilter } : null);
			toasts.push(`Elasticsearch cluster filter saved for ${ctx}`, 'ok');
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
				save: (e, a) => elasticSaveAuth(ctx, e, a),
				special: async (e, moved) => {
					if (auth.method !== 'eck-user' || (auth.stored === 'eck-user' && !moved)) return false;
					auth.stored = await elasticUseEckCredentials(app.kubeconfigPath, ctx, e);
					return true;
				}
			});
			if (refused) {
				result = refused;
				return;
			}
			auth.clearSecrets();
			if (v === 'default') {
				elastic.setDefault(endpoint);
				scope.savedDefault(endpoint);
			} else {
				elastic.setEndpoint(ctx, endpoint);
				scope.savedOwn(ctx, endpoint);
				// Turned off on purpose: the detection banner must not offer it again.
				if (!endpoint) integrations.dismissKind(ctx, 'elasticsearch');
				toasts.push(endpoint ? `Elasticsearch saved for ${ctx}` : `Elasticsearch off for ${ctx}`, 'ok');
			}
			// A changed endpoint or Kibana service must not keep old forwards.
			await elasticDisconnect(ctx);
			if (endpoint) await refreshStoredMethod(scope.forBackend(v, endpoint));
		});
	}

	function scoped(action: (ctx: string) => Promise<void>) {
		const ctx = context;
		if (ctx) void run('scope', () => action(ctx));
	}

	function useEck() {
		const endpoint = draft();
		const ctx = context;
		if (!ctx || !endpoint) return;
		void run('eck', async () => {
			auth.setStored(await elasticUseEckCredentials(app.kubeconfigPath, ctx, endpoint));
			result = {
				ok: true,
				text: 'ECK elastic user found (read from the cluster on each connection). Save to use this endpoint.'
			};
		});
	}

	const authOptions = $derived([
		{ value: 'none', label: 'No authentication' },
		{ value: 'basic', label: 'User and password' },
		{ value: 'api-key', label: 'API key' },
		{ value: 'bearer', label: 'Bearer token' },
		...(form.mode === 'in-cluster' ? [{ value: 'eck-user', label: 'ECK elastic user' }] : [])
	]);
	const secretMethods = {
		'api-key': { label: 'API key', placeholder: 'encoded API key (id:key, base64)' },
		bearer: { label: 'Bearer token', placeholder: 'token' }
	};
</script>

<section data-testid="elastic-prefs">
	<div class="mb-1.5 flex items-baseline justify-between gap-3">
		<div class="type-body text-text-primary">Elasticsearch</div>
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
				hasOwn={elastic.ownEndpoint(context) !== null || scope.overriding}
				disabled={busy !== null}
				onOverride={() => (scope.overriding = true)}
				onTurnOff={() => scoped((ctx) => scope.turnOff(ctx))}
				onUseDefault={() => scoped((ctx) => scope.useDefault(ctx))}
			/>

			{#if view === 'inherited'}
				<ClusterFilterFields bind:field={clusterField} bind:value={clusterValue} {fieldHint} />
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
					sourceLabel="Log history source"
					urlLabel="Elasticsearch URL"
					urlPlaceholder="https://my-deployment.es.example.com:9243"
					httpsLabel="HTTPS (ECK default)"
					detectHint="Finds Elasticsearch and Kibana services in the cluster."
					detecting={busy === 'detect'}
					disabled={busy !== null}
					onDetect={detect}
				>
					{#snippet detected()}
						{@render detectedList()}
					{/snippet}
				</TargetFields>

				{#if form.mode !== 'off'}
					<div class="grid grid-cols-[1fr_9rem] gap-2">
						<input class={INPUT_CLASS} aria-label="Index pattern" placeholder={DEFAULT_INDEX_PATTERN} bind:value={indexPattern} />
						<select class={INPUT_CLASS} aria-label="Log shipper" bind:value={preset}>
							<option value="ecs" title="Elastic Agent, Filebeat: kubernetes.pod.name, message">ECS fields</option>
							<option value="fluent-bit" title="Fluent Bit, Fluentd: kubernetes.pod_name, log">Fluent Bit fields</option>
						</select>
					</div>
					<ClusterFilterFields bind:field={clusterField} bind:value={clusterValue} {fieldHint} />
					<input class={INPUT_CLASS} aria-label="Kibana URL" placeholder="Kibana URL (optional), e.g. https://kibana.example.com" bind:value={kibanaUrl} />
					{#if kibanaError}<p class="type-caption text-status-err">{kibanaError}</p>{/if}
					{#if form.mode === 'in-cluster' && kibanaService}
						<InClusterUi
							name="Kibana"
							service={kibanaService}
							urlSet={kibanaUrl.trim() !== ''}
							testid="kibana-service"
							onClear={() => (kibanaService = null)}
						/>
					{/if}

					<AuthFields fields={auth} options={authOptions} {secretMethods}>
						{#snippet extra()}
							{#if auth.method === 'eck-user'}
								<div class="flex items-center gap-2">
									<button type="button" class={BUTTON_CLASS} disabled={busy !== null || incomplete} onclick={useEck}>
										{busy === 'eck' ? 'Checking…' : 'Use ECK credentials'}
									</button>
									<span class="type-caption text-text-tertiary">Read from the cluster on each connection, never stored.</span>
								</div>
							{/if}
						{/snippet}
					</AuthFields>
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
		empty="No Elasticsearch or Kibana service found."
		onUse={(svc) => (svc.kind === 'elasticsearch' ? form.pick(svc) : (kibanaService = serviceRef(svc)))}
	/>
{/snippet}
