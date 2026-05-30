import Foundation
import Observation
import ServiceManagement

// MARK: - Status

/// Login Item registration state surfaced to the UI.
///
/// Mirrors `SMAppService.Status` but is `Sendable` and stable across SDKs,
/// so it can be passed through `@Observable` state and used in tests.
enum LoginItemStatus: Sendable, Equatable {
    /// The app is not registered as a login item.
    case notRegistered
    /// The app is registered and will launch at login.
    case enabled
    /// The app is registered but the user has not yet approved it in
    /// System Settings → General → Login Items.
    case requiresApproval
    /// The registration was found in a non-standard location (e.g. moved app).
    case notFound

    /// `true` when the app is effectively set to launch at login from the
    /// user's point of view (registered, even if pending approval).
    var isEnabled: Bool {
        switch self {
        case .enabled, .requiresApproval: true
        case .notRegistered, .notFound: false
        }
    }

    init(_ status: SMAppService.Status) {
        switch status {
        case .enabled: self = .enabled
        case .requiresApproval: self = .requiresApproval
        case .notFound: self = .notFound
        case .notRegistered: self = .notRegistered
        @unknown default: self = .notRegistered
        }
    }
}

// MARK: - Protocol

/// Abstraction over `SMAppService` so the controller can be unit-tested
/// without touching the real system service.
///
/// Implementations are only ever called from the main actor (via
/// ``LoginItemController``); the protocol is `@MainActor`-isolated so
/// implementations may safely touch main-actor state.
@MainActor
protocol LoginItemRegistering {
    func register() throws
    func unregister() throws
    func currentStatus() -> LoginItemStatus
}

// MARK: - Concrete Implementation

/// Concrete `LoginItemRegistering` backed by `SMAppService.mainApp`.
///
/// Uses the modern login-item API available on macOS 13+ (the project's
/// deployment target is 14.6, so no `#available` gate is required).
struct SMAppServiceLoginItem: LoginItemRegistering {

    func register() throws {
        try SMAppService.mainApp.register()
    }

    func unregister() throws {
        try SMAppService.mainApp.unregister()
    }

    func currentStatus() -> LoginItemStatus {
        LoginItemStatus(SMAppService.mainApp.status)
    }
}

// MARK: - Controller

/// Observable controller bridging the persisted "Launch at login" preference
/// to the real `SMAppService` registration state.
///
/// The controller is the source of truth the UI binds to: toggling
/// ``setEnabled(_:)`` calls register/unregister on the injected
/// ``LoginItemRegistering`` service, refreshes ``status``, and reports any
/// failure to the supplied logging closure.
@Observable
@MainActor
final class LoginItemController {

    // MARK: Observable state

    /// Latest known login-item status. Updated after every register/unregister
    /// and on ``refresh()``.
    private(set) var status: LoginItemStatus

    // MARK: Dependencies

    private let service: LoginItemRegistering
    /// Receives `(message, details)` whenever a register/unregister attempt
    /// throws. Settable after init so SwiftUI scenes can bind it to a log
    /// store once one is in scope.
    var onError: @MainActor (String, String?) -> Void

    // MARK: Init

    /// - Parameters:
    ///   - service: Backing registration service. Defaults to the real
    ///     `SMAppService.mainApp` wrapper.
    ///   - onError: Called with `(message, details)` whenever a register or
    ///     unregister attempt throws. The default is a no-op so the controller
    ///     remains usable in previews and tests without wiring a log store.
    init(
        service: LoginItemRegistering = SMAppServiceLoginItem(),
        onError: @escaping @MainActor (String, String?) -> Void = { _, _ in }
    ) {
        self.service = service
        self.onError = onError
        self.status = service.currentStatus()
    }

    // MARK: API

    /// Re-reads the current status from the underlying service.
    func refresh() {
        status = service.currentStatus()
    }

    /// Enable or disable the login item.
    ///
    /// Returns `true` if the underlying call succeeded (regardless of whether
    /// the resulting status is `.enabled` or `.requiresApproval`). Returns
    /// `false` and invokes the `onError` reporter when the call throws.
    @discardableResult
    func setEnabled(_ enabled: Bool) -> Bool {
        do {
            if enabled {
                try service.register()
            } else {
                try service.unregister()
            }
            status = service.currentStatus()
            return true
        } catch {
            // Keep the observed status in sync with reality even after failure.
            status = service.currentStatus()
            let action = enabled ? "register" : "unregister"
            onError(
                "Failed to \(action) Launch at Login",
                (error as NSError).localizedDescription
            )
            return false
        }
    }
}
