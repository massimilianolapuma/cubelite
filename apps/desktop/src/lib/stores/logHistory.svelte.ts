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
export const HISTORY_ID_BASE = 1_000_000_000_000;

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
  /** Bumped when a (re)load lands, so the view can jump to the newest line. */
  loads = $state(0);

  readonly namespace: string;
  readonly pod: string;
  #container: () => string | null;
  #onReplace: () => void;
  #nextId = HISTORY_ID_BASE;
  #generation = 0;
  /** Range, text and container of the last reload: `next` belongs to them. */
  #params: { range: HistoryRange; text: string | null; container: string | null } | null = null;

  constructor(
    namespace: string,
    pod: string,
    container: () => string | null,
    onReplace: () => void = () => {},
  ) {
    this.namespace = namespace;
    this.pod = pod;
    this.#container = container;
    this.#onReplace = onReplace;
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

  async #fetch(
    params: { range: HistoryRange; text: string | null; container: string | null },
    searchAfter: unknown[] | null,
  ): Promise<HistoryPage | null> {
    const context = app.activeCluster;
    const endpoint = elastic.endpointFor(context);
    if (!context || !endpoint) {
      this.error = "No Elasticsearch endpoint for this cluster — set one in Preferences → Integrations.";
      return null;
    }
    return elasticSearch(app.kubeconfigPath, context, endpoint, {
      namespace: this.namespace,
      pod: this.pod,
      container: params.container,
      from: params.range,
      to: "now",
      text: params.text,
      searchAfter,
      size: null,
    });
  }

  /** First page for the current range/text/container (replaces the lines). */
  async reload(): Promise<void> {
    const generation = ++this.#generation;
    const params = { range: this.range, text: this.text.trim() || null, container: this.#container() };
    this.#params = params;
    this.started = true;
    this.loading = true;
    this.error = null;
    try {
      const page = await this.#fetch(params, null);
      if (generation !== this.#generation) return;
      if (!page) {
        this.lines = [];
        this.next = null;
        this.total = null;
        return;
      }
      this.#onReplace();
      this.lines = page.lines.map((h) => this.#toLine(h)).reverse();
      this.total = page.total;
      this.totalIsLowerBound = page.totalIsLowerBound;
      this.next = page.next;
      this.loads++;
    } catch (e) {
      if (generation === this.#generation) this.error = errorMessage(e);
    } finally {
      if (generation === this.#generation) this.loading = false;
    }
  }

  /** Prepends the next older page. */
  async loadOlder(): Promise<void> {
    if (!this.canLoadOlder || !this.#params) return;
    const generation = this.#generation;
    this.loading = true;
    this.error = null;
    try {
      // Same range/text/container as the page the cursor came from, even if
      // the inputs were edited since without pressing Enter.
      const page = await this.#fetch(this.#params, this.next);
      if (generation !== this.#generation || !page) return;
      const room = HISTORY_CAP - this.lines.length;
      // Newest-first page: keep its newest `room` lines; past the cap there
      // is nothing older to fetch.
      const kept = page.lines.slice(0, room);
      const older = kept.map((h) => this.#toLine(h)).reverse();
      this.lines = [...older, ...this.lines];
      this.next = kept.length < page.lines.length ? null : page.next;
    } catch (e) {
      if (generation === this.#generation) this.error = errorMessage(e);
    } finally {
      if (generation === this.#generation) this.loading = false;
    }
  }
}
