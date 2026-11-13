import { describe, it, expect } from "vitest";
import { containerRows, type PodUsage } from "#lib/container-usage.ts";
import type { ContainerResourcesInfo, PodMetricsInfo, QuantityInfo } from "#lib/tauri.ts";

const Mi = 1024 * 1024;
const Gi = 1024 * Mi;
const q = (text: string, amount: number | null): QuantityInfo => ({ text, amount });

/** api: cpu 250m / 500m, memory 256Mi / 512Mi. */
const API: ContainerResourcesInfo = {
  cpu: { request: q("250m", 250), limit: q("500m", 500) },
  memory: { request: q("256Mi", 256 * Mi), limit: q("512Mi", 512 * Mi) },
};

/** envoy: cpu request 100m only, nothing else. */
const ENVOY: ContainerResourcesInfo = {
  cpu: { request: q("100m", 100), limit: null },
  memory: { request: null, limit: null },
};

type Sample = { name: string; cpu_millis: number; memory_bytes: number };

function metrics(name: string, samples: Sample[]): PodMetricsInfo {
  return {
    name,
    namespace: "default",
    cpu_millis: samples.reduce((sum, c) => sum + c.cpu_millis, 0),
    memory_bytes: samples.reduce((sum, c) => sum + c.memory_bytes, 0),
    containers: samples,
  };
}

/**
 * A pod running `spec` (container name → its resources) with the given samples.
 * By default every sampled container runs with the template's resources.
 */
function pod(
  name: string,
  samples: Sample[],
  spec: Record<string, ContainerResourcesInfo> = { api: API, envoy: ENVOY },
): PodUsage {
  return {
    containers: Object.entries(spec).map(([container, resources]) => ({ name: container, resources })),
    metrics: metrics(name, samples),
  };
}

