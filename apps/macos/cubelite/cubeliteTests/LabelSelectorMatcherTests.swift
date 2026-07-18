import XCTest

@testable import cubelite

// MARK: - LabelSelectorMatcherTests

/// Tests the equality label-selector parser/matcher and the PodInfo
/// labels mapping it depends on.
final class LabelSelectorMatcherTests: XCTestCase {

    // MARK: - Parsing

    func testInit_parsesEqualityListWithWhitespace() {
        let matcher = LabelSelectorMatcher(" app=api, tier = web ")

        XCTAssertEqual(matcher.requirements, ["app": "api", "tier": "web"])
    }

    func testInit_splitsOnFirstEqualsOnly() {
        XCTAssertEqual(LabelSelectorMatcher("cfg=a=b").requirements, ["cfg": "a=b"])
    }

    func testInit_ignoresMalformedTokens() {
        let matcher = LabelSelectorMatcher("app=api, nonsense, =v, k=")

        XCTAssertEqual(matcher.requirements, ["app": "api"])
    }

    func testInit_emptyInput_hasNoRequirements() {
        XCTAssertTrue(LabelSelectorMatcher("").requirements.isEmpty)
        XCTAssertTrue(LabelSelectorMatcher("   ").requirements.isEmpty)
    }

    // MARK: - Matching

    func testMatches_subsetSemantics() {
        let matcher = LabelSelectorMatcher("app=api")

        XCTAssertTrue(matcher.matches(["app": "api", "tier": "web"]))
        XCTAssertFalse(matcher.matches(["app": "worker"]))
        XCTAssertFalse(matcher.matches(["tier": "web"]))
    }

    func testMatches_emptySelector_matchesEverything() {
        let matcher = LabelSelectorMatcher("")

        XCTAssertTrue(matcher.matches(["app": "api"]))
        XCTAssertTrue(matcher.matches([:]))
        XCTAssertTrue(matcher.matches(nil))
    }

    func testMatches_nilLabels_onlyWhenNoRequirements() {
        XCTAssertFalse(LabelSelectorMatcher("app=api").matches(nil))
    }

    // MARK: - PodInfo labels mapping

    func testToPodInfo_copiesLabels() {
        let pod = K8sPod(
            metadata: K8sObjectMeta(
                name: "api-1", namespace: "default", labels: ["app": "api"]))

        XCTAssertEqual(pod.toPodInfo().labels, ["app": "api"])
    }
}
