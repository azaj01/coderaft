#!/usr/bin/env node
// Upgrades the pinned code-server release and re-runs the whole patch/sync/build
// pipeline, reporting how much the packed archive grew.
//
// Usage:
//   node scripts/upgrade.ts                  # upgrade to the latest GitHub release
//   node scripts/upgrade.ts --to 4.129.0     # pin a specific release
//   node scripts/upgrade.ts --force          # re-run the pipeline on the current version
//   node scripts/upgrade.ts --max-growth 2   # allow code.tar.zst to grow by 2 MiB
//   node scripts/upgrade.ts --no-size-check  # report size drift but never fail on it
//   node scripts/upgrade.ts --skip-tests     # skip the post-upgrade patch assertions
//
// Set GITHUB_TOKEN (or GH_TOKEN) to lift the anonymous GitHub API rate limit.
//
// ## Steps
//
//   1. Resolve the target release and assert it ships `package.tar.gz` — that
//      asset *is* the dependency URL in lib/package.json.
//   2. Snapshot the current lib/code.tar.zst size as the size baseline. It is
//      gitignored, so this only works if the tree has been built before; without
//      it the upgrade still runs, just with nothing to compare against.
//   3. Rewrite the `code-server` URL in lib/package.json and install.
//   4. Regenerate + apply patches/code-server.patch against the new source.
//   5. Re-sync lib devDependencies from the new bundled VS Code and install again
//      so the lockfile picks up whatever upstream added/dropped/bumped.
//   6. Build and diff the archive size against the baseline.
//
// ## Why the patch is moved aside for the first install
//
// link.ts applies patches/code-server.patch on postinstall and *throws* when it
// neither forward- nor reverse-applies, so an unpatched build can't ship silently.
// A patch generated against the old release almost never applies to new upstream
// source (the bundles are minified — names and offsets move every release), so
// that safety net would abort the very install that fetches the new source. We
// hide the patch for that one install and regenerate it in step 4, where
// patch.ts's restorePristine handles both a freshly extracted tree and an
// already-patched one (`--force` on the current version).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const REPO = "coder/code-server";
const MIB = 1024 * 1024;

const rootDir = join(import.meta.dirname!, "..");
const pkgPath = join(rootDir, "lib/package.json");
const patchFile = join(rootDir, "patches/code-server.patch");
const patchHidden = patchFile + ".upgrading";
const archiveFile = join(rootDir, "lib/code.tar.zst");

