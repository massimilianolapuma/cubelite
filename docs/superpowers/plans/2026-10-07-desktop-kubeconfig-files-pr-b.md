# Desktop Kubeconfig Files — PR B: Preferences UI, Custom List, Live Reload Wiring

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From Preferences the user can add and remove kubeconfig files (a custom list that replaces `KUBECONFIG`), see where the current list comes from, and the app reloads contexts when a listed file changes on disk.

**Architecture:** A pure list module (`kubeconfig-list.ts`) holds the add/remove/seed rules. `clusters.reloadKubeconfig(reason)` is the single entry point that resolves sources through the PR A backend (`kubeconfigSources(customPaths)`), refreshes contexts, re-picks the active cluster when needed and (re)starts the backend watcher. `+page.svelte` calls it at startup and on the `kubeconfig-changed` event; `PreferencesModal` calls it after every list change. The file picker is `@tauri-apps/plugin-dialog`'s `open`.

**Tech Stack:** Svelte 5 runes, TypeScript, vitest + @testing-library/svelte (jsdom), Playwright with the `tauri-mock` IPC shim, `@tauri-apps/plugin-dialog`, `@tauri-apps/api/event`.

**Spec:** `docs/superpowers/specs/2026-10-07-desktop-kubeconfig-files-design.md` — §1, §4, §5 (frontend rows), §6 PR B.

## Global Constraints

- Branch `feat/428-desktop-kubeconfig-files-ui`, created from `feat/428-desktop-kubeconfig-files` (PR A head). PR B targets `feat/428-desktop-kubeconfig-files` (stacked) and its body says `Closes #428`. Conventional Commits; no AI attribution footer.
- Desktop gates before every commit: `pnpm --filter desktop exec svelte-kit sync >/dev/null; pnpm --filter desktop lint && pnpm --filter desktop typecheck && pnpm --filter desktop test; echo "EXIT=$?"`. E2E in Task 6: `pnpm --filter desktop test:e2e; echo "EXIT=$?"`. Design lint: `/opt/homebrew/bin/bash scripts/design-lint.sh; echo "EXIT=$?"` (no `text-[Npx]`, no raw hex; use `type-*` utilities and token classes).
- Imports use `#lib/...` with explicit extensions (e.g. `#lib/tauri.ts`, `#lib/stores/app.svelte.ts`).
- Precedence (spec §1.1): custom list non-empty → custom; else env; else default. "Use defaults" clears the custom list. Removing a file from a non-custom list first pins the resolved list as custom, then removes.
- Backend contract from PR A: `kubeconfigSources(customPaths: string[]) → { spec, sources, origin }`; `listContexts(kubeconfigPath?)`, `setContext(name, kubeconfigPath?)`, `getCurrentContext(kubeconfigPath?)`; `watchKubeconfig(paths) → id` (single slot: a new call replaces and aborts the previous watch, so a restart is just another `watchKubeconfig` call), `unwatchKubeconfig(id)`; event `KUBECONFIG_CHANGED = "kubeconfig-changed"` with `{ paths }`; the backend suppresses the echo of the app's own `set_context` write for 1.5 s, so the frontend needs no own-write filter; missing directories are skipped by the backend; dialog permission `dialog:allow-open` granted to the `main` window.
- Copy (verbatim): section title `Kubeconfig`; origin captions `From KUBECONFIG`, `From ~/.kube`, `Custom list`; buttons `Add file…`, `Remove`, link `Use defaults`; toast `Kubeconfig updated`; empty-custom hint under the list when origin is custom: `Custom list replaces KUBECONFIG; remove every file to go back to defaults.`
- Accessibility: list keeps `aria-label="Kubeconfig files"`; each Remove button `aria-label="Remove <path>"`; Add button is a real `<button>`; the origin caption is plain text (no colour-only meaning).

---

## File map

