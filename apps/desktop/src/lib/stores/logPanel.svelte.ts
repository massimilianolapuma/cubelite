/**
 * Shell-level owner of the log panel: open sessions, active tab, panel
 * chrome (height/collapse) and render toggles, persisted via `persisted()`.
 * PR feat/desktop-logpanel-core keeps a single session; the tab strip PR
 * lifts that restriction.
 */
import { persisted } from "./settings.svelte";
import { LogSession } from "./logSession.svelte";

export const PANEL_MIN = 160;
export const PANEL_MAX = 560;
export const PANEL_DEFAULT = 280;
export const PANEL_COLLAPSED = 34;

const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStringRecord = (v: unknown): v is Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v) &&
  Object.values(v).every((x) => typeof x === "string");

class LogPanelStore {
  sessions = $state<LogSession[]>([]);
  activeKey = $state<string | null>(null);

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

  async openFor(pod: { namespace: string; name: string }): Promise<void> {
    const key = `${pod.namespace}/${pod.name}`;
    const existing = this.sessions.find((s) => s.key === key);
    if (existing) {
      this.activeKey = key;
      return;
    }
    // Single-session PR: replace whatever is open.
    for (const s of [...this.sessions]) await this.closeSession(s.key);
    const session = new LogSession(pod.namespace, pod.name, this.#containers.value[key] ?? null);
    this.sessions = [...this.sessions, session];
    this.activeKey = key;
    await session.open();
  }

  async closeSession(key: string): Promise<void> {
    const session = this.sessions.find((s) => s.key === key);
    if (!session) return;
    await session.close();
    this.sessions = this.sessions.filter((s) => s.key !== key);
    if (this.activeKey === key) this.activeKey = this.sessions.at(-1)?.key ?? null;
  }
}

export const logPanel = new LogPanelStore();
