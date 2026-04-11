# AGENTS.md — macOS App

Owner: **macos-agent**

This file defines agent boundaries and rules for the native Swift 6 + SwiftUI macOS app.

---

## Agent

| Agent | `macos-agent` |
|---|---|
| **Owned paths** | `apps/macos/**` |
| **Language** | Swift 6 |
| **Frameworks** | SwiftUI, AppKit (minimal), Security.framework |
| **Minimum target** | macOS 14 |

---

## Owned Paths

```
apps/macos/
├── CubeLite/
│   ├── App.swift               ← Entry point, @main
│   ├── MenuBarView.swift        ← MenuBarExtra / NSStatusItem
│   ├── Models/                  ← @Observable models
│   ├── Views/                   ← SwiftUI views
│   ├── Services/
│   │   ├── KubeconfigService.swift   ← Read kubeconfig
│   │   └── KeychainService.swift     ← Keychain actor
│   └── Info.plist
├── CubeLiteTests/
│   └── ContextTests.swift
└── Package.swift
```

---

## Required Tools Before Commit

```bash
swift build                     # must compile cleanly
swift test                      # all XCTests must pass
```

Or via Xcode:
- Build scheme: `CubeLite`
- Test scheme: `CubeLiteTests`

---

## Prohibited Actions

- No `try!` or forced unwrap (`!`) outside test code
- No `DispatchQueue.main.async` — use `@MainActor` and structured concurrency
- No third-party package managers (CocoaPods, Carthage) — SPM only
- No plaintext secrets — Keychain only via `KeychainService`
- No modifications to `crates/` or `apps/desktop/` from this agent

---

## Concurrency Patterns

```swift
// Correct: @MainActor for UI updates
@MainActor
func refreshContextList() async {
    contexts = try await kubeconfigService.listContexts()
}

// Correct: actor for shared mutable state
actor KeychainService {
    func store(token: String, for key: String) throws { … }
}

// Wrong: DispatchQueue in Swift 6
// DispatchQueue.main.async { self.contexts = result }
```

---

## Handoff Protocol

When a new kubeconfig feature is needed that would benefit from the Rust core:

1. `macos-agent` defines the Swift protocol/interface
2. Post: `@core-agent: new feature needed — \`parseKubeconfig\`, Swift interface defined`
3. Consider whether a shared Rust FFI or a pure Swift implementation is appropriate
4. Document the decision in the issue before implementing
