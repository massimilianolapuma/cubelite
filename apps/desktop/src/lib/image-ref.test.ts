import { describe, expect, it } from "vitest";
import { parseImageRef, shortDigest } from "./image-ref";

const DIGEST = "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

describe("parseImageRef", () => {
  it("a bare name has no tag: the version shown is latest", () => {
    expect(parseImageRef("nginx")).toEqual({
      repository: "nginx",
      prefix: "",
      name: "nginx",
      tag: null,
      digest: null,
      version: "latest",
      separator: ":",
    });
  });

  it("splits a name and its tag", () => {
    expect(parseImageRef("nginx:1.27")).toMatchObject({ repository: "nginx", tag: "1.27", digest: null, version: "1.27" });
  });

  it("keeps the registry and the path in the repository", () => {
    expect(parseImageRef("ghcr.io/org/app:v1.2.3")).toMatchObject({
      repository: "ghcr.io/org/app",
      tag: "v1.2.3",
      version: "v1.2.3",
    });
  });

  it("a registry port is not a tag", () => {
    expect(parseImageRef("localhost:5000/app")).toMatchObject({
      repository: "localhost:5000/app",
      tag: null,
      digest: null,
      version: "latest",
    });
  });

  it("a registry port and a tag", () => {
    expect(parseImageRef("localhost:5000/app:dev")).toMatchObject({
      repository: "localhost:5000/app",
      tag: "dev",
      version: "dev",
    });
  });

  it("a digest alone shows short, after an @", () => {
    expect(parseImageRef(`repo@${DIGEST}`)).toEqual({
      repository: "repo",
      prefix: "",
      name: "repo",
      tag: null,
      digest: DIGEST,
      version: "sha256:4f53cda18c2b",
      separator: "@",
    });
  });

  it("with a tag and a digest the tag is what shows; the digest is kept", () => {
    expect(parseImageRef(`registry.example:5000/team/repo:2.1@${DIGEST}`)).toEqual({
      repository: "registry.example:5000/team/repo",
      prefix: "registry.example:5000/team/",
      name: "repo",
      tag: "2.1",
      digest: DIGEST,
      version: "2.1",
      separator: ":",
    });
  });

  it("an empty reference has nothing to show", () => {
    expect(parseImageRef("")).toEqual({
      repository: "",
      prefix: "",
      name: "",
      tag: null,
      digest: null,
      version: null,
      separator: ":",
    });
    expect(parseImageRef("   ")).toMatchObject({ repository: "", version: null });
  });

  it("ignores surrounding whitespace", () => {
    expect(parseImageRef(" nginx:1.27 ")).toMatchObject({ repository: "nginx", tag: "1.27" });
  });
});

describe("parseImageRef: prefix and name", () => {
  it("the name is the last path segment; the prefix is what comes before it, with its slash", () => {
    expect(parseImageRef("registry.example.internal:5000/platform/team/backend-services/orders-api:2.14.3-rc.1")).toMatchObject({
      prefix: "registry.example.internal:5000/platform/team/backend-services/",
      name: "orders-api",
      tag: "2.14.3-rc.1",
    });
    expect(parseImageRef("ghcr.io/org/app:v1.2.3")).toMatchObject({ prefix: "ghcr.io/org/", name: "app" });
  });

  it("a reference with no slash has an empty prefix", () => {
    expect(parseImageRef("nginx:1.27")).toMatchObject({ prefix: "", name: "nginx" });
  });

  it("a registry with a port is all prefix", () => {
    expect(parseImageRef("localhost:5000/app")).toMatchObject({ prefix: "localhost:5000/", name: "app", version: "latest" });
    expect(parseImageRef("localhost:5000/app:dev")).toMatchObject({ prefix: "localhost:5000/", name: "app", tag: "dev" });
  });

  it("prefix and name together are the repository", () => {
    for (const ref of ["nginx", "a/b/c:1", `x.io/y/z@${DIGEST}`, "localhost:5000/app"]) {
      const { prefix, name, repository } = parseImageRef(ref);
      expect(prefix + name).toBe(repository);
    }
  });
});

describe("shortDigest", () => {
  it("keeps the algorithm and the first 12 hex characters", () => {
    expect(shortDigest(DIGEST)).toBe("sha256:4f53cda18c2b");
  });

  it("leaves a digest that is already short as it is", () => {
    expect(shortDigest("sha256:abc")).toBe("sha256:abc");
  });
});