| File | Responsibility |
|---|---|
| `apps/desktop/src/lib/kubeconfig-list.ts` (new) + `.test.ts` | pure rules: `addPaths`, `removePath`, `seedIfEmpty`, `originLabel` |
| `apps/desktop/src/lib/stores/settings.svelte.ts` | `kubeconfigPaths: persisted<string[]>` + `isStringArray` |
| `apps/desktop/src/lib/stores/app.svelte.ts` | `kubeconfigOrigin` |
| `apps/desktop/src/lib/stores/clusters.svelte.ts` (+ test) | `reloadKubeconfig(reason)`, watcher start/stop, spec passed to `listContexts`/`setContext` |
| `apps/desktop/src/routes/+page.svelte` | startup via `reloadKubeconfig("startup")`, `kubeconfig-changed` listener, cleanup |
| `apps/desktop/src/lib/components/PreferencesModal.svelte` (+ `overlays.test.ts`) | Kubeconfig section: origin caption, rows with Remove, Add file…, Use defaults |
| `apps/desktop/tests/e2e/tauri-mock.ts`, `tests/e2e/app.spec.ts` | mock `customPaths`, dialog open, new e2e case |
| `CHANGELOG.md`, `docs/guide/faq.md` | docs |

---

### Task 1: Pure list rules (`kubeconfig-list.ts`)

**Files:**
- Create: `apps/desktop/src/lib/kubeconfig-list.ts`, `apps/desktop/src/lib/kubeconfig-list.test.ts`

**Interfaces:**
- Produces:
```ts
export function addPaths(current: string[], added: readonly string[]): string[];   // trims, drops blanks, dedupes, keeps order
export function removePath(current: string[], path: string): string[];
export function seedIfEmpty(custom: string[], resolved: readonly string[]): string[]; // custom.length ? custom : [...resolved]
export function originLabel(origin: KubeconfigOrigin): string;                      // "Custom list" | "From KUBECONFIG" | "From ~/.kube"
```

- [ ] **Step 1: Failing tests** — `kubeconfig-list.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { addPaths, originLabel, removePath, seedIfEmpty } from "#lib/kubeconfig-list.ts";

describe("kubeconfig-list", () => {
  it("addPaths appends new absolute paths, trims, dedupes and keeps order", () => {
    expect(addPaths(["/a"], [" /b ", "/a", "", "/c"])).toEqual(["/a", "/b", "/c"]);
  });
  it("removePath drops only the matching entry", () => {
    expect(removePath(["/a", "/b"], "/a")).toEqual(["/b"]);
    expect(removePath(["/a"], "/zzz")).toEqual(["/a"]);
  });
  it("seedIfEmpty copies the resolved list only when custom is empty", () => {
    expect(seedIfEmpty([], ["/x", "/y"])).toEqual(["/x", "/y"]);
    expect(seedIfEmpty(["/mine"], ["/x"])).toEqual(["/mine"]);
  });
  it("originLabel names every origin", () => {
    expect(originLabel("custom")).toBe("Custom list");
    expect(originLabel("env")).toBe("From KUBECONFIG");
    expect(originLabel("default")).toBe("From ~/.kube");
  });
});
```
Run `pnpm --filter desktop test -- kubeconfig-list` → fails (module missing).

- [ ] **Step 2: Implement** — `kubeconfig-list.ts`:

```ts
import type { KubeconfigOrigin } from "#lib/tauri.ts";

/** Append `added` to `current`: trimmed, non-blank, deduplicated, order kept. */
export function addPaths(current: string[], added: readonly string[]): string[] {
  const out = [...current];
  for (const raw of added) {
    const p = raw.trim();
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

export function removePath(current: string[], path: string): string[] {
  return current.filter((p) => p !== path);
}

/** The macOS "seed then edit" rule: an empty custom list starts from the resolved files. */
export function seedIfEmpty(custom: string[], resolved: readonly string[]): string[] {
  return custom.length > 0 ? custom : [...resolved];
}

export function originLabel(origin: KubeconfigOrigin): string {
  switch (origin) {
    case "custom":
      return "Custom list";
    case "env":
      return "From KUBECONFIG";
    default:
      return "From ~/.kube";
  }
}
```

- [ ] **Step 3: Gates + commit** — desktop gates EXIT=0; `git commit -m "feat(desktop): pure rules for the kubeconfig file list"` (two files).

---

### Task 2: Persisted custom list, origin state, `clusters.reloadKubeconfig`

**Files:**
- Modify: `apps/desktop/src/lib/stores/settings.svelte.ts`, `apps/desktop/src/lib/stores/app.svelte.ts`, `apps/desktop/src/lib/stores/clusters.svelte.ts`, `apps/desktop/src/lib/stores/clusters.svelte.test.ts`

**Interfaces:**
- Produces: `settings.kubeconfigPaths.value: string[]`; `app.kubeconfigOrigin: KubeconfigOrigin`; `clusters.reloadKubeconfig(reason: "startup" | "preferences" | "file-change"): Promise<void>`; `clusters.stopKubeconfigWatch(): Promise<void>`.

