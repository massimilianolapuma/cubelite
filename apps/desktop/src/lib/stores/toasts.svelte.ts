/**
 * Toast queue — bottom-right, auto-dismiss 3.2s, dot colored by outcome.
 */

export type ToastTone = "ok" | "warn" | "err";

/** A way out offered by a toast; pressing it runs it and dismisses the toast. */
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
  action?: ToastAction;
}

const DISMISS_MS = 3200;
/** A toast with an action stays longer: there is something to reach and press. */
const DISMISS_WITH_ACTION_MS = 8000;
const MAX_TOASTS = 4;

let nextId = 1;

class ToastStore {
  items = $state<Toast[]>([]);

  push(message: string, tone: ToastTone = "ok", action?: ToastAction): number {
    const id = nextId++;
    const toast: Toast = action ? { id, message, tone, action } : { id, message, tone };
    this.items = [...this.items, toast].slice(-MAX_TOASTS);
    setTimeout(() => this.dismiss(id), action ? DISMISS_WITH_ACTION_MS : DISMISS_MS);
    return id;
  }

  dismiss(id: number): void {
    this.items = this.items.filter((t) => t.id !== id);
  }
}

export const toasts = new ToastStore();
