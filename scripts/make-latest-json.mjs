#!/usr/bin/env node
// Generates the Tauri v2 updater "latest.json" manifest from a directory of
// release artifacts (the Tauri updater bundles created by
// `createUpdaterArtifacts: true`, plus their `.sig` companions).
//
// Production usage (invoked from the `publish-release` job in
// .github/workflows/release.yml):
//
//   node scripts/make-latest-json.mjs \
//     --dir assets --tag v1.2.3 --repo owner/name \
//     --notes-file notes.md --out assets/latest.json
//
// Test / CI-gate usage (fixture-driven, see scripts/fixtures/updater/):
//
//   node scripts/make-latest-json.mjs --check scripts/fixtures/updater/happy
//   node scripts/make-latest-json.mjs --check scripts/fixtures/updater/missing-sig
//
// `--check <dir>` runs the exact same scan-and-validate code path as
// production, with a fake --tag/--repo filled in and the resulting JSON
// printed to stdout instead of written to --out. It exits 0 when every
// required target has an artifact + signature, and 1 (with a message on
// stderr) otherwise — that's what the fixture test in ci.yml asserts on.
//
// macOS coverage note: the `build-desktop` job builds on macos-15 (Apple
// Silicon) with a plain `tauri build` — no `--target` flag — so it only ever
// produces an aarch64 `.app.tar.gz`. There is no universal/x86_64 macOS
// build today. darwin-x86_64 is therefore NOT a required target; if a
// second `.app.tar.gz` shows up (e.g. a future universal build lands) the
// scan below refuses to guess and asks for arch-specific naming instead.
//
// deb (Linux) is excluded by design: apt doesn't go through the Tauri
// updater, only AppImage does.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REQUIRED_TARGETS = ["darwin-aarch64", "linux-x86_64", "windows-x86_64"];

class ScriptError extends Error {}

function findOne(files, predicate, label) {
  const matches = files.filter(predicate);
  if (matches.length > 1) {
    throw new ScriptError(
      `found ${matches.length} candidate files for ${label} (${matches.join(", ")}); expected exactly one. ` +
        `If this is a new build variant (e.g. a universal/x86_64 macOS build), give it a distinct stable ` +
        `name so make-latest-json can tell them apart.`,
    );
  }
  return matches[0] ?? null;
}

function resolveWindowsArtifact(files) {
  // Prefer the NSIS installer; fall back to MSI if that's all that's present.
  const exe = files.find((f) => f.endsWith("-setup.exe"));
  if (exe) return exe;
  return files.find((f) => f.endsWith(".msi")) ?? null;
}

// Scans `dir` for the Tauri updater artifacts + `.sig` companions and
// returns { target: { artifact, signature } } for every REQUIRED target.
// Throws ScriptError (one message, all problems) if anything required is
// missing.
function scanPlatforms(dir) {
  const files = readdirSync(dir);

  const candidates = {
    "darwin-aarch64": findOne(files, (f) => f.endsWith(".app.tar.gz"), "darwin-aarch64 (*.app.tar.gz)"),
    "linux-x86_64": findOne(files, (f) => f.endsWith(".AppImage"), "linux-x86_64 (*.AppImage)"),
    "windows-x86_64": resolveWindowsArtifact(files),
  };

  const errors = [];
  const platforms = {};

  for (const target of REQUIRED_TARGETS) {
    const artifact = candidates[target];
    if (!artifact) {
      errors.push(`missing artifact for required target "${target}"`);
      continue;
    }
    const sigName = `${artifact}.sig`;
    if (!files.includes(sigName)) {
      errors.push(
        `missing .sig for required target "${target}" (expected "${sigName}" next to "${artifact}")`,
      );
      continue;
    }
    const signature = readFileSync(join(dir, sigName), "utf8").trim();
    if (!signature) {
      errors.push(`empty .sig for required target "${target}" ("${sigName}")`);
      continue;
    }
    platforms[target] = { artifact, signature };
  }

  if (errors.length > 0) {
    throw new ScriptError(`latest.json generation failed:\n  - ${errors.join("\n  - ")}`);
  }

  return platforms;
}

function parseArgs(argv) {
  const args = { dir: null, tag: null, repo: null, notes: "", out: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--dir":
        args.dir = argv[++i];
        break;
      case "--check":
        args.check = true;
        args.dir = argv[++i];
        break;
      case "--tag":
        args.tag = argv[++i];
        break;
      case "--repo":
        args.repo = argv[++i];
        break;
      case "--notes":
        args.notes = argv[++i] ?? "";
        break;
      case "--notes-file":
        args.notes = readFileSync(argv[++i], "utf8");
        break;
      case "--out":
        args.out = argv[++i];
        break;
      default:
        throw new ScriptError(`unknown argument "${a}"`);
    }
  }

  if (!args.dir) {
    throw new ScriptError("missing --dir <artifactsDir> (or --check <fixtureDir>)");
  }
  if (args.check) {
    // --check is a scan/validate smoke test, not a real release — fill in
    // placeholders so callers don't have to pass --tag/--repo/--out.
    args.tag ??= "v0.0.0-test";
    args.repo ??= "example/example";
  }
  if (!args.tag) throw new ScriptError("missing --tag vX.Y.Z");
  if (!args.repo) throw new ScriptError("missing --repo owner/name");
  if (!args.out && !args.check) throw new ScriptError("missing --out <path>");

  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const scanned = scanPlatforms(args.dir);

  const platforms = {};
  for (const [target, { artifact, signature }] of Object.entries(scanned)) {
    platforms[target] = {
      signature,
      url: `https://github.com/${args.repo}/releases/download/${args.tag}/${artifact}`,
    };
  }

  const manifest = {
    version: args.tag.replace(/^v/, ""),
    notes: args.notes.trim(),
    pub_date: new Date().toISOString(),
    platforms,
  };

  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  if (args.out) {
    writeFileSync(args.out, json);
    console.log(`Wrote ${args.out}`);
  } else {
    process.stdout.write(json);
  }
}

try {
  main();
} catch (err) {
  if (err instanceof ScriptError) {
    console.error(`make-latest-json: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
