import { describe, it, expect } from "vitest";
import { containerRows } from "#lib/container-usage.ts";
import type { ContainerResourcesInfo, PodMetricsInfo, QuantityInfo } from "#lib/tauri.ts";

const Mi = 1024 * 1024;
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

function pod(
  name: string,
  containers: { name: string; cpu_millis: number; memory_bytes: number }[],
): PodMetricsInfo {
  return {
    name,
    namespace: "default",
    cpu_millis: containers.reduce((sum, c) => sum + c.cpu_millis, 0),
    memory_bytes: containers.reduce((sum, c) => sum + c.memory_bytes, 0),
    containers,
  };
}

describe("containerRows", () => {
  it("gives a meter row with used of limit when a limit and a sample exist", () => {
    const [api] = containerRows(
      [{ name: "api", resources: API }],
      [
        {
          name: "api-0",
          namespace: "default",
          cpu_millis: 260,
          memory_bytes: 498 * Mi,
          containers: [{ name: "api", cpu_millis: 260, memory_bytes: 498 * Mi }],
        },
      ],
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
      [pod("api-0", [{ name: "api", cpu_millis: 260, memory_bytes: 0 }])],
    );
    expect(noRequest.rows[0].detail).toBe("260m of 500m · no request");
    expect(noRequest.rows[0].percent).toBe(52);
  });

  it("has no percent for a limit of 0 or a limit it cannot read, and 100 above the limit", () => {
    const sample = [pod("api-0", [{ name: "api", cpu_millis: 650, memory_bytes: 498 * Mi }])];

    const zero: ContainerResourcesInfo = {
      cpu: { request: null, limit: q("0", 0) },
      memory: { request: q("256Mi", 256 * Mi), limit: q("1Xi", null) },
    };
    const [api] = containerRows([{ name: "api", resources: zero }], sample);
    expect(api.rows[0].meter).toBe(true);
    expect(api.rows[0].percent).toBeNull();
    expect(Number.isFinite(api.rows[0].percent ?? 0)).toBe(true);
    expect(api.rows[1]).toEqual({
      resource: "memory",
      label: "MEM",
      percent: null,
      meter: true,
      detail: "498Mi of 1Xi · request 256Mi",
    });

    const [over] = containerRows([{ name: "api", resources: API }], sample);
    expect(over.rows[0].percent).toBe(100);
    expect(over.rows[0].detail).toBe("650m of 500m · request 250m");
  });

  it("ignores metrics of a container the spec does not have, and null pods", () => {
    const rows = containerRows(
      [{ name: "api", resources: API }],
      [null, pod("api-0", [{ name: "istio-proxy", cpu_millis: 90, memory_bytes: 60 * Mi }])],
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
    const [api] = containerRows([{ name: "old" }, { name: "api", resources: API }], [older]);
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
