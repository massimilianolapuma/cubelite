import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";

const handlers = new Map<string, (event: { payload: unknown }) => void>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  }),
}));
vi.mock("#lib/tauri.ts", () => ({
  startExec: vi.fn(),
  execSend: vi.fn(),
  stopExec: vi.fn(async () => {}),
}));

import ShellModal from "./ShellModal.svelte";
import { execSend, startExec, stopExec } from "#lib/tauri.ts";
import { app } from "#lib/stores/app.svelte.ts";

function emit(prefix: "exec-output" | "exec-end", payload: unknown = null) {
  const name = [...handlers.keys()].find((k) => k.startsWith(`${prefix}:`));
  if (!name) throw new Error(`no listener for ${prefix}`);
  handlers.get(name)?.({ payload });
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  app.kubeconfigPath = "/home/u/.kube/config";
  app.activeCluster = "prod";
  vi.mocked(startExec).mockResolvedValue(undefined);
  vi.mocked(execSend).mockResolvedValue(undefined);
});

async function openShell() {
  const view = render(ShellModal, {
    props: { namespace: "default", pod: "api-0", onClose: vi.fn() },
  });
  await screen.findByText("connected: line-based shell (/bin/sh, no TTY)");
  return view;
}

describe("ShellModal (#488)", () => {
  it("listens on the session id before starting the shell", async () => {
    await openShell();
    const [kc, sessionId, namespace, pod, context] = vi.mocked(startExec).mock.calls[0];
    expect([kc, namespace, pod, context]).toEqual(["/home/u/.kube/config", "default", "api-0", "prod"]);
    expect(handlers.has(`exec-output:${sessionId}`)).toBe(true);
    expect(handlers.has(`exec-end:${sessionId}`)).toBe(true);
    expect(screen.getByText("api-0 shell")).toBeInTheDocument();
  });

  it("Enter sends the line with a newline and echoes it", async () => {
    await openShell();
    const sessionId = vi.mocked(startExec).mock.calls[0][1];
    const input = screen.getByRole("textbox", { name: "Shell command" });
    await fireEvent.input(input, { target: { value: "ls -la" } });
    await fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(execSend).toHaveBeenCalledWith(sessionId, "ls -la\n");
    expect(screen.getByText("$ ls -la")).toHaveAttribute("data-kind", "input");
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("routes output channels to their own styles", async () => {
    await openShell();
    emit("exec-output", { channel: "stdout", text: "bin etc usr" });
    emit("exec-output", { channel: "stderr", text: "sh: nope: not found" });
    emit("exec-output", { channel: "status", text: "command terminated with exit code 127" });

    expect(await screen.findByText("bin etc usr")).toHaveAttribute("data-kind", "stdout");
    expect(screen.getByText("sh: nope: not found")).toHaveAttribute("data-kind", "stderr");
    expect(screen.getByText("command terminated with exit code 127")).toHaveAttribute("data-kind", "status");
  });

  it("disables the input when the session ends", async () => {
    await openShell();
    emit("exec-end");
    expect(await screen.findByText("session closed")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Shell command" })).toBeDisabled();
  });

  it("caps the scrollback at 1000 lines", async () => {
    await openShell();
    for (let i = 0; i < 1005; i++) emit("exec-output", { channel: "stdout", text: `line ${i}` });
    await screen.findByText("line 1004");
    const rows = screen.getByTestId("shell-scrollback").querySelectorAll("[data-kind]");
    expect(rows).toHaveLength(1000);
    expect(screen.queryByText("line 0")).not.toBeInTheDocument();
  });

  it("shows a start failure inline", async () => {
    vi.mocked(startExec).mockRejectedValue("pods \"api-0\" is forbidden");
    render(ShellModal, { props: { namespace: "default", pod: "api-0", onClose: vi.fn() } });
    expect(await screen.findByRole("alert")).toHaveTextContent('pods "api-0" is forbidden');
    expect(screen.getByRole("textbox", { name: "Shell command" })).toBeDisabled();
  });

  it("stops the session and its listeners on close", async () => {
    const view = await openShell();
    const sessionId = vi.mocked(startExec).mock.calls[0][1];
    view.unmount();
    expect(stopExec).toHaveBeenCalledWith(sessionId);
    expect(handlers.size).toBe(0);
  });
});
