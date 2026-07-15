import SwiftUI

/// Log panel toolbar: stream context on the left (container, previous),
/// view controls on the right (tail, follow, overflow).
struct LogToolbar: View {

    @Environment(LogSessionStore.self) private var store
    let session: LogSession

    var body: some View {
        HStack(spacing: 8) {
            containerPicker
            if selectedContainerInfo?.restarts ?? 0 > 0 {
                previousChip
            }
            Spacer()
            tailMenu
            followButton
            overflowMenu
        }
        .padding(.horizontal, 8)
        .frame(height: 38)
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
