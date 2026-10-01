import SwiftUI

// MARK: - Menu commands (parity v2 §3)
//
// ⌘R "Refresh" (View menu) and ⇧⌘D "Diagnostics…" (Window menu). The main
// window publishes its actions with `.focusedSceneValue`, so the commands
// act on the frontmost CubeLite window and disable themselves otherwise
// (e.g. while a detached log window is key).

/// Window-scoped actions invoked from the menu bar.
struct MainCommandActions {
    let refresh: @MainActor () -> Void
    let showDiagnostics: @MainActor () -> Void
}

private struct MainCommandActionsKey: FocusedValueKey {
    typealias Value = MainCommandActions
}

extension FocusedValues {
    var mainCommandActions: MainCommandActions? {
        get { self[MainCommandActionsKey.self] }
        set { self[MainCommandActionsKey.self] = newValue }
    }
}

struct MainCommands: Commands {

    @FocusedValue(\.mainCommandActions) private var actions

    var body: some Commands {
        CommandGroup(after: .toolbar) {
            Button("Refresh") { actions?.refresh() }
                .keyboardShortcut("r", modifiers: .command)
                .disabled(actions == nil)
        }
        CommandGroup(after: .windowArrangement) {
            Button("Diagnostics…") { actions?.showDiagnostics() }
                .keyboardShortcut("d", modifiers: [.command, .shift])
                .disabled(actions == nil)
        }
    }
}
