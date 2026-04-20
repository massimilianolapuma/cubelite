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

## URLSession Delegates

- **MUST use completion-handler variants** for `URLSessionDelegate` and `URLSessionTaskDelegate` methods — NOT the async variants
- Async delegate methods are not reliably invoked by macOS URLSession
- Example: use `urlSession(_:didReceive:completionHandler:)` not `urlSession(_:didReceive:) async`
- Share challenge-handling logic via a private helper called from both session-level and task-level delegates

## Session Caching (KubeAPIService)

- Use a `sessionCache: [String: URLSession]` dictionary keyed by cluster server base URL
- Never use a single cached session entry — parallel multi-cluster fetches (e.g. `withTaskGroup` in All Clusters) would cancel each other's in-flight requests
- `invalidateSession()` must iterate and cancel ALL cached sessions
- Create a new session per unique server on cache miss

## TLS Skip Verification

- `AppSettings.skipTLSVerification` is the source of truth (persisted via UserDefaults)
- `KubeAPIService.updateSkipTLS(_:)` receives the flag and stores it in-memory — do NOT read UserDefaults directly in `makeSession()`
- `CubeliteApp` calls `updateSkipTLS()` on startup and on `.onChange(of:)` toggle
- When the flag changes, all cached sessions are invalidated

## Client Certificate Authentication

- Use `SecIdentityCreateWithCertificate(nil, certificate, &identity)` to find the identity for a certificate
- Do NOT use `SecItemCopyMatching` with `kSecClassIdentity` + `kSecMatchLimitAll` — it fails to correlate freshly-imported cert/key pairs
- Import cert and key via `SecItemAdd` first, then use `SecIdentityCreateWithCertificate`

## RBAC Resilience

- Every resource fetch in cross-cluster scenarios must catch `CubeliteError.forbidden` separately
- Track forbidden resources in `forbiddenResources: [String]` per cluster snapshot
- A cluster is "reachable" if any resource succeeds, even if some return 403
- Display RBAC-limited clusters differently from offline clusters in the UI

## Observable Models

- Use `@Observable @MainActor final class` for all view-bound state (ClusterState, CrossClusterState, AppSettings, LogStore)
- Inject via `.environment()` in CubeliteApp, consume via `@Environment(Type.self)` in views
- Use `@Bindable var s = settings` pattern for two-way bindings in PreferencesView
