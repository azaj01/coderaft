// Applies patches/code-server.patch to the installed code-server tree.
//
// We can't use pnpm's `patchedDependencies` here: code-server is now pulled
// from a GitHub release tarball (npm lags behind), and pnpm refuses to patch a
// URL/tarball dep — `pnpm patch` re-resolves the bare name against the registry,
// and enabling `patchedDependencies` fails with ERR_PNPM_MISSING_TARBALL_INTEGRITY
// because the tarball resolution carries no integrity field. So instead the
// patch is applied here, at postinstall time (scripts/link.ts) and by
// scripts/patch.ts after it regenerates the file.
//
// code-server lives under gitignored `node_modules`, i.e. *inside* this repo's
// working tree. `git apply` would then discover the enclosing repo and fall back
// to index/3-way logic that misreports whether a hunk is already applied (a
// reverse `--check` spuriously passes on a pristine tree). We block that
// discovery with GIT_CEILING_DIRECTORIES pinned to the top-level `node_modules`,
// so git treats the code-server dir as a plain, repo-less directory.

import { execFileSync } from "node:child_process";
import { dirname } from "node:path";

/** Top-level `node_modules` above `dir`, used as the git repo-discovery ceiling. */
function repoCeiling(dir: string): string {
  const marker = "/node_modules/";
  const idx = dir.indexOf(marker);
  return idx === -1 ? dirname(dir) : dir.slice(0, idx) + "/node_modules";
}

function gitApply(dir: string, patchFile: string, args: string[]): boolean {
  try {
    execFileSync("git", ["apply", ...args, patchFile], {
      cwd: dir,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: repoCeiling(dir) },
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply `patchFile` to `codeServerDir`, idempotently.
 * - forward check passes → apply it (returns "applied")
 * - reverse check passes → already applied, no-op (returns "already")
 * - neither → the source drifted; throw so an upgrade can't silently ship
 *   unpatched output.
 */
export function applyCodeServerPatch(
  codeServerDir: string,
  patchFile: string,
): "applied" | "already" {
  if (gitApply(codeServerDir, patchFile, ["--check"])) {
    gitApply(codeServerDir, patchFile, []);
    return "applied";
  }
  if (gitApply(codeServerDir, patchFile, ["-R", "--check"])) {
    return "already";
  }
  throw new Error(
    `Cannot apply ${patchFile} to ${codeServerDir}: neither forward nor reverse ` +
      `applies. The code-server source likely changed — regenerate with scripts/patch.ts.`,
  );
}

/**
 * Reverse `patchFile` if it is currently applied, leaving `codeServerDir`
 * pristine. Used by scripts/patch.ts so it always diffs against clean source.
 */
export function restorePristine(codeServerDir: string, patchFile: string): void {
  if (gitApply(codeServerDir, patchFile, ["-R", "--check"])) {
    gitApply(codeServerDir, patchFile, ["-R"]);
  }
}
