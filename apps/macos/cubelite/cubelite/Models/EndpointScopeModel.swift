import Foundation
import Observation

/// Which endpoint the integration preferences edit (#528): the context's
/// own or the default shared by every context, and the per-context actions
/// on the default (override, turn off, use it again). Shared by the
/// Elasticsearch and Prometheus preferences models, like the desktop's
/// `EndpointScope`.
@Observable @MainActor
final class EndpointScopeModel<Endpoint: ScopedEndpoint> {
    var kind = EndpointScopeKind.context
    /// The user chose Override on a context using the default.
    var overriding = false
    /// A scope switch waiting for "Discard changes" (unsaved edits).
    var pending: EndpointScopeKind?
    /// Every kube context (set by the settings view): who a saved default reaches.
    @ObservationIgnored var contexts: [String] = []

    let store: EndpointStore<Endpoint>

    init(store: EndpointStore<Endpoint>) {
        self.store = store
    }

    func view(for context: String?) -> ScopeView {
        ScopeView.of(scope: kind, use: store.use(of: context), overriding: overriding)
    }

    /// The saved endpoint the form edits in `view`.
    func saved(_ view: ScopeView, context: String?) -> Endpoint? {
        view == .sharedDefault ? store.defaultEndpoint : store.ownEndpoint(for: context)
    }

    /// What the form starts from when nothing is saved: Override starts
    /// from the default's values.
    func prefill(_ view: ScopeView) -> Endpoint? {
        view == .own && overriding ? store.defaultEndpoint : nil
    }

    /// `endpoint` as the backend must see it in `view`: the default's
    /// credentials are the default's.
    func forBackend(_ endpoint: Endpoint, view: ScopeView) -> Endpoint {
        var copy = endpoint
        copy.shared = view == .sharedDefault
        return copy
    }

    /// The default's URL, for "Using the default endpoint".
    var defaultTarget: String? {
        store.defaultEndpoint.map { endpoint in
            switch endpoint.target {
            case .external(let url): url
            case .inCluster(let namespace, let service, let port, _): "\(namespace)/\(service):\(port)"
            }
        }
    }

    /// Whether the context has an endpoint of its own (or is overriding).
    func hasOwn(_ context: String?) -> Bool {
        overriding || store.ownEndpoint(for: context) != nil
    }

    /// The default stops applying to `context`; `name` is "Elasticsearch",
    /// "Prometheus".
    func turnOff(
        _ context: String, name: String, onTurnedOff: ((String) -> Void)?,
        disconnect: (String) async -> Void
    ) async -> FormOutcome {
        store.setOff(true, for: context)
        overriding = false
        // Turned off on purpose: the banner does not offer it again.
        onTurnedOff?(context)
        await disconnect(context)
        return FormOutcome(ok: true, text: "\(name) off for \(context)")
    }

    /// Drops the context's own endpoint (`removeSecret` deletes its
    /// credentials first) and turns the default back on.
    func useDefault(
        _ context: String, name: String, removeSecret: (Endpoint) async throws -> Void,
        disconnect: (String) async -> Void
    ) async -> FormOutcome {
        do {
            if let own = store.ownEndpoint(for: context) { try await removeSecret(own) }
        } catch {
            return FormOutcome(ok: false, text: error.localizedDescription)
        }
        store.setEndpoint(nil, for: context)
        store.setOff(false, for: context)
        overriding = false
        await disconnect(context)
        return FormOutcome(ok: true, text: "\(name): \(context) uses the default endpoint")
    }

    /// Stores what the form saved in `view` (nil = Off). Off on the own form
    /// with a default means "not the default either".
    func apply(_ endpoint: Endpoint?, view: ScopeView, context: String) {
        if view == .sharedDefault {
            store.setDefault(endpoint)
            return
        }
        store.setEndpoint(endpoint, for: context)
        if endpoint == nil, store.defaultEndpoint != nil { store.setOff(true, for: context) }
        overriding = false
    }

    /// The result line after Save; a saved default names the contexts it
    /// now reaches (older settings cannot tell "off" from "never configured").
    func savedText(name: String, view: ScopeView, saved: Bool, context: String) -> String {
        switch (view, saved) {
        case (.sharedDefault, true): ScopeText.willUseDefault(store.usersOfDefault(contexts))
        case (.sharedDefault, false): "\(name) default endpoint removed"
        case (_, true): "\(name) saved for \(context)"
        case (_, false): "\(name) off for \(context)"
        }
    }
}
