/**
 * Sidebar C (resource-kinds §3, §5.3): which All resources section is open,
 * which custom API group is open inside Custom Resources, and its filter.
 * One section and one group at a time; remembered for the session only.
 */
import type { SectionId } from "#lib/navigation.ts";

export type OpenSection = SectionId | "custom";

class SidebarState {
  openSection = $state<OpenSection | null>(null);
  /** API group open inside Custom Resources. */
  openGroup = $state<string | null>(null);
  customFilter = $state("");

  /** Opens `id`, closing the open one; closes it when it is already open. */
  toggle(id: OpenSection): void {
    if (this.openSection === id) this.close();
    else this.open(id);
  }

  open(id: OpenSection): void {
    if (this.openSection !== id) this.openGroup = null;
    this.openSection = id;
  }

  close(): void {
    this.openSection = null;
    this.openGroup = null;
  }

  toggleGroup(group: string): void {
    this.openGroup = this.openGroup === group ? null : group;
  }
}

export const sidebar = new SidebarState();
