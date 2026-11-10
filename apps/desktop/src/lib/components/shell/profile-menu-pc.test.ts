import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/svelte";

// The pill shows only the profile's name; "Profile:" stays in its accessible
// name and tooltip on every platform.
vi.mock("#lib/platform.ts", () => ({ isMac: false, modLabel: "Ctrl+" }));

import ProfileMenu from "./ProfileMenu.svelte";
import { profiles } from "#lib/stores/profiles.svelte.ts";

beforeEach(() => {
  window.localStorage.clear();
  profiles.reset();
});

describe("ProfileMenu", () => {
  it("keeps the Profile: prefix for screen readers only", () => {
    render(ProfileMenu);
    const trigger = screen.getByRole("button", { name: /^Profile: On-call/ });
    expect(screen.getByText("Profile:")).toHaveClass("sr-only");
    expect(trigger).toHaveAttribute("title", "Profile: On-call");
  });
});
