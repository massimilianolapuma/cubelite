import Foundation

/// Pure parsing/validation for the port-forward input fields.
///
/// Kept UI-free so the rules are unit-testable: ports are integers in
/// 1–65535; the local field may be left empty to mirror the remote port.
enum PortForwardInput {

    /// Parses a user-entered port. Returns nil unless the trimmed text is
    /// an integer in 1...65535.
    static func parsePort(_ text: String) -> Int? {
        guard let value = Int(text.trimmingCharacters(in: .whitespaces)),
            (1...65535).contains(value)
        else { return nil }
        return value
    }

    /// Resolves the local port field: empty mirrors `remotePort`, anything
    /// else must itself be a valid port.
    static func resolveLocalPort(_ text: String, remotePort: Int) -> UInt16? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return UInt16(exactly: remotePort) }
        guard let value = parsePort(trimmed) else { return nil }
        return UInt16(exactly: value)
    }
}
