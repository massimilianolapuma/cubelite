import { describe, it, expect, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import PinToggle from "./PinToggle.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { profiles } from "#lib/stores/profiles.svelte.ts";
import { navigation } from "#lib/stores/navigation.svelte.ts";

beforeEach(() => {
  window.localStorage.clear();
  profiles.reset();
  navigation.reset();
  app.view = "pods";
});

describe("PinToggle", () => {
  it("is pressed when the view is pinned", () => {
    render(PinToggle);
    expect(screen.getByRole("button", { name: "Pin to On-call" })).toHaveAttribute("aria-pressed", "true");
  });

  it("click pins to the active profile", async () => {
    app.view = "secrets";
    render(PinToggle);
    const button = screen.getByRole("button", { name: "Pin to On-call" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    await fireEvent.click(button);
    expect(profiles.isPinned("secrets")).toBe(true);
    expect(screen.getByRole("button", { name: "Pin to On-call" })).toHaveAttribute("aria-pressed", "true");
  });

  it("is disabled for hidden types", () => {
    app.view = "services";
    navigation.setHidden("services", true);
    render(PinToggle);
    const button = screen.getByRole("button", { name: "Pin to On-call" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Hidden in Preferences");
  });

  it("is absent on the dashboard", () => {
    app.view = "dashboard";
    render(PinToggle);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