- [ ] **Step 1: Failing tests** — in `clusters.svelte.test.ts` extend the existing `vi.mock("#lib/tauri.ts", …)` factory with `kubeconfigSources: vi.fn()`, `watchKubeconfig: vi.fn(async () => "kw1")`, `unwatchKubeconfig: vi.fn(async () => undefined)` (keep the existing mocks), import them, and add:

```ts
describe("reloadKubeconfig", () => {
  beforeEach(() => {
    settings.kubeconfigPaths.value = [];
    vi.mocked(kubeconfigSources).mockResolvedValue({
      spec: "/home/u/.kube/config",
      sources: [{ path: "/home/u/.kube/config", exists: true, contexts: 1, shadowed: [] }],
      origin: "default",
    });
    vi.mocked(listContexts).mockResolvedValue([
      { name: "prod", cluster_server: null, namespace: "default", is_active: true },
    ]);
  });

  it("passes the custom list to the backend and stores spec, sources and origin", async () => {
    settings.kubeconfigPaths.value = ["/custom/a", "/custom/b"];
    await clusters.reloadKubeconfig("preferences");
    expect(kubeconfigSources).toHaveBeenCalledWith(["/custom/a", "/custom/b"]);
    expect(app.kubeconfigPath).toBe("/home/u/.kube/config");
    expect(app.kubeconfigSources).toHaveLength(1);
    expect(app.kubeconfigOrigin).toBe("default");
    expect(listContexts).toHaveBeenCalledWith("/home/u/.kube/config");
  });

  it("(re)starts the file watcher with the requested paths", async () => {
    await clusters.reloadKubeconfig("startup");
    await clusters.reloadKubeconfig("preferences");
    expect(watchKubeconfig).toHaveBeenCalledTimes(2);
    expect(watchKubeconfig).toHaveBeenLastCalledWith(["/home/u/.kube/config"]);
    await clusters.stopKubeconfigWatch();
    expect(unwatchKubeconfig).toHaveBeenCalledWith("kw1");
  });

  it("switches to the first context when the active one disappeared", async () => {
    app.activeCluster = "gone";
    const spy = vi.spyOn(clusters, "switchCluster").mockResolvedValue();
    await clusters.reloadKubeconfig("file-change");
    expect(spy).toHaveBeenCalledWith("prod");
    spy.mockRestore();
  });

  it("keeps the view and reloads resources when the active context survives a file change", async () => {
    app.activeCluster = "prod";
    const load = vi.spyOn(resources, "load").mockResolvedValue(true);
    await clusters.reloadKubeconfig("file-change");
    expect(load).toHaveBeenCalled();
    expect(toasts.items.at(-1)?.message).toBe("Kubeconfig updated");
    load.mockRestore();
  });

  it("falls back to the default path when no kubeconfig can be read", async () => {
    vi.mocked(kubeconfigSources).mockRejectedValue(new Error("no kubeconfig"));
    await clusters.reloadKubeconfig("startup");
    expect(app.kubeconfigPath.endsWith("/.kube/config")).toBe(true);
  });
});
```
(`resources`, `toasts`, `app`, `settings` are already imported in that test file or import them from their `#lib/stores/*.svelte.ts` modules; `homeDir` from `@tauri-apps/api/path` must be mocked: `vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/u") }))`.)

Run `pnpm --filter desktop test -- clusters` → fails (`reloadKubeconfig` missing).

- [ ] **Step 2: Implement**

`settings.svelte.ts`: add `const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");` and in `settings`: `/** Custom kubeconfig file list; empty = follow KUBECONFIG / ~/.kube. */ kubeconfigPaths: persisted<string[]>("kubeconfigPaths", [], isStringArray),`.

`app.svelte.ts`: import `KubeconfigOrigin` type; after `kubeconfigSources` add `/** Which precedence level produced kubeconfigSources. */ kubeconfigOrigin = $state<KubeconfigOrigin>("default");`.

`clusters.svelte.ts`:
- imports: add `kubeconfigSources, unwatchKubeconfig, watchKubeconfig` from `#lib/tauri.ts` and `import { homeDir } from "@tauri-apps/api/path";`.
- `refresh()`: `this.contexts = await listContexts(app.kubeconfigPath || undefined);`
- `switchCluster()`: `await setContext(name, app.kubeconfigPath || undefined);`
- add:

