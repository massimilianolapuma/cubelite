import XCTest

@testable import cubelite

// MARK: - Add File… validation (#450)
//
// `KubeconfigService.isKubeconfigFile(at:)` on real temp files, and the pure
// list logic of `KubeconfigPathsEditor` with injected predicate and defaults.

final class KubeconfigPathsEditorTests: XCTestCase {

    private let fm = FileManager.default
    private var tempDir: URL!

    override func setUp() {
        super.setUp()
        tempDir = fm.temporaryDirectory.appendingPathComponent(
            "cubelite-add-file-\(UUID().uuidString)"
        )
        try? fm.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? fm.removeItem(at: tempDir)
        super.tearDown()
    }

    private func write(_ name: String, _ contents: String) throws -> URL {
        let url = tempDir.appendingPathComponent(name)
        try contents.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    // MARK: - isKubeconfigFile

    func testIsKubeconfigFile_acceptsYAMLWithKindConfig() throws {
        let url = try write("good.yaml", "apiVersion: v1\nkind: Config\ncontexts: []\n")
        XCTAssertTrue(KubeconfigService.isKubeconfigFile(at: url))
    }

    func testIsKubeconfigFile_acceptsQuotedKind() throws {
        let url = try write("quoted.yaml", "apiVersion: v1\nkind: \"Config\"\n")
        XCTAssertTrue(KubeconfigService.isKubeconfigFile(at: url))
    }

    func testIsKubeconfigFile_acceptsJSONKubeconfig() throws {
        let url = try write("kc.json", #"{"apiVersion":"v1","kind":"Config","contexts":[]}"#)
        XCTAssertTrue(KubeconfigService.isKubeconfigFile(at: url))
    }

    /// kubectl sorts keys, so `kind` follows the inline certificate data.
    func testIsKubeconfigFile_acceptsKindAfterLongCertificateData() throws {
        let caData = String(repeating: "QUJD", count: 2_000)
        let contents = """
            apiVersion: v1
            clusters:
            - cluster:
                certificate-authority-data: \(caData)
                server: https://example.invalid:6443
              name: demo
            contexts: []
            kind: Config
            """
        let url = try write("kubectl-order.yaml", contents)
        XCTAssertTrue(KubeconfigService.isKubeconfigFile(at: url))
    }

    func testIsKubeconfigFile_rejectsJSONBlob() throws {
        let url = try write("blob.json", #"{"name":"not a kubeconfig","items":[1,2,3]}"#)
        XCTAssertFalse(KubeconfigService.isKubeconfigFile(at: url))
    }

    func testIsKubeconfigFile_rejectsOtherKind() throws {
        let url = try write("secret.yaml", "apiVersion: v1\nkind: Secret\ndata: {}\n")
        XCTAssertFalse(KubeconfigService.isKubeconfigFile(at: url))
    }

    func testIsKubeconfigFile_rejectsMissingKind() throws {
        let url = try write("no-kind.yaml", "apiVersion: v1\ncontexts: []\n")
        XCTAssertFalse(KubeconfigService.isKubeconfigFile(at: url))
    }

    func testIsKubeconfigFile_rejectsBrokenYAML() throws {
        let url = try write("broken.yaml", "kind: Config\ncontexts: [\n")
        XCTAssertFalse(KubeconfigService.isKubeconfigFile(at: url))
    }

    func testIsKubeconfigFile_rejectsDirectoryAndMissingFile() {
        XCTAssertFalse(KubeconfigService.isKubeconfigFile(at: tempDir))
        XCTAssertFalse(
            KubeconfigService.isKubeconfigFile(at: tempDir.appendingPathComponent("absent")))
    }

    // MARK: - KubeconfigPathsEditor.adding

    private let defaults = ["/home/u/.kube/config", "/home/u/.kube/lab"]

    private func add(
        _ picked: [String], to paths: [String], valid: Set<String>
    ) -> KubeconfigPathsAddition {
        KubeconfigPathsEditor.adding(
            picked.map { URL(fileURLWithPath: $0) },
            to: paths,
            defaults: { self.defaults },
            isKubeconfig: { valid.contains($0.path) }
        )
    }

    func testAdding_validFileToEmptyListSeedsDefaultsFirst() {
        let result = add(["/tmp/extra"], to: [], valid: ["/tmp/extra"])
        XCTAssertEqual(result.paths, defaults + ["/tmp/extra"])
        XCTAssertEqual(result.rejected, [])
    }

    func testAdding_onlyInvalidFilesLeavesEmptyListUntouched() {
        let result = add(["/tmp/blob.json"], to: [], valid: [])
        XCTAssertEqual(result.paths, [])
        XCTAssertEqual(result.rejected, ["/tmp/blob.json"])
    }

    func testAdding_mixAddsValidAndReportsInvalid() {
        let result = add(
            ["/tmp/a", "/tmp/blob.json", "/tmp/b"], to: ["/tmp/x"], valid: ["/tmp/a", "/tmp/b"])
        XCTAssertEqual(result.paths, ["/tmp/x", "/tmp/a", "/tmp/b"])
        XCTAssertEqual(result.rejected, ["/tmp/blob.json"])
    }

    func testAdding_skipsPathsAlreadyListedOrSeeded() {
        let existing = add(["/tmp/x"], to: ["/tmp/x"], valid: ["/tmp/x"])
        XCTAssertEqual(existing.paths, ["/tmp/x"])

        let seeded = add([defaults[1]], to: [], valid: [defaults[1]])
        XCTAssertEqual(seeded.paths, defaults)
    }

    // MARK: - rejectionMessage

    func testRejectionMessage_namesSingleFile() {
        let message = KubeconfigPathsEditor.rejectionMessage(for: ["/tmp/dir/blob.json"])
        XCTAssertTrue(message.hasPrefix("“blob.json” is not a kubeconfig file"))
        XCTAssertTrue(message.contains("kind: Config"))
    }

    func testRejectionMessage_listsEveryFile() {
        let message = KubeconfigPathsEditor.rejectionMessage(for: ["/a/one.json", "/b/two.yaml"])
        XCTAssertTrue(message.contains("“one.json”, “two.yaml”"))
    }
}
