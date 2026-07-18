import XCTest

@testable import cubelite

// MARK: - K8sQuantityTests

/// Tests the Kubernetes resource-quantity parser (CPU cores and byte sizes).
final class K8sQuantityTests: XCTestCase {

    // MARK: - cpuCores

    func testCpuCores_millicores_scales() {
        XCTAssertEqual(K8sQuantity.cpuCores("250m"), 0.25)
    }

    func testCpuCores_bareCores_parses() {
        XCTAssertEqual(K8sQuantity.cpuCores("2"), 2.0)
    }

    func testCpuCores_nanocores_scales() {
        XCTAssertEqual(K8sQuantity.cpuCores("156340607n")!, 0.156340607, accuracy: 1e-9)
    }

    func testCpuCores_microcores_scales() {
        XCTAssertEqual(K8sQuantity.cpuCores("1500u")!, 0.0015, accuracy: 1e-9)
    }

    func testCpuCores_invalid_isNil() {
        XCTAssertNil(K8sQuantity.cpuCores(""))
        XCTAssertNil(K8sQuantity.cpuCores("abc"))
        XCTAssertNil(K8sQuantity.cpuCores("m"))
    }

    // MARK: - bytes

    func testBytes_binarySuffixes_scale() {
        XCTAssertEqual(K8sQuantity.bytes("1129164Ki"), 1_129_164 * 1024.0)
        XCTAssertEqual(K8sQuantity.bytes("512Mi"), 512 * 1_048_576.0)
        XCTAssertEqual(K8sQuantity.bytes("3Gi"), 3 * 1_073_741_824.0)
    }

    func testBytes_decimalSuffixes_scale() {
        XCTAssertEqual(K8sQuantity.bytes("1500k"), 1_500_000.0)
        XCTAssertEqual(K8sQuantity.bytes("2G"), 2_000_000_000.0)
    }

    func testBytes_bareAndExponent_parse() {
        XCTAssertEqual(K8sQuantity.bytes("12345"), 12345.0)
        XCTAssertEqual(K8sQuantity.bytes("123e6"), 123_000_000.0)
    }

    func testBytes_invalid_isNil() {
        XCTAssertNil(K8sQuantity.bytes(""))
        XCTAssertNil(K8sQuantity.bytes("lots"))
        XCTAssertNil(K8sQuantity.bytes("Gi"))
    }
}
