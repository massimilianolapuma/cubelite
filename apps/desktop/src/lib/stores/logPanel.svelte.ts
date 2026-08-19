/**
 * Shell-level owner of the log panel: open sessions (tab strip, capped at
 * `SESSION_CAP`, LRU-evicted via `#focusOrder`), active tab, panel chrome
 * (height/collapse) and render toggles, persisted via `persisted()`.
 * Also owns the single `LogSearch` instance: re-attached (and recomputed)
 * against the newly-active session's buffer on every `focus()`, so the
 * query text survives tab switches; cleared only when `openFor` creates a
 * brand-new session.
 */
import { persisted } from "./settings.svelte";
import { LogSession } from "./logSession.svelte";
import { LogSearch } from "./logSearch.svelte";
import type { KeyedLogLine } from "./logs.svelte";
import type { SessionTransfer } from "./sessionTransfer";

export const PANEL_MIN = 160;
export const PANEL_MAX = 560;
export const PANEL_DEFAULT = 280;
export const PANEL_COLLAPSED = 34;
const SESSION_CAP = 6;

const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStringRecord = (v: unknown): v is Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v) &&
  Object.values(v).every((x) => typeof x === "string");

class LogPanelStore {
  sessions = $state<LogSession[]>([]);
  activeKey = $state<string | null>(null);
  search = new LogSearch();

  #searchFocus: (() => void) | null = null;
  /** LRU order of session keys, oldest-focused first. */
  #focusOrder: string[] = [];
  #height = persisted<number>("logPanel.height", PANEL_DEFAULT, isNumber);
  #collapsed = persisted<boolean>("logPanel.collapsed", false, isBoolean);
  #timestamps = persisted<boolean>("logPanel.timestamps", true, isBoolean);
  #wrap = persisted<boolean>("logPanel.wrap", false, isBoolean);
  /** `namespace/pod` → last chosen container. */
  #containers = persisted<Record<string, string>>("logPanel.containers", {}, isStringRecord);

  get active(): LogSession | null {
    return this.sessions.find((s) => s.key === this.activeKey) ?? null;
  }

  get open(): boolean {
    return this.sessions.length > 0;
  }

  get height(): number {
    return Math.min(PANEL_MAX, Math.max(PANEL_MIN, this.#height.value));
  }
  set height(v: number) {
    this.#height.value = Math.min(PANEL_MAX, Math.max(PANEL_MIN, v));
  }

  get collapsed(): boolean {
    return this.#collapsed.value;
  }
  toggleCollapsed(): void {
    this.#collapsed.value = !this.#collapsed.value;
  }

  get timestamps(): boolean {
    return this.#timestamps.value;
  }
  set timestamps(v: boolean) {
    this.#timestamps.value = v;
  }

  get wrap(): boolean {
    return this.#wrap.value;
  }
  set wrap(v: boolean) {
    this.#wrap.value = v;
  }

  rememberContainer(key: string, container: string): void {
    this.#containers.value = { ...this.#containers.value, [key]: container };
  }

  /** `[time] LEVEL message` per line, one per newline; time omitted when the
   * timestamps toggle is off (export flows). */
  serialize(lines: KeyedLogLine[]): string {
    return lines
      .map((l) => {
        const ts = this.timestamps && l.time ? `${l.time} ` : "";
        return `${ts}${l.level.toUpperCase()} ${l.message}`;
      })
      .join("\n");
  }

  registerSearchFocus(fn: (() => void) | null): void {
    this.#searchFocus = fn;
  }

  focusSearch(): void {
    this.#searchFocus?.();
  }

  /** Sets the active tab, bumps LRU recency and re-attaches `search` to the
   * newly-focused session's buffer so the query text survives the switch. */
  focus(key: string): void {
    const session = this.sessions.find((s) => s.key === key);
    if (!session) return;
    this.activeKey = key;
    this.#focusOrder = [...this.#focusOrder.filter((k) => k !== key), key];
    this.search.attach(() => session.ring.lines);
    this.search.recompute(session.ring.lines);
  }

  async openFor(pod: { namespace: string; name: string }): Promise<void> {
    const key = `${pod.namespace}/${pod.name}`;
    const existing = this.sessions.find((s) => s.key === key);
    if (existing) {
      this.focus(key);
      return;
    }
    while (this.sessions.length >= SESSION_CAP) {
      const lruKey = this.#focusOrder[0];
      if (lruKey === undefined) break;
      await this.closeSession(lruKey);
    }
    const session = new LogSession(pod.namespace, pod.name, this.#containers.value[key] ?? null);
    this.sessions = [...this.sessions, session];
    this.activeKey = key;
    this.#focusOrder = [...this.#focusOrder.filter((k) => k !== key), key];
    this.search.clear();
    this.search.attach(() => session.ring.lines);
    await session.open();
  }

  /** Recreates a transferred session (#298): pop-out bootstrap in the log
   * window, re-attach in the main window. Same LRU eviction as `openFor`. */
  async openSeeded(transfer: SessionTransfer): Promise<void> {
    const existing = this.sessions.find((s) => s.key === transfer.key);
    if (existing) {
      this.focus(transfer.key);
      return;
    }
    while (this.sessions.length >= SESSION_CAP) {
      const lruKey = this.#focusOrder[0];
      if (lruKey === undefined) break;
      await this.closeSession(lruKey);
    }
    const session = new LogSession(transfer.namespace, transfer.pod, transfer.container, {
      lines: transfer.lines,
      previous: transfer.previous,
      tailLines: transfer.tailLines,
      following: transfer.following,
    });
    this.sessions = [...this.sessions, session];
    this.activeKey = transfer.key;
    this.#focusOrder = [...this.#focusOrder.filter((k) => k !== transfer.key), transfer.key];
    this.search.clear();
    this.search.attach(() => session.ring.lines);
    await session.open();
  }

  async closeSession(key: string): Promise<void> {
    const session = this.sessions.find((s) => s.key === key);
    if (!session) return;
    await session.close();
    this.sessions = this.sessions.filter((s) => s.key !== key);
    this.#focusOrder = this.#focusOrder.filter((k) => k !== key);
    if (this.activeKey === key) {
      const fallbackKey = this.sessions.at(-1)?.key ?? null;
      if (fallbackKey) {
        // Route through focus() so LRU order bumps and `search` re-attaches
        // to the fallback session's live buffer instead of the dead one.
        this.focus(fallbackKey);
      } else {
        this.activeKey = null;
        this.search.clear();
        this.search.attach(() => []);
      }
    }
  }

  /** Closes every session (cluster switch — sessions target pods of the old
   * cluster, same story as port-forward's `stopAll`). */
  async closeAll(): Promise<void> {
    const sessions = this.sessions;
    this.sessions = [];
    this.activeKey = null;
    this.#focusOrder = [];
    this.search.clear();
    this.search.attach(() => []);
    await Promise.allSettled(sessions.map((s) => s.close()));
  }
}

export const logPanel = new LogPanelStore();
