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
import { clock } from "#lib/stores/clock.svelte.ts";
import { clusterSettings } from "#lib/stores/cluster-settings.svelte.ts";
import { setAccess } from "#lib/stores/access-mock.ts";
import { tick } from "svelte";

function emit(prefix: "exec-output" | "exec-end", payload: unknown = null) {
  const name = [...handlers.keys()].find((k) => k.startsWith(`${prefix}:`));
  if (!name) throw new Error(`no listener for ${prefix}`);
  handlers.get(name)?.({ payload });
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  clusterSettings.reset();
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

describe("ShellModal on a read-only cluster (#662, spec §4.4)", () => {
  const LINE = "prod is read-only again. Input is off.";
  const input = () => screen.getByRole("textbox", { name: "Shell command" }) as HTMLInputElement;

  async function type(line: string) {
    await fireEvent.input(input(), { target: { value: line } });
    await fireEvent.submit(input().closest("form") as HTMLFormElement);
  }

  it("starts no shell on a read-only cluster and says why", async () => {
    setAccess("prod", "read_only");
    render(ShellModal, { props: { namespace: "default", pod: "api-0", onClose: vi.fn() } });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "prod is read-only. Make it writable from the cluster menu.",
    );
    expect(startExec).not.toHaveBeenCalled();
  });

  it("when the unlock ends: one line, the input off with the reason, and Close still works", async () => {
    const entry = setAccess("prod", "timed", 5);
    const onClose = vi.fn();
    render(ShellModal, { props: { namespace: "default", pod: "api-0", onClose } });
    await screen.findByText("connected: line-based shell (/bin/sh, no TTY)");
    expect(input()).not.toHaveAttribute("aria-disabled");

    clock.now = (entry.writable_until ?? 0) + 1;
    await tick();
    clock.now += 1_000;
    await tick();

    expect(screen.getAllByText(LINE)).toHaveLength(1);
    expect(screen.getByText(LINE)).toHaveAttribute("data-kind", "status");
    // Off, not natively disabled: it keeps its place and its reason.
    expect(input()).toHaveAttribute("aria-disabled", "true");
    expect(input()).not.toBeDisabled();
    expect(input()).toHaveAccessibleDescription("prod is read-only");
    expect(input()).toHaveAttribute("title", "prod is read-only");
    await type("rm -rf /data");
    expect(execSend).not.toHaveBeenCalled();
    expect(screen.queryByText("$ rm -rf /data")).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("follows the cluster it started on, not the one made active since", async () => {
    setAccess("lab", "read_only");
    await openShell();
    app.activeCluster = "lab";
    await tick();
    expect(input()).not.toHaveAttribute("aria-disabled");
    await type("ls");
    expect(execSend).toHaveBeenCalledOnce();

    setAccess("prod", "read_only");
    await tick();
    expect(screen.getAllByText(LINE)).toHaveLength(1);
    expect(input()).toHaveAttribute("aria-disabled", "true");
  });

  it("takes input again once the cluster is writable again", async () => {
    setAccess("prod", "timed", 5);
    await openShell();
    setAccess("prod", "read_only");
    await tick();
    expect(input()).toHaveAttribute("aria-disabled", "true");
    setAccess("prod", "timed", 15);
    await tick();
    expect(input()).not.toHaveAttribute("aria-disabled");
    await type("ls");
    expect(execSend).toHaveBeenCalledOnce();
  });
});
