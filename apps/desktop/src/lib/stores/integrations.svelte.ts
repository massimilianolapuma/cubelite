/**
 * Integrations found when a context connects, and the banner offering them
 * (#527, spec docs/superpowers/specs/2026-11-03-integrations-one-click-design.md).
 *
 * Detection lists the services once per connect, in the background, and
 * fails silently. Nothing reaches Elasticsearch or Prometheus, and no
 * secret is read, until the user clicks Enable. Enable is offered only when
 * each integration has exactly one operator-managed service (anyone may
 * create a look-alike Service in their namespace); otherwise Review.
 */
import { errorMessage } from "#lib/errors.ts";
import {
  INTEGRATION_KINDS,
  NOTHING_DETECTED,
  enabledText,
  failureText,
  isEck,
  isOneClick,
  noCadvisorText,
  suggestedElastic,
  suggestedPrometheus,
  type IntegrationKind,
} from "#lib/integration-suggest.ts";
import {
  elasticSaveAuth,
  elasticTest,
  elasticUseEckCredentials,
  integrationsDetect,
  prometheusSaveAuth,
  prometheusTest,
  type DetectedIntegrations,
  type DetectedPrometheus,
  type DetectedService,
  type EsEndpoint,
  type PromEndpoint,
} from "#lib/tauri.ts";
import { app, type PreferencesSection } from "./app.svelte";
import { elastic } from "./elastic.svelte";
import { prometheus } from "./prometheus.svelte";
import { settings } from "./settings.svelte";
import { toasts } from "./toasts.svelte";

/** What Review hands to Preferences: pre-filled, not saved, with every candidate. */
export type Suggestion = {
  context: string;
  elastic: EsEndpoint | null;
  eck: boolean;
  prometheus: PromEndpoint | null;
  found: DetectedIntegrations;
};

/** The active context's banner. */
export type Banner = {
  context: string;
  found: DetectedIntegrations;
  kinds: IntegrationKind[];
  /** Every offered integration has one operator-managed service: Enable is shown. */
  canEnable: boolean;
  failure: string | null;
};

class IntegrationsStore {
  /** Detection result per context (this session only). */
  detected = $state<Record<string, DetectedIntegrations>>({});
  /** Context an Enable is running for. */
  enabling = $state<string | null>(null);
  /** Why the last Enable failed, per context (nothing was saved). */
  failure = $state<Record<string, string>>({});
  /** Set by Review, taken once by the preferences forms. */
  #suggestion: Suggestion | null = null;

  /** Lists the context's services once (after a connect); errors are silent. */
  async detect(context: string): Promise<void> {
    let found: DetectedIntegrations;
    try {
      found = (await integrationsDetect(app.kubeconfigPath, context)) ?? NOTHING_DETECTED;
    } catch {
      return;
    }
    this.detected = { ...this.detected, [context]: found };
    this.#setFailure(context, null);
  }

