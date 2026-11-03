import { describe, it, expect } from "vitest";
import {
  NAMESPACE_HISTORY_HINT,
  SELECTOR_HISTORY_HINT,
  logsHistoryMapping,
  scopeKey,
  scopeMatcher,
  workloadPodsSource,
  type LogScope,
} from "./log-scope";

const SAFE = "[bcdfghjklmnpqrstvwxz2456789]";

function scope(kind: LogScope["workload"]["kind"], name: string, namespace = "shop"): LogScope {
  return { namespace, workload: { kind, name } };
}

function matches(s: LogScope, name: string, namespace = "shop"): boolean {
  return scopeMatcher(s)({ namespace, name });
}

describe("workload pod regexps (#529, same as the core's)", () => {
  it("builds the core's sources per kind", () => {
    expect(workloadPodsSource({ kind: "deployment", name: "api" })).toBe(`api-${SAFE}{6,10}-${SAFE}{5}`);
    expect(workloadPodsSource({ kind: "stateful-set", name: "db" })).toBe("db-[0-9]+");
    expect(workloadPodsSource({ kind: "daemon-set", name: "agent" })).toBe(`agent-${SAFE}{5}`);
    expect(workloadPodsSource({ kind: "job", name: "migrate" })).toBe(`migrate-${SAFE}{5}`);
    expect(workloadPodsSource({ kind: "deployment", name: "a.b" })).toMatch(/^a\\\.b-/);
  });

  it("matches a workload's pods and never a sibling workload's", () => {
    const api = scope("deployment", "api");
    expect(matches(api, "api-7d9f8b6c5-x7k2p")).toBe(true);
    expect(matches(api, "api-gateway-7d9f8b6c5-x7k2p")).toBe(false);
    expect(matches(api, "api-0")).toBe(false);
    expect(matches(api, "api-7d9f8b6c5-x7k2p", "other")).toBe(false);

    const db = scope("stateful-set", "db");
    expect(matches(db, "db-0")).toBe(true);
    expect(matches(db, "db-backup-0")).toBe(false);

    const agent = scope("daemon-set", "agent");
    expect(matches(agent, "agent-x7k2p")).toBe(true);
    expect(matches(agent, "agent-metrics-x7k2p")).toBe(false);

    const job = scope("job", "migrate");
    expect(matches(job, "migrate-x7k2p")).toBe(true);
    expect(matches(job, "migrate-28374652-x7k2p")).toBe(false);
  });

  it("cuts long generated names at 58 characters", () => {
    const long = "d".repeat(70);
    expect(matches(scope("daemon-set", long), `${"d".repeat(58)}x7k2p`)).toBe(true);
    expect(matches(scope("deployment", long), `${"d".repeat(58)}x7k2p`)).toBe(true);
  });
});

describe("Logs view → history query (#529)", () => {
  it("a workload scope searches its pods in its namespace", () => {
    const s = scope("deployment", "api");
    expect(logsHistoryMapping(null, s, "")).toEqual({ namespace: "shop", target: s.workload, reason: null });
  });

  it("a namespace without a workload searches every pod of it", () => {
    expect(logsHistoryMapping("shop", null, "  ")).toEqual({ namespace: "shop", target: null, reason: null });
  });

  it("refuses what history cannot express", () => {
    expect(logsHistoryMapping("shop", scope("job", "migrate"), "app=api").reason).toBe(SELECTOR_HISTORY_HINT);
    expect(logsHistoryMapping(null, null, "").reason).toBe(NAMESPACE_HISTORY_HINT);
  });

  it("keys scopes by kind, namespace and name", () => {
    expect(scopeKey(scope("stateful-set", "db"))).toBe("stateful-set:shop/db");
  });
});
