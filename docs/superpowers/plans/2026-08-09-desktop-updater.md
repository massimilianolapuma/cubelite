# Desktop Auto-Update (#250) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tauri updater end-to-end senza firma Apple, per spec `docs/superpowers/specs/2026-08-09-desktop-updater-design.md`: plugin + firma minisign, `latest.json` su GitHub Releases, UI check/install/relaunch, CI wiring.

**Architecture:** tauri-plugin-updater v2 + tauri-plugin-process; frontend store `updater.svelte.ts` (macchina a stati idle/checking/available/downloading/ready/error) consumato da un banner in `+page.svelte` e dalla sezione Preferences; CI genera updater artifacts (`createUpdaterArtifacts: true`) e il job publish compone `latest.json` dai `.sig` della matrice.

**Tech Stack:** Tauri v2, Rust, Svelte 5 runes, vitest, GitHub Actions.

## Global Constraints

- Single PR, branch `feat/250-desktop-updater` (spec + piano inclusi).
- La chiave minisign: generata via `pnpm --filter desktop exec tauri signer generate -w /tmp/cubelite-updater.key` SENZA password; privata → secret repo `TAURI_SIGNING_PRIVATE_KEY` via `gh secret set` (account massilp), MAI committata né loggata (né in report né in output); pubkey → `tauri.conf.json`. Il file temporaneo va cancellato dopo. L'utente va avvisato di fare backup della privata dal secret.
- Endpoint: `https://github.com/massimilianolapuma/cubelite/releases/latest/download/latest.json`.
- Gates espliciti (`; echo "X=$?"`): `cd apps/desktop && pnpm vitest run`, `pnpm typecheck`, `pnpm lint`, e `cargo build` in `src-tauri` (il bundle completo non serve in locale); actionlint/yaml check se disponibile per release.yml, altrimenti revisione manuale del diff YAML.
- Conventional Commits, NO attribution, no session links.

---

### Task 1: Plugin wiring (Rust + config + chiave)

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml` (+ `tauri-plugin-updater = "2"`, `tauri-plugin-process = "2"`)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (registra i plugin nel builder)
- Modify: `apps/desktop/src-tauri/tauri.conf.json` (sezione `plugins.updater` con `endpoints` + `pubkey`; `bundle.createUpdaterArtifacts: true`)
- Modify: `apps/desktop/package.json` (+ `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process`)
- Modify: `apps/desktop/src-tauri/capabilities/*.json` (permessi `updater:default`, `process:allow-restart` — verificare il file capabilities esistente e seguirne il formato)

**Interfaces:**
- Produces: pubkey installata; API JS `check()` da `@tauri-apps/plugin-updater` e `relaunch()` da `@tauri-apps/plugin-process` disponibili al frontend (Task 2).

- [ ] **Step 1: Genera la coppia di chiavi** (comando in Global Constraints), metti la privata nel secret `TAURI_SIGNING_PRIVATE_KEY` con `gh` (account massilp: `gh auth switch --user massilp` prima, ripristina dopo), incolla la pubkey in `tauri.conf.json`, cancella i file in /tmp. NON stampare la chiave privata da nessuna parte.
- [ ] **Step 2: Cargo + npm deps, registrazione plugin** (`.plugin(tauri_plugin_updater::Builder::new().build())` e `.plugin(tauri_plugin_process::init())` nel builder esistente di lib.rs), capabilities, `createUpdaterArtifacts: true`.
- [ ] **Step 3: Gates** — `cargo build` in src-tauri X=0; `pnpm install` e typecheck/lint desktop X=0.
- [ ] **Step 4: Commit** `feat(desktop): tauri updater plugin wiring and signing key`

### Task 2: Frontend — updater store + banner + Preferences

**Files:**
- Create: `apps/desktop/src/lib/stores/updater.svelte.ts`
- Test: `apps/desktop/src/lib/stores/updater.svelte.test.ts`
- Modify: `apps/desktop/src/routes/+page.svelte` (banner non modale; check on startup)
- Modify: la vista Preferences/Settings esistente (trovala: grep "Settings"/"Preferences" in src/lib — sezione "Updates" con bottone e stato)
- Modify: `apps/desktop/src/lib/tauri.ts` se il pattern del progetto incapsula lì le API plugin (seguire il pattern esistente per gli import Tauri)

**Interfaces:**
- Consumes: `check()` (plugin-updater), `relaunch()` (plugin-process).
- Produces: `class UpdaterStore` con `status: "idle"|"checking"|"available"|"downloading"|"ready"|"error"`, `version: string|null`, `error: string|null`, `checkForUpdates(silent: boolean)`, `downloadAndInstall()` (scarica, installa, poi `relaunch()` su conferma), `dismiss()`; singleton `updater`.

- [ ] **Step 1: TDD sullo store** — mock di `@tauri-apps/plugin-updater`/`-process` (vi.mock come per gli altri store): transizioni di stato complete; `silent=true` non passa a `error` visibile su fallimento (torna idle); doppio check concorrente = no-op; `downloadAndInstall` → `ready` e chiama relaunch solo dopo conferma esplicita.
- [ ] **Step 2: Banner in `+page.svelte`** — stile del reconnecting-banner esistente: "Update {version} available" + azioni "Restart to update"/"Later"; mount → `updater.checkForUpdates(true)` una sola volta.
- [ ] **Step 3: Preferences** — bottone "Check for updates" + testo stato (checking…/Up to date/Update available → azione/Errore).
- [ ] **Step 4: Gates verdi (vitest/typecheck/lint), commit** `feat(desktop): in-app update check, banner and preferences`

### Task 3: CI — updater artifacts + latest.json + docs

**Files:**
- Modify: `.github/workflows/release.yml` (env `TAURI_SIGNING_PRIVATE_KEY` sul job matrice; upload dei `.sig` e degli updater artifacts; nel job publish: script che compone `latest.json` con version/notes/pub_date/platforms{darwin-aarch64, darwin-x86_64?, linux-x86_64, windows-x86_64} da url+signature e lo allega alla release)
- Create: `scripts/make-latest-json.mjs` (o .sh — coerente con gli script repo esistenti; input: dir artifacts + tag; output: latest.json; VALIDA che ogni target atteso abbia url+sig, exit 1 se manca)
- Test: verifica dello script con fixture locali (dir finta con sig/asset) — test eseguibile in CI o come unit (`node scripts/... --check` con fixture in `scripts/fixtures/`)
- Modify: `docs/RELEASING.md` (chiave updater: dove vive, backup, cosa succede se ruota; flusso latest.json)

**Interfaces:**
- Consumes: naming asset della matrice esistente in release.yml (leggilo prima; gli updater artifacts Tauri v2 stanno accanto ai bundle: `*.app.tar.gz(.sig)`, `*-setup.exe(.sig)`/msi, `*.AppImage(.sig)`).

- [ ] **Step 1: Script `make-latest-json` + fixture test** (fail se manca un target/sig).
- [ ] **Step 2: release.yml** — env firma sul build job; artifact upload esteso; publish job chiama lo script e carica `latest.json` (nome stabile).
- [ ] **Step 3: Docs RELEASING** aggiornate.
- [ ] **Step 4: Gates (script test X=0; yaml lint o review), commit** `ci(release): updater artifacts and latest.json endpoint`

---

## Delivery

Single PR `feat/250-desktop-updater` → main. Titolo: `feat(desktop): auto-update via tauri-updater (#250)`. Body: architettura, nota chiave (backup!), UX, cosa resta per #121 (dmg firmato). La verifica end-to-end reale avviene alla prossima release (bump versione): documentare i passi nel body. Push `massilp`; merge utente.
