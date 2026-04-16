import XCTest
import SwiftUI
@testable import cubelite

// MARK: - DeploymentDetailTests

final class DeploymentDetailTests: XCTestCase {

    // MARK: - toDeploymentInfo: Field Extraction

    func testToDeploymentInfo_extractsDeploymentName() {
        let dep = makeK8sDeployment(name: "my-deployment")
        XCTAssertEqual(dep.toDeploymentInfo().name, "my-deployment")
    }

    func testToDeploymentInfo_extractsNamespace() {
        let dep = makeK8sDeployment(namespace: "production")
        XCTAssertEqual(dep.toDeploymentInfo().namespace, "production")
    }

    func testToDeploymentInfo_extractsStrategy() {
        let dep = makeK8sDeployment(strategy: "Recreate")
        XCTAssertEqual(dep.toDeploymentInfo().strategy, "Recreate")
    }

    func testToDeploymentInfo_extractsSelector() {
        let labels = ["app": "api", "tier": "backend"]
        let dep = makeK8sDeployment(matchLabels: labels)
        XCTAssertEqual(dep.toDeploymentInfo().selector, labels)
    }

    func testToDeploymentInfo_extractsCreationTimestamp() {
        let ts = "2024-06-01T12:00:00Z"
        let dep = makeK8sDeployment(creationTimestamp: ts)
        XCTAssertEqual(dep.toDeploymentInfo().creationTimestamp, ts)
    }

    func testToDeploymentInfo_extractsAvailableAndUnavailableReplicas() {
        let dep = makeK8sDeployment(replicas: 3, readyReplicas: 2, availableReplicas: 2, unavailableReplicas: 1)
        let info = dep.toDeploymentInfo()
        XCTAssertEqual(info.availableReplicas, 2)
        XCTAssertEqual(info.unavailableReplicas, 1)
    }

    func testToDeploymentInfo_extractsConditions_countAndFields() {
        let conditions: [K8sDeploymentCondition] = [
            K8sDeploymentCondition(type: "Available", status: "True", reason: "MinAvail", message: nil, lastTransitionTime: nil),
            K8sDeploymentCondition(type: "Progressing", status: "True", reason: "NewReplicaSet", message: nil, lastTransitionTime: nil),
        ]
        let dep = makeK8sDeployment(conditions: conditions)
        let info = dep.toDeploymentInfo()

        XCTAssertEqual(info.conditions?.count, 2)
        XCTAssertEqual(info.conditions?.first?.type, "Available")
        XCTAssertEqual(info.conditions?.first?.status, "True")
        XCTAssertEqual(info.conditions?.first?.reason, "MinAvail")
        XCTAssertEqual(info.conditions?[1].type, "Progressing")
    }

    func testToDeploymentInfo_conditionsWithNilTypeAreDropped() {
        let conditions: [K8sDeploymentCondition] = [
            K8sDeploymentCondition(type: nil, status: "True", reason: nil, message: nil, lastTransitionTime: nil),
            K8sDeploymentCondition(type: "Available", status: "True", reason: nil, message: nil, lastTransitionTime: nil),
        ]
        let dep = makeK8sDeployment(conditions: conditions)
        let info = dep.toDeploymentInfo()

        XCTAssertEqual(info.conditions?.count, 1)
        XCTAssertEqual(info.conditions?.first?.type, "Available")
    }

    func testToDeploymentInfo_emptyConditionsArray_returnsNilConditions() {
        let dep = makeK8sDeployment(conditions: [])
        XCTAssertNil(dep.toDeploymentInfo().conditions)
    }

    // MARK: - toDeploymentInfo: Nil / Default Values

    func testToDeploymentInfo_nilSpec_defaultsReplicasToZero() {
        let dep = K8sDeployment(metadata: nil, spec: nil, status: nil)
        let info = dep.toDeploymentInfo()
        XCTAssertEqual(info.replicas, 0)
        XCTAssertEqual(info.readyReplicas, 0)
    }

    func testToDeploymentInfo_nilSpec_returnsNilStrategy() {
        let dep = K8sDeployment(metadata: nil, spec: nil, status: nil)
        XCTAssertNil(dep.toDeploymentInfo().strategy)
    }

    func testToDeploymentInfo_nilSpec_returnsNilSelector() {
        let dep = K8sDeployment(metadata: nil, spec: nil, status: nil)
        XCTAssertNil(dep.toDeploymentInfo().selector)
    }

    func testToDeploymentInfo_nilStatus_returnsNilConditions() {
        let dep = K8sDeployment(
            metadata: K8sObjectMeta(name: "x", namespace: "default", creationTimestamp: nil),
            spec: nil,
            status: nil
        )
        XCTAssertNil(dep.toDeploymentInfo().conditions)
    }

    func testToDeploymentInfo_nilMetadata_usesEmptyStrings() {
        let dep = K8sDeployment(metadata: nil, spec: nil, status: nil)
        let info = dep.toDeploymentInfo()
        XCTAssertEqual(info.name, "")
        XCTAssertEqual(info.namespace, "")
    }

    // MARK: - Condition Status Color Mapping

    func testConditionStatusColor_trueIsGreen() {
        XCTAssertEqual(Color.conditionStatus("True"), Color.green)
    }

    func testConditionStatusColor_falseIsRed() {
        XCTAssertEqual(Color.conditionStatus("False"), Color.red)
    }

    func testConditionStatusColor_unknownIsOrange() {
        XCTAssertEqual(Color.conditionStatus("Unknown"), Color.orange)
    }

    func testConditionStatusColor_unrecognisedValueIsOrange() {
        XCTAssertEqual(Color.conditionStatus(""), Color.orange)
        XCTAssertEqual(Color.conditionStatus("maybe"), Color.orange)
    }

    // MARK: - Helpers

    private func makeK8sDeployment(
        name: String = "test-deployment",
        namespace: String = "default",
        strategy: String? = nil,
        replicas: Int? = nil,
        readyReplicas: Int? = nil,
        matchLabels: [String: String]? = nil,
        creationTimestamp: String? = nil,
        conditions: [K8sDeploymentCondition]? = nil,
        availableReplicas: Int? = nil,
        unavailableReplicas: Int? = nil
    ) -> K8sDeployment {
        K8sDeployment(
            metadata: K8sObjectMeta(name: name, namespace: namespace, creationTimestamp: creationTimestamp),
            spec: K8sDeploymentSpec(
                replicas: replicas,
                strategy: strategy.map { K8sDeploymentStrategy(type: $0) },
                selector: matchLabels.map { K8sLabelSelector(matchLabels: $0) }
            ),
            status: K8sDeploymentStatus(
                readyReplicas: readyReplicas,
                availableReplicas: availableReplicas,
                unavailableReplicas: unavailableReplicas,
                conditions: conditions
            )
        )
    }
}
