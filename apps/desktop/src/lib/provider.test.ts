import { describe, it, expect } from "vitest";
import { providerOf } from "$lib/provider";

describe("providerOf", () => {
  it("detects managed providers from name or server", () => {
    expect(providerOf("prod", "https://x.azmk8s.io:443")).toBe("AKS");
    expect(providerOf("eks-main", null)).toBe("EKS");
    expect(providerOf("gke_project_zone_name", null)).toBe("GKE");
    expect(providerOf("k3d-dev", null)).toBe("K3S");
    expect(providerOf("kind-kind", null)).toBe("KIND");
    expect(providerOf("minikube", "https://127.0.0.1:52443")).toBe("LOCAL");
  });

  it("falls back to K8S", () => {
    expect(providerOf("on-prem", "https://10.0.0.1:6443")).toBe("K8S");
  });
});