describe("containerRows", () => {
  it("gives a meter row with used of limit when a limit and a sample exist", () => {
    const [api] = containerRows(
      [{ name: "api", resources: API }],
      [pod("api-0", [{ name: "api", cpu_millis: 260, memory_bytes: 498 * Mi }])],
    );
    expect(api.rows[0]).toEqual({
      resource: "cpu",
      label: "CPU",
      percent: 52,
      meter: true,
      detail: "260m of 500m · request 250m",
    });
    expect(api.rows[1].resource).toBe("memory");
    expect(api.rows[1].label).toBe("MEM");
    expect(api.rows[1].meter).toBe(true);
    expect(api.rows[1].percent).toBeCloseTo(97.27, 1);
    expect(api.rows[1].detail).toBe("498Mi of 512Mi · request 256Mi");
  });

  it("takes the highest pod per container and per resource", () => {
    const [api] = containerRows(
      [{ name: "api", resources: API }],
      [
        pod("a", [{ name: "api", cpu_millis: 100, memory_bytes: 300 * Mi }]),
        pod("b", [{ name: "api", cpu_millis: 400, memory_bytes: 200 * Mi }]),
      ],
    );
    expect(api.rows[0].detail).toBe("400m of 500m · request 250m");
    expect(api.rows[0].percent).toBe(80);
    expect(api.rows[1].detail).toBe("300Mi of 512Mi · request 256Mi");
  });

  it("counts only pods whose container has the template's limit", () => {
    // The pod of the current ReplicaSet; one of the previous ReplicaSet with
    // limits 2 / 2Gi, close to them; one whose container has no limit at all.
    const OLD: ContainerResourcesInfo = {
      cpu: { request: q("1", 1000), limit: q("2", 2000) },
      memory: { request: q("1Gi", Gi), limit: q("2Gi", 2 * Gi) },
    };
    const [api] = containerRows(
      [{ name: "api", resources: API }],
      [
        pod("api-new", [{ name: "api", cpu_millis: 120, memory_bytes: 200 * Mi }]),
        pod("api-old", [{ name: "api", cpu_millis: 1800, memory_bytes: 1900 * Mi }], { api: OLD }),
        pod("api-unlimited", [{ name: "api", cpu_millis: 3000, memory_bytes: 3 * Gi }], { api: ENVOY }),
      ],
    );
    expect(api.rows[0].detail).toBe("120m of 500m · request 250m");
    expect(api.rows[0].percent).toBe(24);
    expect(api.rows[1].detail).toBe("200Mi of 512Mi · request 256Mi");
  });

  it("compares the limit per resource, by amount, and needs the pod's own container with resources", () => {
    // Same CPU limit written another way (0.5 = 500m), another memory limit.
    const halfCore: ContainerResourcesInfo = {
      cpu: { request: q("0.25", 250), limit: q("0.5", 500) },
      memory: { request: q("256Mi", 256 * Mi), limit: q("1Gi", Gi) },
    };
    const [api] = containerRows(
      [{ name: "api", resources: API }],
      [
        pod("a", [{ name: "api", cpu_millis: 300, memory_bytes: 900 * Mi }], { api: halfCore }),
        // The pod's container has no `resources` (an older core): it does not count.
        { containers: [{ name: "api" }], metrics: metrics("b", [{ name: "api", cpu_millis: 490, memory_bytes: 500 * Mi }]) },
        // The pod has no container of that name: it does not count.
        pod("c", [{ name: "api", cpu_millis: 480, memory_bytes: 500 * Mi }], { other: API }),
        // No containers at all: it does not count.
        { metrics: metrics("d", [{ name: "api", cpu_millis: 470, memory_bytes: 500 * Mi }]) },
      ],
    );
    expect(api.rows[0].detail).toBe("300m of 500m · request 250m");
    expect(api.rows[1].detail).toBe("limit 512Mi · request 256Mi");
  });

  it("counts a pod whose container has no limit for a template container with none", () => {
    const [envoy] = containerRows(
      [{ name: "envoy", resources: ENVOY }],
      [pod("a", [{ name: "envoy", cpu_millis: 38, memory_bytes: 41 * Mi }])],
    );
    expect(envoy.rows[0].detail).toBe("38m used · request 100m · no limit");
  });

  it("words a missing request, a missing limit and a missing sample", () => {
    const sample = [pod("api-0", [{ name: "envoy", cpu_millis: 38, memory_bytes: 41 * Mi }])];

    const [withSample] = containerRows([{ name: "envoy", resources: ENVOY }], sample);
    expect(withSample.rows[0]).toEqual({
      resource: "cpu",
      label: "CPU",
      percent: null,
      meter: false,
      detail: "38m used · request 100m · no limit",
    });
    expect(withSample.rows[1].detail).toBe("41Mi used · no request · no limit");

    const [noSample] = containerRows([{ name: "envoy", resources: ENVOY }], []);
    expect(noSample.rows[1]).toEqual({
      resource: "memory",
      label: "MEM",
      percent: null,
      meter: false,
      detail: "no request · no limit",
    });
    expect(noSample.rows[0].detail).toBe("request 100m · no limit");

    const [limitNoSample] = containerRows([{ name: "api", resources: API }], []);
    expect(limitNoSample.rows[0]).toEqual({
      resource: "cpu",
      label: "CPU",
      percent: null,
      meter: true,
      detail: "limit 500m · request 250m",
    });

    const limitOnly: ContainerResourcesInfo = {
      cpu: { request: null, limit: q("500m", 500) },
      memory: { request: null, limit: null },
    };
    const [noRequest] = containerRows(
      [{ name: "api", resources: limitOnly }],
      [pod("api-0", [{ name: "api", cpu_millis: 260, memory_bytes: 0 }], { api: limitOnly })],
    );
    expect(noRequest.rows[0].detail).toBe("260m of 500m · no request");
    expect(noRequest.rows[0].percent).toBe(52);
  });

  it("has no percent for a limit of 0 or a limit it cannot read, and 100 above the limit", () => {
    const samples = [{ name: "api", cpu_millis: 650, memory_bytes: 498 * Mi }];

    const zero: ContainerResourcesInfo = {
      cpu: { request: null, limit: q("0", 0) },
      memory: { request: q("256Mi", 256 * Mi), limit: q("1Xi", null) },
    };
    const [api] = containerRows([{ name: "api", resources: zero }], [pod("api-0", samples, { api: zero })]);
    expect(api.rows[0].meter).toBe(true);
    expect(api.rows[0].percent).toBeNull();
    expect(api.rows[1]).toEqual({
      resource: "memory",
      label: "MEM",
      percent: null,
      meter: true,
      detail: "498Mi of 1Xi · request 256Mi",
    });

    const [over] = containerRows([{ name: "api", resources: API }], [pod("api-0", samples)]);
    expect(over.rows[0].percent).toBe(100);
    expect(over.rows[0].detail).toBe("650m of 500m · request 250m");
  });

  it("ignores metrics of a container the spec does not have, and pods without metrics", () => {
    const rows = containerRows(
      [{ name: "api", resources: API }],
      [
        { containers: [{ name: "api", resources: API }], metrics: null },
        pod("api-0", [{ name: "istio-proxy", cpu_millis: 90, memory_bytes: 60 * Mi }]),
      ],
    );
    expect(rows.map((c) => c.name)).toEqual(["api"]);
    expect(rows[0].rows[0].percent).toBeNull();
    expect(rows[0].rows[0].detail).toBe("limit 500m · request 250m");
    expect(rows[0].rows[1].detail).toBe("limit 512Mi · request 256Mi");
  });

  it("skips containers without a resources field and pod metrics without containers", () => {
    expect(containerRows([{ name: "old" }], [])).toEqual([]);

    const older: PodMetricsInfo = {
      name: "api-0",
      namespace: "default",
      cpu_millis: 260,
      memory_bytes: 498 * Mi,
    };
    const [api] = containerRows(
      [{ name: "old" }, { name: "api", resources: API }],
      [{ containers: [{ name: "api", resources: API }], metrics: older }],
    );
    expect(api.name).toBe("api");
    expect(api.rows[0].percent).toBeNull();
    expect(api.rows[0].detail).toBe("limit 500m · request 250m");
  });

  it("keeps the sidecar flag", () => {
    const rows = containerRows(
      [
        { name: "api", resources: API },
        { name: "mesh", sidecar: true, resources: ENVOY },
      ],
      [],
    );
    expect(rows.map((c) => [c.name, c.sidecar])).toEqual([
      ["api", false],
      ["mesh", true],
    ]);
  });
});
