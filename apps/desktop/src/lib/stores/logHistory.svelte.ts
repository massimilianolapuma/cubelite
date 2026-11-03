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
import { HistoryKeys, type HistoryRange } from "#lib/elastic.ts";
import type { KeyedLogLine } from "./logs.svelte";
import { app } from "./app.svelte";
import { elastic } from "./elastic.svelte";

/** History line ids live far above live ring ids so `expanded` never collides. */
export const HISTORY_ID_BASE = 1_000_000_000_000;

/** Upper bound of lines kept (twenty pages of 500). */
export const HISTORY_CAP = 10_000;

/** The cluster and endpoint a page came from. */
type Source = { kubeconfigPath: string; context: string; endpoint: EsEndpoint };

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
  /** Where `next` came from: it is released there. */
  #source: Source | null = null;
  /** `_index`/`_id` of the lines shown: a resumed page may repeat some (#531). */
  #seen = new HistoryKeys();

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
    this.#seen.add(h);
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
  ): Promise<{ page: HistoryPage; source: Source } | null> {
    const context = app.activeCluster;
    const endpoint = elastic.endpointFor(context);
    if (!context || !endpoint) {
      this.error = "No Elasticsearch endpoint for this cluster — set one in Preferences → Integrations.";
      return null;
    }
    const source = { kubeconfigPath: app.kubeconfigPath, context, endpoint };
    const page = await elasticSearch(source.kubeconfigPath, context, endpoint, {
      namespace: this.namespace,
      pod: this.pod,
      container: params.container,
      from: params.range,
      to: "now",
      text: params.text,
      searchAfter,
      size: null,
    });
    return { page, source };
  }

  /**
   * Releases the point in time a cursor may hold, on the cluster the cursor
   * came from (best effort, never awaited by the UI: it expires on its own
   * if this fails).
   */
  async #release(cursor: HistoryCursor | null, source: Source | null): Promise<void> {
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
    void this.#release(this.next, this.#source);
    this.next = null;
  }

  /** First page for the current range/text/container (replaces the lines). */
  async reload(): Promise<void> {
    const generation = ++this.#generation;
    // The previous search is replaced: its cursor is never used again.
    void this.#release(this.next, this.#source);
    this.next = null;
    const params = { range: this.range, text: this.text.trim() || null, container: this.#container() };
    this.#params = params;
    this.started = true;
    this.loading = true;
    this.error = null;
    try {
      const fetched = await this.#fetch(params, null);
      if (generation !== this.#generation) {
        void this.#release(fetched?.page.next ?? null, fetched?.source ?? null);
        return;
      }
      if (!fetched) {
        this.lines = [];
        this.next = null;
        this.total = null;
        return;
      }
      const { page, source } = fetched;
      this.#onReplace();
      this.#seen = new HistoryKeys();
      this.lines = page.lines.map((h) => this.#toLine(h)).reverse();
      this.total = page.total;
      this.totalIsLowerBound = page.totalIsLowerBound;
      this.next = page.next;
      this.#source = source;
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
      const fetched = await this.#fetch(this.#params, this.next);
      if (!fetched) return;
      const { page, source } = fetched;
      if (generation !== this.#generation) {
        void this.#release(page.next, source);
        return;
      }
      // A page resumed on a new point in time may repeat the boundary lines.
      const fresh = page.lines.filter((h) => !this.#seen.has(h));
      const room = HISTORY_CAP - this.lines.length;
      // Newest-first page: keep its newest `room` lines; past the cap there
      // is nothing older to fetch.
      const kept = fresh.slice(0, room);
      const older = kept.map((h) => this.#toLine(h)).reverse();
      this.lines = [...older, ...this.lines];
      this.#source = source;
      if (kept.length < fresh.length) {
        void this.#release(page.next, source);
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
