---
applyTo: "apps/desktop/**"
---

# Desktop App Instructions (Tauri + Svelte 5 + TypeScript)

Guidelines for all code under `apps/desktop/`.

## Svelte 5

- Use Svelte 5 runes: `$state`, `$derived`, `$effect`, `$props`
- Prefer `$derived` over `$effect` → state mutation for derived values
- Components live in `src/lib/components/`; pages/routes in `src/routes/`
- One component per file; named after the component with `PascalCase.svelte`
- Avoid `on:event` directives — use prop callbacks: `onclick={() => …}`

## TypeScript

- `strict: true` is enforced in `tsconfig.json` — no `any` types
- Use `satisfies` operator for config objects
- Prefer `type` over `interface` for unions and mapped types; `interface` for extensible shapes
- All Tauri command payloads typed with matching Rust serialization (`#[serde]`)

## shadcn-svelte & Tailwind v4

- Use shadcn-svelte components from `$lib/components/ui/`
- Do not override component internals — compose or extend via slot props
- Tailwind utility classes only — no inline styles, no CSS-in-JS
- Design tokens defined in `src/app.css` as CSS custom properties; reference via Tailwind `theme()`

## Tauri Commands

- Frontend calls backend via `invoke('command_name', { payload })` from `@tauri-apps/api/core`
- All command names in `snake_case`; define TypeScript overloads in `src/lib/tauri.ts`
- Never call `invoke` outside of `$effect` or event handlers — no top-level awaits in components
- Command errors must produce typed `Result`-shaped objects; handle both `ok` and `error` branches

## Tests

- Unit / component tests: Vitest with `@testing-library/svelte`
- E2E: Playwright targeting the Tauri WebView
- Test files: `*.test.ts` co-located or in `src/__tests__/`
- Run: `pnpm --filter desktop test`

## What to Avoid

- No `localStorage` for sensitive data — use Tauri Store plugin or OS keychain via Rust command
- No `document.write`, `eval`, `innerHTML` with unsanitized data
- No `any` types — use `unknown` and narrow
- No `console.log` left in committed code — use `debug` package or remove
