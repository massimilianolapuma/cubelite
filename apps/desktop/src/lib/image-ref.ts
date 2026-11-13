/**
 * A container image reference split into the parts a detail panel shows apart
 * (#648): the repository (registry and path), and the version, which is the
 * tag, or a short digest when there is no tag.
 *
 * Grammar (distribution/reference): `name[:tag][@digest]`, where `name` may
 * start with a registry host that has a port (`localhost:5000/app`). A colon is
 * a tag separator only after the last `/`.
 */
export interface ImageRef {
  /** Registry and path, e.g. `ghcr.io/org/app`. Empty for an empty reference. */
  repository: string;
  /**
   * The repository up to its last segment, trailing slash included
   * (`ghcr.io/org/`): the part that gives way first. Empty without a slash.
   */
  prefix: string;
  /** The last segment of the repository (`app`): the image's own name. */
  name: string;
  /** The tag as written, or null when there is none. */
  tag: string | null;
  /** The full digest (`sha256:…`) as written, or null when there is none. */
  digest: string | null;
  /**
   * What the panel shows as the version: the tag; without one, the short
   * digest; with neither, `latest` (what the runtime pulls). Null for an
   * empty reference.
   */
  version: string | null;
  /** What joins the repository and the version: `@` before a digest, `:` otherwise. */
  separator: ":" | "@";
}

/** Characters of a digest's hex part that identify it well enough to read. */
const SHORT_HEX = 12;

/** A digest as `algorithm:` and its first 12 hex characters. */
export function shortDigest(digest: string): string {
  const colon = digest.indexOf(":");
  if (colon < 0) return digest.slice(0, SHORT_HEX);
  return digest.slice(0, colon + 1 + SHORT_HEX);
}

export function parseImageRef(reference: string): ImageRef {
  const ref = reference.trim();
  if (ref === "") return { repository: "", prefix: "", name: "", tag: null, digest: null, version: null, separator: ":" };

  const at = ref.indexOf("@");
  const named = at < 0 ? ref : ref.slice(0, at);
  const digest = at < 0 ? null : ref.slice(at + 1) || null;

  const colon = named.lastIndexOf(":");
  const hasTag = colon > named.lastIndexOf("/");
  const repository = hasTag ? named.slice(0, colon) : named;
  const tag = hasTag ? named.slice(colon + 1) || null : null;
  const slash = repository.lastIndexOf("/");
  const parts = { repository, prefix: repository.slice(0, slash + 1), name: repository.slice(slash + 1), tag, digest };

  if (tag !== null) return { ...parts, version: tag, separator: ":" };
  if (digest !== null) return { ...parts, version: shortDigest(digest), separator: "@" };
  return { ...parts, version: "latest", separator: ":" };
}
