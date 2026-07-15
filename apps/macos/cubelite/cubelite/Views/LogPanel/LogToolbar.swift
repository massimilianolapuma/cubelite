import SwiftUI

/// Log panel toolbar: stream context on the left (container, previous),
/// view controls on the right (tail, follow, overflow).
struct LogToolbar: View {

    @Environment(LogSessionStore.self) private var store
    let session: LogSession

    @FocusState private var searchFocused: Bool

    var body: some View {
        HStack(spacing: 8) {
            containerPicker
            if selectedContainerInfo?.restarts ?? 0 > 0 {
                previousChip
            }
            searchField
            Spacer()
            tailMenu
            followButton
            overflowMenu
        }
        .padding(.horizontal, 8)
        .frame(height: 38)
    }

    private var searchField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 10))
                .foregroundStyle(DesignTokens.textTertiary)
            TextField("search logs", text: Bindable(session.search).query)
                .textFieldStyle(.plain)
                .font(.system(size: 12, weight: .medium))
                .focused($searchFocused)
                .onSubmit {
                    if NSEvent.modifierFlags.contains(.shift) {
                        session.search.previous()
                    } else {
                        session.search.next()
                    }
                    session.isFollowing = false
                }
                .onKeyPress(.escape) {
                    session.search.clear()
                    searchFocused = false
                    return .handled
                }
            if session.search.isActive {
                Text(matchCountLabel)
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(DesignTokens.textTertiary)
                Button {
                    session.search.previous()
                    session.isFollowing = false
                } label: {
                    Image(systemName: "chevron.up").font(.system(size: 9))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Previous match")
                Button {
                    session.search.next()
                    session.isFollowing = false
                } label: {
                    Image(systemName: "chevron.down").font(.system(size: 9))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Next match")
                Button {
                    session.search.filterMode.toggle()
                } label: {
                    Text("filter")
                        .font(.system(size: 10, weight: .medium))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(
                            session.search.filterMode
                                ? DesignTokens.accentDefault : Color.clear
                        )
                        .foregroundStyle(
                            session.search.filterMode
                                ? DesignTokens.surfaceWindow : DesignTokens.textTertiary
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Filter to matching lines")
            } else {
                Text("⌘F")
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundStyle(DesignTokens.textDisabled)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .overlay(
                        RoundedRectangle(cornerRadius: 4)
                            .stroke(DesignTokens.borderDefault, lineWidth: 1))
            }
        }
        .padding(.horizontal, 8)
        .frame(height: 28)
        .frame(maxWidth: 400)
        .background(DesignTokens.surfaceWindow)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(
            RoundedRectangle(cornerRadius: 6).stroke(
                session.search.isActive
                    ? DesignTokens.accentDefault.opacity(0.45) : DesignTokens.borderDefault,
                lineWidth: 1)
        )
        .background(
            // ⌘F focuses the field from anywhere in the window.
            Button("") { searchFocused = true }
                .keyboardShortcut("f", modifiers: .command)
                .opacity(0)
        )
    }

    private var matchCountLabel: String {
        let total = session.search.matchingLineIDs.count
        guard total > 0 else { return "0/0" }
        let current = (session.search.activeMatchIndex ?? -1) + 1
        return current > 0 ? "\(current)/\(total)" : "\(total)"
    }

    private var selectedContainerInfo: ContainerInfo? {
        session.containers.first { $0.name == session.selectedContainer }
    }

    private var containerPicker: some View {
        Menu {
            let app = session.containers.filter { !$0.isInit }
            let inits = session.containers.filter(\.isInit)
            Section("Containers") {
                ForEach(app) { container in
                    containerItem(container)
                }
            }
            if !inits.isEmpty {
                Section("Init containers") {
                    ForEach(inits) { container in
                        containerItem(container)
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Circle().fill(stateColor(selectedContainerInfo)).frame(width: 6, height: 6)
                Text(session.selectedContainer ?? "—")
                    .font(.system(size: 11.5, weight: .medium, design: .monospaced))
                    .foregroundStyle(DesignTokens.textDataBright)
                Image(systemName: "chevron.down")
                    .font(.system(size: 8))
                    .foregroundStyle(DesignTokens.textTertiary)
            }
            .padding(.horizontal, 8)
            .frame(height: 26)
            .background(DesignTokens.surfaceRaised)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay(
                RoundedRectangle(cornerRadius: 6).stroke(DesignTokens.borderDefault, lineWidth: 1))
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .accessibilityLabel("Select container")

    }

    private func containerItem(_ container: ContainerInfo) -> some View {
        Button {
            session.switchContainer(to: container.name)
        } label: {
            if container.name == session.selectedContainer {
                Label(itemLabel(container), systemImage: "checkmark")
            } else {
                Text(itemLabel(container))
            }
        }
    }

    private func itemLabel(_ container: ContainerInfo) -> String {
        var parts = [container.name]
        if container.isSidecar { parts.append("(sidecar)") }
        if case .waiting(let reason?) = container.state { parts.append("· \(reason)") }
        if case .terminated(let reason?) = container.state { parts.append("· \(reason)") }
        if container.restarts > 0 { parts.append("· restarts \(container.restarts)") }
        return parts.joined(separator: " ")
    }

    private func stateColor(_ container: ContainerInfo?) -> Color {
        switch container?.state {
        case .running: DesignTokens.statusOk
        case .terminated: DesignTokens.textTertiary
        case .waiting, .none: DesignTokens.statusWarn
        }
    }

    private var previousChip: some View {
        Button {
            session.setPrevious(!session.showingPrevious)
        } label: {
            Label("previous", systemImage: "arrow.counterclockwise")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(
                    session.showingPrevious
                        ? DesignTokens.accentDefault : DesignTokens.textSecondary
                )
                .padding(.horizontal, 8)
                .frame(height: 26)
                .background(
                    session.showingPrevious
                        ? DesignTokens.accentDefault.opacity(0.14) : DesignTokens.surfaceRaised
                )
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay(
                    RoundedRectangle(cornerRadius: 6).stroke(
                        session.showingPrevious
                            ? DesignTokens.accentDefault.opacity(0.4) : DesignTokens.borderDefault,
                        lineWidth: 1))
        }
        .buttonStyle(.plain)
        .help("Show logs from the previous container instance")
    }

    private var tailMenu: some View {
        Menu {
            ForEach([100, 500, 1000, 5000], id: \.self) { size in
                Button {
                    session.setTail(size)
                } label: {
                    if session.tailLines == size {
                        Label("last \(size)", systemImage: "checkmark")
                    } else {
                        Text("last \(size)")
                    }
                }
            }
            Divider()
            Button("load 500 earlier") { session.loadEarlier() }
        } label: {
            HStack(spacing: 4) {
                Text("tail")
                    .font(.system(size: 11))
                    .foregroundStyle(DesignTokens.textTertiary)
                Text("\(session.tailLines)")
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(DesignTokens.textDataBright)
                Image(systemName: "chevron.down")
                    .font(.system(size: 8))
                    .foregroundStyle(DesignTokens.textTertiary)
            }
            .padding(.horizontal, 8)
            .frame(height: 26)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .accessibilityLabel("Tail size")
    }

    private var followButton: some View {
        Button {
            session.isFollowing.toggle()
        } label: {
            HStack(spacing: 5) {
                Circle()
                    .fill(session.isFollowing ? DesignTokens.statusOk : DesignTokens.textTertiary)
                    .frame(width: 6, height: 6)
                Text(session.isFollowing ? "Following" : "Paused")
                    .font(.system(size: 11, weight: .medium))
            }
            .padding(.horizontal, 10)
            .frame(height: 28)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
    }

    private var overflowMenu: some View {
        Menu {
            Toggle("Timestamps", isOn: Bindable(store).showTimestamps)
            Toggle("Wrap lines", isOn: Bindable(store).wrapLines)
            Divider()
            Button("Clear buffer") { session.clear() }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 11))
                .foregroundStyle(DesignTokens.textSecondary)
                .frame(width: 26, height: 28)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .accessibilityLabel("More log options")
    }
}
