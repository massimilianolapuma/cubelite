/**
 * Toast queue — bottom-right, auto-dismiss 3.2s, dot colored by outcome.
 */

export type ToastTone = "ok" | "warn" | "err";

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

const DISMISS_MS = 3200;
const MAX_TOASTS = 4;

let nextId = 1;

class ToastStore {
  items = $state<Toast[]>([]);

  push(message: string, tone: ToastTone = "ok"): number {
    const id = nextId++;
    this.items = [...this.items, { id, message, tone }].slice(-MAX_TOASTS);
    setTimeout(() => this.dismiss(id), DISMISS_MS);
    return id;
  }

  dismiss(id: number): void {
    this.items = this.items.filter((t) => t.id !== id);
  }
}

export const toasts = new ToastStore();
