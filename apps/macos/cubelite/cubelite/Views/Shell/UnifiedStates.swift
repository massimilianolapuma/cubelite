import SwiftUI

// MARK: - Unified list states (Design System v1)
//
// Shared loading / empty / error presentation for every resource list,
// matching the desktop app: centered 12pt disabled text for empty states,
// err-colored message for failures.

/// Centered spinner with a caption while a list is loading.
struct UnifiedLoadingState: View {
    let label: String

    var body: some View {
        VStack(spacing: 10) {
            ProgressView().controlSize(.small)
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(DesignTokens.textDisabled)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Centered 12pt disabled message (spec empty state).
struct UnifiedEmptyState: View {
    let message: String

    var body: some View {
        Text(message)
            .font(.system(size: 12))
            .foregroundStyle(DesignTokens.textDisabled)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Centered error presentation in the status err color.
struct UnifiedErrorState: View {
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 24))
                .foregroundStyle(DesignTokens.statusErr)
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(DesignTokens.textPrimary)
            Text(message)
                .font(.system(size: 11))
                .foregroundStyle(DesignTokens.textTertiary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

extension View {
    /// Places a `Table`/`List` on the unified panel background.
    func unifiedTableBackground() -> some View {
        scrollContentBackground(.hidden)
            .background(DesignTokens.surfacePanel)
    }
}
