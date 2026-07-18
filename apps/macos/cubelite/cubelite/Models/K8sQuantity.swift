import Foundation

/// Parses Kubernetes resource quantity strings (CPU cores and byte sizes).
///
/// Covers the forms the API actually emits: CPU as bare cores ("2"),
/// millicores ("250m"), microcores ("1500u"), nanocores from
/// metrics-server ("156340607n"); memory with binary (Ki/Mi/Gi/Ti/Pi/Ei)
/// or decimal (k/M/G/T/P/E) suffixes, bare bytes, and exponent notation.
enum K8sQuantity {

    /// Parses a CPU quantity to cores. Returns nil on unparseable input.
    static func cpuCores(_ text: String) -> Double? {
        let t = text.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return nil }
        let scales: [Character: Double] = ["n": 1e-9, "u": 1e-6, "m": 1e-3]
        if let last = t.last, let scale = scales[last] {
            guard let value = Double(t.dropLast()) else { return nil }
            return value * scale
        }
        return Double(t)
    }

    /// Parses a memory/storage quantity to bytes. Returns nil on
    /// unparseable input.
    static func bytes(_ text: String) -> Double? {
        let t = text.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return nil }
        let binary: [String: Double] = [
            "Ki": 1024, "Mi": 1_048_576, "Gi": 1_073_741_824,
            "Ti": pow(1024, 4), "Pi": pow(1024, 5), "Ei": pow(1024, 6),
        ]
        for (suffix, multiplier) in binary where t.hasSuffix(suffix) {
            guard let value = Double(t.dropLast(2)) else { return nil }
            return value * multiplier
        }
        let decimal: [Character: Double] = [
            "k": 1e3, "M": 1e6, "G": 1e9, "T": 1e12, "P": 1e15, "E": 1e18,
        ]
        if let last = t.last, let multiplier = decimal[last] {
            guard let value = Double(t.dropLast()) else { return nil }
            return value * multiplier
        }
        return Double(t)
    }
}
