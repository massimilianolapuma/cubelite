import XCTest

@testable import cubelite

// MARK: - KubeconfigRedefinitionsTests

/// The Preferences "defined differently in an earlier file" note (#543).
/// The parity fixture shared with `cubelite-core`, so the desktop and native
/// apps show the same note, is the `redefinitions-parity` case of
/// `testdata/kubeconfig` (`KubeconfigFixturesTests`, #548).
final class KubeconfigRedefinitionsTests: XCTestCase {

    private var tempDir: URL?

    override func tearDown() async throws {
        if let tempDir {
            try? FileManager.default.removeItem(at: tempDir)
        }
    }

    func testRelativePathsInTheSameDirectory_areTheSameFile() throws {
        let yaml = """
            clusters:
            - name: c
              cluster:
                server: https://c.example
                certificate-authority: ca.crt
            """
        let first = try write("a/config", yaml)
        let second = try write("a/other", yaml)

        XCTAssertEqual(KubeconfigService.redefinitions(in: [first, second]), [])
    }

    /// Anchors that expand to a million nodes ("billion laughs"): ignored
    /// cluster keys are never converted, and a user over the node budget
    /// skips its file instead of stalling Preferences.
    func testAliasBomb_ignoredKeysAreSkipped_andOverBudgetFilesGetNoNote() throws {
        let first = try write(
            "a",
            """
            clusters:
            - name: c
              cluster:
                server: https://one.example
            users:
            - name: u
              user:
                token: one
            """)
        let bombInExtensions = try write(
            "b", Self.bomb + "\nclusters:\n- name: c\n  cluster:\n    server: https://two.example\n"
                + "    extensions: *f\n")
        let bombInUser = try write(
            "c", Self.bomb + "\nusers:\n- name: u\n  user:\n    token: three\n    extra: *f\n")

        let started = Date()
        let found = KubeconfigService.redefinitions(in: [first, bombInExtensions, bombInUser])

        XCTAssertEqual(
            found, [KubeconfigRedefinition(path: bombInExtensions.path, clusters: ["c"], users: [])])
        XCTAssertLessThan(Date().timeIntervalSince(started), 10)
    }

    func testOversizedFile_isNotRead() throws {
        let first = try write("a", "users:\n- name: u\n  user:\n    token: one\n")
        let big = try write("b", "users:\n- name: u\n  user:\n    token: two\n")
        let handle = try FileHandle(forWritingTo: big)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(repeating: 0x0A, count: KubeconfigService.maxKubeconfigFileSize))
        try handle.close()

        XCTAssertEqual(KubeconfigService.redefinitions(in: [first, big]), [])
        // The same content under the cap is reported.
        let small = try write("c", "users:\n- name: u\n  user:\n    token: two\n")
        XCTAssertEqual(KubeconfigService.redefinitions(in: [first, small]).map(\.users), [["u"]])
    }

    /// A FIFO or a device in the list is skipped, never opened: reading one
    /// would block or never end.
    func testNonRegularFiles_areSkipped() throws {
        let first = try write("a", "users:\n- name: u\n  user:\n    token: one\n")
        let fifo = first.deletingLastPathComponent().appendingPathComponent("fifo")
        XCTAssertEqual(mkfifo(fifo.path, 0o600), 0)
        let device = URL(fileURLWithPath: "/dev/zero")

        let started = Date()
        XCTAssertEqual(KubeconfigService.redefinitions(in: [first, fifo, device]), [])
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
    }

    /// `*f` expands to 10^6 scalars.
    private static let bomb = """
        a: &a [x, x, x, x, x, x, x, x, x, x]
        b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]
        c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]
        d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]
        e: &e [*d, *d, *d, *d, *d, *d, *d, *d, *d, *d]
        f: &f [*e, *e, *e, *e, *e, *e, *e, *e, *e, *e]
        """

    func testCAChange_andUnparseableOrMissingFiles() throws {
        let first = try write("a", "clusters:\n- name: c\n  cluster:\n    server: s\n    certificate-authority-data: T0xE\n")
        let broken = try write("broken", "{ not yaml: [")
        let second = try write("b", "clusters:\n- name: c\n  cluster:\n    server: s\n    certificate-authority-data: TkVX\n")
        let missing = first.deletingLastPathComponent().appendingPathComponent("missing")

        let found = KubeconfigService.redefinitions(in: [first, broken, missing, second])

        XCTAssertEqual(found.map(\.clusters), [["c"]])
        XCTAssertEqual(found.first?.path, second.path)
    }

    func testSummary_namesClustersThenUsers() {
        let note = KubeconfigRedefinition(path: "/p", clusters: ["c"], users: ["u"])
        XCTAssertEqual(
            note.summary,
            "Also defined differently in an earlier file: cluster c, user u."
                + " Contexts in this file use this file's definition.")
    }

    // MARK: - Helpers

    private func write(_ relative: String, _ contents: String) throws -> URL {
        let root: URL
        if let tempDir {
            root = tempDir
        } else {
            root = FileManager.default.temporaryDirectory
                .appendingPathComponent("redefinitions-\(UUID().uuidString)")
            tempDir = root
        }
        let url = root.appendingPathComponent(relative)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try contents.write(to: url, atomically: true, encoding: .utf8)
        return url
    }
}
