# AGENTS.md — Desktop App

Owner: **desktop-agent** (logic, tests) / **design-agent** (UI visuals)

This file defines agent boundaries and rules for the Tauri + Svelte 5 desktop app.

---

## Agents

| Agent | Responsibility |
|---|---|
| `desktop-agent` | Tauri commands, Svelte logic, TypeScript types, tests |
| `design-agent` | Tailwind tokens, shadcn-svelte components, accessibility |

---

## Owned Paths

```
apps/desktop/
├── src/
│   ├── routes/              ← SvelteKit pages
│   ├── lib/
│   │   ├── components/      ← Svelte components (design-agent)
│   │   ├── stores/          ← Svelte state (desktop-agent)
│   │   └── tauri.ts         ← Tauri command wrappers (desktop-agent)
│   └── app.css              ← Tailwind base / design tokens (design-agent)
├── src-tauri/               ← Rust Tauri backend (desktop-agent, coordinate with core-agent)
├── tests/                   ← Playwright e2e (desktop-agent)
└── package.json
```

---

## Required Tools Before Commit

```bash
pnpm --filter desktop lint      # ESLint + Svelte check
pnpm --filter desktop test      # Vitest unit tests
pnpm --filter desktop test:e2e  # Playwright e2e
```

---

## Prohibited Actions

- No `any` type in TypeScript — use `unknown` and narrow
- No `localStorage` for secrets — use Tauri Store or OS keychain via Rust
- No `console.log` in committed code — use `debug` or remove
- No modifications to `crates/` or `apps/macos/` from this agent
- No overriding shadcn-svelte component internals — compose via slots/props

---

## Tauri Command Conventions

```typescript
// src/lib/tauri.ts
import { invoke } from '@tauri-apps/api/core';

export async function listContexts(): Promise<ContextEntry[]> {
  return invoke<ContextEntry[]>('list_contexts');
}
```

- One wrapper function per Tauri command
- Return type must match Rust `#[tauri::command]` serde output
- Handle errors: functions return `Promise<T>` — callers use `try/catch`

---

## Handoff Protocol

When a new Tauri command is needed:

1. `desktop-agent` defines the TypeScript interface and expected payload
2. Post: `@core-agent: new command \`list_contexts\` needed, TypeScript interface defined in PR`
3. `core-agent` implements the Rust `#[tauri::command]` in `src-tauri/`
