import Foundation

/// Writes a log buffer to disk (`<pod>_<container>[_full].log`, or
/// `.ndjson` with one ECS document per line in ECS mode, #493).
enum LogExporter {

    static func filename(pod: String, container: String?, full: Bool, ecs: Bool = false) -> String {
        var name = pod
        if let container { name += "_\(container)" }
        if full { name += "_full" }
        return name + (ecs ? ".ndjson" : ".log")
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

    /// Writes `lines` as text, or as NDJSON ECS documents when `ecs` gives
    /// each line's Kubernetes metadata.
    @discardableResult
    static func write(
        _ lines: [LogLine], pod: String, container: String?, full: Bool, directory: URL,
        ecs: ((LogLine) -> ECSDocument.Metadata)? = nil
    ) throws -> URL {
        let url = directory.appendingPathComponent(
            filename(pod: pod, container: container, full: full, ecs: ecs != nil))
        let text = ecs.map { ECSDocument.ndjson(lines, metadata: $0) } ?? content(lines)
        try text.write(to: url, atomically: true, encoding: .utf8)
        return url
    }
}
