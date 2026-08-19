import SwiftUI

/// Transient toast bubble shown bottom-trailing over log session content.
/// Shared verbatim between the bottom panel and the detached pop-out window
/// (#298) so both surfaces render identical feedback (e.g. "copied").
struct LogToastOverlay: View {

    let message: String

    var body: some View {
        Text(message)
            .scaledFont(size: 11.5, design: .monospaced)
            .foregroundStyle(DesignTokens.textLog)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(DesignTokens.surfaceOverlay)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(DesignTokens.borderStrong, lineWidth: 1))
            .padding(12)
            .transition(.opacity)
    }
}
