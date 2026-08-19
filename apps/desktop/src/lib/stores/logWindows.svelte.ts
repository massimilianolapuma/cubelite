/**
 * Main-window registry of popped-out log windows (#298): spawns them,
 * runs the one-shot seed handoff, receives re-attach transfers, and
 * broadcasts close-all (cluster switch / app quit). The import itself is
 * side-effect-free and safe to load from any window — LogToolbar statically
 * imports this module (it renders in both the main and pop-out windows,
 * via LogWindowShell), even though it only invokes `detach()` when not in
 * detached mode; only `init()` — called once from the main window's page —
 * registers the main-window-only listeners and hooks.
 */
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { logPanel } from "./logPanel.svelte";
import { isSessionTransfer, serializeSession } from "./sessionTransfer";

/**
 * Pop-out window label for a pod's log session key (`namespace/pod`).
 *
 * Provably injective: this is a plain string concatenation with a fixed
 * `"logs-"` prefix and no character rewriting, so distinct keys always
 * produce distinct labels — unlike the previous `replaceAll("/", "-")`
 * version, which collided e.g. `"a/b-c"` and `"a-b/c"` into the same label.
 * It's also label-safe: Tauri window labels allow alphanumeric characters
 * plus `-`, `/`, `:` and `_`, and Kubernetes namespace/pod names are
 * DNS-1123 labels (lowercase alphanumeric and `-` only), so the key's `/`
 * separator and the literal prefix are both legal as-is — no escaping
 * needed.
 */
export function windowLabelFor(key: string): string {
  return `logs-${key}`;
}

class LogWindowsStore {
  /** key → window label of the live pop-out. */
  #open = new Map<string, string>();

  has(key: string): boolean {
    return this.#open.has(key);
  }

  /** Main-window bootstrap: receive re-attach transfers from pop-outs. */
  async init(): Promise<void> {
    await listen<unknown>("log-window-reattach", (event) => {
      if (!isSessionTransfer(event.payload)) return;
      const transfer = event.payload;
      this.#open.delete(transfer.key);
      void logPanel.openSeeded(transfer);
    });
    logPanel.detachedRouter = { has: (k) => this.has(k), focus: (k) => this.focus(k) };
    logPanel.onCloseAll = () => this.closeAll();
  }

  /** Serialize → spawn → await ready → seed → close the local session.
   *
   * A failed `WebviewWindow` creation (label already taken, etc.) does not
   * throw here — it surfaces asynchronously as a `tauri://error` event, so
   * `ready` would otherwise never resolve, the ready listener would leak,
   * and the stale registry entry would route the pod to a dead window
   * forever. We race `ready` against an `errored` signal; on error we clean
   * up the registry/listener and return without seeding or closing the
   * panel session, leaving it open in the panel as the user-visible
   * fallback. */
  async detach(key: string): Promise<void> {
    const session = logPanel.sessions.find((s) => s.key === key);
    if (!session) return;
    const transfer = serializeSession(session);
    const label = windowLabelFor(key);
    let resolveReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    let resolveErrored: () => void = () => {};
    const errored = new Promise<void>((resolve) => {
      resolveErrored = resolve;
    });
    // Register listener BEFORE spawning window to avoid race condition
    const unlistenReady = await listen(`log-window-ready:${key}`, () => resolveReady());
    const win = new WebviewWindow(label, {
      url: `index.html?logWindow=${encodeURIComponent(key)}`,
      title: `${transfer.pod} — logs`,
      width: 900,
      height: 500,
    });
    // Registry hygiene: drop the entry when the OS window goes away by any
    // path (re-attach destroy, close-all destroy).
    void win.once("tauri://destroyed", () => {
      if (this.#open.get(key) === label) this.#open.delete(key);
    });
    void win.once("tauri://error", () => {
      if (this.#open.get(key) === label) this.#open.delete(key);
      resolveErrored();
    });
    this.#open.set(key, label);
    const failed = await Promise.race([ready.then(() => false), errored.then(() => true)]);
    unlistenReady();
    if (failed) return;
    await emitTo(label, `log-window-seed:${key}`, transfer);
    await logPanel.closeSession(key);
  }

  async focus(key: string): Promise<void> {
    const win = await WebviewWindow.getByLabel(windowLabelFor(key));
    await win?.setFocus();
  }

  /** Cluster switch / app quit: windows close without re-attaching. */
  async closeAll(): Promise<void> {
    await emit("log-window-close-all");
    this.#open.clear();
  }
}

export const logWindows = new LogWindowsStore();
