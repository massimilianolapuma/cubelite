/**
 * Sidebar C (resource-kinds §3): which All resources section is open.
 * One at a time; remembered for the session only.
 */
import type { SectionId } from "#lib/navigation.ts";

class SidebarState {
  openSection = $state<SectionId | null>(null);

  /** Opens `id`, closing the open one; closes it when it is already open. */
  toggle(id: SectionId): void {
    this.openSection = this.openSection === id ? null : id;
  }

  open(id: SectionId): void {
    this.openSection = id;
  }

  close(): void {
    this.openSection = null;
  }
}

export const sidebar = new SidebarState();
