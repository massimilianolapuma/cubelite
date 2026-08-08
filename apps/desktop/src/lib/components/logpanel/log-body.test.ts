import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/svelte";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("$lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/tauri")>()),
  streamPodLog: vi.fn(async () => "1"),
  stopLogs: vi.fn(async () => {}),
  getPodContainers: vi.fn(async () => []),
}));

import LogBody from "./LogBody.svelte";
import { LogSession } from "$lib/stores/logSession.svelte";

function sessionWith(messages: string[]): LogSession {
  const s = new LogSession("default", "api-0");
  s.ring.append(
    messages.map((m) => ({
      pod: "api-0",
      namespace: "default",
      time: "2026-08-04T10:00:00Z",
      level: "info",
      message: m,
    })),
  );
  s.markSeen();
  return s;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LogBody", () => {
  it("renders rows for buffered lines", async () => {
    render(LogBody, { props: { session: sessionWith(["hello-log-line"]) } });
    expect(await screen.findByText("hello-log-line")).toBeInTheDocument();
  });

  it("shows the empty state when the buffer is empty", () => {
    render(LogBody, { props: { session: sessionWith([]) } });
    expect(screen.getByText("Waiting for log lines…")).toBeInTheDocument();
  });

  it("shows the new-lines pill when paused and lines arrive", async () => {
    const s = sessionWith(["a"]);
    s.toggleFollow(); // pause
    s.ring.append([
      { pod: "api-0", namespace: "default", time: null, level: "info", message: "b" },
    ]);
    render(LogBody, { props: { session: s } });
    expect(await screen.findByText("↓ 1 new line")).toBeInTheDocument();
  });
});
