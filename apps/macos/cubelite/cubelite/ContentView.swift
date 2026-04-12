import SwiftUI

/// Superseded by ``MainView`` (Lens-like NavigationSplitView layout).
/// Retained to avoid modifying Xcode project.pbxproj.
/// Do not use ContentView directly — the active scene uses MainView.
struct ContentView: View {
    var body: some View {
        Text("Use MainView")
            .foregroundStyle(.secondary)
    }
}