```ts
  #kubeconfigWatchId: string | null = null;

  /**
   * Re-resolve the kubeconfig list (custom list → KUBECONFIG → ~/.kube),
   * refresh contexts, keep or re-pick the active cluster and restart the
   * on-disk watcher. Single entry point for startup, Preferences edits and
   * `kubeconfig-changed` events.
   */
  async reloadKubeconfig(reason: "startup" | "preferences" | "file-change"): Promise<void> {
    try {
      const { spec, sources, origin } = await kubeconfigSources(settings.kubeconfigPaths.value);
      app.kubeconfigPath = spec;
      app.kubeconfigSources = sources;
      app.kubeconfigOrigin = origin;
    } catch {
      // No readable kubeconfig yet: keep the default path so onboarding can explain it.
      app.kubeconfigPath = `${await homeDir()}/.kube/config`;
      app.kubeconfigSources = [];
      app.kubeconfigOrigin = settings.kubeconfigPaths.value.length > 0 ? "custom" : "default";
    }
    await this.refresh();
    await this.#restartKubeconfigWatch();

    const names = this.contexts.map((c) => c.name);
    const activeSurvives = app.activeCluster !== null && names.includes(app.activeCluster);
    if (reason === "startup") return; // +page.svelte picks the initial cluster
    if (!activeSurvives) {
      const next = this.contexts.find((c) => c.is_active)?.name ?? this.contexts[0]?.name ?? null;
      if (next) await this.switchCluster(next);
      else app.activeCluster = null;
    } else if (reason === "file-change") {
      await resources.load();
    }
    if (reason === "file-change") toasts.push("Kubeconfig updated", "ok");
  }

  async stopKubeconfigWatch(): Promise<void> {
    if (this.#kubeconfigWatchId) {
      const id = this.#kubeconfigWatchId;
      this.#kubeconfigWatchId = null;
      await unwatchKubeconfig(id).catch(() => undefined);
    }
  }

  async #restartKubeconfigWatch(): Promise<void> {
    // The backend keeps a single kubeconfig watch: a new call replaces the old one.
    const paths = app.kubeconfigSources.map((s) => s.path);
    if (paths.length === 0) {
      await this.stopKubeconfigWatch();
      return;
    }
    try {
      this.#kubeconfigWatchId = await watchKubeconfig(paths);
    } catch {
      // Watching is best-effort (e.g. no listed directory exists yet).
      this.#kubeconfigWatchId = null;
    }
  }
```

- [ ] **Step 3: Gates + commit** — desktop gates EXIT=0 (all clusters tests, including the pre-existing ones, green). Commit the four files: `feat(desktop): persisted kubeconfig list and clusters.reloadKubeconfig`.

---

### Task 3: Startup and `kubeconfig-changed` wiring in `+page.svelte`

**Files:**
- Modify: `apps/desktop/src/routes/+page.svelte`

- [ ] **Step 1: Implement**
- Replace the inline block that calls `kubeconfigSources()` / sets `app.kubeconfigPath` / `clusters.refresh()` with `await clusters.reloadKubeconfig("startup");` (keep the active-cluster pick that follows it unchanged). Remove the now-unused `kubeconfigSources` and `homeDir` imports.
- Add `import { listen } from "@tauri-apps/api/event";` and `import { KUBECONFIG_CHANGED } from "#lib/tauri.ts";`. After `health.start();` add:

```ts
			unKubeconfigChanged = await listen(KUBECONFIG_CHANGED, () => {
				void clusters.reloadKubeconfig("file-change");
			});
```
with `let unKubeconfigChanged: (() => void) | null = null;` declared next to `unCloseRequested`, and in the cleanup function: `unKubeconfigChanged?.();` and `void clusters.stopKubeconfigWatch();`.

- [ ] **Step 2: Verify** — desktop gates EXIT=0; e2e smoke `pnpm --filter desktop test:e2e; echo "EXIT=$?"` → 10 passed (the mock already answers `kubeconfig_sources`, `watch_kubeconfig`, `plugin:event|listen`). Run `pnpm --filter desktop tauri:dev` (background), confirm the app boots to Overview with the real cluster list, then edit a listed kubeconfig (`kubectl config set-context --current --namespace=default` is enough to touch the file) and confirm the "Kubeconfig updated" toast. Record the result.

- [ ] **Step 3: Commit** — `feat(desktop): reload kubeconfig on startup and when a listed file changes`.

