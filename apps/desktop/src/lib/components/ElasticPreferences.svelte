<script lang="ts">
	import SegmentedControl from '#lib/components/ui/SegmentedControl.svelte';
	import { DEFAULT_INDEX_PATTERN, describeEndpoint, newEndpoint } from '#lib/elastic.ts';
	import { errorMessage } from '#lib/errors.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { elastic } from '#lib/stores/elastic.svelte.ts';
	import { toasts } from '#lib/stores/toasts.svelte.ts';
	import {
		elasticAuthMethod,
		elasticDetect,
		elasticSaveAuth,
		elasticTest,
		elasticUseEckCredentials,
		type DetectedService,
		type EsAuth,
		type EsAuthMethod,
		type EsEndpoint,
		type FieldPreset
	} from '#lib/tauri.ts';

	// Preferences → Integrations → Elasticsearch for the active context
	// (#501, spec §5.2). Secrets go straight to the OS keychain and are never
	// read back; the form only knows which method is stored.

	type Mode = 'off' | 'in-cluster' | 'external';

	const context = $derived(app.activeCluster);
	const saved = $derived(elastic.endpointFor(context));

	let mode = $state<Mode>('off');
	let namespace = $state('');
	let service = $state('');
	let port = $state(9200);
	let https = $state(true);
	let url = $state('');
	let indexPattern = $state(DEFAULT_INDEX_PATTERN);
	let preset = $state<FieldPreset>('ecs');
	let kibanaUrl = $state('');
	let skipTlsVerify = $state(false);

	let authMethod = $state<EsAuthMethod>('none');
	let username = $state('');
	let password = $state('');
	let secret = $state('');
	let storedMethod = $state<EsAuthMethod | null>(null);

	let detected = $state<DetectedService[] | null>(null);
	let busy = $state<'detect' | 'test' | 'save' | 'eck' | null>(null);
	let result = $state<{ ok: boolean; text: string } | null>(null);

	// Load the saved endpoint whenever the context changes.
	$effect(() => {
		const e = saved;
		void context;
		result = null;
		detected = null;
		password = '';
		secret = '';
		if (!e) {
			// Nothing from the previous context may leak into this one.
			mode = 'off';
			namespace = '';
			service = '';
			port = 9200;
			https = true;
			url = '';
			indexPattern = DEFAULT_INDEX_PATTERN;
			preset = 'ecs';
			kibanaUrl = '';
			skipTlsVerify = false;
			authMethod = 'none';
			username = '';
			storedMethod = null;
			return;
		}
		mode = e.target.kind;
		if (e.target.kind === 'in-cluster') {
			({ namespace, service, port, https } = e.target);
		} else {
			url = e.target.url;
		}
		indexPattern = e.indexPattern;
		preset = e.preset;
		kibanaUrl = e.kibanaUrl ?? '';
		skipTlsVerify = e.skipTlsVerify;
		void refreshStoredMethod(e);
	});

	async function refreshStoredMethod(e: EsEndpoint) {
		const ctx = context;
		if (!ctx) return;
		try {
			const method = await elasticAuthMethod(ctx, e);
			// A late answer for another context must not land here.
			if (ctx !== app.activeCluster) return;
			storedMethod = method;
			authMethod = method;
		} catch {
			if (ctx === app.activeCluster) storedMethod = null;
		}
	}

	/** Credentials embedded in a URL would bypass the keychain. */
	function urlProblem(value: string): string | null {
		const v = value.trim();
		if (!v) return null;
		try {
			const u = new URL(v);
			if (!['http:', 'https:'].includes(u.protocol)) return 'Use an http:// or https:// URL.';
			if (u.username || u.password) return 'Remove the credentials from the URL; use the authentication fields.';
			return null;
		} catch {
			return 'Not a valid URL.';
		}
	}

	const urlError = $derived(mode === 'external' ? urlProblem(url) : null);
	const kibanaError = $derived(mode !== 'off' ? urlProblem(kibanaUrl) : null);

	/** What stored credentials are bound to (mirrors the backend's binding). */
	function bindingOf(e: EsEndpoint): string {
		const t = e.target;
		let origin: string;
		if (t.kind === 'external') {
			try {
				origin = new URL(t.url).origin;
			} catch {
				origin = t.url;
			}
		} else {
			origin = `in-cluster:${t.namespace}/${t.service}:${t.port}:${t.https}`;
		}
		return `${origin}|${e.skipTlsVerify}`;
	}

	const modeSegments: { value: Mode; label: string }[] = [
		{ value: 'off', label: 'Off' },
		{ value: 'in-cluster', label: 'In cluster' },
		{ value: 'external', label: 'External' }
	];

	function draft(): EsEndpoint | null {
		if (mode === 'off') return null;
		const target: EsEndpoint['target'] =
			mode === 'in-cluster'
				? { kind: 'in-cluster', namespace: namespace.trim(), service: service.trim(), port, https }
				: { kind: 'external', url: url.trim() };
		return {
			...newEndpoint(target),
			indexPattern: indexPattern.trim() || DEFAULT_INDEX_PATTERN,
			preset,
			kibanaUrl: kibanaUrl.trim() || null,
			skipTlsVerify
		};
	}

	const incomplete = $derived.by(() => {
		if (urlError || kibanaError) return true;
		if (mode === 'in-cluster') return !namespace.trim() || !service.trim() || !port;
		if (mode === 'external') return !url.trim();
		return false;
	});

	/** Auth typed in the form, or null to use the stored one. */
	function typedAuth(): EsAuth | null {
		switch (authMethod) {
			case 'none':
				return storedMethod === 'none' ? null : { method: 'none' };
			case 'basic':
				return username && password ? { method: 'basic', username, password } : null;
			case 'api-key':
				return secret ? { method: 'api-key', key: secret } : null;
			case 'bearer':
				return secret ? { method: 'bearer', token: secret } : null;
			case 'eck-user':
				return null;
		}
	}

	function pick(svc: DetectedService) {
		namespace = svc.namespace;
		service = svc.name;
		port = svc.port;
		https = svc.https;
	}

	async function detect() {
		if (!context) return;
		busy = 'detect';
		try {
			detected = await elasticDetect(app.kubeconfigPath, context);
		} catch (e) {
			result = { ok: false, text: errorMessage(e) };
		} finally {
			busy = null;
		}
	}

	async function test() {
		const endpoint = draft();
		if (!context || !endpoint) return;
		busy = 'test';
		result = null;
		try {
			const info = await elasticTest(app.kubeconfigPath, context, endpoint, typedAuth() ?? undefined);
			const parts = [`Elasticsearch ${info.version}`, info.clusterName];
			if (info.health) parts.push(`health ${info.health}`);
			if (info.indices !== null) parts.push(`${info.indices} matching indices or data streams`);
			result = { ok: true, text: parts.filter(Boolean).join(' · ') };
		} catch (e) {
			result = { ok: false, text: errorMessage(e) };
		} finally {
			busy = null;
		}
	}

	async function save() {
		if (!context) return;
		const endpoint = draft();
		busy = 'save';
		result = null;
		try {
			if (endpoint) {
				const auth = typedAuth();
				const moved = saved !== null && bindingOf(saved) !== bindingOf(endpoint);
				if (authMethod === 'eck-user' && (storedMethod !== 'eck-user' || moved)) {
					storedMethod = await elasticUseEckCredentials(app.kubeconfigPath, context, endpoint);
				} else if (auth) {
					await elasticSaveAuth(context, endpoint, auth);
				} else if (moved && storedMethod && storedMethod !== 'none') {
					// Stored secrets only work with the endpoint they were saved for.
					result = {
						ok: false,
						text: 'The endpoint or TLS setting changed: enter the credentials again (or choose No authentication).'
					};
					return;
				}
				password = '';
				secret = '';
			} else if (saved) {
				// Turning it off also removes the stored secret and open connection.
				await elasticSaveAuth(context, saved, { method: 'none' });
			}
			elastic.setEndpoint(context, endpoint);
			if (endpoint) await refreshStoredMethod(endpoint);
			toasts.push(endpoint ? `Elasticsearch saved for ${context}` : `Elasticsearch off for ${context}`, 'ok');
		} catch (e) {
			result = { ok: false, text: errorMessage(e) };
		} finally {
			busy = null;
		}
	}

	async function useEck() {
		const endpoint = draft();
		if (!context || !endpoint) return;
		busy = 'eck';
		try {
			storedMethod = await elasticUseEckCredentials(app.kubeconfigPath, context, endpoint);
			authMethod = storedMethod;
			result = {
				ok: true,
				text: 'ECK elastic user found (read from the cluster on each connection). Save to use this endpoint.'
			};
		} catch (e) {
			result = { ok: false, text: errorMessage(e) };
		} finally {
			busy = null;
		}
	}

	const input =
		'focus-ring h-7 w-full rounded-md border border-border-default bg-surface-window px-2.5 type-caption text-text-primary placeholder:text-text-disabled';
	const button =
		'focus-ring type-caption rounded-md border border-border-default bg-surface-raised px-2.5 py-1 text-text-secondary hover:brightness-110 disabled:opacity-50';
