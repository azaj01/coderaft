# coderaft

Custom VS Code server build with bundled dependencies.

## Project Structure

- `lib/` — Main dependency package, pulls in `code-server` (pinned to a GitHub release tarball) and all required VS Code native/runtime deps
- `shims/` — Workspace shim packages replacing native deps (pnpm overrides). See [shims/README.md](./shims/README.md) for the full list, pnpm override mappings, and native binary breakdown.
- `scripts/` — Dev/test scripts (docker, ssh, ESM deadlock repro)

## Upgrading code-server

`node scripts/upgrade.ts` runs the whole upgrade in one shot: resolve the latest
GitHub release, re-pin `lib/package.json`, install, regenerate + apply
`patches/code-server.patch` against the new source, re-sync lib devDependencies
from the newly bundled VS Code, renovate the lockfile, run the patch
post-condition tests, then build and diff `lib/code.tar.zst` against its
pre-upgrade size. Useful flags: `--to <version>` to pin a specific release,
`--force` to re-run on the current one, `--max-growth <MiB>` (default 1) for the
size gate. `--help` prints the full pipeline.

The archive sits close to pack.ts's hard cap (~24 of 25 MiB on linux), so a
release that bundles something big fails the build rather than shipping. When
that happens, `lib/code.tar.zst.txt` has the per-file breakdown and pack.ts's
`excludeDirPaths` / `excludeFilePaths` are where things get dropped.

The individual steps still work standalone: `scripts/patch.ts` regenerates the
patch, `scripts/sync.ts` re-syncs deps, and `scripts/link.ts` does the
postinstall linking and patch application.

## Shims: CJS vs ESM

Shims **must be CJS** (no `"type": "module"` in package.json) unless VS Code's bundled code imports them via ESM `import { ... } from "..."`.

- On Node 24+, `require()` of an ESM module goes through `syncLink` → `Atomics.wait()`. If VS Code's extension host has registered its custom ESM resolve hook (`module.register` + `MessageChannel`), this deadlocks: the main thread blocks waiting for the hook, but the hook needs the main thread to respond on `MessageChannel`.
- VS Code's bundled code uses `require()` for most deps (node-pty, ripgrep, spdlog, etc.) — these shims **must be CJS**.
- Exception: `@vscode/proxy-agent` is loaded via ESM `import { createHttpPatch, ... }` in VS Code's bundle — it **must stay ESM**, otherwise Node throws `SyntaxError: Named export not found`.

When adding a new shim, check how VS Code loads the original package (`require()` vs `import`) to decide CJS vs ESM.
