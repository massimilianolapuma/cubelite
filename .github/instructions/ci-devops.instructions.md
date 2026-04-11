---
applyTo: ".github/**"
---

# CI / DevOps Instructions

Guidelines for all files under `.github/` — workflows, actions, and tooling config.

## GitHub Actions YAML

- Indent: 2 spaces
- Always pin action versions to a full SHA commit hash (not a mutable tag like `@v3`)
  - Preferred: `uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2`
- Use `timeout-minutes` on every job — default: `15`; long build jobs: `60`
- Set `permissions` at the top level to the minimum required by each workflow

## Secrets

- **Never hardcode secrets, tokens, or credentials** in workflow files
- Reference secrets only via `${{ secrets.SECRET_NAME }}`
- Do not `echo` secret values or use them in `run:` commands that write to logs
- Use OIDC (`id-token: write`) for cloud authentication where supported

## Job Structure

- Separate jobs for: lint, test, build, release — do not combine unrelated steps
- Use `needs:` to express explicit dependency ordering
- Cache dependencies:
  - Rust: `actions/cache` on `~/.cargo/registry` + `target/` keyed on `Cargo.lock` hash
  - Node: `actions/setup-node` with `cache: 'pnpm'`
  - Swift: `actions/cache` on `.build/` keyed on `Package.resolved` hash

## Branch / PR Conventions

- CI must pass on: `main`, `feat/**`, `fix/**`, `chore/**`
- All PRs require at least one approval and all status checks green before merge
- Squash merge only — no merge commits, no rebase-merge to `main`

## What to Avoid

- No `continue-on-error: true` on security-critical steps (lint, CodeQL)
- No `pull_request_target` without explicit checkout restrictions (security risk)
- No matrix explosion — cap `matrix` to needed platform combinations
- No self-hosted runners for public-facing workflows without isolation guarantees
