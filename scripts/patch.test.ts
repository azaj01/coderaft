// Post-condition tests for patches/code-server.patch.
//
// These assert the *installed, patched* code-server actually has the shape
// scripts/patch.ts intends to produce. They run against whatever pnpm linked
// into node_modules (the committed patch applied at install time), so they
// catch two failure modes that a regex-in-isolation check would miss:
//
//   1. A patch step that silently no-ops. `String.replace` with a
//      non-matching pattern returns the input unchanged and throws nothing,
//      so a stale minifier-renamed pattern can drop a transform without any
//      error — exactly how the MessageChannel/transferList removal regressed.
//   2. A code-server upgrade that shifts the source so a step stops matching.
//
// Each check is paired: assert the fix IS present AND the broken artifact is
// GONE. The "absent" half is what guards against a silent no-op — a step that
// didn't run leaves its original artifact behind.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
// Resolve from lib/, where code-server is declared as a dependency.
const codeServerRoot = dirname(
  require.resolve("code-server/package.json", { paths: [join(import.meta.dirname!, "../lib")] }),
);
const read = (rel: string) => readFileSync(join(codeServerRoot, rel), "utf8");

const extHost = read("lib/vscode/out/vs/workbench/api/node/extensionHostProcess.js");
const productJson = read("lib/vscode/product.json");
const serverMain = read("lib/vscode/out/server-main.js");

describe("ESM hook deadlock fix (extensionHostProcess.js)", () => {
  it("installs the inline data-URI hook", () => {
    expect(extHost).toContain("const EXPORTS = [");
  });

  it("removes the MessageChannel round-trip resolve (deadlock source)", () => {
    // The broken resolve awaited a MessageChannel reply mid-`syncLink`.
    expect(extHost).not.toContain("await lookup(context.parentURL)");
  });

  it("rewrites _VSCODE_IMPORT_VSCODE_API to load the factory by caller URL", () => {
    expect(extHost).toContain('load("_not_used",');
  });

  it("strips the MessageChannel port + transferList from the hook registration", () => {
    // The exact artifact that regressed: the fixed hook ignores the port, so
    // the registration must not still pass `data:{port:…},transferList:[…]`.
    expect(extHost).not.toMatch(/_loaderScript\),\{parentURL:import\.meta\.url,data:\{port:/);
  });
});

describe("Platform-not-supported fix (Termux/android startup)", () => {
  const files = [
    "lib/vscode/out/server-main.js",
    "lib/vscode/out/vs/platform/terminal/node/ptyHostMain.js",
    "lib/vscode/out/vs/platform/agentHost/node/agentHostMain.js",
  ];
  for (const rel of files) {
    it(`removes the throw in ${rel.split("/").pop()}`, () => {
      expect(read(rel)).not.toContain('throw new Error("Platform not supported")');
    });
  }
});

describe("Copilot/chat wiring removal (product.json)", () => {
  it("drops defaultChatAgent", () => {
    expect(productJson).not.toContain('"defaultChatAgent"');
  });

  it("empties builtInExtensionsEnabledWithAutoUpdates", () => {
    expect(productJson).toMatch(/"builtInExtensionsEnabledWithAutoUpdates": \[\]/);
  });

  it("drops copilot from trustedExtensionAuthAccess", () => {
    expect(productJson).not.toMatch(/"github\.copilot(-chat)?"/);
  });
});

describe("Workbench default settings (server-main.js)", () => {
  it("injects configurationDefaults with AI features disabled", () => {
    expect(serverMain).toContain("configurationDefaults:");
    expect(serverMain).toContain("chat.disableAIFeatures");
  });
});