---

### Task 4: Preferences UI (origin caption, Remove, Add file…, Use defaults)

**Files:**
- Modify: `apps/desktop/src/lib/components/PreferencesModal.svelte`, `apps/desktop/src/lib/components/overlays.test.ts`

- [ ] **Step 1: Failing tests** — in `overlays.test.ts` add `vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));` next to the other mocks, import `{ open } from "@tauri-apps/plugin-dialog"`, extend the `#lib/tauri.ts` mock with `kubeconfigSources: vi.fn(async () => ({ spec: "", sources: [], origin: "default" }))`, `watchKubeconfig: vi.fn(async () => "kw1")`, `unwatchKubeconfig: vi.fn(async () => undefined)`; in `beforeEach` add `settings.kubeconfigPaths.value = []; app.kubeconfigOrigin = "env";`. Then inside `describe("PreferencesModal")`:

```ts
  it("shows where the kubeconfig list comes from", () => {
    app.kubeconfigOrigin = "env";
    app.preferencesOpen = true;
    render(PreferencesModal);
    expect(screen.getByText("From KUBECONFIG")).toBeInTheDocument();
  });

  it("Add file… seeds the custom list with the resolved files, then appends the picked ones", async () => {
    app.kubeconfigSources = [
      { path: "/home/u/.kube/config", exists: true, contexts: 1, shadowed: [] },
    ];
    vi.mocked(open).mockResolvedValue(["/home/u/team.yaml"]);
    const reload = vi.spyOn(clusters, "reloadKubeconfig").mockResolvedValue();
    app.preferencesOpen = true;
    render(PreferencesModal);
    await fireEvent.click(screen.getByRole("button", { name: "Add file…" }));
    await vi.waitFor(() =>
      expect(settings.kubeconfigPaths.value).toEqual(["/home/u/.kube/config", "/home/u/team.yaml"]),
    );
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ multiple: true, directory: false }));
    expect(reload).toHaveBeenCalledWith("preferences");
    reload.mockRestore();
  });

  it("Remove pins the list as custom and drops the file; Use defaults clears it", async () => {
    app.kubeconfigSources = [
      { path: "/home/u/.kube/config", exists: true, contexts: 1, shadowed: [] },
      { path: "/home/u/.kube/team.yaml", exists: true, contexts: 1, shadowed: [] },
    ];
    const reload = vi.spyOn(clusters, "reloadKubeconfig").mockResolvedValue();
    app.preferencesOpen = true;
    render(PreferencesModal);
    await fireEvent.click(screen.getByRole("button", { name: "Remove /home/u/.kube/team.yaml" }));
    expect(settings.kubeconfigPaths.value).toEqual(["/home/u/.kube/config"]);
    app.kubeconfigOrigin = "custom";
    await fireEvent.click(await screen.findByRole("button", { name: "Use defaults" }));
    expect(settings.kubeconfigPaths.value).toEqual([]);
    expect(reload).toHaveBeenCalledTimes(2);
    reload.mockRestore();
  });
```
Also update the existing test "lists every kubeconfig file with counts, merged and missing notes" only if its selectors break (e.g. now there is a Remove button per row); keep its assertions.

Run `pnpm --filter desktop test -- overlays` → the three new tests fail.

- [ ] **Step 2: Implement** — in `PreferencesModal.svelte`:

Script additions:
```ts
	import { open } from '@tauri-apps/plugin-dialog';
	import { addPaths, originLabel, removePath, seedIfEmpty } from '#lib/kubeconfig-list.ts';

	const resolvedPaths = $derived(app.kubeconfigSources.map((s) => s.path));

	async function applyKubeconfigList(next: string[]) {
		settings.kubeconfigPaths.value = next;
		await clusters.reloadKubeconfig('preferences');
	}

	async function addKubeconfigFiles() {
		const picked = await open({ multiple: true, directory: false, title: 'Select kubeconfig files' });
		const files = Array.isArray(picked) ? picked : picked ? [picked] : [];
		if (files.length === 0) return;
		const seeded = seedIfEmpty(settings.kubeconfigPaths.value, resolvedPaths);
		await applyKubeconfigList(addPaths(seeded, files));
	}

	async function removeKubeconfigFile(path: string) {
		const seeded = seedIfEmpty(settings.kubeconfigPaths.value, resolvedPaths);
		await applyKubeconfigList(removePath(seeded, path));
	}

	async function useDefaultKubeconfig() {
		await applyKubeconfigList([]);
	}
```

