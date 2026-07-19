#!/usr/bin/env node
// Regenerates patches/code-server.patch and applies it to the installed tree.
// Usage: node scripts/patch.ts
//
// ## Why this doesn't use `pnpm patch`
//
// code-server is pulled from a GitHub release tarball (npm lags behind). pnpm
// can't patch a URL/tarball dep: `pnpm patch code-server` re-resolves the bare
// name against the npm registry (which has no matching version), and enabling
// `patchedDependencies` fails with ERR_PNPM_MISSING_TARBALL_INTEGRITY. So we
// build the patch by hand and apply it at postinstall time (scripts/link.ts,
// via scripts/apply-patch.ts).
//
// ## How regeneration works
//
//   1. Reverse any already-applied patch so the installed tree is pristine.
//   2. Copy the touched files into a scratch git repo, commit, apply the
//      transforms below, and `git diff` — which yields the exact `diff --git`
//      format pnpm used to produce.
//   3. Apply the fresh patch back to the installed tree (so pack.ts / the
//      post-condition tests in patch.test.ts see patched output).
//
// ## What this patches (code-server >= 4.127)
//
//   - Platform-not-supported throw (Termux/android startup) in three entry files
//   - Copilot/chat wiring in product.json
//   - Default workbench settings injected into server-main.js
//
// Note: earlier versions also rewrote an ESM `module.register()` loader hook in
// extensionHostProcess.js that deadlocked on Node >=24. VS Code replaced that
// hook with a synchronous CJS `Module._load` interceptor (`_installInterceptor`)
// in 4.127, so that patch is obsolete and has been dropped.

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { applyCodeServerPatch, restorePristine } from "./apply-patch.ts";

const rootDir = join(import.meta.dirname!, "..");
const require = createRequire(join(rootDir, "lib/index.js"));
const codeServerDir = dirname(require.resolve("code-server/package.json"));
const patchFile = join(rootDir, "patches/code-server.patch");

// Files the patch touches, relative to the code-server package root.
const TOUCHED = [
  "lib/vscode/out/server-main.js",
  "lib/vscode/out/vs/platform/terminal/node/ptyHostMain.js",
  "lib/vscode/out/vs/platform/agentHost/node/agentHostMain.js",
  "lib/vscode/product.json",
];

const PLATFORM_SWITCH_FILES = new Set([
  "lib/vscode/out/server-main.js",
  "lib/vscode/out/vs/platform/terminal/node/ptyHostMain.js",
  "lib/vscode/out/vs/platform/agentHost/node/agentHostMain.js",
]);

// Step 1: make sure we're reading pristine source (undo a prior application).
restorePristine(codeServerDir, patchFile);

// Step 2: assemble a scratch git repo of just the pristine touched files,
// transform them, and diff.
const work = join(rootDir, "node_modules/.code-server-patchgen");
rmSync(work, { recursive: true, force: true });
for (const rel of TOUCHED) {
  const dest = join(work, rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(codeServerDir, rel), dest);
}
const git = (args: string[]) => execFileSync("git", args, { cwd: work, stdio: "pipe" });
git(["init", "-q"]);
git(["add", "-A"]);
git(["-c", "user.email=patch@coderaft", "-c", "user.name=coderaft", "commit", "-qm", "pristine"]);

for (const rel of TOUCHED) {
  const src = join(work, rel);
  writeFileSync(src, transform(rel, readFileSync(src, "utf8")));
}

const diff = execFileSync("git", ["diff"], {
  cwd: work,
  encoding: "utf8",
  maxBuffer: 128 * 1024 * 1024,
});
if (!diff.trim()) {
  console.error("No changes produced — every transform no-oped. Source likely changed.");
  process.exit(1);
}
writeFileSync(patchFile, diff);
rmSync(work, { recursive: true, force: true });
console.log(`Wrote ${patchFile}`);

// Step 3: apply the fresh patch to the installed tree.
const status = applyCodeServerPatch(codeServerDir, patchFile);
console.log(`Applied patch to installed code-server (${status})`);

// --- Transforms ---

function transform(rel: string, code: string): string {
  if (rel === "lib/vscode/product.json") return patchProductJson(code);
  if (PLATFORM_SWITCH_FILES.has(rel)) code = patchPlatformSwitch(code, rel);
  if (rel.endsWith("server-main.js")) code = patchServerMain(code);
  return code;
}

// Rewrite `case"linux":<body>;break;default:throw new Error("Platform not supported")`
// so linux falls through from default, giving unknown platforms (e.g. Termux's
// `android`) the XDG/~/.config code path instead of a startup crash. Variable
// names are minified per bundle, so match the body with a regex.
function patchPlatformSwitch(code: string, rel: string): string {
  const re =
    /case"linux":((?:(?!break;).)*?)break;default:throw new Error\("Platform not supported"\)/;
  const match = code.match(re);
  if (!match) throw new Error(`platform switch pattern not found in ${rel}`);
  return code.replace(re, `case"linux":default:${match[1]}break`);
}

