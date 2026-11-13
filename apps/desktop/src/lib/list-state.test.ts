import { describe, expect, it } from "vitest";
import { listState, type ListInput } from "./list-state";

const base: ListInput = {
  nouns: ["pod", "pods"],
  namespace: "payments",
  loaded: true,
  error: null,
  total: 3,
  shown: 3,
};

describe("listState", () => {
  it("is ready when rows are shown", () => {
    expect(listState(base)).toEqual({ kind: "ready" });
  });

  it("is loading until the first load of this scope has finished, never empty", () => {
    expect(listState({ ...base, loaded: false, total: 0, shown: 0 })).toEqual({ kind: "loading" });
  });

  it("is loading rather than showing rows kept from another scope", () => {
    expect(listState({ ...base, loaded: false })).toEqual({ kind: "loading" });
  });

  it("names the namespace in the empty state", () => {
    expect(listState({ ...base, total: 0, shown: 0 })).toEqual({
      kind: "empty",
      title: "No pods in payments",
      hint: "Other namespaces may have some: change the namespace in the top bar.",
    });
  });

  it("says any namespace when all namespaces are shown", () => {
    const state = listState({ ...base, namespace: null, total: 0, shown: 0 });
    expect(state).toMatchObject({ kind: "empty", title: "No pods in any namespace" });
  });

  it("says this cluster for a cluster-scoped kind, whatever namespace is selected", () => {
    const state = listState({ ...base, nouns: ["node", "nodes"], namespaced: false, total: 0, shown: 0 });
    expect(state).toEqual({
      kind: "empty",
      title: "No nodes in this cluster",
      hint: "They show up here as soon as one exists.",
    });
  });

  it("quotes the filter text when it matches nothing", () => {
    expect(listState({ ...base, shown: 0, filter: "  abc " })).toEqual({
      kind: "filtered",
      title: 'No pods match "abc"',
    });
  });

  it("names the status chips when only they hide every row", () => {
    expect(listState({ ...base, shown: 0, chips: true })).toEqual({
      kind: "filtered",
      title: "No pods with the selected status",
    });
  });

  it("names both the text and the chips when both are set", () => {
    expect(listState({ ...base, shown: 0, filter: "abc", chips: true })).toEqual({
      kind: "filtered",
      title: 'No pods match "abc" with the selected status',
    });
  });

  it("an empty list stays empty, not filtered, even with a filter typed", () => {
    expect(listState({ ...base, total: 0, shown: 0, filter: "abc" }).kind).toBe("empty");
  });

  it("shows a failed load as an error with the server's message", () => {
    expect(listState({ ...base, error: "connection reset by peer" })).toEqual({
      kind: "error",
      title: "Could not load pods",
      message: "connection reset by peer",
    });
  });

  it("an error wins over loading and over rows from the last good load", () => {
    expect(listState({ ...base, loaded: false, error: "boom" }).kind).toBe("error");
  });

  it("turns an RBAC denial into the forbidden state", () => {
    expect(listState({ ...base, error: 'pods is forbidden: User "dev" cannot list resource' })).toEqual({
      kind: "forbidden",
      title: "You are not allowed to list pods in payments.",
    });
  });

  it("forbidden across all namespaces and for cluster-scoped kinds", () => {
    expect(listState({ ...base, namespace: null, error: "HTTP 403" })).toMatchObject({
      title: "You are not allowed to list pods in any namespace.",
    });
    expect(listState({ ...base, nouns: ["node", "nodes"], namespaced: false, error: "403 Forbidden" })).toMatchObject({
      title: "You are not allowed to list nodes in this cluster.",
    });
  });

  it("a kind the cluster does not serve wins over everything", () => {
    expect(listState({ ...base, unavailable: true, error: "boom", loaded: false })).toEqual({ kind: "unavailable" });
  });
});