Markup: replace the Kubeconfig `<section>` with:
```svelte
		<section>
			<div class="mb-1.5 flex items-baseline justify-between gap-3">
				<div class="type-body text-text-primary">Kubeconfig</div>
				<div class="type-caption text-text-tertiary">{originLabel(app.kubeconfigOrigin)}</div>
			</div>
			<ul
				class="overflow-hidden rounded-md border border-border-faint bg-surface-window"
				aria-label="Kubeconfig files"
			>
				{#each kubeconfigRows as row (row.path)}
					<li class="flex items-start gap-2 border-b border-border-faint px-2.5 py-2 last:border-b-0">
						<div class="min-w-0 flex-1">
							<div
								class="truncate type-data-sm {row.exists ? 'text-text-secondary' : 'text-text-disabled'}"
								title={row.path}
							>
								{row.path}
							</div>
							<div class="type-caption mt-0.5 text-text-tertiary">
								{#if !row.exists}
									not found — skipped
								{:else}
									{row.contexts} context{row.contexts === 1 ? '' : 's'}
									{#if row.shadowed.length > 0}
										<span
											class="text-status-warn"
											title="Also defined in an earlier file, which wins: {row.shadowed.join(', ')}"
										>
											· {row.shadowed.length} merged
										</span>
									{/if}
								{/if}
							</div>
						</div>
						<button
							type="button"
							class="focus-ring type-caption shrink-0 rounded-sm px-1.5 py-0.5 text-text-tertiary hover:text-status-err"
							aria-label="Remove {row.path}"
							onclick={() => void removeKubeconfigFile(row.path)}
						>
							Remove
						</button>
					</li>
				{/each}
			</ul>
			<div class="mt-1.5 flex items-center gap-3">
				<button
					type="button"
					class="focus-ring type-caption rounded-md border border-border-default bg-surface-raised px-2.5 py-1 text-text-secondary hover:brightness-110"
					onclick={() => void addKubeconfigFiles()}
				>
					Add file…
				</button>
				{#if app.kubeconfigOrigin === 'custom'}
					<button
						type="button"
						class="focus-ring type-caption rounded-sm text-accent hover:brightness-110"
						onclick={() => void useDefaultKubeconfig()}
					>
						Use defaults
					</button>
				{/if}
			</div>
			{#if app.kubeconfigOrigin === 'custom'}
				<p class="type-caption mt-1 text-text-tertiary">
					Custom list replaces KUBECONFIG; remove every file to go back to defaults.
				</p>
			{:else if kubeconfigRows.length > 1}
				<p class="type-caption mt-1 text-text-tertiary">
					Files come from KUBECONFIG; on a name clash the first file wins.
				</p>
			{/if}
		</section>
```
(`kubeconfigRows` derived block stays as is.)

- [ ] **Step 3: Gates + visual** — desktop gates EXIT=0; design lint EXIT=0; `pnpm --filter desktop tauri:dev`: open Preferences, Add file… picks a second kubeconfig, its contexts appear in the rail, Remove hides them, Use defaults restores the env list. Screenshot the Preferences section to `.superpowers/sdd/<plan>/task-4-preferences.png` if screen capture is permitted.

- [ ] **Step 4: Commit** — `feat(desktop): manage kubeconfig files from Preferences`.

---

### Task 5: Playwright coverage

**Files:**
- Modify: `apps/desktop/tests/e2e/tauri-mock.ts`, `apps/desktop/tests/e2e/app.spec.ts`

- [ ] **Step 1: Mock** — in `tauri-mock.ts`: `FIXTURES.extraKubeconfig = { path: "/home/test/.kube/extra.yaml", exists: true, contexts: 1, shadowed: [] }`; `kubeconfig_sources` handler returns, when `args.customPaths?.length`, `{ spec: args.customPaths.join(":"), origin: "custom", sources: args.customPaths.map(p => fixtures.kubeconfig.sources.find(s => s.path === p) ?? fixtures.extraKubeconfig) }`, otherwise `fixtures.kubeconfig`; `list_contexts` returns the two fixtures plus `{ name: "extra", cluster_server: "https://extra:6443", namespace: "default", is_active: false, source: "/home/test/.kube/extra.yaml" }` when the last `kubeconfig_sources` call was custom and included `extra.yaml` (keep a `let customSpec = null` in the script); add `if (cmd === "plugin:dialog|open") return ["/home/test/.kube/extra.yaml"];`.