// Neuter the bundled Copilot Chat ("Build with Agent") wiring in product.json.
// String-level edits (not JSON.stringify) keep the diff minimal — product.json
// uses a custom mixed compact/pretty layout that JSON.stringify would normalize.
function patchProductJson(src: string): string {
  // 1. Drop the `defaultChatAgent` object (multiline block, ends with `},\n`).
  const defaultChatAgentRe = /^ {2}"defaultChatAgent": \{[\s\S]*?^ {2}\},\n/m;
  if (!defaultChatAgentRe.test(src)) {
    throw new Error("product.json: defaultChatAgent block not found");
  }
  src = src.replace(defaultChatAgentRe, "");

  // 2. Drop copilot entries from `trustedExtensionAuthAccess`.
  src = src.replace(/, "github\.copilot(?:-chat)?"/g, "");

  // 3. Empty `builtInExtensionsEnabledWithAutoUpdates`.
  const builtInRe = /"builtInExtensionsEnabledWithAutoUpdates": \[[^\]]*\]/;
  if (!builtInRe.test(src)) {
    throw new Error("product.json: builtInExtensionsEnabledWithAutoUpdates not found");
  }
  src = src.replace(builtInRe, '"builtInExtensionsEnabledWithAutoUpdates": []');

  return src;
}

// Inject default settings into the workbench config sent to the browser.
//
// product.json's `configurationDefaults` won't do — VS Code only reads that key
// from extension `contributes` and from workbench `options.configurationDefaults`.
// `server-main.js` builds the workbench options object and serializes it into the
// `WORKBENCH_WEB_CONFIGURATION` meta tag; we inject `configurationDefaults` as its
// first key so the browser workbench applies the defaults.
//
// Both `chat.disableAIFeatures` AND `workbench.disableAICustomizations` must be
// true to fully hide the chat setup UI (e.g. the "Sign in to use AI Features"
// button in the Accounts menu / status bar).
function patchServerMain(code: string): string {
  const configDefaults = {
    "chat.disableAIFeatures": true,
    "workbench.disableAICustomizations": true,
    "chat.commandCenter.enabled": false,
    "chat.agent.enabled": false,
    // MCP (Model Context Protocol) — disable the server runtime, gallery, and
    // discovery so VS Code doesn't scan Claude Desktop / Cursor configs or
    // expose the "Add MCP Server" / gallery UI even if chat were re-enabled.
    "chat.mcp.enabled": false,
    "chat.mcp.discovery.enabled": false,
    "chat.mcp.gallery.enabled": false,
    "chat.mcp.autostart": "never",
    "chat.mcp.access": "none",
    "workbench.colorTheme": "Default Dark Modern",
    "workbench.preferredDarkColorTheme": "Default Dark Modern",
    "workbench.preferredLightColorTheme": "Default Light Modern",
    "window.autoDetectColorScheme": true,
    "workbench.startupEditor": "none",
    "workbench.secondarySideBar.defaultVisibility": "hidden",
    // Opt into the reworked workbench chrome (compact activity bar, floating
    // panels, thinner scrollbars). Registered in 4.129 with default `false` and
    // an `experiment: { mode: "auto" }` tag, so it stays off unless set.
    "workbench.experimental.modernUI": true,
    // File watcher exclusions. The bundled VS Code only excludes git/hg metadata
    // by default (no node_modules), so each window's recursive watcher indexes
    // heavy dirs into a multi-GB JS-heap tree. `files.watcherExclude` is a merged
    // object setting, so these are additive — user-added watches still fire.
    "files.watcherExclude": {
      "**/.git/objects/**": true,
      "**/.git/subtree-cache/**": true,
      "**/node_modules/**": true,
      "**/dist/**": true,
      "**/.cache/**": true,
    },
    "search.followSymlinks": false,
    // Bound the bundled tsserver heap. Default ceiling is 3072 MB per instance,
    // and idle instances outlive their window (backend-scoped), so several can
    // accumulate on a shared box. Lower the cap to limit worst-case residency.
    "typescript.tsserver.maxTsServerMemory": 2048,
  };

  // The options object is `let <var>={remoteAuthority:...,serverBasePath:...,webviewEndpoint:...}`.
  // The var name is minified (was `U`, now `F`), so capture it.
  const re = /let (\w+)=\{remoteAuthority:\w+,serverBasePath:\w+,webviewEndpoint:/;
  const match = code.match(re);
  if (!match) throw new Error("server-main.js: workbench config object pattern not found");
  const varName = match[1];
  return code.replace(
    match[0],
    match[0].replace(
      `let ${varName}={`,
      `let ${varName}={configurationDefaults:${JSON.stringify(configDefaults)},`,
    ),
  );
}
