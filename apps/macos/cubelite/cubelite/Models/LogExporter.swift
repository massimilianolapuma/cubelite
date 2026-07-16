import Foundation

/// Writes a log buffer to disk (`<pod>_<container>[_full].log`).
enum LogExporter {

    static func filename(pod: String, container: String?, full: Bool) -> String {
        var name = pod
        if let container { name += "_\(container)" }
        if full { name += "_full" }
        return name + ".log"
    }

    /// Plain-text rendering: `time message` per line, bare message when the
    /// line carried no timestamp prefix.
    static func content(_ lines: [LogLine]) -> String {
        lines.map { line in
            if let time = line.time {
                "\(time) \(line.message)\n"
            } else {
                "\(line.message)\n"
            }
        }.joined()
    }

    @discardableResult
    static func write(
        _ lines: [LogLine], pod: String, container: String?, full: Bool, directory: URL
    ) throws -> URL {
        let url = directory.appendingPathComponent(
            filename(pod: pod, container: container, full: full))
        try content(lines).write(to: url, atomically: true, encoding: .utf8)
        return url
    }
}
