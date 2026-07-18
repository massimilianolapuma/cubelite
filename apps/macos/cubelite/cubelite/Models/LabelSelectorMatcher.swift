import Foundation

/// Equality-based label selector ("app=api, tier=web") with subset
/// matching semantics.
///
/// Malformed tokens (no key, no value, no "=") are ignored; values may
/// themselves contain "=". An empty selector matches everything.
struct LabelSelectorMatcher: Equatable {

    /// Parsed key → required value.
    let requirements: [String: String]

    init(_ text: String) {
        var parsed: [String: String] = [:]
        for token in text.split(separator: ",") {
            guard let eq = token.firstIndex(of: "=") else { continue }
            let key = token[token.startIndex..<eq].trimmingCharacters(in: .whitespaces)
            let value = token[token.index(after: eq)...].trimmingCharacters(in: .whitespaces)
            guard !key.isEmpty, !value.isEmpty else { continue }
            parsed[key] = value
        }
        requirements = parsed
    }

    /// True when every requirement is present in `labels`. An empty
    /// selector matches all pods, including ones without labels.
    func matches(_ labels: [String: String]?) -> Bool {
        guard !requirements.isEmpty else { return true }
        guard let labels else { return false }
        return requirements.allSatisfy { labels[$0.key] == $0.value }
    }
}
