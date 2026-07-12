# Releasing CubeLite

Releases are fully automatic: merging a version bump to `main` builds, tags, and publishes everything. No manual tagging.

## Checklist (one PR)

1. **Bump versions** (keep them aligned):
   - `Cargo.toml` → `[workspace.package] version` — **this is the trigger and the source of truth for the tag**
   - `apps/desktop/src-tauri/tauri.conf.json` → `version`
   - Xcode project → `MARKETING_VERSION` for the cubelite target
   - refresh the lockfile: `cargo update --workspace`
2. **CHANGELOG.md**: rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` and start a fresh empty `## [Unreleased]` above it. This section becomes the release notes.
3. Open the PR, merge to `main`. Done.

## What automation does on merge

`release.yml` fires on any `main` push that touches `Cargo.toml`:

1. **version** job reads the workspace version; if release `vX.Y.Z` already exists the run ends there (so unrelated `Cargo.toml` edits are free).
2. Builds:
   - native macOS app (Release, ad-hoc signed) → `CubeLite-macOS.dmg` / `.zip`
   - Tauri desktop bundles on macOS/Linux/Windows → `CubeLite-Desktop-*`
3. **publish-release** creates the `vX.Y.Z` tag *and* the GitHub Release in one step (`gh release create --target`), with the CHANGELOG section as notes, `SHA256SUMS.txt`, and **stable asset names** (`releases/latest/download/…` links never change). Versions containing `-` (e.g. `0.4.0-beta.1`) are marked pre-release. A failing desktop platform does **not** block the release; the macOS native build is the gate.
4. **Pages redeploy** is dispatched explicitly at the end (releases created by the workflow token don't emit triggering events), so the site's docs and version badge refresh.

`workflow_dispatch` on `release.yml` is the manual escape hatch: run it from the Actions UI to (re)attempt a release of the current `main` version.

## After the release

- Verify the download links on <https://massimilianolapuma.github.io/cubelite/> resolve to the new version.
- If a desktop platform job failed, fix it, then upload the missing asset to the existing release (`gh release upload vX.Y.Z <file>`).

## Not automated yet

- Code-signing & notarization (macOS) and Sparkle auto-update — #121
- Desktop auto-updater and signed Windows installers — #250
