import SwiftUI

// MARK: - MainView Integration Entries
//
// Command palette entries for the active context's Kibana and Grafana and
// the Integrations settings (#526).
extension MainView {

    /// The web UIs of the selected context.
    var integrationLinks: IntegrationLinks {
        IntegrationLinks(context: selectedContext, elastic: logSessionStore.elastic, prometheus: prometheusStore)
    }

    @MainActor
    func runIntegrationEntry(_ entry: IntegrationPaletteEntry) {
        let links = integrationLinks
        switch entry {
        case .openKibana:
            WebUI.open({ try await links.kibanaURL() }) { reportIntegrationFailure("Kibana", $0) }
        case .openGrafana:
            WebUI.open({ try await links.grafanaURL() }) { reportIntegrationFailure("Grafana", $0) }
        case .integrationsSettings:
            appSettings.showIntegrationSettings()
            openSettings()
        }
    }

    @MainActor
    private func reportIntegrationFailure(_ source: String, _ message: String) {
        logStore.append(LogEntry(severity: .error, source: source, message: message, details: nil))
    }
}
