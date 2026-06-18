import { fork } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface EnsureExtensionsOptions {
  /** Directory extensions are installed into (must match the running server). */
  extensionsDir: string;
  /** VS Code user data directory. */
  userDataDir: string;
  /** VS Code server data directory. */
  serverDataDir?: string;
  /** Reinstall even if an extension with the same id is already present. */
  force?: boolean;
  /** Install pre-release versions when available. */
  preRelease?: boolean;
}

interface InstalledEntry {
  identifier?: { id?: string };
}

/**
 * Read the ids of already-installed extensions (lowercased) from the
 * `extensions.json` manifest VS Code maintains in the extensions directory.
 * Returns an empty set when the directory or manifest doesn't exist yet.
 */
export function readInstalledExtensions(extensionsDir: string): Set<string> {
  try {
    const raw = readFileSync(join(extensionsDir, "extensions.json"), "utf8");
    const entries = JSON.parse(raw) as InstalledEntry[];
    return new Set(
      entries
        .map((e) => e.identifier?.id?.toLowerCase())
        .filter((id): id is string => typeof id === "string"),
    );
  } catch {
    return new Set();
  }
}

/** Strip a `@version` / `@pre-release` suffix from an extension spec. */
function specId(spec: string): string {
  // A leading `@` (scoped-style ids don't exist here, but be safe) shouldn't be
  // treated as a version separator.
  const at = spec.indexOf("@", 1);
  return (at === -1 ? spec : spec.slice(0, at)).toLowerCase();
}

/** Returns the specs that still need installing (skips local `.vsix` paths' dedupe). */
function pendingExtensions(specs: string[], extensionsDir: string): string[] {
  const installed = readInstalledExtensions(extensionsDir);
  return specs.filter((spec) => {
    // Local .vsix files are cheap to re-apply and may have changed on disk;
    // always hand them to the CLI (it no-ops if identical).
    if (spec.toLowerCase().endsWith(".vsix")) return true;
    return !installed.has(specId(spec));
  });
}

/**
 * Ensure the given extensions are installed before the server boots. Missing
 * extensions are installed from the gallery (Open VSX by default) in a forked
 * child process — `spawnCli` calls `process.exit()` when done, so it cannot run
 * in the server process. Best-effort: install failures are logged, not thrown,
 * so a bad id or a gallery outage never blocks startup.
 */
export async function ensureExtensions(
  specs: string[],
  opts: EnsureExtensionsOptions,
): Promise<void> {
  const pending = opts.force ? specs : pendingExtensions(specs, opts.extensionsDir);
  if (pending.length === 0) return;

  console.log(
    `[coderaft] Installing ${pending.length} extension${pending.length === 1 ? "" : "s"}: ${pending.join(", ")}`,
  );

  await runInstall(pending, opts);

  // Verify against the manifest and warn about anything that didn't land.
  const installed = readInstalledExtensions(opts.extensionsDir);
  for (const spec of pending) {
    if (spec.toLowerCase().endsWith(".vsix")) continue;
    if (!installed.has(specId(spec))) {
      console.warn(`[coderaft] Extension failed to install: ${spec}`);
    }
  }
}

function runInstall(specs: string[], opts: EnsureExtensionsOptions): Promise<void> {
  const installPath = fileURLToPath(import.meta.resolve("#install"));
  return new Promise((resolve, reject) => {
    const child = fork(installPath, {
      // Pipe stdout so we can drop VS Code's noisy `info [uuid] …` log lines and
      // keep only the human-facing "Installing …" / "successfully installed"
      // messages; surface stderr as-is.
      stdio: ["ignore", "pipe", "inherit", "ipc"],
      env: {
        ...process.env,
        CODERAFT_INSTALL: JSON.stringify({
          ids: specs,
          extensionsDir: opts.extensionsDir,
          userDataDir: opts.userDataDir,
          serverDataDir: opts.serverDataDir,
          force: opts.force,
          preRelease: opts.preRelease,
        }),
      },
    });

    let buf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (/^\s*(info|debug|trace)\s+\[/.test(line)) continue;
        if (line.trim()) console.log(line);
      }
    });

    // Resolve regardless of exit code — `ensureExtensions` verifies the result
    // against the manifest and warns on failures. A spawn error (e.g. missing
    // entry file) is a real problem, so reject on that.
    child.once("exit", () => {
      if (buf.trim() && !/^\s*(info|debug|trace)\s+\[/.test(buf)) console.log(buf);
      resolve();
    });
    child.once("error", reject);
  });
}
