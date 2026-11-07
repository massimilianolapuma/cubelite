import { describe, it, expect, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";
import ProfilesPreferences from "./ProfilesPreferences.svelte";
import { profiles } from "#lib/stores/profiles.svelte.ts";
import { navigation } from "#lib/stores/navigation.svelte.ts";

const rows = () => within(screen.getByRole("list", { name: "Profiles" })).getAllByRole("listitem");
const names = () => rows().map((r) => within(r).getByRole("button", { name: /^Show pins of / }).textContent?.trim());
const pinList = (name: string) => within(screen.getByRole("list", { name: `Pins of ${name}` }));

beforeEach(() => {
  window.localStorage.clear();
  profiles.reset();
  navigation.reset();
});

describe("ProfilesPreferences", () => {
  it("lists every profile in menu order, built-ins marked", () => {
    render(ProfilesPreferences);
    expect(names()).toEqual(["On-call", "Developer", "Security", "All"]);
    expect(within(rows()[0]).getByText("Built-in")).toBeInTheDocument();
    expect(within(rows()[0]).queryByRole("button", { name: /^Delete/ })).toBeNull();
    expect(within(rows()[0]).queryByRole("button", { name: /^Rename/ })).toBeNull();
  });

  it("creates a copy of the active profile and activates it", async () => {
    render(ProfilesPreferences);
    await fireEvent.input(screen.getByLabelText("Profile name"), { target: { value: "Team A" } });
    await fireEvent.click(screen.getByRole("radio", { name: "Copy On-call" }));
    await fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(profiles.active.name).toBe("Team A");
    expect(profiles.active.pins).toEqual(["overview", "nodes", "pods", "deployments", "jobs", "events", "logs"]);
    expect(names()).toEqual(["On-call", "Developer", "Security", "All", "Team A"]);
    expect(screen.getByLabelText("Profile name")).toHaveValue("");
  });

  it("creates an empty profile by default", async () => {
    render(ProfilesPreferences);
    await fireEvent.input(screen.getByLabelText("Profile name"), { target: { value: "Blank" } });
    await fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(profiles.active.pins).toEqual([]);
  });

  it("shows the name error", async () => {
    render(ProfilesPreferences);
    await fireEvent.input(screen.getByLabelText("Profile name"), { target: { value: "on-call" } });
    await fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByRole("alert")).toHaveTextContent("A profile with this name already exists");
    expect(profiles.list).toHaveLength(4);
  });

  it("renames and deletes a user profile", async () => {
    expect(profiles.create("Mine", "empty")).toBeNull();
    render(ProfilesPreferences);
    await fireEvent.click(screen.getByRole("button", { name: "Rename Mine" }));
    const input = screen.getByLabelText("New name for Mine");
    await fireEvent.input(input, { target: { value: "Ours" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(names()).toContain("Ours");
    await fireEvent.click(screen.getByRole("button", { name: "Delete Ours" }));
    expect(names()).not.toContain("Ours");
    expect(profiles.active.id).toBe("oncall");
  });

  it("Escape cancels a rename and a bad name shows its error", async () => {
    expect(profiles.create("Mine", "empty")).toBeNull();
    render(ProfilesPreferences);
    await fireEvent.click(screen.getByRole("button", { name: "Rename Mine" }));
    const input = screen.getByLabelText("New name for Mine");
    await fireEvent.input(input, { target: { value: "" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert")).toHaveTextContent("Use 1 to 24 characters");
    await fireEvent.keyDown(screen.getByLabelText("New name for Mine"), { key: "Escape" });
    expect(screen.queryByLabelText("New name for Mine")).toBeNull();
    expect(names()).toContain("Mine");
  });

  it("reorders profiles", async () => {
    render(ProfilesPreferences);
    await fireEvent.click(screen.getByRole("button", { name: "Move All up" }));
    expect(names()).toEqual(["On-call", "Developer", "All", "Security"]);
    expect(screen.getByRole("button", { name: "Move On-call up" })).toBeDisabled();
  });

  it("shows the selected profile's pins, reorders and removes them", async () => {
    render(ProfilesPreferences);
    await fireEvent.click(screen.getByRole("button", { name: "Show pins of Security" }));
    expect(screen.getByRole("button", { name: "Show pins of Security" })).toHaveAttribute("aria-pressed", "true");
    const labels = () => pinList("Security").getAllByRole("listitem").map((li) => li.textContent?.trim());
    expect(labels()[0]).toContain("Service Accounts");
    await fireEvent.click(screen.getByRole("button", { name: "Move Roles up in Security" }));
    expect(labels()[0]).toContain("Roles");
    await fireEvent.click(screen.getByRole("button", { name: "Unpin Secrets from Security" }));
    expect(profiles.list.find((p) => p.id === "security")!.pins).not.toContain("secrets");
  });

  it("resets a built-in's pins", async () => {
    profiles.unpin("pods", "developer");
    render(ProfilesPreferences);
    await fireEvent.click(screen.getByRole("button", { name: "Reset Developer to default pins" }));
    expect(profiles.list.find((p) => p.id === "developer")!.pins[0]).toBe("pods");
  });

  it("says how to add pins to an empty profile", async () => {
    expect(profiles.create("Empty", "empty")).toBeNull();
    render(ProfilesPreferences);
    await fireEvent.click(screen.getByRole("button", { name: "Show pins of Empty" }));
    expect(screen.getByText("No pins yet: pin a resource from its list header.")).toBeInTheDocument();
  });
});
