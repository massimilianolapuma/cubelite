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
        ("2 minutes", 120)
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

/// Advanced preferences: kubeconfig path and API timeout.
private struct AdvancedPreferencesTab: View {

    @Environment(AppSettings.self) private var settings

    /// Default kubeconfig file path shown as placeholder text.
    private static let defaultKubeconfigPrompt = "~/.kube/config"

    var body: some View {
        @Bindable var s = settings
        Form {
            HStack {
                TextField("Kubeconfig path:", text: $s.kubeconfigPath, prompt: Text(Self.defaultKubeconfigPrompt))
                Button("Choose…") { pickKubeconfigFile(binding: $s.kubeconfigPath) }
            }
            Stepper("API timeout: \(s.apiTimeout) s", value: $s.apiTimeout, in: 5...120, step: 5)
            Section {
                Toggle("Skip TLS certificate verification", isOn: $s.skipTLSVerification)
                Text("⚠️ Accepts self-signed certificates from all clusters. Only enable for local development (e.g., minikube).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding()
    }

    /// Opens an `NSOpenPanel` to choose a kubeconfig file.
    private func pickKubeconfigFile(binding: Binding<String>) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.prompt = "Select"
        panel.message = "Choose a kubeconfig file"
        if panel.runModal() == .OK, let url = panel.url {
            binding.wrappedValue = url.path
        }
    }
}
