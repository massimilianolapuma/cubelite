/**
 * Sidebar C (resource-kinds §3, §5.3): which All resources section is open,
 * and the Custom Resources filter. One section at a time; remembered for the
 * session only.
 */
import type { SectionId } from "#lib/navigation.ts";

export type OpenSection = SectionId | "custom";

class SidebarState {
  openSection = $state<OpenSection | null>(null);
  customFilter = $state("");

  /** Opens `id`, closing the open one; closes it when it is already open. */
  toggle(id: OpenSection): void {
    if (this.openSection === id) this.close();
    else this.open(id);
  }

  open(id: OpenSection): void {
    this.openSection = id;
  }

  close(): void {
    this.openSection = null;
  }
}

export const sidebar = new SidebarState();
