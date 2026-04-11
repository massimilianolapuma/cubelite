---
applyTo: "apps/macos/**"
---

# macOS App Instructions (Swift 6 + SwiftUI)

Guidelines for all code under `apps/macos/`.

## Swift 6

- Full strict concurrency checking enabled (`SWIFT_STRICT_CONCURRENCY = complete`)
- All types crossing concurrency boundaries must be `Sendable`
- Prefer `actor` for mutable shared state; `@MainActor` for UI-bound types
- Use Swift 6 `Observation` framework (`@Observable`) — not `ObservableObject`

## SwiftUI

- Minimum deployment target: **macOS 14**
- Views are structs — extract sub-views aggressively; keep body under ~20 lines
- Use `@Environment` and `@EnvironmentObject` for dependency injection
- Avoid `.onAppear` for async work — use `.task { }` modifier
- Prefer `@Observable` models over `@StateObject` / `@ObservedObject` pairs

## Menu Bar App

- Entry point: `NSStatusItem` with `NSMenu` or `MenuBarExtra` (SwiftUI)
- Background agent: `LSUIElement = true` in `Info.plist` to suppress Dock icon
- Use `AppKit` only where SwiftUI has no equivalent API

## Credentials / Keychain

- All credentials and tokens via `Security.framework` Keychain APIs — no UserDefaults for secrets
- Wrap Keychain operations in a `KeychainService` actor

## Tests

- XCTest for unit and integration tests
- SwiftUI previews for visual validation (not substitutes for tests)
- Run: `swift test` (SPM) or Xcode scheme `CubeLiteTests`
- Target code coverage ≥ 80% on new code

## What to Avoid

- No `force try` (`try!`) or forced unwrap (`!`) outside of test code
- No `DispatchQueue.main.async` — use `@MainActor` and structured concurrency
- No third-party package manager (CocoaPods, Carthage) — Swift Package Manager only
- No `AnyView` except as a last resort; use type-erased `some View` instead
