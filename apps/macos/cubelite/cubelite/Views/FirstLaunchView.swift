import AppKit
import SwiftUI

// MARK: - KubeconfigStatus

/// Detection state of the kubeconfig file during onboarding.
private enum KubeconfigStatus: Sendable {
    /// Detection is in progress.
    case checking
    /// At least one kubeconfig file was found with the given number of contexts.
    case found(contextCount: Int, displayPath: String)
    /// No kubeconfig file was found at any resolved path.
    case notFound
}

// MARK: - FirstLaunchView

/// Onboarding view shown once on first application launch.
///
/// Automatically detects the kubeconfig at startup, reports how many
/// contexts were discovered, and presents a "Get Started" button that
/// completes onboarding and hands control back to the caller via
/// `onComplete`.
struct FirstLaunchView: View {

    // MARK: - Feature Highlights

    /// A single feature highlight item displayed during onboarding.
    struct FeatureItem: Sendable, Identifiable {
        /// SF Symbol name for the feature icon.
        let icon: String
        /// Short description label.
        let label: String

        var id: String { icon }
    }

    /// Feature highlights shown during onboarding.
    ///
    /// Exposed as a static property so that unit tests can verify content
    /// without instantiating the view.
    static let featureHighlights: [FeatureItem] = [
        FeatureItem(icon: "server.rack",       label: "Discover & switch contexts across clusters"),
        FeatureItem(icon: "cube.box",          label: "Monitor pods, deployments, and namespaces"),
        FeatureItem(icon: "menubar.rectangle", label: "Native macOS menu bar integration"),
    ]

    // MARK: - Properties

    let kubeconfigService: KubeconfigService
    /// Called when the user taps "Get Started" to complete onboarding.
    let onComplete: () -> Void

    @State private var status: KubeconfigStatus = .checking

    // MARK: - Body

    var body: some View {
        VStack(spacing: 22) {
            OnboardingHeaderSection()
            KubeconfigStatusCard(status: status)
            FeatureListSection(items: Self.featureHighlights)
            Spacer(minLength: 0)
            GetStartedButton(action: onComplete)
        }
        .padding(.horizontal, 48)
        .padding(.vertical, 32)
        .frame(width: 600, height: 400)
        .task { await detectKubeconfig() }
    }

    // MARK: - Private

    @MainActor
    private func detectKubeconfig() async {
        let paths = KubeconfigService.resolveKubeconfigPaths()
        do {
            let config = try await kubeconfigService.loadFromPaths(paths)
            let rawPath = paths.first?.path ?? ""
            let home = NSHomeDirectory()
            let displayPath = rawPath.hasPrefix(home)
                ? "~" + rawPath.dropFirst(home.count)
                : rawPath
            status = .found(contextCount: config.contexts.count, displayPath: displayPath)
        } catch {
            status = .notFound
        }
    }
}

// MARK: - OnboardingHeaderSection

/// App logo, title, and subtitle row.
private struct OnboardingHeaderSection: View {
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "square.3.layers.3d")
                .font(.system(size: 36, weight: .medium))
                .foregroundStyle(.tint)
            Text("Welcome to CubeLite")
                .font(.title2.bold())
            Text("Your Kubernetes contexts, unified")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - KubeconfigStatusCard

/// Card that reflects the current kubeconfig detection state.
private struct KubeconfigStatusCard: View {
    let status: KubeconfigStatus

    var body: some View {
        HStack(spacing: 12) {
            statusIcon
            statusDetails
            Spacer()
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color(nsColor: .controlBackgroundColor))
                .shadow(color: .black.opacity(0.06), radius: 4, x: 0, y: 1)
        )
    }

    @ViewBuilder
    private var statusIcon: some View {
        switch status {
        case .checking:
            ProgressView().controlSize(.small)
        case .found:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .notFound:
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
        }
    }

    @ViewBuilder
    private var statusDetails: some View {
        switch status {
        case .checking:
            Text("Detecting kubeconfig…").foregroundStyle(.secondary)
        case let .found(count, path):
            VStack(alignment: .leading, spacing: 2) {
                Text("\(count) context\(count == 1 ? "" : "s") discovered")
                    .font(.callout.weight(.medium))
                Text(path)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        case .notFound:
            VStack(alignment: .leading, spacing: 2) {
                Text("No kubeconfig found")
                    .font(.callout.weight(.medium))
                Text("Place your kubeconfig at ~/.kube/config")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

// MARK: - FeatureListSection

/// Vertical list of onboarding feature highlights.
private struct FeatureListSection: View {
    let items: [FirstLaunchView.FeatureItem]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(items) { item in
                FeatureRow(icon: item.icon, label: item.label)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - FeatureRow

/// A single feature row with an SF Symbol icon and a short label.
private struct FeatureRow: View {
    let icon: String
    let label: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .foregroundStyle(.tint)
                .frame(width: 20, alignment: .center)
            Text(label)
                .font(.callout)
        }
    }
}

// MARK: - GetStartedButton

/// Full-width primary action button that completes onboarding.
private struct GetStartedButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text("Get Started")
                .font(.headline)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
    }
}
