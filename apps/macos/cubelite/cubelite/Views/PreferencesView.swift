import SwiftUI

/// Root preferences window for CubeLite (480 × 360).
///
/// Contains three tabs — General, Appearance, and Advanced — each
/// implemented as a separate sub-view to keep individual `body`s concise.
struct PreferencesView: View {

    var body: some View {
        TabView {
            GeneralPreferencesTab()
                .tabItem { Label("General", systemImage: "gearshape") }
            AppearancePreferencesTab()
                .tabItem { Label("Appearance", systemImage: "paintbrush") }
            AdvancedPreferencesTab()
                .tabItem { Label("Advanced", systemImage: "slider.horizontal.3") }
        }
        .frame(width: 480, height: 360)
        .padding()
    }
}

// MARK: - General Tab

/// General preferences: auto-refresh, launch at login, system namespaces.
private struct GeneralPreferencesTab: View {

    @Environment(AppSettings.self) private var settings

    private static let refreshOptions: [(label: String, value: Int)] = [
        ("Off", 0),
        ("15 seconds", 15),
        ("30 seconds", 30),
        ("1 minute", 60),
        ("2 minutes", 120),
    ]

    var body: some View {
        Form {
            Picker("Auto-refresh:", selection: Bindable(settings).autoRefreshInterval) {
                ForEach(Self.refreshOptions, id: \.value) { option in
                    Text(option.label).tag(option.value)
                }
            }
            Toggle("Launch at login", isOn: Bindable(settings).launchAtLogin)
            Toggle("Show system namespaces", isOn: Bindable(settings).showSystemNamespaces)
        }
        .formStyle(.grouped)
        .padding()
    }
}

// MARK: - Appearance Tab

/// Appearance preferences: theme and menu bar icon style.
private struct AppearancePreferencesTab: View {

    @Environment(AppSettings.self) private var settings

    var body: some View {
        Form {
            Picker("Theme:", selection: Bindable(settings).appearanceMode) {
                ForEach(AppSettings.AppearanceMode.allCases, id: \.self) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            .pickerStyle(.radioGroup)

            Picker("Menu bar icon:", selection: Bindable(settings).menuBarIconStyle) {
                ForEach(AppSettings.MenuBarIconStyle.allCases, id: \.self) { style in
                    Text(style.label).tag(style)
                }
            }
            .pickerStyle(.radioGroup)
        }
        .formStyle(.grouped)
        .padding()
    }
}

// MARK: - Advanced Tab

/// Advanced preferences: kubeconfig paths, API timeout, TLS settings.
private struct AdvancedPreferencesTab: View {

    @Environment(AppSettings.self) private var settings

    var body: some View {
        @Bindable var s = settings
        Form {
            Section("Kubeconfig Files") {
                KubeconfigPathsSection(paths: $s.kubeconfigPaths)
            }
            Stepper("API timeout: \(s.apiTimeout) s", value: $s.apiTimeout, in: 5...120, step: 5)
            Section {
                Toggle("Skip TLS certificate verification", isOn: $s.skipTLSVerification)
                Text(
                    "⚠️ Accepts self-signed certificates from all clusters. Only enable for local development (e.g., minikube)."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

// MARK: - Kubeconfig Paths Section

/// Displays the list of custom kubeconfig file paths with add/remove controls.
private struct KubeconfigPathsSection: View {

    @Binding var paths: [String]

    var body: some View {
        if paths.isEmpty {
            Text("Using default: ~/.kube/config")
                .foregroundStyle(.secondary)
                .font(.callout)
        }
        ForEach(Array(paths.enumerated()), id: \.offset) { index, path in
            KubeconfigPathRow(path: path) { paths.remove(at: index) }
        }
        Button("Add File…") { addFiles() }
    }

    private func addFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.message = "Select kubeconfig files"
        if panel.runModal() == .OK {
            // When adding to an empty list, seed with the currently resolved
            // default paths so the user doesn't lose their existing config.
            if paths.isEmpty {
                paths = KubeconfigService.resolveKubeconfigPaths().map(\.path)
            }
            for url in panel.urls {
                let path = url.path
                if !paths.contains(path) {
                    paths.append(path)
                }
            }
        }
    }
}

// MARK: - Kubeconfig Path Row

/// A single row in the kubeconfig paths list showing status, path, and a remove button.
private struct KubeconfigPathRow: View {

    let path: String
    let onRemove: () -> Void

    private var fileExists: Bool { FileManager.default.fileExists(atPath: path) }

    var body: some View {
        HStack {
            Image(
                systemName: fileExists ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
            )
            .foregroundStyle(fileExists ? .green : .orange)
            .font(.caption)
            Text(path)
                .font(.system(.body, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            Button(role: .destructive) {
                onRemove()
            } label: {
                Image(systemName: "minus.circle")
            }
            .buttonStyle(.borderless)
        }
    }
}