const { values: opts } = parseArgs({
  options: {
    to: { type: "string" },
    force: { type: "boolean", default: false },
    "max-growth": { type: "string", default: "1" },
    "no-size-check": { type: "boolean", default: false },
    "skip-tests": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (opts.help) {
  const header = readFileSync(import.meta.filename!, "utf8");
  console.log(
    header
      .split("\n")
      .slice(1)
      .filter((l) => l.startsWith("//"))
      .map((l) => l.slice(3))
      .join("\n"),
  );
  process.exit(0);
}

const maxGrowth = Number(opts["max-growth"]);
if (!Number.isFinite(maxGrowth) || maxGrowth < 0) {
  fail(`--max-growth must be a non-negative number of MiB, got ${opts["max-growth"]}`);
}

// --- Step 1: resolve the target release ---

const target = await resolveRelease(opts.to);
const current = readPinnedVersion();

console.log(`Current: ${current ?? "(unpinned)"}`);
console.log(`Target:  ${target}`);

if (current === target && !opts.force) {
  console.log("\nAlready up to date. Re-run with --force to rebuild the pipeline anyway.");
  process.exit(0);
}

// --- Step 2: size baseline ---

const baseline = existsSync(archiveFile) ? statSync(archiveFile).size : undefined;
if (baseline === undefined) {
  console.warn(
    `\n! ${rel(archiveFile)} not found — no size baseline to compare against.\n` +
      `  Build once on the current version first if you want a size check.`,
  );
}

// --- Steps 3-6 ---

const pkgBefore = readFileSync(pkgPath, "utf8");
let pkgRestorable = true;

try {
  step(3, `Pinning code-server ${target} and installing`);
  writePinnedVersion(target);
  withPatchHidden(() => install());

  step(4, "Regenerating patches/code-server.patch against the new source");
  // Past this point the working tree carries a real upgrade (new source, new
  // patch), so a later failure is a result to inspect, not something to undo.
  pkgRestorable = false;
  run("node", [join(rootDir, "scripts/patch.ts")]);

  step(5, "Syncing lib devDependencies from the new bundled VS Code");
  run("node", [join(rootDir, "scripts/sync.ts")]);
  install();

  if (!opts["skip-tests"]) {
    step(6, "Verifying the patch landed");
    run("pnpm", ["exec", "vitest", "run"]);
  }

  step(opts["skip-tests"] ? 6 : 7, "Building");
  run("pnpm", ["build"]);
} catch (error) {
  if (pkgRestorable) {
    writeFileSync(pkgPath, pkgBefore);
    console.error(`\nRestored ${rel(pkgPath)} — the upgrade did not get far enough to keep.`);
  }
  throw error;
}

// --- Size report ---

const size = statSync(archiveFile).size;
console.log(`\n${"─".repeat(60)}`);
console.log(`code-server ${current ?? "(unpinned)"} → ${target}`);
console.log(`Archive:    ${mib(size)} MiB`);

let regressed = false;
if (baseline !== undefined) {
  const delta = size - baseline;
  const pct = ((delta / baseline) * 100).toFixed(1);
  const sign = delta >= 0 ? "+" : "-";
  console.log(`Baseline:   ${mib(baseline)} MiB`);
  console.log(`Delta:      ${sign}${mib(Math.abs(delta))} MiB (${sign}${pct.replace("-", "")}%)`);
  regressed = !opts["no-size-check"] && delta > maxGrowth * MIB;
}

console.log(
  "\nChanged files to review and commit:\n" +
    "  lib/package.json           code-server pin + synced devDependencies\n" +
    "  patches/code-server.patch  regenerated against the new source\n" +
    "  lib/code.mjs               codeArchiveHash for the new archive\n" +
    "  pnpm-lock.yaml             renovated lockfile",
);

if (regressed) {
  console.error(
    `\nERROR: archive grew by more than ${maxGrowth} MiB.\n` +
      `  See ${rel(archiveFile)}.txt for the per-file breakdown, and pack.ts's\n` +
      `  exclude lists for what to drop. Raise the bar with --max-growth <MiB>\n` +
      `  once you've confirmed the growth is warranted.`,
  );
  process.exit(1);
}

console.log("\nUpgrade complete.");

// --- Helpers ---

/** Resolve `version` (or the latest release) to a tag that ships `package.tar.gz`. */
async function resolveRelease(version?: string): Promise<string> {
  const tag = version ? `v${version.replace(/^v/, "")}` : undefined;
  const url = tag
    ? `https://api.github.com/repos/${REPO}/releases/tags/${tag}`
    : `https://api.github.com/repos/${REPO}/releases/latest`;

  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "coderaft-upgrade",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const hint =
      res.status === 403 && !token ? " (set GITHUB_TOKEN to lift the anonymous rate limit)" : "";
    fail(`GitHub API ${res.status} ${res.statusText} for ${url}${hint}`);
  }
  const release = (await res.json()) as { tag_name: string; assets: { name: string }[] };

  // The dependency URL points straight at this asset; a release without it (or
  // one still uploading) would resolve to a 404 tarball at install time.
  if (!release.assets.some((a) => a.name === "package.tar.gz")) {
    fail(`Release ${release.tag_name} has no package.tar.gz asset — nothing to depend on.`);
  }
  return release.tag_name.replace(/^v/, "");
}

function tarballURL(version: string): string {
  return `https://github.com/${REPO}/releases/download/v${version}/package.tar.gz`;
}

/** The pinned release, or undefined if the dep isn't a release tarball URL. */
function readPinnedVersion(): string | undefined {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const dep = pkg.devDependencies?.["code-server"] as string | undefined;
  return dep?.match(/\/releases\/download\/v(\d+\.\d+\.\d+)\/package\.tar\.gz$/)?.[1];
}

function writePinnedVersion(version: string): void {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.devDependencies["code-server"] = tarballURL(version);
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

/** Run `fn` with the patch file hidden from link.ts's postinstall hook. */
function withPatchHidden(fn: () => void): void {
  const hide = existsSync(patchFile);
  if (hide) renameSync(patchFile, patchHidden);
  try {
    fn();
  } finally {
    if (hide && existsSync(patchHidden)) renameSync(patchHidden, patchFile);
  }
}

function install(): void {
  // The whole point is to move the lockfile, so never let a CI-style frozen
  // lockfile default abort the install.
  run("pnpm", ["install", "--no-frozen-lockfile"]);
}

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { cwd: rootDir, stdio: "inherit" });
}

function step(n: number, label: string): void {
  console.log(`\n${"─".repeat(60)}\n[${n}] ${label}\n${"─".repeat(60)}`);
}

function mib(bytes: number): string {
  return (bytes / MIB).toFixed(2);
}

function rel(path: string): string {
  return path.startsWith(rootDir + "/") ? path.slice(rootDir.length + 1) : path;
}

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}
