// Forked child entry used to preinstall extensions through VS Code's own CLI
// (`spawnCli`). This runs in a dedicated process because `spawnCli` calls
// `process.exit()` once installs settle — doing it in-process would tear down
// the parent's long-lived server. Config is passed via the `CODERAFT_INSTALL`
// env var (JSON); progress is logged to stdout/stderr by VS Code itself.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadCode } from "#code";

const cfg = JSON.parse(process.env.CODERAFT_INSTALL || "{}");

// Suppress server-main.js's standalone auto-boot (same trick as server.ts):
// the module top-level is `process.env.CODE_SERVER_PARENT_PID || <boot>()`, so
// a truthy value makes the import side-effect-free and lets us drive the CLI.
process.env.CODE_SERVER_PARENT_PID ??= String(process.pid);

const { modulesDir } = await loadCode();
const vsRoot = join(modulesDir, "code-server", "lib", "vscode");
const mod = await import(pathToFileURL(join(vsRoot, "out/server-main.js")).href);
const serverModule = await mod.loadCodeWithNls();

// `spawnCli` consumes a VS Code NativeParsedArgs object. Extensions resolve
// against the gallery baked into the patched server-main.js, which defaults to
// Open VSX (https://open-vsx.org/vscode/gallery).
await serverModule.spawnCli({
  _: [],
  "install-extension": cfg.ids,
  "extensions-dir": cfg.extensionsDir,
  "user-data-dir": cfg.userDataDir,
  "server-data-dir": cfg.serverDataDir,
  ...(cfg.force ? { force: true } : {}),
  ...(cfg.preRelease ? { "pre-release": true } : {}),
});
