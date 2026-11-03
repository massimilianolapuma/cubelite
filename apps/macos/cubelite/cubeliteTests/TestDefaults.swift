import Foundation

/// A UserDefaults domain of its own for one test class, emptied on each
/// call: parallel test processes never share `UserDefaults.standard` (#482).
enum TestDefaults {
    static func fresh(for owner: Any.Type) -> UserDefaults {
        let name = "cubelite.tests.\(String(reflecting: owner))"
        guard let defaults = UserDefaults(suiteName: name) else { return .standard }
        defaults.removePersistentDomain(forName: name)
        return defaults
    }
}
