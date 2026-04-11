# AGENTS.md — cubelite-core

Owner: **core-agent**

This file defines agent boundaries and rules for the `crates/cubelite-core` Rust crate.

---

## Agent

| Agent | `core-agent` |
|---|---|
| **Owned paths** | `crates/**` |
| **Language** | Rust 1.82+ |
| **Key crates** | `kube-rs 0.97`, `tokio`, `thiserror 2`, `anyhow 1` |

---

## Owned Paths

```
crates/
└── cubelite-core/
    ├── src/
    │   ├── lib.rs
    │   ├── context.rs       ← k8s context model
    │   ├── client.rs        ← kube::Client wrapping
    │   └── error.rs         ← thiserror error types
    ├── tests/               ← integration tests
    └── Cargo.toml
```

---

## Required Tools Before Commit

```bash
cargo fmt --check               # formatting
cargo clippy --deny warnings    # lint (zero warnings allowed)
cargo test --workspace          # all tests must pass
```

---

## Prohibited Actions

- No `unwrap()` or `expect()` in `src/` (only `tests/` may use them)
- No `unsafe` without `// SAFETY:` justification comment
- No `println!` in library code — use `tracing::{debug, info, warn, error}`
- No direct k8s cluster credentials in code — read from kubeconfig only
- No modifications to `apps/` or `.github/` from this agent

---

## Test Patterns

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_context_list_returns_vec() {
        // Arrange: build fake kube client
        // Act: call domain function
        // Assert: verify output
    }
}
```

---

## Handoff Protocol

When a Rust type needs a TypeScript binding:

1. Define and stabilize the Rust type first
2. Post a comment on the issue: `@desktop-agent: new type \`ContextEntry\` in \`cubelite-core\`, binding needed`
3. Desktop-agent creates the mirrored TypeScript interface
