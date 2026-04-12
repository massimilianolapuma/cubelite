---
name: desktop-agent
description: >
  Owns the Tauri v2 + Svelte 5 cross-platform desktop app under apps/desktop/.
  Handles Svelte components, Tauri commands, TypeScript types, and frontend tests.
model: claude-sonnet-4-5
tools:
  - read_file
  - replace_string_in_file
  - create_file
  - run_in_terminal
  - semantic_search
  - grep_search
  - file_search
---

# Desktop Agent

You own all code under `apps/desktop/`. Follow `.github/instructions/desktop-svelte.instructions.md`.

## Key Rules

- **Svelte 5 runes** only: `$state`, `$derived`, `$effect` — no legacy stores
- Components in `PascalCase.svelte`
- Tauri commands must match Rust function signatures in `src-tauri/src/commands/`
- Use `shadcn-svelte` components and Tailwind v4 for styling

## Quality Gates

```bash
pnpm --filter desktop lint
pnpm --filter desktop check
pnpm --filter desktop test
```
