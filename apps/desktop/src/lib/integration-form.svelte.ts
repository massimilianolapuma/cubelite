/**
 * Form state shared by the integration preferences (Elasticsearch #501,
 * Prometheus #510): where the endpoint lives and the typed credentials.
 * Secrets are typed here and sent to the keychain; they are never read back.
 */
import type { IntegrationTarget } from "#lib/tauri.ts";
import { urlProblem, type TargetMode } from "./integration.ts";

export * from "./integration.ts";

/** Where the endpoint lives: off, a service in the cluster, or a URL. */
export class TargetForm {
  mode = $state<TargetMode>("off");
  namespace = $state("");
  service = $state("");
  port = $state(0);
  https = $state(false);
  url = $state("");
  skipTlsVerify = $state(false);

  readonly #defaultPort: number;
  readonly #defaultHttps: boolean;

  constructor(defaultPort: number, defaultHttps: boolean) {
    this.#defaultPort = defaultPort;
    this.#defaultHttps = defaultHttps;
    this.reset();
  }

  /** Back to "off" with defaults: nothing from another context may leak. */
  reset(): void {
    this.mode = "off";
    this.namespace = "";
    this.service = "";
    this.port = this.#defaultPort;
    this.https = this.#defaultHttps;
    this.url = "";
    this.skipTlsVerify = false;
  }

  load(target: IntegrationTarget, skipTlsVerify: boolean): void {
    this.mode = target.kind;
    if (target.kind === "in-cluster") {
      ({ namespace: this.namespace, service: this.service, port: this.port, https: this.https } = target);
    } else {
      this.url = target.url;
    }
    this.skipTlsVerify = skipTlsVerify;
  }

  pick(svc: { namespace: string; name: string; port: number; https: boolean }): void {
    this.namespace = svc.namespace;
    this.service = svc.name;
    this.port = svc.port;
    this.https = svc.https;
  }

  /** The target typed in the form; null when off. */
  target(): IntegrationTarget | null {
    if (this.mode === "off") return null;
    return this.mode === "in-cluster"
      ? {
          kind: "in-cluster",
          namespace: this.namespace.trim(),
          service: this.service.trim(),
          port: this.port,
          https: this.https,
        }
      : { kind: "external", url: this.url.trim() };
  }

  get urlError(): string | null {
    return this.mode === "external" ? urlProblem(this.url) : null;
  }

  get incomplete(): boolean {
    if (this.urlError) return true;
    if (this.mode === "in-cluster") return !this.namespace.trim() || !this.service.trim() || !this.port;
    if (this.mode === "external") return !this.url.trim();
    return false;
  }
}

/** Typed credentials: what the user entered, never what is stored. */
export class SecretFields<M extends string> {
  method = $state<M>("none" as M);
  username = $state("");
  password = $state("");
  secret = $state("");
  /** Method stored in the keychain for the saved endpoint; null = unknown. */
  stored = $state<M | null>(null);

  clearSecrets(): void {
    this.password = "";
    this.secret = "";
  }

  reset(): void {
    this.method = "none" as M;
    this.username = "";
    this.stored = null;
    this.clearSecrets();
  }

  /** The stored method became known: show it as the selection. */
  setStored(method: M | null): void {
    this.stored = method;
    if (method) this.method = method;
  }
}

