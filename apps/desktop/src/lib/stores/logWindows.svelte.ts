/**
 * Main-window registry of popped-out log windows (#298): spawns them,
 * runs the one-shot seed handoff, receives re-attach transfers, and
 * broadcasts close-all (cluster switch / app quit). Import is
 * side-effect-free — `init()` is called once from the main window's page.
 * Never imported by pop-out window code paths.
 */
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { logPanel } from "./logPanel.svelte";
import { isSessionTransfer, serializeSession } from "./sessionTransfer";

export function windowLabelFor(key: string): string {
  return `logs-${key.replaceAll("/", "-")}`;
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
  }

  /** Serialize → spawn → await ready → seed → close the local session. */
  async detach(key: string): Promise<void> {
    const session = logPanel.sessions.find((s) => s.key === key);
    if (!session) return;
    const transfer = serializeSession(session);
    const label = windowLabelFor(key);
    const ready = new Promise<void>((resolve) => {
      void listen(`log-window-ready:${key}`, () => resolve());
    });
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
    this.#open.set(key, label);
    await ready;
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
