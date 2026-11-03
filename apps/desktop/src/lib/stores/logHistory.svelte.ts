/**
 * Elasticsearch history of one log session (#501): pages of a pod's logs,
 * newest first from the backend, kept oldest-first here so the panel
 * renders them like a live buffer; "Load older" prepends.
 *
 * The paging cursor is opaque (#531): it may hold an Elasticsearch point in
 * time, released when the search is replaced, capped or closed.
 */
import {
  elasticCloseCursor,
  elasticSearch,
  type EsEndpoint,
  type HistoryCursor,
  type HistoryLine,
  type HistoryPage,
} from "#lib/tauri.ts";
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
  /** Opaque cursor for older lines; null at the end. */
  next = $state<HistoryCursor | null>(null);
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
  /** Where the last page came from: cursors are released there. */
  #source: { kubeconfigPath: string; context: string; endpoint: EsEndpoint } | null = null;

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
    searchAfter: HistoryCursor | null,
  ): Promise<HistoryPage | null> {
    const context = app.activeCluster;
    const endpoint = elastic.endpointFor(context);
    if (!context || !endpoint) {
      this.error = "No Elasticsearch endpoint for this cluster — set one in Preferences → Integrations.";
      return null;
    }
    this.#source = { kubeconfigPath: app.kubeconfigPath, context, endpoint };
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

  /**
   * Releases the point in time a cursor may hold (best effort, never awaited
   * by the UI: it expires on its own if this fails).
   */
  async #release(cursor: HistoryCursor | null): Promise<void> {
    const source = this.#source;
    if (!cursor || !source) return;
    try {
      await elasticCloseCursor(source.kubeconfigPath, source.context, source.endpoint, cursor);
    } catch {
      // Best effort: the point in time expires on its own.
    }
  }

  /** The session closed: release the cursor of the shown search. */
  close(): void {
    this.#generation++;
    void this.#release(this.next);
    this.next = null;
  }

  /** First page for the current range/text/container (replaces the lines). */
  async reload(): Promise<void> {
    const generation = ++this.#generation;
    // The previous search is replaced: its cursor is never used again.
    void this.#release(this.next);
    this.next = null;
    const params = { range: this.range, text: this.text.trim() || null, container: this.#container() };
    this.#params = params;
    this.started = true;
    this.loading = true;
    this.error = null;
    try {
      const page = await this.#fetch(params, null);
      if (generation !== this.#generation) {
        void this.#release(page?.next ?? null);
        return;
      }
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
      if (!page) return;
      if (generation !== this.#generation) {
        void this.#release(page.next);
        return;
      }
      const room = HISTORY_CAP - this.lines.length;
      // Newest-first page: keep its newest `room` lines; past the cap there
      // is nothing older to fetch.
      const kept = page.lines.slice(0, room);
      const older = kept.map((h) => this.#toLine(h)).reverse();
      this.lines = [...older, ...this.lines];
      if (kept.length < page.lines.length) {
        void this.#release(page.next);
        this.next = null;
      } else {
        this.next = page.next;
      }
    } catch (e) {
      if (generation === this.#generation) this.error = errorMessage(e);
    } finally {
      if (generation === this.#generation) this.loading = false;
    }
  }
}
