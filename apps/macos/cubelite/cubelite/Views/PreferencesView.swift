import SwiftUI

/// Root preferences window for CubeLite (480 × 360).
///
/// Contains three tabs — General, Appearance, and Advanced — each
/// implemented as a separate sub-view to keep individual `body`s concise.
struct PreferencesView: View {

    /// Backend used by the credential-reset action; nil hides that section.
    var kubeAPIService: KubeAPIService?

    var body: some View {
        TabView {
            GeneralPreferencesTab()
                .tabItem { Label("General", systemImage: "gearshape") }
            AppearancePreferencesTab()
                .tabItem { Label("Appearance", systemImage: "paintbrush") }
            NavigationPreferencesTab()
                .tabItem { Label("Navigation", systemImage: "sidebar.left") }
            AdvancedPreferencesTab(kubeAPIService: kubeAPIService)
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
    @Environment(LoginItemController.self) private var loginItem

    private static let refreshOptions: [(label: String, value: Int)] = [
        ("Off", 0),
        ("15 seconds", 15),
        ("30 seconds", 30),
        ("1 minute", 60),
        ("2 minutes", 120),
    ]

    /// Binding that routes toggle changes through the `LoginItemController`
    /// so the system registration stays in sync with the persisted setting.
    private var launchAtLoginBinding: Binding<Bool> {
        Binding(
            get: { settings.launchAtLogin },
            set: { newValue in
                let ok = loginItem.setEnabled(newValue)
                // Only persist the user's intent when the system accepted it.
                // On failure, leave the toggle reflecting the real status so
                // the UI doesn't silently disagree with the system.
                settings.launchAtLogin = ok ? newValue : loginItem.status.isEnabled
            }
        )
    }

    var body: some View {
        Form {
            Picker("Auto-refresh:", selection: Bindable(settings).autoRefreshInterval) {
                ForEach(Self.refreshOptions, id: \.value) { option in
                    Text(option.label).tag(option.value)
                }
            }
            Toggle("Launch at login", isOn: launchAtLoginBinding)
            if loginItem.status == .requiresApproval {
                Text(
                    "Approval required in System Settings → General → Login Items."
                )
                .typeStyle(DesignTokens.Typography.caption)
                .foregroundStyle(.secondary)
            }
            Toggle("Show system namespaces", isOn: Bindable(settings).showSystemNamespaces)
        }
        .formStyle(.grouped)
        .padding()
        .task { loginItem.refresh() }
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

// MARK: - Navigation Tab

/// Resource-type order and visibility plus the default list sort (#497).
private struct NavigationPreferencesTab: View {

    @Environment(ResourcePreferences.self) private var preferences

    var body: some View {
        Form {
            Section {
                Picker("Sort lists by:", selection: sortField) {
                    ForEach(SortField.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                .accessibilityIdentifier("preferences.sort-field")
                Picker("Order:", selection: sortAscending) {
                    Text("Ascending").tag(true)
                    Text("Descending").tag(false)
                }
                .pickerStyle(.segmented)
                .disabled(preferences.defaultSort.field == .api)
            } header: {
                Text("Default list sort")
            } footer: {
                Text("Click a column header to sort a list for this session.")
                    .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textTertiary)
            }

            let arranged = preferences.navigation.arranged
            ForEach(Array(arranged.enumerated()), id: \.element.section) { index, entry in
                Section {
                    ForEach(Array(entry.types.enumerated()), id: \.element) { position, type in
                        row(type, position: position, count: entry.types.count)
                    }
                } header: {
                    sectionHeader(entry.section, index: index, count: arranged.count)
                }
            }

            Section {
                Button("Reset to Default") { preferences.resetNavigation() }
                    .accessibilityIdentifier("preferences.navigation-reset")
            } footer: {
                Text("Hidden types stay reachable from the command palette.")
                    .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textTertiary)
            }
        }
        .formStyle(.grouped)
        .padding()
    }

    private var sortField: Binding<SortField> {
        Binding(
            get: { preferences.defaultSort.field },
            set: { preferences.defaultSort.field = $0 })
    }

    private var sortAscending: Binding<Bool> {
        Binding(
            get: { preferences.defaultSort.ascending },
            set: { preferences.defaultSort.ascending = $0 })
    }

    private func sectionHeader(_ section: NavSection, index: Int, count: Int) -> some View {
        HStack {
            Text(section.label)
            Spacer()
            if section != NavPrefs.pinnedSection {
                moveButtons(
                    label: "\(section.label) section", canUp: index > 1, canDown: index < count - 1,
                    up: { preferences.moveSection(section, by: -1) },
                    down: { preferences.moveSection(section, by: 1) })
            }
        }
    }

    @ViewBuilder
    private func row(_ type: ResourceType, position: Int, count: Int) -> some View {
        let hidden = preferences.navigation.isHidden(type)
        HStack {
            Label(type.rawValue, systemImage: type.systemImage)
                .foregroundStyle(hidden ? DesignTokens.textDisabled : DesignTokens.textPrimary)
            Spacer()
            if type == NavPrefs.pinnedType {
                Text("Always shown")
                    .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textTertiary)
            } else {
                let firstMovable = type.navID == "nodes" ? 1 : 0
                moveButtons(
                    label: type.rawValue, canUp: position > firstMovable, canDown: position < count - 1,
                    up: { preferences.moveType(type, by: -1) },
                    down: { preferences.moveType(type, by: 1) })
                Toggle(
                    "Show \(type.rawValue)",
                    isOn: Binding(
                        get: { !preferences.navigation.isHidden(type) },
                        set: { preferences.setHidden(type, !$0) })
                )
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.mini)
                .disabled(!hidden && !preferences.navigation.canHide(type))
                .accessibilityIdentifier("preferences.show-\(type.navID)")
            }
        }
    }

    private func moveButtons(
        label: String, canUp: Bool, canDown: Bool, up: @escaping () -> Void,
        down: @escaping () -> Void
    ) -> some View {
        HStack(spacing: 2) {
            Button(action: up) { Image(systemName: "chevron.up") }
                .disabled(!canUp)
                .accessibilityLabel("Move \(label) up")
            Button(action: down) { Image(systemName: "chevron.down") }
                .disabled(!canDown)
                .accessibilityLabel("Move \(label) down")
        }
        .buttonStyle(.borderless)
        .controlSize(.small)
    }
}

// MARK: - Advanced Tab

/// Advanced preferences: kubeconfig paths, API timeout, TLS settings.
private struct AdvancedPreferencesTab: View {

    @Environment(AppSettings.self) private var settings
    let kubeAPIService: KubeAPIService?
    @State private var credentialsReset = false

    var body: some View {
        @Bindable var s = settings
        Form {
            Section("Kubeconfig Files") {
                KubeconfigPathsSection(paths: $s.kubeconfigPaths)
            }
            Stepper("API timeout: \(s.apiTimeout) s", value: $s.apiTimeout, in: 5...120, step: 5)
            if let service = kubeAPIService {
                Section("Credentials") {
                    Button("Reset stored credentials") {
                        Task {
                            await service.resetStoredCredentials()
                            credentialsReset = true
                        }
                    }
                    .accessibilityIdentifier("preferences.reset-credentials")
                    Text(
                        credentialsReset
                            ? "Keychain entries removed — they will be re-imported on next use."
                            : "Removes bearer tokens and client identities from the Keychain."
                    )
                    .typeStyle(DesignTokens.Typography.caption)
                    .foregroundStyle(.secondary)
                }
            }
            Section {
                Toggle("Skip TLS certificate verification", isOn: $s.skipTLSVerification)
                    .onChange(of: s.skipTLSVerification) { _, newValue in
                        // Sync the actor here, not only from MainView: the
                        // Settings scene outlives the main window, and a toggle
                        // flipped while it is closed must still reach the
                        // session factory (#309).
                        guard let service = kubeAPIService else { return }
                        Task { await service.updateSkipTLS(newValue) }
                    }
                Text(
                    "⚠️ Accepts self-signed certificates from all clusters. Only enable for local development (e.g., minikube)."
                )
                .typeStyle(DesignTokens.Typography.caption)
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
    /// Picked files rejected by the last Add File… (#450); non-empty shows the alert.
    @State private var rejectedFiles: [String] = []

    var body: some View {
        if paths.isEmpty {
            Text("Using default: ~/.kube/config")
                .foregroundStyle(.secondary)
                .typeStyle(DesignTokens.Typography.body)
        }
        ForEach(Array(paths.enumerated()), id: \.offset) { index, path in
            KubeconfigPathRow(path: path) { paths.remove(at: index) }
        }
        Button("Add File…") { addFiles() }
            .accessibilityIdentifier("preferences.add-kubeconfig-file")
            .alert("Not a kubeconfig file", isPresented: showsRejection) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(KubeconfigPathsEditor.rejectionMessage(for: rejectedFiles))
            }
    }

    private var showsRejection: Binding<Bool> {
        Binding(
            get: { !rejectedFiles.isEmpty },
            set: { if !$0 { rejectedFiles = [] } }
        )
    }

    private func addFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.message = "Select kubeconfig files"
        guard panel.runModal() == .OK else { return }
        // Only kubeconfig documents are added; the list is seeded with the
        // resolved defaults when it was empty (see KubeconfigPathsEditor).
        let result = KubeconfigPathsEditor.adding(panel.urls, to: paths)
        if result.paths != paths {
            paths = result.paths
        }
        rejectedFiles = result.rejected
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
            .foregroundStyle(fileExists ? DesignTokens.statusOk : DesignTokens.statusWarn)
            .typeStyle(DesignTokens.Typography.caption)
            .accessibilityLabel(fileExists ? "File found" : "File missing")
            Text(path)
                .typeStyle(DesignTokens.Typography.dataSm)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            Button(role: .destructive) {
                onRemove()
            } label: {
                Image(systemName: "minus.circle")
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Remove \(path)")
        }
    }
}