</script>

<section data-testid="elastic-prefs">
	<div class="mb-1.5 flex items-baseline justify-between gap-3">
		<div class="type-body text-text-primary">Elasticsearch</div>
		<div class="type-caption truncate text-text-tertiary">
			{context ? `for ${context}` : 'no cluster selected'}
		</div>
	</div>
	{#if context}
		<div class="flex flex-col gap-2 rounded-md border border-border-faint bg-surface-window px-2.5 py-2">
			<div class="flex items-center justify-between gap-3">
				<span class="type-caption text-text-secondary">Log history source</span>
				<SegmentedControl segments={modeSegments} bind:value={mode} />
			</div>

			{#if mode === 'in-cluster'}
				<div class="flex items-center gap-2">
					<button type="button" class={button} disabled={busy !== null} onclick={() => void detect()}>
						{busy === 'detect' ? 'Detecting…' : 'Detect'}
					</button>
					<span class="type-caption text-text-tertiary">Finds Elasticsearch and Kibana services in the cluster.</span>
				</div>
				{#if detected}
					{#if detected.length === 0}
						<p class="type-caption text-text-tertiary">No Elasticsearch or Kibana service found.</p>
					{:else}
						<ul class="flex flex-col gap-0.5" aria-label="Detected services">
							{#each detected as svc (svc.namespace + '/' + svc.name)}
								<li class="flex items-center gap-2">
									<span class="type-data-sm flex-1 truncate text-text-secondary">
										{svc.kind} · {svc.namespace}/{svc.name}:{svc.port}{svc.https ? ' (https)' : ''}
									</span>
									{#if svc.kind === 'elasticsearch'}
										<button
											type="button"
											class="focus-ring type-caption rounded-sm text-accent hover:brightness-110"
											onclick={() => pick(svc)}>Use</button
										>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				{/if}
				<div class="grid grid-cols-[1fr_1.4fr_5rem] gap-2">
					<input class={input} aria-label="Namespace" placeholder="namespace" bind:value={namespace} />
					<input class={input} aria-label="Service" placeholder="service" bind:value={service} />
					<input class={input} aria-label="Port" type="number" min="1" max="65535" bind:value={port} />
				</div>
				<label class="type-caption flex items-center gap-2 text-text-secondary">
					<input type="checkbox" bind:checked={https} /> HTTPS (ECK default)
				</label>
			{:else if mode === 'external'}
				<input class={input} aria-label="Elasticsearch URL" placeholder="https://my-deployment.es.example.com:9243" bind:value={url} />
				{#if urlError}<p class="type-caption text-status-err">{urlError}</p>{/if}
			{/if}

			{#if mode !== 'off'}
				<div class="grid grid-cols-[1fr_9rem] gap-2">
					<input class={input} aria-label="Index pattern" placeholder={DEFAULT_INDEX_PATTERN} bind:value={indexPattern} />
					<select class={input} aria-label="Log shipper" bind:value={preset}>
						<option value="ecs" title="Elastic Agent, Filebeat: kubernetes.pod.name, message">ECS fields</option>
						<option value="fluent-bit" title="Fluent Bit, Fluentd: kubernetes.pod_name, log">Fluent Bit fields</option>
					</select>
				</div>
				<input class={input} aria-label="Kibana URL" placeholder="Kibana URL (optional), e.g. https://kibana.example.com" bind:value={kibanaUrl} />
				{#if kibanaError}<p class="type-caption text-status-err">{kibanaError}</p>{/if}

				<div class="flex items-center gap-2">
					<select class="{input} w-40" aria-label="Authentication" bind:value={authMethod}>
						<option value="none">No authentication</option>
						<option value="basic">User and password</option>
						<option value="api-key">API key</option>
						<option value="bearer">Bearer token</option>
						{#if mode === 'in-cluster'}<option value="eck-user">ECK elastic user</option>{/if}
					</select>
					{#if storedMethod && storedMethod !== 'none'}
						<span class="type-caption text-text-tertiary">saved in the keychain: {storedMethod}</span>
					{/if}
				</div>
				{#if authMethod === 'basic'}
					<div class="grid grid-cols-2 gap-2">
						<input class={input} aria-label="Username" placeholder="username" autocomplete="off" bind:value={username} />
						<input class={input} aria-label="Password" type="password" placeholder={storedMethod === 'basic' ? '•••••• (saved)' : 'password'} autocomplete="off" bind:value={password} />
					</div>
				{:else if authMethod === 'api-key' || authMethod === 'bearer'}
					<input
						class={input}
						aria-label={authMethod === 'api-key' ? 'API key' : 'Bearer token'}
						type="password"
						autocomplete="off"
						placeholder={storedMethod === authMethod ? '•••••• (saved)' : authMethod === 'api-key' ? 'encoded API key (id:key, base64)' : 'token'}
						bind:value={secret}
					/>
				{:else if authMethod === 'eck-user'}
					<div class="flex items-center gap-2">
						<button type="button" class={button} disabled={busy !== null || incomplete} onclick={() => void useEck()}>
							{busy === 'eck' ? 'Checking…' : 'Use ECK credentials'}
						</button>
						<span class="type-caption text-text-tertiary">Read from the cluster on each connection, never stored.</span>
					</div>
				{/if}
				<label class="type-caption flex items-center gap-2 text-text-secondary">
					<input type="checkbox" bind:checked={skipTlsVerify} /> Skip TLS verification (self-signed, no CA)
				</label>
			{/if}

			<div class="flex items-center gap-2">
				{#if mode !== 'off'}
					<button type="button" class={button} disabled={busy !== null || incomplete} onclick={() => void test()}>
						{busy === 'test' ? 'Testing…' : 'Test connection'}
					</button>
				{/if}
				<button type="button" class={button} disabled={busy !== null || incomplete} onclick={() => void save()}>
					{busy === 'save' ? 'Saving…' : 'Save'}
				</button>
				{#if saved}
					<span class="type-caption truncate text-text-tertiary" title={describeEndpoint(saved)}>
						current: {describeEndpoint(saved)}
					</span>
				{/if}
			</div>
			{#if result}
				<p class="type-caption {result.ok ? 'text-status-ok' : 'text-status-err'}" role={result.ok ? 'status' : 'alert'}>
					{result.text}
				</p>
			{/if}
		</div>
	{/if}
</section>
