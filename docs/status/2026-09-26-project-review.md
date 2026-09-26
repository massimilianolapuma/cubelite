# Project review — 2026-09-26

This snapshot covers the open PRs, the open issues, project health, and how well the desktop app matches the
Claude Design handoff (`design/design_handoff_cubelite_ui/`). It is based on `main` at `fa9c886` (v0.4.2).

## Open pull requests

| PR | State | Next step |
|---|---|---|
| #356 design(tokens): type scale v1.1, Swift typography tokens, bundled Geist | CI green, mergeable, in review since 2026-09-16 | Review and merge. This unblocks unified parity v2 PR 2–4 (#358, #359, #360). |
| #353 test(macos): fix E2E suite under CLI-driven runs | Mergeable, no linked issue or labels | Review and merge, then consider running UI tests in CI (#365 item 8). |
| #354 chore(deps-dev): bump vitest 3.2.6 → 4.1.11 | CI green | Merge, ideally together with vite 7 and vite-plugin-svelte 6. |

## Open issues

Existing:

- #121 macOS code signing, notarization and Sparkle. Priority high and open since April; this blocks distribution.
- #350 Windows Authenticode signing.
- #351 Follow-ups for the pop-out log window.
- #355 Type scale v1.1. Closed by #356.

Filed during this review:

| Issue | Topic |
|---|---|
| #357 | Tracking issue for unified parity v2, with sub-issues #358 (macOS shell + Events), #359 (Overview parity) and #360 (design lint + handoff v1.1) |
| #361 | fix(desktop): Esc closes the drawer instead of the modal on top of it; focus rings are missing |
| #362 | feat(desktop): All Clusters dashboard parity |
| #363 | feat(desktop): remaining design gaps in drawers, tables and preferences |
| #364 | chore(desktop): leftover styles that are not in the design system |
| #365 | chore(ci): Dependabot failures, audits, CodeQL for Rust, release toolchain |
| #366 | chore(core): workspace dependency hygiene and the kube upgrade |

## Project health

What is already good:

- No `unwrap`, `expect` or `panic!` in production Rust code.
- No TODO comments in source code.
- All GitHub Actions are pinned to a commit SHA.
- The CHANGELOG is up to date.
- Versions agree across Cargo, Tauri and Xcode.

What needs work:

- Five of the last six Dependabot npm update jobs failed, and there is no versioned `dependabot.yml`.
- `on_branch_create.yml` fails on Dependabot branches.
- `release.yml` builds with Node 20, while CI tests with Node 22.
- CI does not run `cargo audit` or `pnpm audit`.
- CodeQL does not scan Rust.
- The Playwright e2e tests do not run in CI.

All of these are tracked in #365.

Lower priority:

- The core crate redeclares workspace dependencies, and `k8s-openapi` is set to `v1_30` in one place and `v1_31` in another (#366).
- Several frontend dependencies are behind by a major version: vite 6, eslint-plugin-svelte 2, tailwind-merge 2, bits-ui 1.
- Both `package.json` files still say version `0.1.0`.
- The README asks for Node 20+, while CI uses Node 22.

## Desktop design compliance (handoff v1)

About 80% of the roughly 120 checked items match exactly (97 match, 17 deviate, 7 missing).

These match the spec: colour, typography, radius, shadow and motion tokens; the app shell (titlebar, cluster rail, sidebar, status bar);
Pods, Logs, Secrets, Helm and Events; the command palette; onboarding; and the drawers. No raw hex colours appear in any component.

These deviate or are missing:

- All Clusters dashboard stats and CPU/MEM bars (#362).
- Pod label chips, drawer scrolling away with the content, replica stepper segments, pod counts per namespace, compact row density,
  and hit targets below 28px (#363).
- Esc closing overlays in the wrong order (#361).
- Leftover shadcn variables, unicode glyphs where Lucide icons belong, and a light theme with no design review (#364).
- Two dark tokens deliberately changed for WCAG AA contrast: `text/tertiary` is `#7d7d86` and `err/solid` is `#d72929`. These need
  writing back into the handoff (#360).
