# Releasing CubeLite

One tag push does everything: builds, publishes the GitHub Release with installers, and redeploys the website/docs.

## Checklist

1. **Bump versions** (keep them aligned with the tag):
   - `Cargo.toml` → `[workspace.package] version` (drives the Tauri desktop bundles)
   - `apps/desktop/src-tauri/tauri.conf.json` → `version`
   - Xcode project → `MARKETING_VERSION` for the cubelite target
2. **CHANGELOG.md**: rename the `## [Unreleased]` section to `## [X.Y.Z] - YYYY-MM-DD` and start a fresh empty `## [Unreleased]` above it. The release notes are extracted from this section.
3. Merge to `main`, then tag:

   ```sh
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

## What automation does on the tag

- `release.yml` builds:
  - native macOS app (Release, ad-hoc signed) → `CubeLite-macOS.dmg` / `.zip`
  - Tauri desktop bundles on macOS/Linux/Windows → `CubeLite-Desktop-*` assets
  - publishes the GitHub Release with the CHANGELOG section as notes, `SHA256SUMS.txt`, and **stable asset names** (so `releases/latest/download/…` links on the site and in the docs never need editing)
  - tags containing a `-` (e.g. `v0.4.0-beta.1`) are marked pre-release
  - a failing desktop platform does **not** block the release; the macOS native assets are the gate
- `pages.yml` redeploys the website on release publish; the site's version badge reads the latest release from the GitHub API at page load, and the user guide is re-rendered from `docs/guide/*.md`.

## After the release

- Verify the download links on <https://massimilianolapuma.github.io/cubelite/> resolve to the new version.
- If a desktop platform job failed, fix it and re-run just that job from the Actions UI, then upload the missing asset to the existing release (`gh release upload vX.Y.Z <file>`).

## Not automated yet

- Code-signing & notarization (macOS) and Sparkle auto-update — #121
- Desktop auto-updater and signed Windows installers — #250
