/**
 * Elasticsearch history of one log session (#501): pages of a pod's logs,
 * newest first from the backend, kept oldest-first here so the panel
 * renders them like a live buffer; "Load older" prepends.
 */
import { elasticSearch, type HistoryLine, type HistoryPage } from "#lib/tauri.ts";
import { errorMessage } from "#lib/errors.ts";
import type { HistoryRange } from "#lib/elastic.ts";
import type { KeyedLogLine } from "./logs.svelte";
import { app } from "./app.svelte";
import { elastic } from "./elastic.svelte";

/** History line ids live far above live ring ids so `expanded` never collides. */
const ID_BASE = 1_000_000_000_000;

/** Upper bound of lines kept (twenty pages of 500). */
export const HISTORY_CAP = 10_000;

export class LogHistory {
  lines = $state<KeyedLogLine[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);
  total = $state<number | null>(null);
  totalIsLowerBound = $state(false);
  /** `search_after` for older lines; null at the end. */
  next = $state<unknown[] | null>(null);
  range = $state<HistoryRange>("now-1h");
  text = $state("");
  /** True once a first page was requested. */
  started = $state(false);

  readonly namespace: string;
  readonly pod: string;
  #container: () => string | null;
  #nextId = ID_BASE;
  #generation = 0;

  constructor(namespace: string, pod: string, container: () => string | null) {
    this.namespace = namespace;
    this.pod = pod;
    this.#container = container;
  }

  get canLoadOlder(): boolean {
    return this.next !== null && !this.loading && this.lines.length < HISTORY_CAP;
  }

  #toLine(h: HistoryLine): KeyedLogLine {
    return {
      id: this.#nextId++,
      pod: this.pod,
      namespace: this.namespace,
      time: h.time,
      level: h.level,
      message: h.message,
      container: h.container ?? undefined,
      document: h.document,
    };
  }

  async #fetch(searchAfter: unknown[] | null): Promise<HistoryPage | null> {
    const context = app.activeCluster;
    const endpoint = elastic.endpointFor(context);
    if (!context || !endpoint) {
      this.error = "No Elasticsearch endpoint for this cluster — set one in Preferences → Integrations.";
      return null;
    }
    return elasticSearch(app.kubeconfigPath, context, endpoint, {
      namespace: this.namespace,
      pod: this.pod,
      container: this.#container(),
      from: this.range,
      to: "now",
      text: this.text.trim() || null,
      searchAfter,
      size: null,
    });
  }

  /** First page for the current range/text/container (replaces the lines). */
  async reload(): Promise<void> {
    const generation = ++this.#generation;
    this.started = true;
    this.loading = true;
    this.error = null;
    try {
      const page = await this.#fetch(null);
      if (generation !== this.#generation) return;
      if (!page) {
        this.lines = [];
        this.next = null;
        this.total = null;
        return;
      }
      this.lines = page.lines.map((h) => this.#toLine(h)).reverse();
      this.total = page.total;
      this.totalIsLowerBound = page.totalIsLowerBound;
      this.next = page.next;
    } catch (e) {
      if (generation === this.#generation) this.error = errorMessage(e);
    } finally {
      if (generation === this.#generation) this.loading = false;
    }
  }

  /** Prepends the next older page. */
  async loadOlder(): Promise<void> {
    if (!this.canLoadOlder) return;
    const generation = this.#generation;
    this.loading = true;
    this.error = null;
    try {
      const page = await this.#fetch(this.next);
      if (generation !== this.#generation || !page) return;
      const older = page.lines.map((h) => this.#toLine(h)).reverse();
      this.lines = [...older, ...this.lines].slice(-HISTORY_CAP);
      this.next = page.next;
    } catch (e) {
      if (generation === this.#generation) this.error = errorMessage(e);
    } finally {
      if (generation === this.#generation) this.loading = false;
    }
  }
}