  #configured(kind: IntegrationKind, context: string): boolean {
    // A context using the default endpoint (#528) is configured; one where
    // the default is off was turned off on purpose.
    const store = kind === "elasticsearch" ? elastic : prometheus;
    return store.endpointFor(context) !== null || store.useOf(context) === "off";
  }

  dismissed(context: string | null): IntegrationKind[] {
    return context ? (settings.integrationDismissals.value[context] ?? []) : [];
  }

  /**
   * Integrations the banner offers for `context`: found, not configured,
   * not dismissed, and hints on.
   */
  offered(context: string | null): IntegrationKind[] {
    const found = context ? this.detected[context] : undefined;
    if (!context || !found || !settings.integrationHints.value) return [];
    const dismissed = this.dismissed(context);
    return INTEGRATION_KINDS.filter((k) => found[k] !== null && !this.#configured(k, context) && !dismissed.includes(k));
  }

  /** Whether Enable may save everything offered without a review. */
  canEnable(context: string): boolean {
    const found = this.detected[context];
    const kinds = this.offered(context);
    return !!found && kinds.length > 0 && kinds.every((k) => isOneClick(found, k));
  }

  /** The active context's banner: what it offers and a failed Enable's reason. */
  get banner(): Banner | null {
    const context = app.activeCluster;
    if (!context) return null;
    const kinds = this.offered(context);
    const failure = settings.integrationHints.value ? (this.failure[context] ?? null) : null;
    if (kinds.length === 0 && !failure) return null;
    const found = this.detected[context] ?? NOTHING_DETECTED;
    return { context, found, kinds, canEnable: this.canEnable(context), failure };
  }

  #setFailure(context: string, text: string | null): void {
    const next = { ...this.failure };
    if (text) next[context] = text;
    else delete next[context];
    this.failure = next;
  }

  /** ✕: hides what the banner offers for `context` until Preferences resets it. */
  dismiss(context: string): void {
    this.#addDismissals(context, this.offered(context));
    this.#setFailure(context, null);
  }

  /** Turned off in Preferences: not offered again for `context` until reset. */
  dismissKind(context: string, kind: IntegrationKind): void {
    this.#addDismissals(context, [kind]);
  }

  #addDismissals(context: string, kinds: IntegrationKind[]): void {
    const current = this.dismissed(context);
    const next = [...current, ...kinds.filter((k) => !current.includes(k))];
    settings.integrationDismissals.value = { ...settings.integrationDismissals.value, [context]: next };
  }

  /** Preferences → suggest the dismissed integrations again. */
  resetDismissals(context: string): void {
    const next = { ...settings.integrationDismissals.value };
    delete next[context];
    settings.integrationDismissals.value = next;
  }

  /** Review: opens Preferences on the integration, pre-filled but not saved. */
  review(context: string): void {
    const found = this.detected[context] ?? NOTHING_DETECTED;
    const kinds = this.offered(context);
    this.#suggestion = {
      context,
      elastic: kinds.includes("elasticsearch") ? suggestedElastic(found) : null,
      eck: isEck(found.elasticsearch),
      prometheus: kinds.includes("prometheus") ? suggestedPrometheus(found) : null,
      found,
    };
    this.#setFailure(context, null);
    const section: PreferencesSection = kinds[0] ?? "integrations";
    app.openPreferences(section);
  }

  /** Review's Elasticsearch suggestion and candidates for `context`, taken once by Preferences. */
  takeElastic(context: string): { endpoint: EsEndpoint; eck: boolean; candidates: DetectedService[] } | null {
    const s = this.#suggestion;
    if (s?.context !== context || !s.elastic) return null;
    this.#suggestion = { ...s, elastic: null };
    return { endpoint: s.elastic, eck: s.eck, candidates: s.found.elasticServices };
  }

  /** Review's Prometheus suggestion and candidates for `context`, taken once by Preferences. */
  takePrometheus(context: string): { endpoint: PromEndpoint; candidates: DetectedPrometheus[] } | null {
    const s = this.#suggestion;
    if (s?.context !== context || !s.prometheus) return null;
    this.#suggestion = { ...s, prometheus: null };
    return { endpoint: s.prometheus, candidates: s.found.prometheusServices };
  }

  /**
   * Enable: tests each offered integration with the one-click defaults and
   * saves only what answered. ECK's secret is read here, never before.
   * Refused unless every offered integration is operator-managed and unique.
   */
  async enable(context: string): Promise<void> {
    const found = this.detected[context];
    if (!found || this.enabling || !this.canEnable(context)) return;
    this.enabling = context;
    this.#setFailure(context, null);
    try {
      for (const kind of this.offered(context)) {
        const eck = kind === "elasticsearch" && isEck(found.elasticsearch);
        try {
          if (kind === "elasticsearch") {
            await enableElastic(context, found, eck);
            toasts.push(enabledText(kind, context), "ok");
          } else if (await enablePrometheus(context, found)) {
            toasts.push(enabledText(kind, context), "ok");
          } else {
            toasts.push(noCadvisorText(context), "warn");
          }
        } catch (e) {
          // Nothing was saved for it; the banner says why.
          this.#setFailure(context, failureText(kind, errorMessage(e), eck));
        }
      }
    } finally {
      this.enabling = null;
    }
  }
}

async function enableElastic(context: string, found: DetectedIntegrations, eck: boolean): Promise<void> {
  const endpoint = suggestedElastic(found);
  if (!endpoint) return;
  await elasticTest(app.kubeconfigPath, context, endpoint, { method: eck ? "eck-user" : "none" });
  // The same paths as Preferences → Save (stored choice, closed connections).
  if (eck) await elasticUseEckCredentials(app.kubeconfigPath, context, endpoint);
  else await elasticSaveAuth(context, endpoint, { method: "none" });
  elastic.setEndpoint(context, endpoint);
}

/** Saves Prometheus once it answered; whether it has cAdvisor series. */
async function enablePrometheus(context: string, found: DetectedIntegrations): Promise<boolean> {
  const endpoint = suggestedPrometheus(found);
  if (!endpoint) return false;
  const info = await prometheusTest(app.kubeconfigPath, context, endpoint, { method: "none" });
  await prometheusSaveAuth(context, endpoint, { method: "none" });
  prometheus.setEndpoint(context, endpoint);
  return info.cadvisor;
}

export const integrations = new IntegrationsStore();