- [ ] **Step 2: Test** — `app.spec.ts`:
```ts
test("adding a kubeconfig file lists it and reloads contexts", async ({ page }) => {
  await boot(page);
  await page.getByLabel("Preferences").click();
  await page.getByRole("button", { name: "Add file…" }).click();
  const files = page.getByRole("list", { name: "Kubeconfig files" });
  await expect(files.getByText("/home/test/.kube/extra.yaml")).toBeVisible();
  await expect(page.getByText("Custom list")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("extra")).toBeVisible(); // rail avatar of the new context
  await page.getByLabel("Preferences").click();
  await page.getByRole("button", { name: "Use defaults" }).click();
  await expect(page.getByText("From KUBECONFIG")).toBeVisible();
});
```
(If the rail avatar's accessible name differs, use the selector the existing "shell renders…" test uses for `prod-aks`.)

- [ ] **Step 3: Run** — `pnpm --filter desktop test:e2e; echo "EXIT=$?"` → 11 passed. Commit: `test(desktop): e2e for adding a kubeconfig file from Preferences`.

---

### Task 6: Docs, changelog, push, PR B

- [ ] **Step 1: Docs** — `CHANGELOG.md` `## [Unreleased]` → `### Added`:
```markdown
- **Manage kubeconfig files from Preferences** (desktop, #428): Add file…
  opens a file picker, each file has Remove, and "Use defaults" returns to
  `KUBECONFIG` / `~/.kube`. The custom list replaces the environment, as in
  the macOS app. A caption shows where the list comes from, and when a listed
  file changes on disk the contexts reload with a "Kubeconfig updated" toast.
```
`docs/guide/faq.md`: in "CubeLite shows 'no kubeconfig found'" replace "In Settings you can point CubeLite at explicit kubeconfig paths" with "In Preferences → Kubeconfig you can add kubeconfig files; a custom list replaces `KUBECONFIG`" (and the final sentence "configure the paths in Settings" → "add the files in Preferences"). Add a new FAQ entry after it:

```markdown
**I switched to a cluster in CubeLite and now `kubectl` says "context not found".**
CubeLite merges every kubeconfig it lists (`KUBECONFIG`, `~/.kube/config` plus the other kubeconfig files in `~/.kube/`, or your custom list) and writes `current-context` into the first file, exactly like `kubectl config use-context` with `KUBECONFIG` set. A plain `kubectl` without `KUBECONFIG` reads only `~/.kube/config`, so a context that lives in another file is invisible to it. Set `KUBECONFIG` to the same list in your shell, or merge the files.
```

- [ ] **Step 2: Gates** — desktop gates, design lint, e2e: all EXIT=0.

- [ ] **Step 3: Push + PR**
```bash
git -c credential.helper= -c credential.helper='!f() { echo username=massilp; echo "password=$(gh auth token --user massilp)"; }; f' push -u origin feat/428-desktop-kubeconfig-files-ui
GH_TOKEN=$(gh auth token --user massilp) gh pr create --base feat/428-desktop-kubeconfig-files --head feat/428-desktop-kubeconfig-files-ui \
  --title "feat(desktop): manage kubeconfig files from Preferences" \
  --label "area:desktop,type:feat,status:review" --body "Closes #428 … (What per task; Spec §4; Verification; Stacked on PR A #430)"
```
Then `gh pr checks --watch` (cap 20 min) and report.

---

## Self-review

- **Spec coverage (PR B):** §4 settings/app state → Task 2; `reloadKubeconfig` steps 1–5 → Task 2 (watch restart, re-pick, toast) + Task 3 (startup + event); Preferences UI incl. captions, seed-then-edit, Add/Remove/Use defaults → Task 4; §5 vitest rows → Tasks 1, 2, 4; Playwright → Task 5; docs → Task 6.
- **Placeholders:** none; the e2e rail selector has an explicit fallback instruction.
- **Type consistency:** `reloadKubeconfig("startup" | "preferences" | "file-change")` identical in Tasks 2–4 and tests; `kubeconfigSources(customPaths)` / `watchKubeconfig(paths)` / `unwatchKubeconfig(id)` names match PR A's `tauri.ts`; `originLabel` strings match the copy constraints and the e2e assertions; `settings.kubeconfigPaths` used in Tasks 2 and 4 with the same name.
